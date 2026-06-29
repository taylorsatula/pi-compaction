import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateEntryTokens } from "./session-history.ts";

export const MAX_MODEL_SELECTED_RETAINED_TOKENS = 15_000;

export interface CutpointSelectionDetails {
	defaultFirstKeptEntryId: string;
	selectedFirstKeptEntryId: string;
	recommendedFirstKeptEntryId?: string;
	selectionReason: "model" | "model-capped" | "fallback";
	validationMessage: string;
}

export function isValidCutpointEntry(entry: SessionEntry): boolean {
	if (entry.type === "branch_summary" || entry.type === "custom_message") {
		return true;
	}
	if (entry.type !== "message") {
		return false;
	}

	switch (entry.message.role) {
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
		case "user":
		case "assistant":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function estimateRetainedTokens(branchEntries: SessionEntry[], firstKeptEntryId: string): number {
	const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (firstKeptIndex < 0) {
		return 0;
	}

	let tokens = 0;
	for (const entry of branchEntries.slice(firstKeptIndex)) {
		tokens += estimateEntryTokens(entry);
	}
	return tokens;
}

function findCappedCutpointId(branchEntries: SessionEntry[], presentedCutpointIds: Set<string>): string | undefined {
	let retainedTokens = 0;
	let earliestCandidateWithinCap: string | undefined;

	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entryTokens = estimateEntryTokens(branchEntries[i]);
		if (retainedTokens + entryTokens > MAX_MODEL_SELECTED_RETAINED_TOKENS) {
			return earliestCandidateWithinCap;
		}

		retainedTokens += entryTokens;
		const candidate = branchEntries[i];
		if (presentedCutpointIds.has(candidate.id) && isValidCutpointEntry(candidate)) {
			earliestCandidateWithinCap = candidate.id;
		}
	}

	return earliestCandidateWithinCap;
}

export function selectCutpoint(
	branchEntries: SessionEntry[],
	defaultFirstKeptEntryId: string,
	recommendedEntryId: string | undefined,
	presentedCutpointIds: Set<string>,
): CutpointSelectionDetails {
	if (!recommendedEntryId) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			selectionReason: "fallback",
			validationMessage: "Summarizer did not return a cut-point recommendation.",
		};
	}

	if (!presentedCutpointIds.has(recommendedEntryId)) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: `Recommended cut point ${recommendedEntryId} was not one of the valid cut points presented to the summarizer.`,
		};
	}

	const recommendedEntry = branchEntries.find((entry) => entry.id === recommendedEntryId);
	if (!recommendedEntry) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: `Recommended cut point ${recommendedEntryId} was not found in the current branch.`,
		};
	}

	if (!isValidCutpointEntry(recommendedEntry)) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: `Recommended cut point ${recommendedEntryId} is not a valid cut point.`,
		};
	}

	const retainedTokenEstimate = estimateRetainedTokens(branchEntries, recommendedEntryId);
	if (retainedTokenEstimate > MAX_MODEL_SELECTED_RETAINED_TOKENS) {
		const cappedEntryId = findCappedCutpointId(branchEntries, presentedCutpointIds);
		if (cappedEntryId) {
			return {
				defaultFirstKeptEntryId,
				selectedFirstKeptEntryId: cappedEntryId,
				recommendedFirstKeptEntryId: recommendedEntryId,
				selectionReason: "model-capped",
				validationMessage: `Recommended cut point was valid but exceeded the retained-token cap; selected the nearest presented valid cut point within ${MAX_MODEL_SELECTED_RETAINED_TOKENS} estimated tokens.`,
			};
		}

		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: "Recommended cut point was valid but exceeded the retained-token cap, and no capped presented cut point was available.",
		};
	}

	return {
		defaultFirstKeptEntryId,
		selectedFirstKeptEntryId: recommendedEntryId,
		recommendedFirstKeptEntryId: recommendedEntryId,
		selectionReason: "model",
		validationMessage: "Recommended cut point was presented, found, and valid.",
	};
}
