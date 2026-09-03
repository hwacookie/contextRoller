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
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let config: ContextRollerConfig = DEFAULT_CONFIG;
	let state: RollingSummaryState = { ...EMPTY_STATE };
	// TODO(worker): FIFO delta queue + sequential pump (SPEC §5.1) — next TODO item.
	// TODO(diary): diary buffer + lastDiaryFlush (SPEC §5.7).

	function statusText(): string {
		const model = config.model ?? "not configured";
		const summary = state.summaryText ? `${state.summaryText.length} chars` : "none";
		const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "never";
		return `model: ${model} | summary: ${summary} | updated: ${updated}`;
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

	pi.on("turn_end", async (_event, _ctx) => {
		// TODO(worker): serialize the delta with
		// serializeConversation(convertToLlm([event.message, ...event.toolResults])),
		// push it to the queue, and pump via ctx.modelRegistry.complete(secondaryModel, ...) — SPEC §5.1.
		console.log("[contextRoller] turn_end (background worker not implemented yet)");
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
				case "now":
					// TODO(worker): force a catch-up update — SPEC §5.1/§5.3.
					ctx.ui.notify("not implemented yet (TODO: background worker)", "warning");
					break;
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
