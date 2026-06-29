import {
	convertToLlm,
	estimateTokens,
	serializeConversation,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const MAX_RETAINED_CONTEXT_REFERENCE_CHARS = 80_000;

export type CustomContextMessage = {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
};

export type BranchSummaryContextMessage = {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
};

export type CutpointValidityPredicate = (entry: SessionEntry) => boolean;

export interface PreparedEntryRanges {
	newHistoryEntries: SessionEntry[];
	turnPrefixEntries: SessionEntry[];
	retainedEntries: SessionEntry[];
}

export interface SerializedEntriesResult {
	serialized: string;
	validCutpointIds: Set<string>;
}

function timestampMillis(timestamp: string): number {
	const parsed = new Date(timestamp).getTime();
	return Number.isNaN(parsed) ? Date.now() : parsed;
}

function createCustomContextMessage(entry: Extract<SessionEntry, { type: "custom_message" }>): CustomContextMessage {
	return {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		timestamp: timestampMillis(entry.timestamp),
	};
}

function createBranchSummaryContextMessage(
	entry: Extract<SessionEntry, { type: "branch_summary" }>,
): BranchSummaryContextMessage {
	return {
		role: "branchSummary",
		summary: entry.summary,
		fromId: entry.fromId,
		timestamp: timestampMillis(entry.timestamp),
	};
}

export function messageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomContextMessage(entry);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryContextMessage(entry);
	}
	return undefined;
}

function serializeAgentMessages(messages: AgentMessage[]): string {
	if (messages.length === 0) {
		return "None captured.";
	}
	return serializeConversation(convertToLlm(messages));
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function entryRoleLabel(entry: SessionEntry): string {
	if (entry.type === "message") {
		return entry.message.role;
	}
	return entry.type;
}

export function findPreviousCompactionIndex(entries: SessionEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return i;
		}
	}
	return -1;
}

export function findEntryIndexById(entries: SessionEntry[], entryId: string): number {
	return entries.findIndex((entry) => entry.id === entryId);
}

export function getBoundaryStartIndex(entries: SessionEntry[]): number {
	const previousCompactionIndex = findPreviousCompactionIndex(entries);
	if (previousCompactionIndex < 0) {
		return 0;
	}

	const previousCompaction = entries[previousCompactionIndex];
	if (previousCompaction.type !== "compaction") {
		return previousCompactionIndex + 1;
	}

	const firstKeptEntryIndex = findEntryIndexById(entries, previousCompaction.firstKeptEntryId);
	return firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : previousCompactionIndex + 1;
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "bashExecution")) {
			return i;
		}
	}
	return -1;
}

export function getPreparedEntryRanges(
	branchEntries: SessionEntry[],
	defaultFirstKeptEntryId: string,
	isSplitTurn: boolean,
): PreparedEntryRanges {
	const boundaryStart = getBoundaryStartIndex(branchEntries);
	const firstKeptIndex = findEntryIndexById(branchEntries, defaultFirstKeptEntryId);
	if (firstKeptIndex < 0) {
		return {
			newHistoryEntries: [],
			turnPrefixEntries: [],
			retainedEntries: [],
		};
	}

	const turnStartIndex = isSplitTurn ? findTurnStartIndex(branchEntries, firstKeptIndex, boundaryStart) : -1;
	const historyEndIndex = turnStartIndex >= 0 ? turnStartIndex : firstKeptIndex;

	return {
		newHistoryEntries: branchEntries.slice(boundaryStart, historyEndIndex),
		turnPrefixEntries: turnStartIndex >= 0 ? branchEntries.slice(turnStartIndex, firstKeptIndex) : [],
		retainedEntries: branchEntries.slice(firstKeptIndex),
	};
}

export function serializeEntriesWithIds(
	entries: SessionEntry[],
	isValidCutpointEntry: CutpointValidityPredicate,
): SerializedEntriesResult {
	const serializedEntries: string[] = [];
	const validCutpointIds = new Set<string>();
	for (const entry of entries) {
		const message = messageFromEntry(entry);
		if (!message) {
			continue;
		}
		const isValid = isValidCutpointEntry(entry);
		if (isValid) {
			validCutpointIds.add(entry.id);
		}
		serializedEntries.push(
			`<session_entry id="${escapeXmlAttribute(entry.id)}" type="${escapeXmlAttribute(entry.type)}" role="${escapeXmlAttribute(entryRoleLabel(entry))}" valid_cutpoint="${isValid}">\n${serializeAgentMessages([message])}\n</session_entry>`,
		);
	}
	return {
		serialized: serializedEntries.length > 0 ? serializedEntries.join("\n\n") : "None captured.",
		validCutpointIds,
	};
}

export function collectValidCutpointIds(
	entries: SessionEntry[],
	isValidCutpointEntry: CutpointValidityPredicate,
): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (messageFromEntry(entry) && isValidCutpointEntry(entry)) {
			ids.add(entry.id);
		}
	}
	return ids;
}

export function getRetainedRecentEntries(branchEntries: SessionEntry[], firstKeptEntryId: string): SessionEntry[] {
	const firstKeptIndex = findEntryIndexById(branchEntries, firstKeptEntryId);
	return firstKeptIndex >= 0 ? branchEntries.slice(firstKeptIndex) : [];
}

export function getRetainedRecentMessages(branchEntries: SessionEntry[], firstKeptEntryId: string): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of getRetainedRecentEntries(branchEntries, firstKeptEntryId)) {
		const message = messageFromEntry(entry);
		if (message) {
			messages.push(message);
		}
	}
	return messages;
}

export function estimateEntryTokens(entry: SessionEntry): number {
	const message = messageFromEntry(entry);
	return message ? estimateTokens(message) : 0;
}

export function truncateRetainedReference(text: string): string {
	if (text.length <= MAX_RETAINED_CONTEXT_REFERENCE_CHARS) {
		return text;
	}

	const headChars = Math.floor(MAX_RETAINED_CONTEXT_REFERENCE_CHARS * 0.25);
	const tailChars = MAX_RETAINED_CONTEXT_REFERENCE_CHARS - headChars;
	const closingTag = "</session_entry>";
	const openingTag = "<session_entry";

	const headCloseIndex = text.lastIndexOf(closingTag, headChars);
	const headEnd = headCloseIndex >= 0 ? headCloseIndex + closingTag.length : headChars;
	const tailSearchStart = Math.max(headEnd, text.length - tailChars);
	const tailOpenIndex = text.indexOf(openingTag, tailSearchStart);
	const tailStart = tailOpenIndex >= 0 ? tailOpenIndex : tailSearchStart;
	const omittedChars = Math.max(0, tailStart - headEnd);

	return `${text.slice(0, headEnd)}\n\n[... ${omittedChars} characters of retained recent context omitted from the middle ...]\n\n${text.slice(tailStart)}`;
}
