import type { GitSnapshot } from "./artifact-snapshot.ts";
import type { CutpointSelectionDetails } from "./cutpoint-selection.ts";
import { EXTENSION_NAME, SUMMARY_VERSION } from "./identity.ts";
import { formatHandoffLine } from "./handoff-reference.ts";
import type { SummarizerSelectionReason } from "./summarizer-model.ts";

export const SYSTEM_PROMPT = `You are a coding-session compaction engine.

Your output is not a chat response. Your output is the body of an engineering handoff checkpoint that another coding agent will use after older context has been removed.

Think of the coding session like a hurdle race. The checkpoint records the race so far: what was attempted, what was decided, what changed, and why. The retained verbatim messages are the runner's short runway into the next hurdle: just enough live context for the next agent to regain stride and continue without replaying the whole race.

Core rules:
- Produce one complete successor checkpoint body, not a delta.
- Produce a detailed recovery checkpoint, not a brief summary. Preserve concrete facts, code references, validation results, decisions, and unresolved risks when they add recovery value. However, do not repeat the same fact in multiple sections. Each section has a distinct purpose. State a fact in the section that best serves that purpose, and refer to that section elsewhere rather than restating it. A detail may appear more than once only when the repetition is necessary for immediate execution in a different section; emphasis, completeness, or narrative flow are not sufficient reasons.
- If <previous_checkpoint> is present, treat it as frozen historical state and evolve it with <new_history_to_compact>, <split_turn_prefix>, and <kept_recent_context>.
- Preserve still-relevant prior facts from the previous checkpoint.
- Fully integrate all entries that will be before your recommended cut point; those entries are being replaced by this checkpoint.
- Use <kept_recent_context> as default boundary evidence. The actual preserved verbatim range depends on your recommended cut point, so do not recap messages you recommend keeping verbatim, but do integrate any messages that fall before your recommended cut point.
- STATE AT COMPACTION BOUNDARY, WORK QUEUE, and COMMANDS, TESTS, AND FAILURES must reflect the newest evidence in <kept_recent_context>, not only the older compacted history.
- If <kept_recent_context> shows that an implementation was written, tests were run, or a decision changed, do not leave stale prior claims like "plan not implemented" or "next edit is to create the file".
- Update current status based on newer compacted and retained history.
- Remove only facts contradicted by newer evidence, current deterministic metadata, or explicit user correction.
- Current filesystem state and later visible messages will be more authoritative than this checkpoint.
- Separate verified facts, user-stated requirements, and assistant inferences.
- Do not invent file contents, test results, commands, decisions, preferences, or failures.
- Do not list every tool call verbatim — coding sessions may contain hundreds of routine reads, greps, and edits — but include substantive tool activity: exact commands/tests and outcomes, failures, important output/error snippets, file sets, decisions, and plan-changing observations. Err on the side of inclusion when the detail adds distinct recovery value; the checkpoint is an engineering handoff, not a log.
- Preserve exact file paths, symbols, function/class/type names, config keys, commands, error messages, test names, IDs, and user wording when important for continuation, validation, or risk management.
- Prefer bounded historical phrasing: "During the compacted range", "At the compaction boundary", "As of this checkpoint".
- Do not say timeless-present claims like "the user wants" unless bounded to this checkpoint.
- Be dense and continuation-oriented. No praise, greetings, narrative filler, or generic project-management prose.
- Begin with the required cut-point decision block, then output plain text using the section ownership rules below. Do not use a code fence. Do not include wrapper XML tags except the required cut-point decision block.
- Session entries are annotated with entry IDs and valid_cutpoint flags. Before writing the checkpoint body, decide the first entry ID that should remain verbatim after compaction.
- The recommended cut point is the earliest entry to keep live in the future context, not the last entry to summarize.
- Choose only an entry marked valid_cutpoint="true". Never choose a tool result or non-message bookkeeping entry.

Wrapper-generated section ownership:
- RECOVERY owns only mechanical continuation metadata: session/recovery source, compaction boundary, retained-message details, split-turn status, and the authority rule that live filesystem/current context overrides stale checkpoint content. Do not output a RECOVERY section in the body; it will be added by the wrapper.
- ARTIFACT STATE owns deterministic file and git metadata that the wrapper adds from tool/session state. In the generated body, mention files or git state only when they are needed for current work, validation, blockers, or risks.

Cross-reference rule:
- When a fact is relevant outside its owning section, refer to the section rather than restating the fact. For example: "The remaining compile-validation gap is documented under COMMANDS, TESTS, AND FAILURES." Do not use cross-references to hide essential state: STATE AT COMPACTION BOUNDARY must still be independently usable as a resume point.

Status labels:
- Completed — done and verified to the stated degree.
- In Progress — actively underway at the compaction boundary.
- Pending Validation — edit is complete but compile, test, loader, or end-to-end confirmation remains.
- Blocked — a concrete external limitation prevents the next required step.
- Open Question — unresolved uncertainty that materially affects future work.

Cut-point strategy:
- The checkpoint captures the full history needed for recovery. Retained verbatim messages exist solely to give the next agent a live starting point, not to re-enact old work.
- Aim for a user message as the cut point. A user request gives the next agent a concrete task to act on. An assistant-only tail (e.g. a lone "Done." with no preceding request) provides almost no usable context.
- Keep at least one coherent interaction unit: a user request and its response, or the start of a new action. Do not leave the next agent staring at an orphaned tool result or completion confirmation.
- Avoid splitting a multi-step tool-call sequence. If the last compacted-away entry is mid-sequence, push the cut point forward to include the full turn.
- Routine reads, greps, edits, and their tool results are safe to summarize — their outcomes live in the filesystem and checkpoint sections. You do not need to retain them verbatim.
- Between tasks, you can cut earlier. Mid-task, keep the active instruction and any partial results or errors needed to finish the current stride.
- Include one concise reasoning sentence in the cut-point decision block explaining why that spot positions the agent to continue.
- The extension may cap the retained token count; write the checkpoint body as if your recommendation will be honored.

Output must start with exactly this decision block:

<cutpoint_decision>
<recommended_cut_before_entry_id>ENTRY_ID</recommended_cut_before_entry_id>
<cutpoint_reasoning>One sentence explaining why this cut point preserves continuity better than nearby alternatives.</cutpoint_reasoning>
</cutpoint_decision>

Then output the checkpoint body sections below. Keep sections detailed when detail adds distinct recovery value. Omit optional sections when they would only duplicate other sections.

STATE AT COMPACTION BOUNDARY:
Ownership: current operational truth. This is the primary resume section. It owns the active task, the immediate boundary status, exact next action, context needed to continue, and blockers that directly prevent that next action. Include what was just completed only when it is necessary to understand the current resume point. Do not list the full completed-work history here; completed task inventory belongs in WORK QUEUE. Do not repeat proof details, command transcripts, broad history, or navigation inventories here.
- Active task:
- Most recent user request:
- Current operational state:
- Exact next action:
- Context needed to continue:
- Direct blockers:

EVIDENCE TIERS:
Ownership: confidence and provenance only. It owns verified facts, user requirements, and clearly labeled inferences. Do not use it as a second project-status summary.
- Verified from session/tool history:
- User-stated requirements:
- Assistant-inferred implementation implications:

CODE REFERENCES:
Ownership: navigation aids relevant to the current task, likely validation work, blockers, or open risks. Do not inventory every touched symbol, type, constant, command, or error string from the session.
- Files and paths:
- Symbols/classes/functions/types:
- Config keys, constants, settings, and identifiers:
- Verbatim error messages, command lines, and test names (lookup strings only; do not narrate context — that belongs in COMMANDS, TESTS, AND FAILURES):

DECISIONS AND RATIONALE:
Optional. Include this section only when there are durable choices that constrain later work and prevent an agent from undoing intentional behavior. Omit it when there are no such decisions. Do not repeat ordinary completed edits or requirements.
- Decisions made:
- Rationale:
- Things ruled out:

COMMANDS, TESTS, AND FAILURES:
Ownership: exact commands run, test results, failed validation attempts, and remaining validation gaps. Do not repeat general project state. If a validation gap also appears in WORK QUEUE, put the exact command/output evidence here and use a short cross-reference there.
- Commands run:
- Tests run:
- Failed validation attempts:
- Remaining validation gaps:

WORK QUEUE:
Ownership: work ledger. Retain completed tasks when they add recovery value, but put each completed task here once rather than repeating it across STATE AT COMPACTION BOUNDARY, EVIDENCE TIERS, DECISIONS AND RATIONALE, or COMPACTED HISTORY SYNOPSIS. Use concise status phrasing and verification degree; put proof details in EVIDENCE TIERS or COMMANDS, TESTS, AND FAILURES. Unfinished work remains the action-oriented part of this section.
- Completed:
- In Progress:
- Pending Validation:
- Blocked:
- Next Exact Edits:
- Open Questions:
- Unresolved User Requests:

COMPACTED HISTORY SYNOPSIS:
Optional. Use this section only for causal narrative or important pivots that cannot be reconstructed from the rest of the checkpoint. Do not recap the task, completed work, evidence, decisions, code references, or work queue. Omit this section when it would be a duplicate narrative.

Final self-check before output:
1. Identify each completed implementation change.
2. Put completed task inventory once in WORK QUEUE > Completed when it adds recovery value.
3. Put only immediate resume-relevant completed status in STATE AT COMPACTION BOUNDARY.
4. Put proof or confidence details only in EVIDENCE TIERS or COMMANDS, TESTS, AND FAILURES.
5. Put file/symbol navigation only in CODE REFERENCES.
6. Put durable rationale only in DECISIONS AND RATIONALE.
7. Delete historical recap text that merely repeats any of the above.
8. Keep additional detail whenever it is distinct and useful for continuation.`;

