# @taylorsatula/pi-compaction

Mira-style coding checkpoint compaction for [Pi](https://pi.dev). Replaces Pi's default compaction with structured engineering handoff summaries that preserve concrete facts, decisions, code references, and artifact state — and gates the `request_compaction` tool on a session handoff document with optional post-compaction auto-resume.

## What it does

When Pi triggers context compaction (automatically or via `/compact`), this extension intercepts the event and produces a detailed recovery checkpoint instead of a brief summary. The checkpoint follows a strict section ownership model designed so another coding agent can resume work without replaying history.

Key differences from Pi's default compaction:

- **Model-selected cut point** — the summarizer chooses where to split retained verbatim context, aiming for a user message that gives the next agent a concrete task. Falls back to Pi's algorithm if the model's recommendation is invalid.
- **Full artifact tracking** — tracks read-only, modified, compacted, and retained file lists across three scopes (compacted range, retained range, all). Includes scoped git status and diff stat for session-touched paths only.
- **Structured sections** — STATE AT COMPACTION BOUNDARY, EVIDENCE TIERS, CODE REFERENCES, DECISIONS AND RATIONALE, COMMANDS TESTS AND FAILURES, WORK QUEUE, COMPACTED HISTORY SYNOPSIS. Each section owns distinct information; cross-references replace repetition.
- **Cut-point adjustment notes** — when the model's recommended cut point is capped or falls back, an explicit note is prepended explaining why and what was selected instead.
- **Iterative merging** — previous checkpoints are treated as frozen historical state and evolved with new history, not discarded.

## The request_compaction tool

The extension registers a `request_compaction` tool for the model to call at a milestone (feature shipped, tests green, bug fixed) or when context feels heavy. Compaction runs after the current turn finishes so the checkpoint captures a clean boundary.

The tool requires `handoff_url`: the path of a session handoff document, created beforehand with the `session-handoff` skill. The tool validates the path before queueing compaction:

- Omitted or empty `handoff_url` → error reply naming the skill and the retry shape: load the session-handoff skill, create a handoff, call again with its path.
- Path that is not an existing file → error reply naming the path; compaction is never queued against a missing document.

The path travels into the compaction event as the first line of the compaction instructions (`Session handoff document: <path>`), so the generated checkpoint references it deterministically: the summary's RECOVERY section and the structured compaction details both record it. A `/compact` invocation carrying the same line in its instructions gets the identical treatment.

## Post-compaction auto-resume

With the `--mirastyle-compaction-autocontinue` flag enabled, a compaction queued via `request_compaction` is followed by an injected user message so the agent self-orients and resumes instead of going idle:

> The context window has just been compacted. Please read \<handoff path\> and other related orientation documentation, then resume your work.

The message is sent after the compaction completes, starts a fresh agent run, and appears in the transcript as a user message. Auto-resume applies to compactions that carried a handoff reference; threshold and overflow compactions (which have none) are unaffected. If compaction fails or is cancelled, no message is injected.

Flag invocation caveat: Pi's generic argument parser treats the token after an extension flag as that flag's value. Put the flag after the prompt or use the `=true` form:

```bash
pi --mirastyle-compaction-autocontinue=true -p "your prompt"
pi -p "your prompt" --mirastyle-compaction-autocontinue
```

Note for one-shot modes: `pi -p` (print mode) returns as soon as the run settles and does not wait for a compaction queued during `agent_end`, so a request_compaction call at the end of a print-mode session will not complete. Auto-resume applies to interactive sessions.

## Installation

```bash
# Global
pi install npm:@taylorsatula/pi-compaction

# Project-local (shared with team via .pi/settings.json)
pi install -l npm:@taylorsatula/pi-compaction

# Temporary test
pi -e npm:@taylorsatula/pi-compaction
```

## Configuration

Three CLI flags control the extension:

| Flag | Description |
|------|-------------|
| `--mirastyle-compaction-provider` | Provider name for the summarizer, e.g. `anthropic` or `google`. Requires `--mirastyle-compaction-model`. |
| `--mirastyle-compaction-model` | Model ID for the summarizer, e.g. `claude-sonnet-4-20250514`. Requires `--mirastyle-compaction-provider`. |
| `--mirastyle-compaction-autocontinue` | Boolean. After a request_compaction compaction completes, inject a user message pointing at the handoff document so the agent self-orients and resumes. Default: off. |

If neither summarizer flag is set, or if the configured model is unavailable, the extension falls back to the currently active model. If no active model has auth, Pi's default compaction is used.

Example:

```bash
pi --mirastyle-compaction-provider anthropic --mirastyle-compaction-model claude-sonnet-4-20250514
```

Custom compaction instructions can be passed via Pi's standard mechanism:

```bash
pi --append-system-prompt "Focus on error handling changes"
```

Or via the `customInstructions` field in `ctx.compact()`.

## Checkpoint format

The output is wrapped in `<pi:mirastyle_compacted_coding_context>` tags with deterministic metadata (session file, handoff document when provided, first kept entry ID, token count, git state, artifact lists) followed by the model-generated body using the section ownership rules defined in the system prompt.

## Security

Like all Pi extensions, this runs with full system access. It executes git commands (`git rev-parse`, `git branch`, `git status --short`, `git diff --stat`) scoped to session-touched files only, and `fs.stat` on the handoff path passed to `request_compaction`. No files are written or modified beyond the compaction entry appended to the session file.
