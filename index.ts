/**
 * contextRoller — rolling context summary + automatic project diary for pi.
 *
 * Maintains an incremental rolling summary in the background using a secondary
 * model from pi's model catalog, intercepts compaction to inject it (no heavy
 * summarization pass), and writes a per-day project diary of what was worked
 * on — including dead ends the summary deliberately discards.
 *
 * Design: SPEC.md (verified against pi 0.84.3).
 * Load for testing:  pi -e ./index.ts
 *
 * Note: diagnostics go to stderr (console.error) — stdout is reserved for pi's
 * own output and the RPC protocol.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	convertToLlm,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	estimateTokens,
	getMarkdownTheme,
	serializeConversation,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type AgentMessage, type AssistantMessage, type Model, uuidv7 } from "@earendil-works/pi-ai";
import { Markdown, matchesKey } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Configuration (SPEC §5.5)
// ---------------------------------------------------------------------------

interface DiaryConfig {
	enabled: boolean;
	intervalMinutes: number;
	dir: string;
}

interface ContextRollerConfig {
	/** Secondary model as "provider/modelId" from pi's model catalog. */
	model?: string;
	/** Entries kept after compaction (0 = keep nothing, default). */
	keepLastEntries: number;
	/** Max output tokens for secondary-model calls. */
	maxOutputTokens: number;
	/** Max size of the rolling summary in tokens (0 = no budget, FR-7). */
	maxSummaryTokens: number;
	diary: DiaryConfig;
}

const DEFAULT_CONFIG: ContextRollerConfig = {
	keepLastEntries: 0,
	maxOutputTokens: 2048,
	maxSummaryTokens: 4096,
	diary: { enabled: true, intervalMinutes: 15, dir: "diary" },
};

/** Load config: global (~/.pi/agent) first, project (.pi/) overrides. */
function loadConfig(cwd: string): ContextRollerConfig {
	const candidates = [
		join(homedir(), CONFIG_DIR_NAME, "agent", "contextRoller.json"),
		join(cwd, CONFIG_DIR_NAME, "contextRoller.json"),
	];
	let merged: Record<string, unknown> = {};
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			merged = { ...merged, ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) };
		} catch (err) {
			console.error(`[contextRoller] failed to parse config ${path}:`, err);
		}
	}
	return {
		...DEFAULT_CONFIG,
		...merged,
		diary: { ...DEFAULT_CONFIG.diary, ...(merged.diary as Partial<DiaryConfig> | undefined) },
	};
}

// ---------------------------------------------------------------------------
// State (SPEC §5.2)
// ---------------------------------------------------------------------------

interface RollingSummaryState {
	summaryText: string;
	/** Session entry id up to which the summary is current. */
	lastCoveredEntryId: string | null;
	updatedAt: number;
}

const EMPTY_STATE: RollingSummaryState = { summaryText: "", lastCoveredEntryId: null, updatedAt: 0 };

const STATE_ENTRY_TYPE = "rolling-summary";

/** Non-matching firstKeptEntryId → pi keeps nothing before the compaction entry (SPEC §4 fact 2). */
const KEEP_NONE_ID = "contextRoller-keep-none";

/** Reconstruct state from the latest persisted custom entry on the branch. */
function restoreState(ctx: ExtensionContext): RollingSummaryState {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
			const data = entry.data as Partial<RollingSummaryState> | undefined;
			return {
				summaryText: typeof data?.summaryText === "string" ? data.summaryText : "",
				lastCoveredEntryId: typeof data?.lastCoveredEntryId === "string" ? data.lastCoveredEntryId : null,
				updatedAt: typeof data?.updatedAt === "number" ? data.updatedAt : 0,
			};
		}
	}
	return { ...EMPTY_STATE };
}

// ---------------------------------------------------------------------------
// Secondary-model helpers (SPEC §5.1)
// ---------------------------------------------------------------------------

