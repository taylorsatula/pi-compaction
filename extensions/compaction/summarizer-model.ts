import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME } from "./identity.ts";

const DEFAULT_SUMMARIZER_PROVIDER = "";
const DEFAULT_SUMMARIZER_MODEL_ID = "";
const MAX_SUMMARY_OUTPUT_TOKENS = 12_000;

export type SummarizerSelectionReason = "configured" | "active-model-fallback";
export type NotificationType = "info" | "warning" | "error";
export type Notify = (message: string, type?: NotificationType) => void;

export interface SelectedSummarizer {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	selectionReason: SummarizerSelectionReason;
}

function stringFlag(pi: ExtensionAPI, name: string): string {
	const value = pi.getFlag(name);
	return typeof value === "string" ? value.trim() : "";
}

function completionMaxTokens(model: Model<Api>): number {
	return Math.min(
		MAX_SUMMARY_OUTPUT_TOKENS,
		model.maxTokens > 0 ? model.maxTokens : MAX_SUMMARY_OUTPUT_TOKENS,
	);
}

export function registerSummarizerFlags(pi: ExtensionAPI): void {
	pi.registerFlag("mirastyle-compaction-provider", {
		description: "Provider for Mira-style compaction summaries, e.g. anthropic or google. Requires --mirastyle-compaction-model.",
		type: "string",
	});
	pi.registerFlag("mirastyle-compaction-model", {
		description: "Model ID for Mira-style compaction summaries. Requires --mirastyle-compaction-provider.",
		type: "string",
	});
}

export async function resolveModelAuth(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	notify: Notify,
): Promise<SelectedSummarizer | undefined> {
	const provider = stringFlag(pi, "mirastyle-compaction-provider") || DEFAULT_SUMMARIZER_PROVIDER;
	const modelId = stringFlag(pi, "mirastyle-compaction-model") || DEFAULT_SUMMARIZER_MODEL_ID;

	if (provider && modelId) {
		const configured = ctx.modelRegistry.find(provider, modelId);
		if (!configured) {
			notify(`${EXTENSION_NAME}: configured model ${provider}/${modelId} was not found; trying active model`, "warning");
		} else {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
			if (auth.ok === true) {
				return {
					model: configured,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					selectionReason: "configured",
				};
			}
			notify(`${EXTENSION_NAME}: configured model auth failed (${auth.error}); trying active model`, "warning");
		}
	} else if (provider || modelId) {
		notify(
			`${EXTENSION_NAME}: both provider and model must be configured together; trying active model`,
			"warning",
		);
	}

	if (!ctx.model) {
		notify(`${EXTENSION_NAME}: no active model available; using Pi default compaction`, "warning");
		return undefined;
	}

	const activeAuth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (activeAuth.ok === false) {
		notify(`${EXTENSION_NAME}: active model auth failed (${activeAuth.error}); using Pi default compaction`, "warning");
		return undefined;
	}

	return {
		model: ctx.model,
		apiKey: activeAuth.apiKey,
		headers: activeAuth.headers,
		env: activeAuth.env,
		selectionReason: "active-model-fallback",
	};
}

export async function completeWithSummarizer(input: {
	selected: SelectedSummarizer;
	systemPrompt: string;
	userPrompt: string;
	signal: AbortSignal;
}): Promise<string> {
	const response = await complete(
		input.selected.model,
		{
			systemPrompt: input.systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: input.userPrompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: input.selected.apiKey,
			headers: input.selected.headers,
			env: input.selected.env,
			maxTokens: completionMaxTokens(input.selected.model),
			signal: input.signal,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "unknown provider error");
	}

	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}