export interface MirastyleCompactionDetails {
	extension: typeof EXTENSION_NAME;
	version: number;
	generatedAt: string;
	handoffUrl?: string;
	readFiles: string[];
	modifiedFiles: string[];
	compactedReadFiles: string[];
	compactedModifiedFiles: string[];
	retainedReadFiles: string[];
	retainedModifiedFiles: string[];
	retainedMessageCount: number;
	retainedReferenceChars: number;
	model: {
		provider: string;
		id: string;
		selectionReason: SummarizerSelectionReason;
	};
	git: GitSnapshot;
	cutpoint: CutpointSelectionDetails;
}

interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

export function buildCompactionDetails(input: {
	generatedAt: string;
	handoffUrl?: string;
	allFileLists: FileLists;
	compactedFileLists: FileLists;
	retainedFileLists: FileLists;
	retainedMessageCount: number;
	retainedReferenceChars: number;
	selectedModelProvider: string;
	selectedModelId: string;
	selectionReason: SummarizerSelectionReason;
	git: GitSnapshot;
	cutpoint: CutpointSelectionDetails;
}): MirastyleCompactionDetails {
	return {
		extension: EXTENSION_NAME,
		version: SUMMARY_VERSION,
		generatedAt: input.generatedAt,
		handoffUrl: input.handoffUrl,
		readFiles: input.allFileLists.readFiles,
		modifiedFiles: input.allFileLists.modifiedFiles,
		compactedReadFiles: input.compactedFileLists.readFiles,
		compactedModifiedFiles: input.compactedFileLists.modifiedFiles,
		retainedReadFiles: input.retainedFileLists.readFiles,
		retainedModifiedFiles: input.retainedFileLists.modifiedFiles,
		retainedMessageCount: input.retainedMessageCount,
		retainedReferenceChars: input.retainedReferenceChars,
		model: {
			provider: input.selectedModelProvider,
			id: input.selectedModelId,
			selectionReason: input.selectionReason,
		},
		git: input.git,
		cutpoint: input.cutpoint,
	};
}

