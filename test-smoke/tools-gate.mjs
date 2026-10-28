// Smoke test for the request_compaction handoff gate.
// Run: node --experimental-strip-types test-smoke/tools-gate.mjs
// Imports the extension source directly (node 24 strips types natively for
// type-only syntax; the sources use no runtime-requiring TS features).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { installTools, buildOrientationMessage } = await import(
	new URL("../extensions/compaction/tools.ts", import.meta.url).href
);

const captured = {};
const pi = {
	registerFlag(name, opts) { captured.flags ??= {}; captured.flags[name] = opts; },
	registerTool(tool) { captured.tool = tool; },
	getFlag: () => undefined,
	on() {},
	sendUserMessage(msg) { captured.sent ??= []; captured.sent.push(msg); },
};
installTools(pi);
assert.equal(captured.tool.name, "request_compaction");
assert.ok(captured.flags["mirastyle-compaction-autocontinue"], "autocontinue flag registered");
assert.equal(captured.flags["mirastyle-compaction-autocontinue"].default, false);

const run = (params) => captured.tool.execute("id", params, undefined, undefined, {});

// 1. omitted handoff_url -> nudge naming the skill, isError true
let r = await run({ reason: "milestone" });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /session-handoff skill/);
assert.match(r.content[0].text, /handoff_url/);

// 2. empty string -> same nudge
r = await run({ reason: "milestone", handoff_url: "   " });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /handoff_url is required/);

// 3. nonexistent path -> nudge naming the path
r = await run({ reason: "milestone", handoff_url: "/nonexistent/handoff.md" });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /\/nonexistent\/handoff\.md/);
assert.match(r.content[0].text, /session-handoff skill/);

// 4. directory path -> refusal
const dir = mkdtempSync(join(tmpdir(), "handoff-gate-"));
r = await run({ reason: "milestone", handoff_url: dir });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /is not a file/);

// 5. real file -> queued, success text names the path
const handoffPath = join(dir, "2026-10-27-handoff-smoke.md");
writeFileSync(handoffPath, "# HANDOFF\n");
r = await run({ reason: "milestone", handoff_url: handoffPath });
assert.equal(r.isError, undefined);
assert.match(r.content[0].text, new RegExp(handoffPath));

// 6. file:// URL normalized to a path and queued
r = await run({ reason: "milestone", handoff_url: `file://${handoffPath}` });
assert.equal(r.isError, undefined);

// 7. orientation message shape
const orientation = buildOrientationMessage(handoffPath);
assert.equal(
	orientation,
	`The context window has just been compacted. Please read ${handoffPath} and other related orientation documentation, then resume your work.`,
);

// 8. handoff-reference format/parse round trip
const href = await import(new URL("../extensions/compaction/handoff-reference.ts", import.meta.url).href);
assert.equal(href.parseHandoffUrl(href.formatHandoffLine("/a/b.md")), "/a/b.md");
assert.equal(href.parseHandoffUrl("Focus: testing"), undefined);
assert.equal(href.parseHandoffUrl(undefined), undefined);
assert.equal(href.parseHandoffUrl("Session handoff document:  "), undefined);

console.log("tools-gate smoke: all 8 groups passed");
