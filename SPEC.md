# Technical Specification: Rolling Context Extension for Pi.dev

**Document Status:** Design — API verified against `@earendil-works/pi-coding-agent` v0.84.3
**Target Platform:** Pi extension system (`~/.pi/agent/extensions/` or `.pi/extensions/`)
**Working name:** `contextRoller`

---

## 1. Problem Statement

When working in long-running development sessions with large-context models (e.g., 220k tokens), token utilization eventually reaches capacity. At this point, the standard compaction mechanism triggers a monolithic summarization pass.

This process introduces two major friction points:

* **High Latency:** Processing and summarizing ~200k tokens using the primary (large) model takes up to 5 minutes, severely interrupting the active workflow.
* **High Initial Load:** After compaction, the session restarts at ~20% token usage due to the sheer size of the newly generated summary and lingering context (default `keepRecentTokens` is 20k), leading to shorter intervals between compaction cycles.

---

## 2. Proposed Architecture

Instead of performing a reactive, heavy summarization pass when the context limit is reached, an extension maintains an **incremental rolling summary** asynchronously in the background using a secondary model selected from pi's own model catalog. When compaction triggers, the extension intercepts it and supplies the precomputed summary — no new session, no heavy LLM call.

The same per-turn delta stream feeds a second consumer: an automatic **project diary** (§5.7) that records what was worked on when — including dead ends the rolling summary deliberately overwrites.

```
[ Active Dev Session ] ──(turn_end)──> [ Background Worker (FIFO queue) ]
         │                                    │
         │                                    ▼  delta updates via
         │                              ctx.modelRegistry.complete(secondaryModel, …)
         │                                    │
         │                                    ▼
         │                          [ Rolling Summary State ] ──persisted via pi.appendEntry()
         │                                    ▲
[ session_before_compact ] ──(catch-up update for uncovered entries, if any)──┘
         │
         ▼
[ return { compaction: { summary, firstKeptEntryId, tokensBefore } } ]
   → pi replaces the heavy summarization pass with our precomputed summary
   → same session file; post-compaction context = system prompt + summary (+ kept entries)
```

### Core Mechanisms

1. **Asynchronous Incremental Updates:** After each turn (`turn_end` event: assistant message + tool results), the delta is serialized and enqueued. A sequential worker updates the structured state document via `ctx.modelRegistry.complete(secondaryModel, …)` — pi's standard one-shot completion path (the same mechanism pi itself uses for compaction summaries). No hand-rolled HTTP client; provider/auth/streaming are all reused from pi.
2. **Compaction Interception:** On `session_before_compact`, the extension returns a custom compaction object containing the precomputed rolling summary. In the common case this is zero-latency (no LLM call); if the summary lags behind recent turns, one fast catch-up call to the secondary model covers the gap.
3. **No Session Handover Needed:** The conceptual "create fresh session + inject state" step is unnecessary and not implementable as drafted (see §4): pi natively supports custom compaction, which achieves the same end state — context reduced to system prompt + summary — within the same session file. With a keep policy of zero retained entries, post-compaction footprint is just system prompt + rolling summary (NFR-3).

---

## 3. Requirements

### Functional Requirements

* **FR-1:** Listen to post-turn events without blocking the user interface or main inference loop.
* **FR-2:** Maintain a structured, markdown-formatted working memory document containing:
  * Overarching goals / objectives
  * Key architectural decisions
  * Modified files & active code regions
  * Pending tasks & open issues

  The format aligns with pi's native compaction summary format (`## Goal`, `## Constraints & Preferences`, `## Progress`, `## Key Decisions`, `## Next Steps`, `## Critical Context`, `<read-files>`, `<modified-files>`) so post-handover behavior matches native compaction.
