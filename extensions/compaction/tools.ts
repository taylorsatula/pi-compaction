import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME } from "./identity.ts";

let pendingRequest: { reason: string; customInstructions?: string } | null = null;

export function installTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "request_compaction",
		label: "Request compaction",
		description:
			"Request a compaction checkpoint after a completed unit of work, before pivoting to an unrelated task, " +
			"or when context feels heavy. Compaction runs after the current turn finishes so the checkpoint captures " +
			"a clean boundary.",
		promptSnippet: "Request a compaction checkpoint when a milestone is done or context is high",
		promptGuidelines: [
			"Call request_compaction when a logical milestone is complete (feature shipped, tests green, bug fixed) and before pivoting to an unrelated task.",
			"Call request_compaction when context feels heavy or you sense stale distant history is hurting decisions.",
			"Do not call request_compaction mid-edit or mid-tool-sequence; finish the current stride first so the checkpoint has a clean boundary.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "Why compaction is appropriate now" }),
			customInstructions: Type.Optional(
				Type.String({ description: "Optional focus instructions for the compaction summary" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			pendingRequest = {
				reason: params.reason,
				customInstructions: params.customInstructions,
			};
			return {
				content: [{
					type: "text",
					text: "Compaction queued. It will run after this turn so the checkpoint captures a clean boundary.",
				}],
				details: undefined,
			};
		},
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (!pendingRequest) return;
		const req = pendingRequest;
		pendingRequest = null;
		ctx.compact({
			customInstructions: req.customInstructions ?? `Focus: ${req.reason}`,
		});
	});

	pi.on("session_before_compact", () => {
		pendingRequest = null;
	});
}