const ROLLING_SUMMARY_PROMPT = `You are a state tracking assistant for a coding agent session. You maintain a concise working-memory document that replaces summarized conversation history, so it must stand alone.

Rules:
- Update the document with the latest interaction; keep it current and concise.
- Overwrite outdated information (e.g. abandoned approaches) instead of accumulating it.
- Track files read/modified from tool calls in the tagged sections at the end.
- Keep exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] ...

### In Progress
- [ ] ...

### Blocked
- [...]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. ...

## Critical Context
- [Data needed to continue]

<read-files>
...
</read-files>

<modified-files>
...
</modified-files>`;

interface QueuedDelta {
	text: string;
	/** Session leaf id at enqueue time — becomes the coverage marker on success. */
	entryId: string;
}

const MAX_QUEUE = 50; // cap memory if the secondary server is down for a long time

function extractText(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Whether a message carries state worth recording in the rolling summary.
 * Aborted/empty assistant messages (e.g. after a mid-stream /compact abort)
 * must not be fed to the secondary model — they destroy the document.
 */
function hasSubstance(msg: AgentMessage): boolean {
	if (msg.role === "assistant") {
		return msg.content.some((c) => (c.type === "text" && c.text.trim() !== "") || c.type === "toolCall");
	}
	const content = (msg as { content?: unknown }).content;
	if (typeof content === "string") return content.trim() !== "";
	if (Array.isArray(content)) {
		return content.some((c) => c?.type === "text" && typeof c.text === "string" && c.text.trim() !== "");
	}
	return false;
}

/** Token estimate for plain text via pi's chars/4 heuristic. */
function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let config: ContextRollerConfig = DEFAULT_CONFIG;
	let state: RollingSummaryState = { ...EMPTY_STATE };
	let queue: QueuedDelta[] = [];
	let activePump: Promise<void> | null = null;
	// TODO(diary): diary buffer + lastDiaryFlush (SPEC §5.7).

	function statusText(): string {
		const model = config.model ?? "not configured";
		const summary = state.summaryText ? `${state.summaryText.length} chars` : "none";
		const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "never";
		const queued = queue.length > 0 ? ` | queued: ${queue.length}` : "";
		return `model: ${model} | summary: ${summary} | updated: ${updated}${queued}`;
	}

	function budgetClause(): string {
		return config.maxSummaryTokens > 0
			? `\n\nKeep the entire document under ~${config.maxSummaryTokens} tokens.`
			: "";
	}

	/** Resolve the configured secondary model ("provider/modelId", first slash). */
	function resolveSecondaryModel(ctx: ExtensionContext): Model<any> | undefined {
		const ref = config.model;
		if (!ref) return undefined;
		const slash = ref.indexOf("/");
		if (slash <= 0 || slash === ref.length - 1) return undefined;
		return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
	}

	/** One rolling-summary update for a delta. Returns true on success. */
	async function runSummaryUpdate(
		ctx: ExtensionContext,
		delta: { text: string; entryId: string },
		signal?: AbortSignal,
	): Promise<boolean> {
		const model = resolveSecondaryModel(ctx);
		if (!model) return false;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: ROLLING_SUMMARY_PROMPT + budgetClause(),
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `Current state:\n${state.summaryText || "(empty)"}\n\nLatest interaction:\n${delta.text}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: config.maxOutputTokens, cacheRetention: "none", sessionId: uuidv7(), signal },
			);
			const text = extractText(response);
			if (!text.trim()) return false;
			state = {
				summaryText: text.trim(),
				lastCoveredEntryId: delta.entryId || state.lastCoveredEntryId,
				updatedAt: Date.now(),
			};
			pi.appendEntry(STATE_ENTRY_TYPE, state);
			console.error(`[contextRoller] summary updated (${state.summaryText.length} chars)`);
			// FR-7: keep the document within budget.
			if (config.maxSummaryTokens > 0 && estimateTextTokens(state.summaryText) > config.maxSummaryTokens) {
				await compressSummary(ctx);
			}
			return true;
		} catch (err) {
			console.error("[contextRoller] summary update failed:", err instanceof Error ? err.message : err);
			return false;
		}
	}

	/** FR-7: compress the current summary to fit the token budget. */
	async function compressSummary(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		const model = resolveSecondaryModel(ctx);
		if (!model) return;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: `Compress the working-memory document provided by the user to fit under ~${config.maxSummaryTokens} tokens. Preserve the exact section structure and the most important content (goals, key decisions, in-progress work, file lists); drop verbose details first. Output only the compressed document.`,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: state.summaryText }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: config.maxOutputTokens, cacheRetention: "none", sessionId: uuidv7(), signal },
			);
			const text = extractText(response);
			if (text.trim()) {
				state = { ...state, summaryText: text.trim(), updatedAt: Date.now() };
				pi.appendEntry(STATE_ENTRY_TYPE, state);
				console.error(`[contextRoller] summary compressed to ${state.summaryText.length} chars`);
			}
		} catch (err) {
			console.error("[contextRoller] compression failed:", err instanceof Error ? err.message : err);
		}
	}

	async function doPump(ctx: ExtensionContext): Promise<void> {
		while (queue.length > 0) {
			if (!resolveSecondaryModel(ctx)) break; // unresolvable ref — retry once config/model changes
			const item = queue.shift()!;
			if (ctx.hasUI) ctx.ui.setStatus("contextRoller", "updating…");
			const ok = await runSummaryUpdate(ctx, item);
			if (!ok) {
				queue.unshift(item); // retry on the next turn
				break;
			}
		}
		if (ctx.hasUI) ctx.ui.setStatus("contextRoller", statusText());
		console.error("[contextRoller] idle"); // queue drained — test/diagnostic signal
	}

	function startPump(ctx: ExtensionContext): void {
		if (activePump) return;
		activePump = doPump(ctx).finally(() => {
			activePump = null;
		});
	}

	/** Entry id where kept messages start after compaction (SPEC §5.3 keep policy). */
	function firstKeptEntryId(branch: SessionEntry[]): string {
		const keep = config.keepLastEntries;
		if (keep <= 0 || branch.length === 0) return KEEP_NONE_ID;
		let idx = Math.max(0, branch.length - keep);
		// Never start at a tool result — it must stay attached to its tool call.
		while (idx < branch.length && !isValidCutPoint(branch[idx])) idx++;
		return idx < branch.length ? branch[idx].id : KEEP_NONE_ID;
	}

	function isValidCutPoint(entry: SessionEntry): boolean {
		if (entry.type === "message") return entry.message.role !== "toolResult";
		return entry.type === "custom" || entry.type === "branch_summary";
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		state = restoreState(ctx);
		console.error(
			`[contextRoller] loaded (summary: ${state.summaryText ? "restored" : "none"}, secondary model: ${config.model ?? "not configured"})`,
		);
		if (ctx.hasUI) {
			ctx.ui.setStatus("contextRoller", statusText());
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.model) return; // no secondary model configured — nothing to update
		const messages = [event.message, ...event.toolResults].filter(hasSubstance);
		if (messages.length === 0) return; // aborted/empty turn — nothing to record
		const delta = serializeConversation(convertToLlm(messages));
		if (!delta.trim()) return;
		queue.push({ text: delta, entryId: ctx.sessionManager.getLeafId() ?? "" });
		while (queue.length > MAX_QUEUE) queue.shift();
		startPump(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const instructions = event.customInstructions?.trim() ?? "";

		// "/compact native …" → let pi run its built-in compaction (SPEC §5.3).
		if (instructions.toLowerCase().startsWith("native")) return undefined;

		// Nothing to inject yet → native fallback (NFR-4).
		if (!state.summaryText) return undefined;

		const branch = event.branchEntries;

		// Catch-up: entries the rolling summary doesn't cover yet (SPEC §5.2/§5.3).
		let coveredIdx = state.lastCoveredEntryId
			? branch.findIndex((e) => e.id === state.lastCoveredEntryId)
			: -1;
		if (coveredIdx < 0) {
			// Coverage invalid (e.g. /tree navigation): catch up from the latest compaction boundary.
			for (let i = branch.length - 1; i >= 0; i--) {
				if (branch[i].type === "compaction") {
					coveredIdx = i;
					break;
				}
			}
		}
		const tail = branch.slice(coveredIdx + 1);
		const uncovered = tail.flatMap((e) => (e.type === "message" ? [e.message] : []));
		const substantive = uncovered.filter(hasSubstance);
		if (substantive.length > 0) {
			const delta = serializeConversation(convertToLlm(substantive));
			const lastMessageEntry = [...tail].reverse().find((e) => e.type === "message");
			console.error(`[contextRoller] compaction catch-up: ${substantive.length} uncovered entries`);
			const ok = await runSummaryUpdate(ctx, { text: delta, entryId: lastMessageEntry?.id ?? "" }, event.signal);
			if (!ok) return undefined; // NFR-4: native fallback
		} else if (uncovered.length > 0) {
			// Only substance-less entries (e.g. aborted messages) — advance the coverage
			// marker without an LLM call so we don't re-check them next time.
			const lastMessageEntry = [...tail].reverse().find((e) => e.type === "message");
			if (lastMessageEntry?.id && lastMessageEntry.id !== state.lastCoveredEntryId) {
				state = { ...state, lastCoveredEntryId: lastMessageEntry.id };
				pi.appendEntry(STATE_ENTRY_TYPE, state);
			}
		}

		let summary = state.summaryText;

		// FR-7: handoff budget guarantee.
		if (config.maxSummaryTokens > 0 && estimateTextTokens(summary) > config.maxSummaryTokens) {
			await compressSummary(ctx, event.signal);
			summary = state.summaryText;
		}

		// "/compact <instructions>" → one extra pass applying the user's instructions (SPEC §5.3).
		if (instructions) {
			const model = resolveSecondaryModel(ctx);
			let applied = false;
			if (model) {
				try {
					console.error(`[contextRoller] applying /compact instructions: ${instructions}`);
					const response = await ctx.modelRegistry.complete(
						model,
						{
							systemPrompt:
								ROLLING_SUMMARY_PROMPT +
								budgetClause() +
								`\n\nAdditional user instruction for this compaction summary: ${instructions}\nApply the instruction to the document you output.`,
							messages: [
								{
									role: "user" as const,
									content: [
										{ type: "text" as const, text: `Current state:\n${summary}\n\nOutput the full updated document.` },
									],
									timestamp: Date.now(),
								},
							],
						},
						{ maxTokens: config.maxOutputTokens, cacheRetention: "none", sessionId: uuidv7(), signal: event.signal },
					);
					const text = extractText(response);
					if (text.trim()) {
						summary = text.trim();
						applied = true;
					}
				} catch (err) {
					console.error("[contextRoller] instruction pass failed:", err instanceof Error ? err.message : err);
				}
			}
			if (!applied) {
				ctx.ui.notify("contextRoller: could not apply /compact instructions; injecting plain summary", "warning");
			}
		}

		return {
			compaction: {
				summary,
				firstKeptEntryId: firstKeptEntryId(branch),
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// TODO(diary): flush the pending diary window — SPEC §5.7.
	});

	/**
	 * FR-7: scrollable Markdown viewer for the rolling summary with token count.
	 * Rendered as a centered overlay; the document is clipped to the viewport
	 * manually (main-screen mode renders components without the flex layout
	 * engine, so pi-tui's ScrollView would not get a viewport there).
	 */
	async function showSummaryViewer(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") return; // non-TUI callers keep the notify fallback
		await ctx.ui.custom(
			(tui, theme, _kb, done) => {
				const md = new Markdown(state.summaryText, 1, 0, getMarkdownTheme());
				const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				let scrollTop = 0;
				let docLines: string[] = [];
				let docWidth = 0;

				// Rows around the document: top border, title, meta line, hint line, bottom border.
				const CHROME_ROWS = 5;
				const MARGIN = 2; // must match overlayOptions.margin below
				const viewportRows = () => Math.max(4, tui.terminal.rows - 2 * MARGIN - CHROME_ROWS);

				const renderDoc = (width: number): string[] => {
					const inner = Math.max(10, width - 2); // one padding column per side inside the border
					if (inner !== docWidth) {
						docLines = md.render(inner);
						docWidth = inner;
					}
					const viewH = viewportRows();
					scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, docLines.length - viewH)));
					return docLines.slice(scrollTop, scrollTop + viewH);
				};

				const meta = [
					`~${estimateTextTokens(state.summaryText)} tokens`,
					config.maxSummaryTokens > 0 ? `budget ${config.maxSummaryTokens}` : undefined,
					state.updatedAt ? `updated ${new Date(state.updatedAt).toLocaleTimeString()}` : undefined,
				]
					.filter((part): part is string => part !== undefined)
					.join(" · ");

				return {
					render: (width: number) => [
						...topBorder.render(width),
						` ${theme.fg("accent", theme.bold("contextRoller — rolling summary"))}`,
						` ${theme.fg("dim", meta)}`,
						...renderDoc(width),
						` ${theme.fg("dim", "↑↓ scroll · PgUp/PgDn page · Home/End jump · q/Enter/Esc close")}`,
						...bottomBorder.render(width),
					],
					invalidate: () => {
						docWidth = 0; // force the document to re-render on the next frame
					},
					handleInput: (data: string) => {
						if (matchesKey(data, "q") || matchesKey(data, "enter") || matchesKey(data, "escape")) {
							done(undefined);
							return;
						}
						const page = Math.max(3, viewportRows() - 2);
						if (matchesKey(data, "up")) scrollTop = Math.max(0, scrollTop - 1);
						else if (matchesKey(data, "down")) scrollTop += 1; // clamped in renderDoc
						else if (matchesKey(data, "pageup")) scrollTop = Math.max(0, scrollTop - page);
						else if (matchesKey(data, "pagedown")) scrollTop += page;
						else if (matchesKey(data, "home")) scrollTop = 0;
						else if (matchesKey(data, "end")) scrollTop = Number.MAX_SAFE_INTEGER; // clamped in renderDoc
						else return;
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", margin: 2, width: "90%" } },
		);
	}

	pi.registerCommand("contextRoller", {
		description: "Manage rolling context summary + diary (model | now | show | diary [now])",
		handler: async (args, ctx) => {
			const [sub, arg] = (args ?? "").trim().split(/\s+/);
			switch (sub) {
				case undefined:
				case "":
					ctx.ui.notify(statusText(), "info");
					break;
				case "model":
					// TODO(command): fuzzy picker over ctx.modelRegistry.getAvailable() — SPEC §5.4.
					ctx.ui.notify("not implemented yet (TODO: fuzzy model picker)", "warning");
					break;
				case "now": {
					if (activePump) await activePump;
					startPump(ctx);
					if (activePump) await activePump;
					ctx.ui.notify(statusText(), "info");
					break;
				}
				case "show": {
					if (!state.summaryText) {
						ctx.ui.notify("contextRoller: no summary yet", "info");
						break;
					}
					if (ctx.mode !== "tui") {
						// Non-TUI modes (e.g. RPC): plain text, token count on the first line.
						ctx.ui.notify(`~${estimateTextTokens(state.summaryText)} tokens\n${state.summaryText}`, "info");
						break;
					}
					await showSummaryViewer(ctx);
					break;
				}
				case "diary":
					// TODO(diary): show today's diary tail / flush now — SPEC §5.7.
					ctx.ui.notify(
						arg === "now" ? "not implemented yet (TODO: diary flush)" : "not implemented yet (TODO: project diary)",
						"warning",
					);
					break;
				default:
					ctx.ui.notify("Usage: /contextRoller [model | now | show | diary [now]]", "error");
			}
		},
	});
}
