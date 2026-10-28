/**
 * Single wire format for the session handoff document reference.
 *
 * The request_compaction tool composes this line into the customInstructions
 * passed to ctx.compact(), making it the only channel the substrate offers
 * into the session_before_compact event. The compaction handler parses it
 * back out and records it deterministically in the checkpoint wrapper and
 * details. A human running /compact with the same line in the instructions
 * gets the identical treatment.
 */

const HANDOFF_LINE_PREFIX = "Session handoff document: ";

export function formatHandoffLine(url: string): string {
	return `${HANDOFF_LINE_PREFIX}${url}`;
}

export function parseHandoffUrl(customInstructions: string | undefined): string | undefined {
	if (!customInstructions) {
		return undefined;
	}
	for (const line of customInstructions.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith(HANDOFF_LINE_PREFIX)) {
			const url = trimmed.slice(HANDOFF_LINE_PREFIX.length).trim();
			if (url) {
				return url;
			}
		}
	}
	return undefined;
}
