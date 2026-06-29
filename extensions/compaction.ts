import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	computeFileLists,
	computeFileOpsForCutpoint,
	listTouchedFiles,
	safeGitSnapshot,
	type GitSnapshot,
} from "./compaction/artifact-snapshot.ts";
import {
	buildCompactionDetails,
	buildCutpointAdjustmentNote,
	buildEffectiveSystemPrompt,
	buildUserPrompt,
	parseCheckpointResponse,
	wrapSummary,
} from "./compaction/checkpoint-contract.ts";
import {
	isValidCutpointEntry,
	selectCutpoint,
} from "./compaction/cutpoint-selection.ts";
import { EXTENSION_NAME } from "./compaction/identity.ts";
import {
	getPreparedEntryRanges,
	getRetainedRecentEntries,
	getRetainedRecentMessages,
	serializeEntriesWithIds,
	truncateRetainedReference,
} from "./compaction/session-history.ts";
import {
	completeWithSummarizer,
	registerSummarizerFlags,
	resolveModelAuth,
	type NotificationType,
} from "./compaction/summarizer-model.ts";

interface PreparedPromptContext {
	readFiles: string[];
	modifiedFiles: string[];
	retainedMessageCount: number;
	retainedReferenceChars: number;
	presentedCutpointIds: Set<string>;
	git: GitSnapshot;
	sessionFile: string;
	compactedAt: string;
	newHistory: string;
	retainedRecentContext: string;
	turnPrefix: string;
}

function notifyUi(ctx: ExtensionContext, message: string, type: NotificationType = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}

/** Project the model-selected cutpoint into all derived values needed for summary + details. */
function projectSelectedCutpoint(branchEntries: SessionEntry[], selectedFirstKeptEntryId: string) {
	const retainedEntries = getRetainedRecentEntries(branchEntries, selectedFirstKeptEntryId);
	const retainedMessages = getRetainedRecentMessages(branchEntries, selectedFirstKeptEntryId);
	const retainedReferenceChars = serializeEntriesWithIds(retainedEntries, isValidCutpointEntry).serialized.length;
	const fileOps = computeFileOpsForCutpoint(branchEntries, selectedFirstKeptEntryId);
	const compactedFileLists = computeFileLists(fileOps.compactedFileOps);
	const retainedFileLists = computeFileLists(fileOps.retainedFileOps);
	const allFileLists = computeFileLists(fileOps.allFileOps);
	return { retainedEntries, retainedMessages, retainedReferenceChars, compactedFileLists, retainedFileLists, allFileLists };
}

async function preparePromptContext(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	signal: AbortSignal;
	branchEntries: SessionEntry[];
	firstKeptEntryId: string;
	isSplitTurn: boolean;
}): Promise<PreparedPromptContext> {
	const retainedMessages = getRetainedRecentMessages(input.branchEntries, input.firstKeptEntryId);
	const promptFileOps = computeFileOpsForCutpoint(input.branchEntries, input.firstKeptEntryId);
	const promptFileLists = computeFileLists(promptFileOps.allFileOps);
	const { readFiles, modifiedFiles } = promptFileLists;
	const touchedFiles = listTouchedFiles(promptFileLists);
	const git = await safeGitSnapshot(input.pi, input.ctx, input.signal, touchedFiles);
	const sessionFile = input.ctx.sessionManager.getSessionFile() ?? "In-memory or unsaved session.";
	const compactedAt = new Date().toISOString();
	const preparedEntryRanges = getPreparedEntryRanges(
		input.branchEntries,
		input.firstKeptEntryId,
		input.isSplitTurn,
	);

	// Serialize entries and collect valid cutpoint IDs structurally — no regex needed.
	const newHistoryResult = serializeEntriesWithIds(preparedEntryRanges.newHistoryEntries, isValidCutpointEntry);
	const retainedResult = serializeEntriesWithIds(preparedEntryRanges.retainedEntries, isValidCutpointEntry);
	const retainedRecentContext = truncateRetainedReference(retainedResult.serialized);
	const turnPrefixResult = input.isSplitTurn
		? serializeEntriesWithIds(preparedEntryRanges.turnPrefixEntries, isValidCutpointEntry)
		: null;

	// Merge presented cutpoint IDs from all serialized sections.
	const presentedCutpointIds = new Set([...newHistoryResult.validCutpointIds, ...retainedResult.validCutpointIds]);
	for (const id of (turnPrefixResult?.validCutpointIds ?? [])) {
		presentedCutpointIds.add(id);
	}

	return {
		readFiles,
		modifiedFiles,
		retainedMessageCount: retainedMessages.length,
		retainedReferenceChars: retainedRecentContext.length,
		presentedCutpointIds,
		git,
		sessionFile,
		compactedAt,
		newHistory: newHistoryResult.serialized,
		retainedRecentContext,
		turnPrefix: turnPrefixResult?.serialized ?? "None captured. This compaction did not split a turn.",
	};
}