* **FR-3:** Intercept the native Pi context compaction lifecycle event (`session_before_compact`) and supply the precomputed summary as a custom compaction.
* **FR-4:** On context saturation, reduce the active context to system prompt + rolling summary (+ configurable kept entries) — no session replacement.
* **FR-5:** Provide a `/contextRoller` command to select the secondary model via a fuzzy-search picker over pi's live model registry, without changing the session's active (main) model. Persist the selection.
* **FR-6:** Maintain an append-only project diary: in activity windows (default 15 minutes), summarize what was worked on, what was completed, and what was tried and discarded (with reasons) — generated from the raw turn deltas, not from the rolling summary. Entries carry date + timestamps; files are per-day, per-user at `<project>/diary/<YYYY-MM-DD>-<user>.md`, plain markdown, committed via the user's normal git workflow (no auto-commit). Diary content never enters LLM context.
* **FR-7:** The maximum size of the rolling summary is user-configurable in tokens (`maxSummaryTokens`, default 4096; `0` disables the budget). Enforcement: the budget is stated in the secondary model's prompt; after each update, if the estimated token count exceeds the budget, one compression call to the secondary model regenerates a fitting document (same structure); at compaction handoff, an over-budget summary is compressed once, falling back to using it as-is on failure (never block the session — NFR-4).

### Non-Functional Requirements

* **NFR-1:** Zero impact on primary LLM response time (background worker must run asynchronously).
* **NFR-2:** Low resource footprint (secondary model inference should be fast and lightweight — typically a local 3B–8B model, but any catalog model works).
* **NFR-3:** Post-compaction context footprint should stay below 5% of maximum capacity (system prompt + rolling summary only, by default).
* **NFR-4:** Fallback safety: if no summary exists yet or the secondary model is unreachable, the extension returns `undefined` from `session_before_compact`, letting pi run its native compaction. The extension must never wedge the session.
* **NFR-5:** The main conversation model is never modified (`pi.setModel()` is never called).

---

## 4. Verified API Mapping (pi 0.84.3)

The original conceptual draft (§7 of the v0 spec) assumed hook names and APIs that do not exist. Verified against the installed package (docs, `dist/` type definitions, and implementation source):

| Conceptual draft | Verified reality |
|---|---|
| `pi.on("message_end")` for post-turn updates | Exists, but fires per message (user/assistant/toolResult). Use **`turn_end`** instead: `{ turnIndex, message, toolResults }` — one clean delta per assistant turn including tool results. |
| `event.preventDefault()` to cancel compaction | Does not exist. Handlers **return** `{ cancel: true }` or a result object. |
| `pi.on("session_before_tree")` to intercept compaction | Wrong event — that is `/tree` navigation. Compaction is **`session_before_compact`**, carrying `preparation` (messages, cut point, tokens), `reason: "manual" \| "threshold" \| "overflow"`, `willRetry`, and an `AbortSignal`. |
| `pi.sessions.create()` / `pi.sessions.switch()` | **Do not exist.** Session replacement (`ctx.newSession()`) is only available in *command* handlers — deliberately unavailable from event handlers (deadlock risk). Unneeded anyway: custom compaction achieves the same end state. |
| Raw `fetch("http://localhost:1234/v1/chat/completions")` | Use **`ctx.modelRegistry.complete(model, { systemPrompt, messages }, options)`** — a stateless one-shot completion on the session's live registry with full provider/auth machinery (same path as built-in compaction and the `handoff.ts` example). Returns `AssistantMessage` incl. `usage`. |
| In-memory `let state` only | Persist via **`pi.appendEntry("rolling-summary", data)`** (custom entries do not enter LLM context) and reconstruct on `session_start`. |

### Key verified facts (with source references)