export interface ParsedCheckpointResponse {
	body: string;
	recommendedEntryId: string | undefined;
}

function formatBulletList(items: string[]): string {
	if (items.length === 0) {
		return "  - None captured.";
	}
	return items.map((item) => `  - ${item}`).join("\n");
}

export function buildEffectiveSystemPrompt(customInstructions: string | undefined): string {
	return customInstructions?.trim()
		? `${SYSTEM_PROMPT}

If <user_compaction_instructions> is present, treat it as high-priority human guidance about what to emphasize, preserve, and describe in extra detail. Follow it unless it conflicts with required output format, deterministic metadata, or newer session evidence.`
		: SYSTEM_PROMPT;
}

export function buildUserPrompt(input: {
	previousSummary: string | undefined;
	newHistory: string;
	turnPrefix: string;
	retainedRecentContext: string;
	retainedMessageCount: number;
	retainedReferenceChars: number;
	customInstructions: string | undefined;
	sessionFile: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	isSplitTurn: boolean;
	readFiles: string[];
	modifiedFiles: string[];
	git: GitSnapshot;
}): string {
	const previousSection = input.previousSummary
		? `<previous_checkpoint>\n${input.previousSummary}\n</previous_checkpoint>\n\n`
		: "";

	const customInstructionsSection = input.customInstructions?.trim()
		? `<user_compaction_instructions priority="high" source="human">
IMPORTANT: The user explicitly supplied custom compaction instructions for this checkpoint.
You must take them into account prominently when deciding what details to preserve, emphasize, and describe.
Follow them unless they conflict with required output format, deterministic metadata, or newer session evidence.

${input.customInstructions.trim()}
</user_compaction_instructions>

`
		: "";

	const customInstructionsReminder = input.customInstructions?.trim()
		? "\nCUSTOM INSTRUCTION PRIORITY: The human-provided <user_compaction_instructions> above is high priority and should materially affect checkpoint emphasis and retained detail."
		: "";

	return `${previousSection}${customInstructionsSection}<deterministic_metadata>
Session file: ${input.sessionFile}
Default fallback first kept entry ID: ${input.firstKeptEntryId}
Compacted from token count: ${input.tokensBefore}
Split turn: ${input.isSplitTurn}
Read-only files:
${formatBulletList(input.readFiles)}
Modified files:
${formatBulletList(input.modifiedFiles)}
${input.git.isGitRepo
? `Git repository: true
Git branch: ${input.git.branch}
Git scope: ${input.git.scope}
Git pathspec count: ${input.git.pathspecCount}
Git status --short (session-touched paths only):
${input.git.statusShort}
Git diff --stat (session-touched paths only):
${input.git.diffStat}`
: ''}
Retained recent message count: ${input.retainedMessageCount}
Retained recent reference chars: ${input.retainedReferenceChars}
</deterministic_metadata>

<new_history_to_compact>
${input.newHistory}
</new_history_to_compact>

<split_turn_prefix>
${input.turnPrefix}
</split_turn_prefix>

<kept_recent_context boundary_reference="true">
These messages start at Pi's default fallback first kept entry ID. They are included as boundary evidence, but your <recommended_cut_before_entry_id> controls the final verbatim retention point. Use them to compute STATE AT COMPACTION BOUNDARY, WORK QUEUE, and validation status accurately. If you recommend a later cut point, integrate any earlier boundary messages into the checkpoint because they will not remain verbatim. If they contradict older checkpoint claims about current work state, they win.

${input.retainedRecentContext}
</kept_recent_context>

<cutpoint_recommendation_instructions>
Follow the cut-point strategy from the system prompt. Choose only an ID from a <session_entry> marked valid_cutpoint="true". Keep the short runway needed for the next action; summarize completed context instead of retaining a long replay.
</cutpoint_recommendation_instructions>${customInstructionsReminder}
Output the cut-point decision block first, then the checkpoint body using the section ownership rules from the system prompt. Do not include wrapper XML tags other than the cut-point decision block. Do not include a raw per-tool-call history list.`;
}

