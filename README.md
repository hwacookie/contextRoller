# contextRoller

A [pi](https://pi.dev) extension that keeps long coding sessions fast: it maintains a rolling project summary in the background with a small secondary model, and writes an automatic daily diary of what was worked on.

## Problem

Long-running sessions with large-context models eventually hit the context limit. Pi's built-in compaction then summarizes ~200k tokens with the main model — up to 5 minutes of blocked workflow — and restarts the session at ~20% token usage, shortening the next cycle.

## What it does

**1. Rolling context**

- After every turn, a lightweight secondary model (e.g. a local 3B–8B via Ollama/LM Studio) incrementally updates a structured summary: goals, key decisions, modified files, pending tasks.
- When compaction triggers, the extension intercepts it and injects the precomputed summary — no heavy summarization pass, near-zero latency.
- Post-compaction context is just system prompt + summary (configurable keep policy), so sessions roll over at a few percent of capacity instead of ~20%.
- The secondary model is picked with `/contextRoller model` (fuzzy picker over pi's model catalog) — the main conversation model is never touched.

**2. Project diary**

- Every ~15 minutes of activity, a short timestamped entry is appended to `diary/<YYYY-MM-DD>-<user>.md` in the project root: what was worked on, what was completed, and — unlike the rolling summary — what was *tried and discarded* (with reasons).
- Plain markdown, one file per day per user, meant to be committed with your normal git workflow.

## Commands

| Command | Action |
|---|---|
| `/contextRoller` | Status: secondary model, last update, summary size |
| `/contextRoller model` | Pick the secondary model (fuzzy search) |
| `/contextRoller now` | Force a summary catch-up update |
| `/contextRoller show` | Show the current rolling summary |
| `/contextRoller diary` | Show today's diary entries |
| `/contextRoller diary now` | Flush the current diary window immediately |

## Requirements

- pi (tested against 0.84.3)
- A secondary model in pi's catalog — any cloud model works; for local inference, register your server (Ollama, LM Studio, llama.cpp, vLLM) in `~/.pi/agent/models.json` (see [SPEC.md §6](SPEC.md))

## Status

Design complete — see [SPEC.md](SPEC.md). Implementation in progress.