1. **Custom compaction results are used as-is.** `agent-session.js` (`compact()` / auto-compaction path): if the `session_before_compact` handler returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }`, pi appends that `CompactionEntry` directly — no re-validation of `firstKeptEntryId`.
2. **Any `firstKeptEntryId` is valid.** `session-manager.js` (`buildContextEntries()`): walks the branch path and keeps entries from the one matching `firstKeptEntryId`; if nothing matches, *nothing* before the compaction entry is kept. → Post-compaction context = system prompt + summary only.
3. **Returning `undefined` falls back to native compaction** (verified pattern in `examples/extensions/custom-compaction.ts`, which returns `undefined` on error).
4. **`getAvailable()` = models whose provider has configured auth** (`model-runtime.js`: `all.filter(m => configuredProviders.has(m.provider))`) — exactly the set `/model` presents as selectable.
5. **The `/model` fuzzy search is `fuzzyFilter`**, exported publicly from `@earendil-works/pi-tui` (used at `model-selector.js:229`). Subsequence matching, whitespace/slash-separated tokens, best-match-first.
6. **`ModelSelectorComponent` (the real `/model` picker) requires a `ModelRuntime` instance** that `ctx` does not expose. Creating a second runtime via `ModelRuntime.create()` loads the same `models.json` + auth store but diverges from the session's live registry (extension-registered providers, mid-session `/login` state). Shimming a fake runtime into the component is fragile (it also hands the runtime to `refreshModelCatalogs()` internally). → **Build a small custom picker** from public building blocks: `Input` + `SelectList` + `fuzzyFilter`, fed by `ctx.modelRegistry.getAvailable()`.
7. **`pi.setModel(model)` is the only main-model switch.** The picker's `onSelect` callback saves to config and never calls it; completion goes through `modelRegistry.complete()`, which changes no session state.
8. **Local servers are first-class via `models.json`** (Ollama, LM Studio, llama.cpp, vLLM as OpenAI-compatible providers) — see §6. No custom HTTP client needed.

---

## 5. Component Design (v1)

### 5.1 Background worker

* Hook: `pi.on("turn_end", …)` → serialize the delta (`message` + `toolResults`) with exported `serializeConversation(convertToLlm(…))`.
* Deltas are appended to a FIFO queue; a single sequential worker processes them (the draft's mutex idea, generalized so updates are never dropped or interleaved).
* Each item: `ctx.modelRegistry.complete(secondaryModel, { systemPrompt: ROLLING_SUMMARY_PROMPT, messages: [{ role: "user", content: "Current state:\n…\n\nLatest interaction:\n…" }] }, { maxTokens, signal?, cacheRetention: "none", sessionId: uuidv7() })`.
* On success: update `state.summaryText`, advance coverage marker (see 5.2), persist via `pi.appendEntry`, refresh footer status.
* Budget enforcement (FR-7): the prompt states the configured token budget; after each successful update, if `estimateTokens(summaryText)` (exported from pi) exceeds it, one additional compression call to the secondary model regenerates a fitting document. Compression failure keeps the current summary.
* On failure: keep previous summary, log + throttled notify; next turn retries naturally.

### 5.2 State & persistence

```ts
interface RollingSummaryState {
  summaryText: string;          // structured markdown (FR-2 format)
  lastCoveredEntryId: string | null;  // session entry id up to which the summary is current
  updatedAt: number;
}
```

* Persist after each successful update: `pi.appendEntry("rolling-summary", state)` (TUI-only, not sent to LLM).
* Reconstruct on `session_start` by scanning branch entries for the latest `rolling-summary` custom entry.
* Coverage: at compaction time, `event.branchEntries` gives the current branch path; entries after `lastCoveredEntryId` are "uncovered" → serialized as the catch-up delta (5.3). If the branch no longer contains `lastCoveredEntryId` (e.g., `/tree` navigation), coverage is invalid → full catch-up from the latest compaction boundary (rare; one local-model call).

### 5.3 Compaction interception

```ts
pi.on("session_before_compact", async (event, ctx) => {
  if (!state.summaryText) return;                    // NFR-4: native fallback
  const uncovered = entriesAfter(event.branchEntries, state.lastCoveredEntryId);
  if (uncovered.length > 0) {
    try {
      await updateSummaryWith(uncovered, event.signal);   // one fast local-model call
    } catch { return; }                                  // NFR-4: native fallback
  }
  return {
    compaction: {
      summary: state.summaryText,
      firstKeptEntryId: keepPolicy(event.branchEntries),  // default: keep nothing
      tokensBefore: event.preparation.tokensBefore,
    },
  };
});
```

* Keep policy: config `keepLastEntries` (default `0`). `0` → a non-matching id (keeps nothing); `n > 0` → id of the branch entry `n` positions before the end. Rationale for default 0: the rolling summary is designed to stand alone; keeping 20k tokens would reintroduce the "high initial load" problem (NFR-3).
* Works for all three reasons (`manual`, `threshold`, `overflow`); on overflow with `willRetry`, the retried turn runs against system prompt + summary.
* Budget guarantee (FR-7): if the summary still exceeds `maxSummaryTokens` at handoff, one compression call with `event.signal`; on failure the summary is used as-is (NFR-4).

### 5.4 `/contextRoller` command

| Invocation | Action |
|---|---|
| `/contextRoller` | Status: secondary model, last update time, queue depth, summary size |
| `/contextRoller model` | Fuzzy picker (below) → persist `provider/modelId` to config |
| `/contextRoller now` | Force an immediate catch-up update |
| `/contextRoller show` | Open the current rolling summary in a scrollable Markdown viewer, with token estimate vs budget and last-update time |
| `/contextRoller diary` | Show the tail of today's diary file |
| `/contextRoller diary now` | Flush the current diary window immediately |

**Fuzzy picker** (`/contextRoller model`): custom TUI component via `ctx.ui.custom()` built from public pi-tui exports — `Input` (search box, focused first) + `SelectList`, filtered with `fuzzyFilter(models, query, m => \`${m.provider}/${m.id}\`)`. Data source: `ctx.modelRegistry.getAvailable()` (live session registry → full parity with `/model`). Enter selects, Esc cancels. The selected model is resolved later via `ctx.modelRegistry.find(provider, id)`; unresolvable at `session_start` → notify + native-compaction fallback.

**Show viewer** (`/contextRoller show`): `ctx.ui.custom()` with a Markdown component plus a header line (token estimate vs budget, last update time); Esc closes. Non-TUI modes fall back to plain-text output.

### 5.5 Configuration

`.pi/contextRoller.json` (project) with `~/.pi/agent/contextRoller.json` (global) fallback:

```json
{
  "model": "ollama/qwen2.5-3b-instruct",
  "keepLastEntries": 0,
  "maxOutputTokens": 2048,
  "maxSummaryTokens": 4096,
  "diary": { "enabled": true, "intervalMinutes": 15, "dir": "diary" }
}
```

### 5.6 UX

* Footer status via `ctx.ui.setStatus("contextRoller", …)`: idle / updating / last update time.
* `ctx.ui.notify` on compaction handoff ("Context rolled: summary injected, N tokens before → M after") and on fallback to native compaction (warning).

### 5.7 Project Diary (Use Case 2)

**Rationale.** The rolling summary is *convergent* memory: it must overwrite dead ends, otherwise it pollutes the context with things that no longer exist. The diary is *divergent* (episodic) memory: append-only, never overwritten. "We tried X and discarded it because Y" is useless for continuing to code — but valuable for not repeating mistakes and for later understanding why we are at approach Z. Both consumers read the same `turn_end` delta stream through the same sequential worker.

**Windowing & flush triggers.** Deltas since the last diary entry accumulate in a buffer. A window is flushed (one secondary-model call → one entry) when any of:

* the window is ≥ `diary.intervalMinutes` old (default 15) *and* contains new content — checked on each `turn_end` (no persistent timer needed);
* `session_shutdown` / reload fires (nothing is lost);
* a compaction rollover occurs (the diary then also records the context rollover);
* manually via `/contextRoller diary now`.

Known limitation: flushes happen at turn boundaries — a 40-minute build delays its entry until it completes.

**Source of truth.** Entries are generated from the *raw accumulated deltas* of the window, **not** from the rolling summary — the summary has already dropped the discarded approaches. The prompt explicitly asks for: what was worked on, what was completed, **what was tried and why it was abandoned**, state at end of window.

**Entry format.**

```markdown
## 2026-02-14 14:35–14:52 (hauke)
- Worked on: …
- Done: …
- Tried & discarded: Y (reason: …)
- State: …
```

**File layout.** One file per day per user at the project root, parallel to `.pi/` / `.git`:

```
<project>/diary/2026-02-14-hauke.md
<project>/diary/2026-02-14-lena.md
<project>/diary/2026-02-15-hauke.md
```

Date-first so files sort chronologically; multiple users cluster within a day. (Username-first naming is a one-line change if preferred.)

**User identity.** `git config user.name`, sanitized to be filesystem-safe (lowercase, spaces → `-`) — ties diary entries to the same identity as commit history. Fallback: OS username when not in a git repo or git user is unset.

**Concurrency & git.** Multiple sessions of the same user append to the same file (O_APPEND with small writes — safe in practice); per-user files avoid cross-user write collisions and git merge conflicts entirely. Files are plain markdown for the user's normal git workflow — **no auto-commit** by the extension. Diary content never enters LLM context.

---

## 6. Secondary Model Registration (local servers)

Register once in `~/.pi/agent/models.json`; the model then appears in the `/contextRoller model` picker like any other. Example (Ollama, from pi docs):

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        { "id": "qwen2.5-3b-instruct" },
        { "id": "llama3.1:8b" }
      ]
    }
  }
}
```

LM Studio / llama.cpp / vLLM use the same shape with their own `baseUrl`. The secondary model does not have to be local — any catalog model (e.g., a cheap cloud model) works through the identical path.

---

## 7. Implementation Sketch

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { Container, Input, SelectList, Text, Spacer, fuzzyFilter } from "@earendil-works/pi-tui";

const ROLLING_SUMMARY_PROMPT = `You are a state tracking assistant. Maintain the working-memory
document below, updated with the latest interaction. Keep it concise and structured:
## Goal / ## Constraints & Preferences / ## Progress (Done/In Progress/Blocked) /
## Key Decisions / ## Next Steps / ## Critical Context / <read-files> / <modified-files>`;

