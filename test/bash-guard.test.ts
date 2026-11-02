import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBashCall, DEFAULT_LONG_COMMANDS, parseLongCommands, slowBashHint } from "../src/bash-guard.ts";

const opts = { timeoutThresholdS: 120 };

test("the screenshot: bash with a high timeout is blocked", () => {
	const cmd = "cd ~/projetos/pi-web-research && npm test 2>&1 | tail -8 && npm run test:vitest 2>&1 | tail -6";
	const verdict = checkBashCall({ command: cmd, timeout: 600 }, opts);
	assert.equal(verdict.block, true);
	assert.match(verdict.block ? verdict.reason : "", /timeout: 600/);
	assert.equal(checkBashCall({ command: "npm test 2>&1 | tail -8", timeout: 300 }, opts).block, true);
});

test("no timeout, or a timeout at/below the threshold, passes", () => {
	assert.equal(checkBashCall({ command: "npm test" }, opts).block, false);
	assert.equal(checkBashCall({ command: "ls", timeout: 120 }, opts).block, false);
	assert.equal(checkBashCall({ command: "ls", timeout: 30 }, opts).block, false);
});

test("threshold 0 disables the timeout check", () => {
	assert.equal(checkBashCall({ command: "ls", timeout: 9999 }, { timeoutThresholdS: 0 }).block, false);
});

test("long-command list is opt-in", () => {
	assert.equal(checkBashCall({ command: "npm test" }, opts).block, false);
	const on = { ...opts, longCommands: DEFAULT_LONG_COMMANDS };
	assert.equal(checkBashCall({ command: "npm test 2>&1 | tail" }, on).block, true);
	assert.equal(checkBashCall({ command: "pnpm run test" }, on).block, true);
	assert.equal(checkBashCall({ command: "npx vitest run" }, on).block, true);
	assert.equal(checkBashCall({ command: "cargo build --release" }, on).block, true);
	assert.equal(checkBashCall({ command: "gh run watch 123" }, on).block, true);
	assert.equal(checkBashCall({ command: "git commit -m 'fix npm test'" }, on).block, false);
	assert.equal(checkBashCall({ command: "npm run lint" }, on).block, false);
});

test("PI_WATCH_LONG_COMMANDS parsing", () => {
	assert.equal(parseLongCommands(undefined), undefined);
	assert.equal(parseLongCommands("0"), undefined);
	assert.equal(parseLongCommands("1"), DEFAULT_LONG_COMMANDS);
	assert.equal(parseLongCommands("\\bmake\\b")?.test("make all"), true);
});

test("slow bash hint above the threshold only; 0 disables", () => {
	assert.equal(slowBashHint(29_000, 30), undefined);
	assert.match(slowBashHint(61_000, 30) ?? "", /61s.*process_start/);
	assert.equal(slowBashHint(600_000, 0), undefined);
});
