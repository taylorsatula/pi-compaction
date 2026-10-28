import { statSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatHandoffLine } from "./handoff-reference.ts";
import { AUTOCONTINUE_FLAG, EXTENSION_NAME } from "./identity.ts";

interface PendingCompactionRequest {
	reason: string;
	customInstructions?: string;
	handoffUrl: string;
}

type HandoffValidation =
	| { ok: true; path: string }
	| { ok: false; nudge: string };

const MISSING_HANDOFF_NUDGE =
	"handoff_url is required: the compaction checkpoint must reference a session handoff document. " +
	"Load the session-handoff skill (see available_skills), create a handoff, " +
	"then call request_compaction again with the document's path in handoff_url.";

function validateHandoffUrl(raw: string | undefined): HandoffValidation {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) {
		return { ok: false, nudge: MISSING_HANDOFF_NUDGE };
	}
	const path = trimmed.startsWith("file://") ? trimmed.slice("file://".length) : trimmed;
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return {
			ok: false,
			nudge:
				`No session handoff document exists at ${path}. ` +
				"Load the session-handoff skill (see available_skills), write the handoff, " +
				"then call request_compaction again with its path in handoff_url.",
		};
	}
	if (!stat.isFile()) {
		return {
			ok: false,
			nudge: `${path} is not a file. Pass the path of the session handoff document in handoff_url.`,
		};
	}
	return { ok: true, path };
}

function composeCustomInstructions(req: PendingCompactionRequest): string {
	const tail = req.customInstructions?.trim() || `Focus: ${req.reason}`;
	return `${formatHandoffLine(req.handoffUrl)}\n${tail}`;
}

export function buildOrientationMessage(handoffUrl: string): string {
	return (
		"The context window has just been compacted. " +
		`Please read ${handoffUrl} and other related orientation documentation, then resume your work.`
	);
}

export function installTools(pi: ExtensionAPI): void {
	pi.registerFlag(AUTOCONTINUE_FLAG, {
		description:
			"After a request_compaction compaction completes, inject a user message pointing at the " +
			"handoff document so the agent self-orients and resumes work.",
		type: "boolean",
		default: false,
	});

	let pendingRequest: PendingCompactionRequest | null = null;

	pi.registerTool({
		name: "request_compaction",
		label: "Request compaction",
		description:
			"Request a compaction checkpoint after a completed unit of work, before pivoting to an unrelated task, " +
			"or when context feels heavy. Requires handoff_url: the path of a session handoff document created " +
			"beforehand with the session-handoff skill; the checkpoint references it and the post-compaction " +
			"continuation reads it. Compaction runs after the current turn finishes so the checkpoint captures " +
			"a clean boundary.",
		promptSnippet: "Request a compaction checkpoint when a milestone is done or context is high",
		promptGuidelines: [
			"Call request_compaction when a logical milestone is complete (feature shipped, tests green, bug fixed) and before pivoting to an unrelated task.",
			"Call request_compaction when context feels heavy or you sense stale distant history is hurting decisions.",
			"Do not call request_compaction mid-edit or mid-tool-sequence; finish the current stride first so the checkpoint has a clean boundary.",
			"Create the session handoff document first (session-handoff skill) and pass its path as handoff_url.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "Why compaction is appropriate now" }),
			handoff_url: Type.Optional(
				Type.String({
					description:
						"Path to the session handoff document for this session. Required: create it with the session-handoff skill before calling.",
				}),
			),
			customInstructions: Type.Optional(
				Type.String({ description: "Optional focus instructions for the compaction summary" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			const handoff = validateHandoffUrl(params.handoff_url);
			if (!handoff.ok) {
				return {
					content: [{ type: "text", text: handoff.nudge }],
					details: undefined,
					isError: true,
				};
			}
			pendingRequest = {
				reason: params.reason,
				customInstructions: params.customInstructions,
				handoffUrl: handoff.path,
			};
			return {
				content: [{
					type: "text",
					text: `Compaction queued. It will run after this turn so the checkpoint captures a clean boundary. The checkpoint will reference the session handoff document at ${handoff.path}.`,
				}],
				details: undefined,
			};
		},
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (!pendingRequest) return;
		const req = pendingRequest;
		pendingRequest = null;
		const autocontinue = pi.getFlag(AUTOCONTINUE_FLAG) === true;
		ctx.compact({
			customInstructions: composeCustomInstructions(req),
			onComplete: () => {
				// Best-effort: by the time this fires the runtime may already be torn down
				// (print-mode exit after the run, reload, session switch), and a stale
				// runtime throws on every ctx/pi access. There is nothing to continue
				// into then; the completed checkpoint in the session file is the record.
				try {
					if (!autocontinue) return;
					if (ctx.hasUI) {
						ctx.ui.notify(
							`${EXTENSION_NAME}: compaction complete; auto-continuing from ${req.handoffUrl}`,
							"info",
						);
					}
					pi.sendUserMessage(buildOrientationMessage(req.handoffUrl));
				} catch {
					// Swallows stale-runtime throws at teardown; also a live-session failure
					// of sendUserMessage (e.g. model vanished mid-compaction), which leaves
					// the session idle after compaction — visible to the user, safe.
				}
			},
			onError: (error) => {
				try {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`${EXTENSION_NAME}: compaction failed (${error.message}); no continuation injected`,
							"warning",
						);
					}
				} catch {
					// Same teardown race as onComplete.
				}
			},
		});
	});

	pi.on("session_before_compact", () => {
		pendingRequest = null;
	});
}