export default function (pi: ExtensionAPI) {
  let state = { summaryText: "", lastCoveredEntryId: null as string | null, updatedAt: 0 };
  let queue: Array<{ text: string; entryId: string }> = [];
  let working = false;

  // FR-1 / NFR-1: non-blocking per-turn deltas
  pi.on("turn_end", async (event, ctx) => {
    const delta = serializeConversation(
      convertToLlm([event.message, ...event.toolResults]),
    );
    queue.push({ text: delta, entryId: ctx.sessionManager.getLeafId() ?? "" });
    void pump(ctx); // fire-and-forget; never blocks the agent loop
  });

  async function pump(ctx: any) {
    if (working) return;
    working = true;
    try {
      while (queue.length > 0) {
        const model = resolveSecondaryModel(ctx);
        if (!model) break; // NFR-4: nothing to do, retry next turn
        const item = queue.shift()!;
        ctx.ui.setStatus("contextRoller", "updating…");
        try {
          const response = await ctx.modelRegistry.complete(
            model,
            {
              systemPrompt: ROLLING_SUMMARY_PROMPT,
              messages: [{ role: "user", content: `Current state:\n${state.summaryText}\n\nLatest interaction:\n${item.text}` }],
            },
            { maxTokens: 2048, cacheRetention: "none", sessionId: uuidv7() },
          );
          const text = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          if (text.trim()) {
            state = { summaryText: text, lastCoveredEntryId: item.entryId, updatedAt: Date.now() };
            pi.appendEntry("rolling-summary", state);
          }
        } catch (err) {
          console.error("[contextRoller] update failed:", err); // keep old summary; next turn retries
        }
      }
    } finally {
      working = false;
      ctx.ui.setStatus("contextRoller", state.updatedAt ? `ok ${new Date(state.updatedAt).toLocaleTimeString()}` : undefined);
    }
  }

  // FR-3 / FR-4: intercept compaction, supply precomputed summary
  pi.on("session_before_compact", async (event, ctx) => {
    if (!state.summaryText) return; // NFR-4: native fallback
    const uncovered = event.branchEntries.filter(
      e => e.type === "message" && state.lastCoveredEntryId !== null && isAfter(event.branchEntries, e, state.lastCoveredEntryId),
    );
    if (uncovered.length > 0) {
      try {
        await updateSummaryWith(uncovered, event.signal, ctx); // one fast catch-up call
      } catch { return; } // NFR-4: native fallback
    }
    const keep = config.keepLastEntries ?? 0;
    return {
      compaction: {
        summary: state.summaryText,
        firstKeptEntryId: keep > 0 ? event.branchEntries[event.branchEntries.length - keep].id : "contextRoller-keep-none",
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  // FR-5: /contextRoller — status | model | now | show
  pi.registerCommand("contextRoller", {
    description: "Manage rolling context summary (model | now | show)",
    handler: async (args, ctx) => {
      if (args.startsWith("model")) {
        const models = ctx.modelRegistry.getAvailable(); // live registry → /model parity
        const chosen = await ctx.ui.custom<any | null>((tui, theme, _kb, done) => {
          const input = new Input();
          const list = new SelectList(fuzzyFilter(models, "", m => `${m.provider}/${m.id}`));
          // input.onInput → list.setItems(fuzzyFilter(models, input.getValue(), …))
          // list.onSelect → done(model); esc → done(null)
          const box = new Container();
          box.addChild(input); box.addChild(new Spacer(1)); box.addChild(list);
          return box;
        });
        if (chosen) saveConfig({ model: `${chosen.provider}/${chosen.id}` });
      } else if (args === "now") {
        await pump(ctx);
      } else if (args === "show") {
        ctx.ui.notify(state.summaryText || "(no summary yet)", "info");
      } else {
        ctx.ui.notify(statusLine(), "info");
      }
    },
  });

  // Reconstruct persisted state on (re)start
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type === "custom" && entry.customType === "rolling-summary") {
        state = { summaryText: "", lastCoveredEntryId: null, updatedAt: 0, ...entry.data };
        break;
      }
    }
  });
}
```

```ts
  // Use Case 2 (FR-6): project diary — second consumer of the same delta stream
  let diaryBuffer: string[] = [];
  let lastDiaryFlush = 0;

  function diaryFilePath(cwd: string): string {
    const user = gitUserName(cwd) ?? os.userInfo().username; // sanitized per §5.7
    const day = new Date().toISOString().slice(0, 10);
    return join(cwd, config.diary?.dir ?? "diary", `${day}-${user}.md`);
  }

  async function flushDiary(ctx: any, signal?: AbortSignal) {
    if (diaryBuffer.length === 0) return;
    const model = resolveSecondaryModel(ctx);
    if (!model) return; // retry on next trigger
    const windowText = diaryBuffer.join("\n\n");
    diaryBuffer = [];
    lastDiaryFlush = Date.now();
    const response = await ctx.modelRegistry.complete(model, {
      systemPrompt: "Write a concise project-diary entry (markdown) for this work window: worked on / done / tried & discarded (with reasons) / state. Start with '## <ISO date> <HH:MM>–<HH:MM> (<user>)'.",
      messages: [{ role: "user", content: windowText }],
    }, { maxTokens: 1024, signal, cacheRetention: "none", sessionId: uuidv7() });
    const entry = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    await appendFile(diaryFilePath(ctx.cwd), `\n${entry}\n`); // append-only, plain markdown
  }

  // in turn_end handler: diaryBuffer.push(delta);
  //   if (Date.now() - lastDiaryFlush >= intervalMs) void flushDiary(ctx);
  pi.on("session_shutdown", async (_e, ctx) => { await flushDiary(ctx); });
