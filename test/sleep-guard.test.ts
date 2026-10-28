import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommand } from "../src/sleep-guard.ts";

const opts = { thresholdS: 10 };

test("long sleep is blocked, short sleep passes", () => {
	assert.equal(checkCommand("sleep 20", opts).block, true);
	assert.equal(checkCommand("sleep 2", opts).block, false);
	assert.equal(checkCommand("sleep 10", opts).block, true);
});

test("the screenshots: compound sleep and polling loop are blocked", () => {
	assert.equal(checkCommand("sleep 20; npm view @igor-guari/pi-status-line version --prefer-online", opts).block, true);
	const loop =
		'for i in $(seq 1 10); do v=$(npm view x version 2>/dev/null); [ "$v" = "0.2.0" ] && break; sleep 15; done; echo "registro: $v"';
	assert.equal(checkCommand(loop, opts).block, true);
});

test("any loop containing sleep is blocked, even with a short sleep", () => {
	assert.equal(checkCommand("while ! curl -sf localhost:3000; do sleep 1; done", opts).block, true);
	assert.equal(checkCommand("until gh run view 1 --json status | grep -q completed; do sleep 2; done", opts).block, true);
	assert.equal(checkCommand("for f in *.ts; do echo $f; done", opts).block, false);
});

test("unit suffixes count toward the threshold", () => {
	assert.equal(checkCommand("sleep 1m", opts).block, true);
	assert.equal(checkCommand("sleep 5s", opts).block, false);
	assert.equal(checkCommand("sleep 1h", opts).block, true);
});

test("sleep inside quotes or comments is not a sleep", () => {
	assert.equal(checkCommand('echo "sleep 99"', opts).block, false);
	assert.equal(checkCommand("git commit -m 'remove sleep 30 from loop'", opts).block, false);
	assert.equal(checkCommand("ls # sleep 60", opts).block, false);
	assert.equal(checkCommand("grep -rn 'for x do sleep 1 done' src", opts).block, false);
	assert.equal(checkCommand("./sleepy 30", opts).block, false);
});
