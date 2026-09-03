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

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import {
	CONFIG_DIR_NAME,
	convertToLlm,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	estimateTokens,
	getMarkdownTheme,
	getSelectListTheme,
	serializeConversation,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type AgentMessage, type AssistantMessage, type Model, uuidv7 } from "@earendil-works/pi-ai";
import { fuzzyFilter, Input, Markdown, matchesKey, SelectList } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Configuration (SPEC §5.5)
// ---------------------------------------------------------------------------

interface DiaryConfig {
	enabled: boolean;
	/** Safety net: force-flush a non-empty window older than this (minutes; 0 = judgment only). */
	maxWindowMinutes: number;
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
	diary: { enabled: true, maxWindowMinutes: 60, dir: "diary" },
};

/** Load config: global (~/.pi/agent) first, project (.pi/) overrides. */
function loadConfig(cwd: string): { config: ContextRollerConfig; modelSourcePath: string | null } {
	const candidates = [
		join(homedir(), CONFIG_DIR_NAME, "agent", "contextRoller.json"),
		join(cwd, CONFIG_DIR_NAME, "contextRoller.json"),
	];
	let merged: Record<string, unknown> = {};
	let modelSourcePath: string | null = null;
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (typeof parsed.model === "string") modelSourcePath = path; // last (most specific) wins
			merged = { ...merged, ...parsed };
		} catch (err) {
			console.error(`[contextRoller] failed to parse config ${path}:`, err);
		}
	}
	return {
		config: {
			...DEFAULT_CONFIG,
			...merged,
			diary: { ...DEFAULT_CONFIG.diary, ...(merged.diary as Partial<DiaryConfig> | undefined) },
		},
		modelSourcePath,
	};
}

/** Persist the selected secondary model back to its config file (project file if unset). */
function persistModel(cwd: string, sourcePath: string | null, model: string): void {
	const target = sourcePath ?? join(cwd, CONFIG_DIR_NAME, "contextRoller.json");
	try {
		let existing: Record<string, unknown> = {};
		if (existsSync(target)) {
			existing = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		}
		existing.model = model;
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify(existing, null, 2) + "\n");
	} catch (err) {
		console.error("[contextRoller] failed to persist model selection:", err);
	}
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

// ---------------------------------------------------------------------------
// Project diary (SPEC §5.7, FR-6)
// ---------------------------------------------------------------------------

const DIARY_STATE_ENTRY_TYPE = "diary-window";

interface DiaryWindowState {
	/** Epoch ms of the first delta in the current window (0 = empty window). */
	windowStartTs: number;
	/** Raw accumulated deltas since the last flush. */
	pendingDeltas: string;
	/** Session entry id up to which the diary is written/pending. */
	lastCoveredEntryId: string | null;
}

const EMPTY_DIARY_WINDOW: DiaryWindowState = { windowStartTs: 0, pendingDeltas: "", lastCoveredEntryId: null };

const DIARY_PROMPT = `You maintain a project work diary for a coding agent session. Based ONLY on the raw conversation excerpt provided by the user, write diary bullets in exactly this format (no header, no preamble):

- Worked on: <what was being worked on, naming files and approaches>
- Done: <concrete completed results; "nothing yet" if none>
- Tried & discarded: <approach> (reason: <why it was abandoned or failed>)
- State: <concise state at the end of the window: what is open, what comes next>

Rules:
- Include the "Tried & discarded" line only if something was actually tried and abandoned or failed; otherwise omit that line entirely.
- Be specific (file names, commands, error messages). The "Tried & discarded" line is the diary's unique value over a rolling summary — capture dead ends with reasons.
- Keep the whole entry under 20 lines. Output only the bullets.`;

let cachedDiaryUser: string | null = null;

/** Diary file user part: git user.name (sanitized), fallback OS username. */
function diaryUserName(cwd: string): string {
	if (cachedDiaryUser) return cachedDiaryUser;
	let name: string | undefined;
	try {
		name = execFileSync("git", ["config", "user.name"], { cwd, encoding: "utf8", timeout: 3000 }).trim();
	} catch {
		/* not a git repo or user unset — fall through */
	}
	if (!name) name = userInfo().username;
	cachedDiaryUser = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
	return cachedDiaryUser;
}

const localDate = (d: Date): string =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localTime = (d: Date): string => d.toTimeString().slice(0, 5);

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
</modified-files>