function stripAccidentalWrapper(summary: string): string {
	return summary
		.replace(/^```(?:xml|text)?\s*/i, "")
		.replace(/```\s*$/i, "")
		.replace(/^<pi:mirastyle_compacted_coding_context[^>]*>/i, "")
		.replace(/<\/pi:mirastyle_compacted_coding_context>\s*$/i, "")
		.trim();
}

function extractRecommendedCutpoint(summary: string): ParsedCheckpointResponse {
	const recommendationPattern = /<recommended_cut_before_entry_id>\s*([^<\s]+)\s*<\/recommended_cut_before_entry_id>/i;
	const decisionBlockPattern = /<cutpoint_decision>[\s\S]*?<\/cutpoint_decision>/gi;
	const match = summary.match(recommendationPattern);
	let body = summary.replace(decisionBlockPattern, "").trim();
	// Backward/partial-compliance cleanup: strip standalone tags if the model omitted the wrapper.
	body = body
		.replace(/<recommended_cut_before_entry_id>\s*([^<\s]+)\s*<\/recommended_cut_before_entry_id>/gi, "")
		.replace(/<cutpoint_reasoning>[\s\S]*?<\/cutpoint_reasoning>/gi, "")
		.trim();
	return {
		body,
		recommendedEntryId: match?.[1]?.trim(),
	};
}