```

*(Sketch level: `pump`/`updateSummaryWith`/`isAfter`/config helpers omitted or elided. The picker wiring, queue details, and diary flush triggers are finalized during implementation.)*

---

## 8. Status

### Done

- [x] API verification against pi 0.84.3 (hook names, custom compaction semantics, model registry — see §4)
- [x] Use case 2 (project diary) specified (§5.7, FR-6)
- [x] Public GitHub repository, README, English-only documentation rule (AGENTS.md)
- [x] Extension scaffold (`index.ts`): config loading, state restore, hook stubs, `/contextRoller` command; loads cleanly via `pi -e ./index.ts`
- [x] Background worker: `turn_end` deltas, FIFO queue with sequential pump, persistence via `appendEntry`; verified end-to-end against a local model (Unsloth Studio) incl. restart round-trip (`summary: restored`)

### TODO
- [ ] Compaction interception: `session_before_compact` custom compaction; test all three reasons (`/compact`, threshold, overflow) and the native-fallback path (secondary model down)
- [ ] Token budget (FR-7): `maxSummaryTokens` config, prompt + per-update compression pass, handoff guarantee; upgrade `/contextRoller show` to a Markdown viewer with token count
- [ ] `/contextRoller` command: status | model (fuzzy picker over `getAvailable()`) | now | show; verify main model is untouched after selection
- [ ] Local server registration via `models.json`; end-to-end test: long session → compaction → context ≈ system prompt + summary
- [ ] Project diary: windowing, flush triggers, per-day/per-user files under `<project>/diary/`; verify entries survive restarts, capture discarded approaches, and never enter LLM context
