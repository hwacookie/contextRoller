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
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { type Model, uuidv7 } from "@earendil-works/pi-ai";

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
	diary: DiaryConfig;
}

const DEFAULT_CONFIG: ContextRollerConfig = {
	keepLastEntries: 0,
	maxOutputTokens: 2048,
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
// Background worker (SPEC §5.1)
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

	/** Resolve the configured secondary model ("provider/modelId", first slash). */
	function resolveSecondaryModel(ctx: ExtensionContext): Model<any> | undefined {
		const ref = config.model;
		if (!ref) return undefined;
		const slash = ref.indexOf("/");
		if (slash <= 0 || slash === ref.length - 1) return undefined;
		return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
	}

	async function doPump(ctx: ExtensionContext): Promise<void> {
		while (queue.length > 0) {
			const model = resolveSecondaryModel(ctx);
			if (!model) break; // unresolvable ref — retry once config/model changes
			const item = queue.shift()!;
			if (ctx.hasUI) ctx.ui.setStatus("contextRoller", "updating…");
			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: ROLLING_SUMMARY_PROMPT,
						messages: [
							{
								role: "user" as const,
								content: [
									{
										type: "text" as const,
										text: `Current state:\n${state.summaryText || "(empty)"}\n\nLatest interaction:\n${item.text}`,
									},
								],
								timestamp: Date.now(),
							},
						],
					},
					{ maxTokens: config.maxOutputTokens, cacheRetention: "none", sessionId: uuidv7() },
				);
				const text = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (text.trim()) {
					state = {
						summaryText: text.trim(),
						lastCoveredEntryId: item.entryId || state.lastCoveredEntryId,
						updatedAt: Date.now(),
					};
					pi.appendEntry(STATE_ENTRY_TYPE, state);
					console.log(`[contextRoller] summary updated (${state.summaryText.length} chars)`);
				}
			} catch (err) {
				console.error("[contextRoller] background update failed:", err instanceof Error ? err.message : err);
				queue.unshift(item); // retry on the next turn
				break;
			}
		}
		if (ctx.hasUI) ctx.ui.setStatus("contextRoller", statusText());
	}

	function startPump(ctx: ExtensionContext): void {
		if (activePump) return;
		activePump = doPump(ctx).finally(() => {
			activePump = null;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		state = restoreState(ctx);
		console.log(
			`[contextRoller] loaded (summary: ${state.summaryText ? "restored" : "none"}, secondary model: ${config.model ?? "not configured"})`,
		);
		if (ctx.hasUI) {
			ctx.ui.setStatus("contextRoller", statusText());
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.model) return; // no secondary model configured — nothing to update
		const delta = serializeConversation(convertToLlm([event.message, ...event.toolResults]));
		if (!delta.trim()) return;
		queue.push({ text: delta, entryId: ctx.sessionManager.getLeafId() ?? "" });
		while (queue.length > MAX_QUEUE) queue.shift();
		startPump(ctx);
	});

	pi.on("session_before_compact", async (_event, _ctx) => {
		// TODO(compact): catch-up update for uncovered entries, then return the
		// custom compaction with state.summaryText — SPEC §5.3.
		// Until then: always fall back to native compaction (NFR-4).
		return undefined;
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// TODO(diary): flush the pending diary window — SPEC §5.7.
	});

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
				case "show":
					ctx.ui.notify(state.summaryText || "(no summary yet)", "info");
					break;
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
