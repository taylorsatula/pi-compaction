# @taylatsatula/pi-mirastyle-compaction

Mira-style coding checkpoint compaction for [Pi](https://pi.dev). Replaces Pi's default compaction with structured engineering handoff summaries that preserve concrete facts, decisions, code references, and artifact state.

## What it does

When Pi triggers context compaction (automatically or via `/compact`), this extension intercepts the event and produces a detailed recovery checkpoint instead of a brief summary. The checkpoint follows a strict section ownership model designed so another coding agent can resume work without replaying history.

Key differences from Pi's default compaction:

- **Model-selected cut point** — the summarizer chooses where to split retained verbatim context, aiming for a user message that gives the next agent a concrete task. Falls back to Pi's algorithm if the model's recommendation is invalid.
- **Full artifact tracking** — tracks read-only, modified, compacted, and retained file lists across three scopes (compacted range, retained range, all). Includes scoped git status and diff stat for session-touched paths only.
- **Structured sections** — STATE AT COMPACTION BOUNDARY, EVIDENCE TIERS, CODE REFERENCES, DECISIONS AND RATIONALE, COMMANDS TESTS AND FAILURES, WORK QUEUE, COMPACTED HISTORY SYNOPSIS. Each section owns distinct information; cross-references replace repetition.
- **Cut-point adjustment notes** — when the model's recommended cut point is capped or falls back, an explicit note is prepended explaining why and what was selected instead.
- **Iterative merging** — previous checkpoints are treated as frozen historical state and evolved with new history, not discarded.

## Installation

```bash
# Global
pi install npm:@taylatsatula/pi-mirastyle-compaction

# Project-local (shared with team via .pi/settings.json)
pi install -l npm:@taylatsatula/pi-mirastyle-compaction

# Temporary test
pi -e npm:@taylatsatula/pi-mirastyle-compaction
```

## Configuration

Two CLI flags control which model generates the checkpoint:

| Flag | Description |
|------|-------------|
| `--mirastyle-compaction-provider` | Provider name, e.g. `anthropic` or `google`. Requires `--mirastyle-compaction-model`. |
| `--mirastyle-compaction-model` | Model ID, e.g. `claude-sonnet-4-20250514`. Requires `--mirastyle-compaction-provider`. |

If neither flag is set, or if the configured model is unavailable, the extension falls back to the currently active model. If no active model has auth, Pi's default compaction is used.

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

The output is wrapped in `<pi:mirastyle_compacted_coding_context>` tags with deterministic metadata (session file, first kept entry ID, token count, git state, artifact lists) followed by the model-generated body using the section ownership rules defined in the system prompt.

## Security

Like all Pi extensions, this runs with full system access. It executes git commands (`git rev-parse`, `git branch`, `git status --short`, `git diff --stat`) scoped to session-touched files only. No files are written or modified beyond the compaction entry appended to the session file.
