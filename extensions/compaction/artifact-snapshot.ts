import { isAbsolute, relative, resolve as resolveFsPath } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	findEntryIndexById,
	findPreviousCompactionIndex,
	getBoundaryStartIndex,
	messageFromEntry,
} from "./session-history.ts";

const GIT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_GIT_FIELD_CHARS = 4_000;

export interface GitSnapshot {
	isGitRepo: boolean;
	branch: string;
	statusShort: string;
	diffStat: string;
	scope: string;
	pathspecCount: number;
}

export interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CutpointFileOps {
	compactedFileOps: FileOps;
	retainedFileOps: FileOps;
	allFileOps: FileOps;
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set([...values].filter((value) => value.trim().length > 0))].sort();
}

function createFileOps(): FileOps {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

function mergeFileOps(target: FileOps, source: FileOps): void {
	for (const file of source.read) target.read.add(file);
	for (const file of source.written) target.written.add(file);
	for (const file of source.edited) target.edited.add(file);
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOps): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return;
	}

	for (const block of message.content) {
		if (typeof block !== "object" || block === null || block.type !== "toolCall") {
			continue;
		}

		const toolCall = block as { name?: string; arguments?: { path?: unknown } };
		const path = typeof toolCall.arguments?.path === "string" ? toolCall.arguments.path : undefined;
		if (!path) {
			continue;
		}

		switch (toolCall.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

export function computeFileLists(fileOps: FileOps): FileLists {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = sortedUnique([...fileOps.read].filter((file) => !modified.has(file)));
	const modifiedFiles = sortedUnique(modified);
	return { readFiles, modifiedFiles };
}

export function listTouchedFiles(fileLists: FileLists): string[] {
	return sortedUnique([...fileLists.readFiles, ...fileLists.modifiedFiles]);
}

function extractFileOpsFromEntries(entries: SessionEntry[]): FileOps {
	const fileOps = createFileOps();
	for (const entry of entries) {
		const message = messageFromEntry(entry);
		if (message) {
			extractFileOpsFromMessage(message, fileOps);
		}
	}
	return fileOps;
}

function mergePreviousCompactionFileOps(entries: SessionEntry[], fileOps: FileOps): void {
	const previousCompactionIndex = findPreviousCompactionIndex(entries);
	if (previousCompactionIndex < 0) {
		return;
	}

	const previousCompaction = entries[previousCompactionIndex];
	// Only import file ops from Pi-generated compactions (not extension-generated ones).
	// Extension-generated compactions can store arbitrary data in details.
	if (previousCompaction.type !== "compaction" || previousCompaction.fromHook || !previousCompaction.details) {
		return;
	}

	const details = previousCompaction.details as { readFiles?: unknown; modifiedFiles?: unknown };
	if (Array.isArray(details.readFiles)) {
		for (const file of details.readFiles) {
			if (typeof file === "string") {
				fileOps.read.add(file);
			}
		}
	}
	if (Array.isArray(details.modifiedFiles)) {
		for (const file of details.modifiedFiles) {
			if (typeof file === "string") {
				fileOps.edited.add(file);
			}
		}
	}
}

export function computeFileOpsForCutpoint(branchEntries: SessionEntry[], firstKeptEntryId: string): CutpointFileOps {
	const boundaryStart = getBoundaryStartIndex(branchEntries);
	const firstKeptIndex = findEntryIndexById(branchEntries, firstKeptEntryId);
	const safeFirstKeptIndex = firstKeptIndex >= 0 ? firstKeptIndex : branchEntries.length;

	const compactedFileOps = extractFileOpsFromEntries(branchEntries.slice(boundaryStart, safeFirstKeptIndex));
	mergePreviousCompactionFileOps(branchEntries, compactedFileOps);

	const retainedFileOps = extractFileOpsFromEntries(branchEntries.slice(safeFirstKeptIndex));
	const allFileOps = createFileOps();
	mergeFileOps(allFileOps, compactedFileOps);
	mergeFileOps(allFileOps, retainedFileOps);

	return { compactedFileOps, retainedFileOps, allFileOps };
}

function truncateDisplayField(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxChars)}\n[truncated ${trimmed.length - maxChars} chars]`;
}

export function normalizeGitPathspecs(cwd: string, gitRoot: string, touchedFiles: string[]): string[] {
	const resolvedCwd = resolveFsPath(cwd);
	const resolvedGitRoot = resolveFsPath(gitRoot);
	const pathspecs = new Set<string>();

	for (const file of touchedFiles) {
		const trimmed = file.trim();
		if (!trimmed) {
			continue;
		}

		let absolutePath: string;
		if (isAbsolute(trimmed)) {
			absolutePath = resolveFsPath(trimmed);
		} else {
			// Try resolving relative to cwd first, then fall back to git root.
			// The model may use paths relative to the project root while ctx.cwd
			// points elsewhere, so both bases need checking.
			absolutePath = resolveFsPath(resolvedCwd, trimmed);
			const relativeFromRoot = relative(resolvedGitRoot, absolutePath);
			if (relativeFromRoot && !relativeFromRoot.startsWith("..") && !isAbsolute(relativeFromRoot)) {
				pathspecs.add(`:(top)${relativeFromRoot.split("\\").join("/")}`);
				continue;
			}

			// Fallback: treat the path as relative to the git root directly.
			absolutePath = resolveFsPath(resolvedGitRoot, trimmed);
		}

		const relativePath = relative(resolvedGitRoot, absolutePath);
		if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
			continue;
		}
		pathspecs.add(`:(top)${relativePath.split("\\").join("/")}`);
	}

	return [...pathspecs].sort();
}

export async function safeGitSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal,
	touchedFiles: string[],
): Promise<GitSnapshot> {
	const execOptions = { cwd: ctx.cwd, timeout: GIT_COMMAND_TIMEOUT_MS, signal };
	try {
		const inside = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], execOptions);
		if (inside.code !== 0 || inside.stdout.trim() !== "true") {
			return {
				isGitRepo: false,
				branch: "Not a git repository.",
				statusShort: "",
				diffStat: "",
				scope: "not-a-git-repository",
				pathspecCount: 0,
			};
		}

		const [branchResult, gitRootResult] = await Promise.all([
			pi.exec("git", ["branch", "--show-current"], execOptions),
			pi.exec("git", ["rev-parse", "--show-toplevel"], execOptions),
		]);
		const branch = truncateDisplayField(branchResult.stdout || "(detached or unnamed HEAD)", MAX_GIT_FIELD_CHARS);

		if (gitRootResult.code !== 0 || !gitRootResult.stdout.trim()) {
			return {
				isGitRepo: true,
				branch,
				statusShort: "Git root unavailable; scoped status omitted.",
				diffStat: "Git root unavailable; scoped diff stat omitted.",
				scope: "session-touched paths only; git root unavailable",
				pathspecCount: 0,
			};
		}

		const pathspecs = normalizeGitPathspecs(ctx.cwd, gitRootResult.stdout.trim(), touchedFiles);
		const scope = `session-touched paths only (${pathspecs.length} pathspec${pathspecs.length === 1 ? "" : "s"}); repo-wide status/diff intentionally omitted`;
		if (pathspecs.length === 0) {
			return {
				isGitRepo: true,
				branch,
				statusShort: "Could not resolve session-touched file paths within this git repository; scoped status omitted.",
				diffStat: "Could not resolve session-touched file paths within this git repository; scoped diff stat omitted.",
				scope,
				pathspecCount: 0,
			};
		}

		const [statusResult, diffStatResult] = await Promise.all([
			pi.exec("git", ["status", "--short", "--", ...pathspecs], execOptions),
			pi.exec("git", ["diff", "--stat", "--", ...pathspecs], execOptions),
		]);

		const statusText = statusResult.code === 0
			? statusResult.stdout || "Clean session-touched paths."
			: `git status failed (exit ${statusResult.code}): ${statusResult.stderr || statusResult.stdout || "no output"}`;
		const diffText = diffStatResult.code === 0
			? diffStatResult.stdout || "No unstaged diff stat for session-touched paths."
			: `git diff --stat failed (exit ${diffStatResult.code}): ${diffStatResult.stderr || diffStatResult.stdout || "no output"}`;

		return {
			isGitRepo: true,
			branch,
			statusShort: truncateDisplayField(statusText, MAX_GIT_FIELD_CHARS),
			diffStat: truncateDisplayField(diffText, MAX_GIT_FIELD_CHARS),
			scope,
			pathspecCount: pathspecs.length,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			isGitRepo: false,
			branch: `Git snapshot unavailable: ${message}`,
			statusShort: "",
			diffStat: "",
			scope: "git snapshot unavailable",
			pathspecCount: 0,
		};
	}
}