export default function (pi: ExtensionAPI) {
	registerSummarizerFlags(pi);

	pi.on("session_before_compact", async (event, ctx) => {
		const selected = await resolveModelAuth(pi, ctx, (message, type) => notifyUi(ctx, message, type));
		if (!selected) {
			return;
		}

		const { preparation, customInstructions, signal, branchEntries } = event;
		const normalizedCustomInstructions = customInstructions?.trim() || undefined;
		const promptContext = await preparePromptContext({
			pi,
			ctx,
			signal,
			branchEntries,
			firstKeptEntryId: preparation.firstKeptEntryId,
			isSplitTurn: preparation.isSplitTurn,
		});

		notifyUi(
			ctx,
			`${EXTENSION_NAME}: generating coding checkpoint with ${selected.model.provider}/${selected.model.id}`,
			"info",
		);

		const userPrompt = buildUserPrompt({
			previousSummary: preparation.previousSummary,
			newHistory: promptContext.newHistory,
			turnPrefix: promptContext.turnPrefix,
			retainedRecentContext: promptContext.retainedRecentContext,
			retainedMessageCount: promptContext.retainedMessageCount,
			retainedReferenceChars: promptContext.retainedReferenceChars,
			customInstructions: normalizedCustomInstructions,
			sessionFile: promptContext.sessionFile,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			isSplitTurn: preparation.isSplitTurn,
			readFiles: promptContext.readFiles,
			modifiedFiles: promptContext.modifiedFiles,
			git: promptContext.git,
		});

		try {
			const rawBody = await completeWithSummarizer({
				selected,
				systemPrompt: buildEffectiveSystemPrompt(normalizedCustomInstructions),
				userPrompt,
				signal,
			});
			const { body, recommendedEntryId } = parseCheckpointResponse(rawBody);
			if (!body) {
				if (!signal.aborted) {
					notifyUi(ctx, `${EXTENSION_NAME}: summarizer returned an empty checkpoint; using Pi default compaction`, "warning");
				}
				return;
			}

			const cutpoint = selectCutpoint(
				branchEntries,
				preparation.firstKeptEntryId,
				recommendedEntryId,
				promptContext.presentedCutpointIds,
			);
			if (!signal.aborted) {
				const isFallback = cutpoint.selectionReason === "fallback";
				notifyUi(
					ctx,
					`${EXTENSION_NAME}: ${isFallback ? "using fallback" : "using model-selected"} cut point ${cutpoint.selectedFirstKeptEntryId}`,
					isFallback ? "warning" : "info",
				);
			}

			const projection = projectSelectedCutpoint(branchEntries, cutpoint.selectedFirstKeptEntryId);

			const bodyWithCutpointNote = cutpoint.selectionReason === "model"
				? body
				: `${buildCutpointAdjustmentNote(cutpoint)}\n\n${body}`;

			const summary = wrapSummary({
				body: bodyWithCutpointNote,
				compactedAt: promptContext.compactedAt,
				firstKeptEntryId: cutpoint.selectedFirstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				isSplitTurn: preparation.isSplitTurn,
				sessionFile: promptContext.sessionFile,
				readFiles: projection.allFileLists.readFiles,
				modifiedFiles: projection.allFileLists.modifiedFiles,
				retainedMessageCount: projection.retainedMessages.length,
				git: promptContext.git,
			});

			const details = buildCompactionDetails({
				generatedAt: promptContext.compactedAt,
				allFileLists: projection.allFileLists,
				compactedFileLists: projection.compactedFileLists,
				retainedFileLists: projection.retainedFileLists,
				retainedMessageCount: projection.retainedMessages.length,
				retainedReferenceChars: projection.retainedReferenceChars,
				selectedModelProvider: selected.model.provider,
				selectedModelId: selected.model.id,
				selectionReason: selected.selectionReason,
				git: promptContext.git,
				cutpoint,
			});

			return {
				compaction: {
					summary,
					firstKeptEntryId: cutpoint.selectedFirstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) {
				notifyUi(ctx, `${EXTENSION_NAME}: custom compaction failed (${message}); using Pi default compaction`, "warning");
			}
			return;
		}
	});
}