Diary judgment — final line of your response:
A project diary records meaningful events only. As the very last line of your response, output exactly one of these two markers:
- <diary>write</diary> — if the latest interaction contains a diary-worthy event: a task or milestone completed, an important decision made, an approach tried and discarded or failed, or a significant state change (including a note that the conversation context was compacted).
- <diary>skip</diary> — otherwise (incremental progress on ongoing work, plain questions and answers, small follow-ups). Skipped content is folded into the next diary entry.`;

/**
 * Extract the diary judgment marker from a model response (SPEC §5.7).
 * Last occurrence wins; missing/malformed markers default to skip.
 */
function parseDiaryMarker(raw: string): { text: string; diaryWrite: boolean } {
	let diaryWrite = false;
	const markerRe = /<diary>\s*(write|skip)\s*<\/diary>/gi;
	let m: RegExpExecArray | null;
	while ((m = markerRe.exec(raw)) !== null) diaryWrite = m[1].toLowerCase() === "write";
	return { text: raw.replace(/<diary>\s*\w+\s*<\/diary>\s*/g, "").trim(), diaryWrite };
}

/** Jobs processed sequentially by the pump (one secondary-model call each). */
type QueuedJob =
	| {
			kind: "summary";
			text: string;
			/** Session leaf id at enqueue time — becomes the coverage marker on success. */
			entryId: string;
	  }
	| {
			kind: "diary";
			/** Raw accumulated deltas of the window (SPEC §5.7: source of truth). */
			text: string;
			windowStartTs: number;
			flushTs: number;
			entryId: string;
	  };

/** Result of a summary job: success plus the diary judgment from the same call (SPEC §5.7). */
type SummaryResult = { ok: false } | { ok: true; diaryWrite: boolean };

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
	let modelSourcePath: string | null = null; // which config file provided `model` (for write-back)
	let state: RollingSummaryState = { ...EMPTY_STATE };
	let queue: QueuedJob[] = [];
	let activePump: Promise<void> | null = null;
	let diaryWindow: DiaryWindowState = { ...EMPTY_DIARY_WINDOW };

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
	): Promise<SummaryResult> {
		const model = resolveSecondaryModel(ctx);
		if (!model) return { ok: false };
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
			const { text, diaryWrite } = parseDiaryMarker(extractText(response));
			if (!text) return { ok: false };
			state = {
				summaryText: text,
				lastCoveredEntryId: delta.entryId || state.lastCoveredEntryId,
				updatedAt: Date.now(),
			};
			pi.appendEntry(STATE_ENTRY_TYPE, state);
			console.error(`[contextRoller] summary updated (${state.summaryText.length} chars)`);
			// FR-7: keep the document within budget.
			if (config.maxSummaryTokens > 0 && estimateTextTokens(state.summaryText) > config.maxSummaryTokens) {
				await compressSummary(ctx);
			}
			return { ok: true, diaryWrite };
		} catch (err) {
			console.error("[contextRoller] summary update failed:", err instanceof Error ? err.message : err);
			return { ok: false };
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

	/** Persist the diary window as a custom entry so it survives restarts. */
	function persistDiaryWindow(ctx: ExtensionContext): void {
		pi.appendEntry(DIARY_STATE_ENTRY_TYPE, diaryWindow);
	}

	/** Reconstruct the diary window from the latest persisted custom entry on the branch. */
	function restoreDiaryWindow(ctx: ExtensionContext): DiaryWindowState {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === DIARY_STATE_ENTRY_TYPE) {
				return { ...EMPTY_DIARY_WINDOW, ...(e.data as Partial<DiaryWindowState>) };
			}
		}
		return { ...EMPTY_DIARY_WINDOW };
	}

	/** Append one entry to <project>/<diary dir>/<YYYY-MM-DD>-<user>.md (no auto-commit). */
	function appendDiaryEntry(ctx: ExtensionContext, startTs: number, flushTs: number, bullets: string): void {
		const dir = join(ctx.cwd, config.diary.dir);
		const file = join(dir, `${localDate(new Date())}-${diaryUserName(ctx.cwd)}.md`);
		mkdirSync(dir, { recursive: true });
		// Zero-length window (baseline entry) → single time instead of a range.
		const timeRange = startTs === flushTs ? localTime(new Date(startTs)) : `${localTime(new Date(startTs))}–${localTime(new Date(flushTs))}`;
		const header = `## ${localDate(new Date(startTs))} ${timeRange} (${diaryUserName(ctx.cwd)})\n`;
		appendFileSync(file, `${header}${bullets.trim()}\n\n`);
	}

	/** One diary flush: secondary-model call over the raw window → append entry (SPEC §5.7). */
	async function runDiaryFlush(ctx: ExtensionContext, job: Extract<QueuedJob, { kind: "diary" }>): Promise<boolean> {
		const model = resolveSecondaryModel(ctx);
		if (!model) return false;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: DIARY_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `Conversation excerpt (window ${localDate(new Date(job.windowStartTs))} ${localTime(new Date(job.windowStartTs))}–${localTime(new Date(job.flushTs))}):\n${job.text}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: config.maxOutputTokens, cacheRetention: "none", sessionId: uuidv7() },
			);
			const bullets = extractText(response).trim();
			if (!bullets) return false;
			appendDiaryEntry(ctx, job.windowStartTs, job.flushTs, bullets);
			// Window is written — reset it (keep the coverage marker at the flushed position).
			diaryWindow = { windowStartTs: 0, pendingDeltas: "", lastCoveredEntryId: job.entryId || diaryWindow.lastCoveredEntryId };
			persistDiaryWindow(ctx);
			console.error("[contextRoller] diary entry written");
			return true;
		} catch (err) {
			console.error("[contextRoller] diary flush failed:", err instanceof Error ? err.message : err);
			return false;
		}
	}

	/**
	 * SPEC §5.7 baseline backfill: if today's diary file has no entries yet and this
	 * (resumed) session contains substantive content, offer to create a baseline entry
	 * from the existing session context. Deferred so pi's startup completes first.
	 */
	function offerDiaryBaseline(ctx: ExtensionContext): void {
		if (!config.diary.enabled || !config.model) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return; // no dialog outside TUI
		const file = join(ctx.cwd, config.diary.dir, `${localDate(new Date())}-${diaryUserName(ctx.cwd)}.md`);
		if (existsSync(file) && readFileSync(file, "utf8").trim()) return; // entries exist today
		const hasContent = ctx.sessionManager
			.getBranch()
			.flatMap((e) => (e.type === "message" ? [e.message] : []))
			.some(hasSubstance);
		if (!hasContent) return; // fresh session — nothing to backfill
		setImmediate(() => {
			void (async () => {
				const yes = await ctx.ui.confirm(
					"contextRoller — diary baseline",
					"No diary entry for today yet. Create a baseline entry from this session's existing context?\n(Exact timestamps of earlier work are unavailable.)",
				);
				if (yes) await runDiaryBaseline(ctx);
			})().catch((err) => console.error("[contextRoller] diary baseline offer failed:", err instanceof Error ? err.message : err));
		});
	}

	/** Write a baseline diary entry from the existing session context (SPEC §5.7). */
	async function runDiaryBaseline(ctx: ExtensionContext): Promise<void> {
		const model = resolveSecondaryModel(ctx);
		if (!model) return;
		// Source: the rolling summary when available (already condensed), else a capped
		// raw serialization of the branch (tail — most recent work).
		let source: string;
		if (state.summaryText) {
			source = `Rolling summary of this session:\n${state.summaryText}`;
			if (diaryWindow.pendingDeltas.trim()) {
				source += `\n\nRecent activity not yet in the summary:\n${diaryWindow.pendingDeltas}`;
			}
		} else {
			const substantive = ctx.sessionManager
				.getBranch()
				.flatMap((e) => (e.type === "message" ? [e.message] : []))
				.filter(hasSubstance);
			const raw = serializeConversation(convertToLlm(substantive));
			source = raw.length > 24_000 ? raw.slice(-24_000) : raw;
		}
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: DIARY_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `Baseline entry — session context (exact timestamps of earlier work are unavailable):\n${source}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: config.maxOutputTokens, cacheRetention: "none", sessionId: uuidv7() },
			);
			const bullets = extractText(response).trim();
			if (!bullets) throw new Error("empty response");
			appendDiaryEntry(ctx, Date.now(), Date.now(), bullets);
			console.error("[contextRoller] diary baseline written");
			ctx.ui.notify("contextRoller: diary baseline entry written", "info");
		} catch (err) {
			console.error("[contextRoller] diary baseline failed:", err instanceof Error ? err.message : err);
			ctx.ui.notify("contextRoller: baseline entry failed", "warning");
		}
	}

	/** Enqueue a diary flush for the current window (no-op when empty) and ensure the pump runs. */
	function flushDiaryWindow(ctx: ExtensionContext): void {
		if (!diaryWindow.pendingDeltas.trim()) return;
		queue.push({
			kind: "diary",
			text: diaryWindow.pendingDeltas,
			windowStartTs: diaryWindow.windowStartTs || Date.now(),
			flushTs: Date.now(),
			entryId: diaryWindow.lastCoveredEntryId ?? "",
		});
		startPump(ctx);
	}

	async function doPump(ctx: ExtensionContext): Promise<void> {
		while (queue.length > 0) {
			if (!resolveSecondaryModel(ctx)) break; // unresolvable ref — retry once config/model changes
			const item = queue.shift()!;
			if (ctx.hasUI) ctx.ui.setStatus("contextRoller", "updating…");
			if (item.kind === "summary") {
				const res = await runSummaryUpdate(ctx, item);
				if (!res.ok) {
					queue.unshift(item); // retry on the next turn
					break;
				}
				// Diary judgment from the same call (SPEC §5.7): when the model judged the
				// turn diary-worthy, format + append the pending window (one extra call).
				if (res.diaryWrite && config.diary.enabled && diaryWindow.pendingDeltas.trim()) {
					const djob: QueuedJob = {
						kind: "diary",
						text: diaryWindow.pendingDeltas,
						windowStartTs: diaryWindow.windowStartTs || Date.now(),
						flushTs: Date.now(),
						entryId: diaryWindow.lastCoveredEntryId ?? "",
					};
					if (!(await runDiaryFlush(ctx, djob))) {
						queue.unshift(djob); // retry the diary job on the next pump cycle
						break;
					}
					}
			} else {
				const ok = await runDiaryFlush(ctx, item);
				if (!ok) {
					queue.unshift(item); // retry on the next turn
					break;
				}
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
		const loaded = loadConfig(ctx.cwd);
		config = loaded.config;
		modelSourcePath = loaded.modelSourcePath;
		state = restoreState(ctx);
		diaryWindow = restoreDiaryWindow(ctx);
		console.error(
			`[contextRoller] loaded (summary: ${state.summaryText ? "restored" : "none"}, secondary model: ${config.model ?? "not configured"}, diary window: ${diaryWindow.pendingDeltas.trim() ? "pending" : "empty"})`,
		);
		if (ctx.hasUI) {
			ctx.ui.setStatus("contextRoller", statusText());
			if (!config.model) {
				// No secondary model configured (global or project) — the extension stays
				// inactive; tell the user once per session how to fix it.
				ctx.ui.notify("contextRoller: no secondary model configured — run /contextRoller model to pick one", "warning");
			}
		}
		offerDiaryBaseline(ctx); // SPEC §5.7: baseline backfill offer (TUI only, deferred)
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.model) return; // no secondary model configured — nothing to update
		const messages = [event.message, ...event.toolResults].filter(hasSubstance);
		if (messages.length === 0) return; // aborted/empty turn — nothing to record
		const delta = serializeConversation(convertToLlm(messages));
		if (!delta.trim()) return;
		const leafId = ctx.sessionManager.getLeafId() ?? "";
		queue.push({ kind: "summary", text: delta, entryId: leafId });

		// Use Case 2 (FR-6): the same raw delta feeds the diary window (SPEC §5.7).
		if (config.diary.enabled) {
			diaryWindow.pendingDeltas += `\n${delta}`;
			if (!diaryWindow.windowStartTs) diaryWindow.windowStartTs = Date.now();
			diaryWindow.lastCoveredEntryId = leafId || diaryWindow.lastCoveredEntryId;
			persistDiaryWindow(ctx);
			const ageMs = Date.now() - diaryWindow.windowStartTs;
			// Safety net only (SPEC §5.7): bounds window growth when nothing diary-worthy happens.
			if (config.diary.maxWindowMinutes > 0 && ageMs >= config.diary.maxWindowMinutes * 60_000) flushDiaryWindow(ctx);
		}

		while (queue.length > MAX_QUEUE) queue.shift();
		startPump(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const instructions = event.customInstructions?.trim() ?? "";

		// Diary: mark the rollover in the pending window (SPEC §5.7). No forced flush —
		// entries are written when the model judges something diary-worthy happened; the
		// note (kept even in a previously empty window) makes sure the next entry that
		// covers this point mentions the rollover.
		if (config.diary.enabled && config.model) {
			diaryWindow.pendingDeltas += `\n[Note: pi rolled over (compacted) the conversation context at this point.]`;
			if (!diaryWindow.windowStartTs) diaryWindow.windowStartTs = Date.now();
			persistDiaryWindow(ctx);
		}

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
			const res = await runSummaryUpdate(ctx, { text: delta, entryId: lastMessageEntry?.id ?? "" }, event.signal);
			if (!res.ok) return undefined; // NFR-4: native fallback
			// Diary judgment at rollover (SPEC §5.7): the window carries the rollover note.
			if (res.diaryWrite && config.diary.enabled && diaryWindow.pendingDeltas.trim()) {
				flushDiaryWindow(ctx);
				if (activePump) await activePump;
			}
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
					// Strip the diary marker — this pass must output only the document.
					const text = parseDiaryMarker(extractText(response)).text;
					if (text) {
						summary = text;
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

	pi.on("session_shutdown", async (_event, ctx) => {
		// Diary: flush the pending window so nothing is lost (SPEC §5.7).
		if (config.diary.enabled && config.model && diaryWindow.pendingDeltas.trim()) {
			flushDiaryWindow(ctx);
			if (activePump) await activePump;
		}
	});

	/**
	 * SPEC §5.4: fuzzy picker over the live model registry (full /model parity via
	 * getAvailable()). Selection updates config.model and persists it to the config
	 * file; the main conversation model is never touched.
	 */
	async function showModelPicker(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") return; // non-TUI callers keep the notify fallback
		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			ctx.ui.notify("contextRoller: no models available in registry", "warning");
			return;
		}

		let picked: string | undefined;
		await ctx.ui.custom((tui, theme, _kb, done) => {
			const input = new Input();
			let lastQuery = "";

			const buildList = (query: string): SelectList => {
				const filtered = fuzzyFilter(models, query, (m) => `${m.provider}/${m.id} ${m.name}`);
				const items = filtered.map((m) => {
					const ref = `${m.provider}/${m.id}`;
					// Provider goes into the description: display names are not unique
					// across providers (e.g. anthropic and github-copilot both offer
					// "Claude Haiku 4.5 (latest)").
					const notes = [m.provider];
					if (ref === config.model) notes.push("current");
					if (!ctx.modelRegistry.hasConfiguredAuth(m)) notes.push("no auth");
					return { value: ref, label: m.name, description: notes.join(" · ") };
				});
				const list = new SelectList(items, 12, getSelectListTheme());
				list.onSelect = (item) => {
					picked = item.value;
					done(picked);
				};
				return list;
			};

			let list = buildList("");
			input.onEscape = () => done(undefined); // cancel — no change
			input.onSubmit = () => {
				const sel = list.getSelectedItem();
				if (sel) {
					picked = sel.value;
					done(picked);
				}
			};

			return {
				render: (width: number) => [
					` ${theme.fg("accent", theme.bold("contextRoller — secondary model"))}`,
					` ${theme.fg("dim", "type to filter · ↑↓ select · Enter confirm · Esc cancel")}`,
					...input.render(width),
					...list.render(width),
				],
				invalidate: () => {
					input.invalidate();
					list.invalidate();
				},
				handleInput: (data: string) => {
					if (matchesKey(data, "up") || matchesKey(data, "down")) {
						list.handleInput(data);
					} else {
						input.handleInput(data);
						const query = input.getValue();
						if (query !== lastQuery) {
							lastQuery = query;
							list = buildList(query); // fuzzyFilter; SelectList.setFilter is prefix-only
						}
					}
					tui.requestRender();
				},
			};
		});

		if (!picked) return; // cancelled
		config.model = picked;
		persistModel(ctx.cwd, modelSourcePath, picked);
		ctx.ui.notify(`contextRoller: secondary model → ${picked}`, "info");
	}

	/**
	 * FR-7: scrollable Markdown viewer for the rolling summary with token count.
	 * Rendered as a centered overlay; the document is clipped to the viewport
	 * manually (main-screen mode renders components without the flex layout
	 * engine, so pi-tui's ScrollView would not get a viewport there).
	 */
	async function showMarkdownOverlay(
		ctx: ExtensionCommandContext,
		title: string,
		metaParts: (string | undefined)[],
		docText: string,
	): Promise<void> {
		if (ctx.mode !== "tui") return; // non-TUI callers keep the notify fallback
		await ctx.ui.custom(
			(tui, theme, _kb, done) => {
				const md = new Markdown(docText, 1, 0, getMarkdownTheme());
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

				const meta = metaParts.filter((part): part is string => part !== undefined).join(" · ");

				return {
					render: (width: number) => [
						...topBorder.render(width),
						` ${theme.fg("accent", theme.bold(title))}`,
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

	/** FR-7: scrollable Markdown viewer for the rolling summary with token count. */
	async function showSummaryViewer(ctx: ExtensionCommandContext): Promise<void> {
		await showMarkdownOverlay(
			ctx,
			"contextRoller — rolling summary",
			[
				`~${estimateTextTokens(state.summaryText)} tokens`,
				config.maxSummaryTokens > 0 ? `budget ${config.maxSummaryTokens}` : undefined,
				state.updatedAt ? `updated ${new Date(state.updatedAt).toLocaleTimeString()}` : undefined,
			],
			state.summaryText,
		);
	}

	pi.registerCommand("contextRoller", {
		description: "Manage rolling context summary + diary (model | now | show | diary [now] | help)",
		handler: async (args, ctx) => {
			const [sub, arg] = (args ?? "").trim().split(/\s+/);
			switch (sub) {
				case undefined:
				case "":
					ctx.ui.notify(statusText(), "info");
					break;
				case "model":
					await showModelPicker(ctx);
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
				case "diary": {
					if (!config.diary.enabled) {
						ctx.ui.notify("contextRoller: diary is disabled in config", "warning");
						break;
					}
					if (arg === "now") {
						flushDiaryWindow(ctx);
						while (activePump) await activePump;
						const pending = diaryWindow.pendingDeltas.trim().length > 0;
						ctx.ui.notify(
							pending
								? "contextRoller: diary flush still pending (secondary model unavailable?)"
								: "contextRoller: diary flushed",
							pending ? "warning" : "info",
						);
						break;
					}
					const file = join(ctx.cwd, config.diary.dir, `${localDate(new Date())}-${diaryUserName(ctx.cwd)}.md`);
					if (!existsSync(file)) {
						ctx.ui.notify("contextRoller: no diary entries today yet", "info");
						break;
					}
					const content = readFileSync(file, "utf8").trim();
					if (ctx.mode !== "tui") {
						ctx.ui.notify(content, "info");
						break;
					}
					await showMarkdownOverlay(ctx, `contextRoller — diary ${localDate(new Date())}`, [file], content);
					break;
				}
				case "help": {
					const helpText = [
						"## Commands",
						"",
						"- **`/contextRoller`** — status: secondary model, summary size, last update",
						"- **`/contextRoller model`** — pick the secondary model (fuzzy search over pi's catalog)",
						"- **`/contextRoller now`** — force an immediate summary catch-up update",
						"- **`/contextRoller show`** — open the rolling summary in a scrollable viewer",
						"- **`/contextRoller diary`** — show today's diary entries",
						"- **`/contextRoller diary now`** — flush the current diary window immediately",
						"",
						"## How it works",
					"",
						"The secondary model updates the rolling summary after every turn; compaction then injects it instead of running a heavy native summarization pass. Diary entries are written when the model judges something meaningful happened (task completed, decision made, approach discarded) — boring turns fold into the next entry.",
						"",
						"Config: `.pi/contextRoller.json` (project) or `~/.pi/agent/contextRoller.json` (global). Diary files: `<project>/diary/<YYYY-MM-DD>-<user>.md`.",
					].join("\n");
					if (ctx.mode !== "tui") {
						ctx.ui.notify(helpText, "info");
						break;
					}
					await showMarkdownOverlay(ctx, "contextRoller — help", [], helpText);
					break;
				}
				default:
					ctx.ui.notify("Usage: /contextRoller [model | now | show | diary [now] | help]", "error");
			}
		},
	});
}