export function parseCheckpointResponse(rawText: string): ParsedCheckpointResponse {
	return extractRecommendedCutpoint(stripAccidentalWrapper(rawText));
}

export function buildCutpointAdjustmentNote(cutpoint: CutpointSelectionDetails): string {
	return `CUTPOINT ADJUSTMENT NOTE:
- Final first kept entry ID: ${cutpoint.selectedFirstKeptEntryId}
- Summarizer recommended: ${cutpoint.recommendedFirstKeptEntryId ?? "None returned."}
- Selection reason: ${cutpoint.selectionReason}
- Validation: ${cutpoint.validationMessage}`;
}

export function wrapSummary(input: {
	body: string;
	compactedAt: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	isSplitTurn: boolean;
	sessionFile: string;
	handoffUrl?: string;
	readFiles: string[];
	modifiedFiles: string[];
	retainedMessageCount: number;
	git: GitSnapshot;
}): string {
	return `<pi:mirastyle_compacted_coding_context compacted_at="${input.compactedAt}" first_kept_entry_id="${input.firstKeptEntryId}" tokens_before="${input.tokensBefore}">
HISTORICAL CODING CHECKPOINT. Current filesystem state and later conversation are more authoritative. If conflicts arise, reread files and trust on-disk contents.
Pi preserved ${input.retainedMessageCount} message(s) after first_kept_entry_id verbatim; this checkpoint used them as boundary evidence.

RECOVERY:
- Session file: ${input.sessionFile}
- First kept entry ID: ${input.firstKeptEntryId}
- Compacted from token count: ${input.tokensBefore}
- Split turn: ${input.isSplitTurn}${input.handoffUrl ? `\n- ${formatHandoffLine(input.handoffUrl)}` : ""}
- For exact pre-compaction details (tool arguments, command output, message order), read session file JSONL records before first_kept_entry_id rather than relying on this checkpoint.

ARTIFACT STATE:
- Files read:
${formatBulletList(input.readFiles)}
- Files modified:
${formatBulletList(input.modifiedFiles)}
${input.git.isGitRepo
? `- Git repository: true\n- Git branch: ${input.git.branch}\n- Git scope: ${input.git.scope}\n- Git pathspec count: ${input.git.pathspecCount}\n- Git status --short (session-touched paths only):\n${input.git.statusShort}\n- Git diff --stat (session-touched paths only):\n${input.git.diffStat}`
: ''}

${input.body.trim()}
</pi:mirastyle_compacted_coding_context>`;
}
