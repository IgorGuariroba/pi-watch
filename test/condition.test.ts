import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, validate } from "../src/condition.ts";

test("eq compares a top-level field", () => {
	assert.equal(matches({ exitCode: { eq: 0 } }, { exitCode: 0 }), true);
	assert.equal(matches({ exitCode: { eq: 0 } }, { exitCode: 1 }), false);
});

test("dotted path reaches into parsed json", () => {
	const obs = { json: { status: "completed", conclusion: "success" } };
	assert.equal(matches({ "json.status": { eq: "completed" } }, obs), true);
	assert.equal(matches({ "json.conclusion": { eq: "failure" } }, obs), false);
	assert.equal(matches({ "json.missing.deep": { eq: "x" } }, obs), false);
});

test("regex and contains match text", () => {
	const obs = { stdout: "Server listening on :3000", line: "PASS 12 tests" };
	assert.equal(matches({ stdout: { regex: "listening on :\\d+" } }, obs), true);
	assert.equal(matches({ stdout: { regex: "^error" } }, obs), false);
	assert.equal(matches({ line: { contains: "PASS" } }, obs), true);
	assert.equal(matches({ line: { contains: "FAIL" } }, obs), false);
});

test("ne, gt, lt and in", () => {
	const obs = { exitCode: 2, elapsedMs: 5000, json: { conclusion: "cancelled" } };
	assert.equal(matches({ exitCode: { ne: 0 } }, obs), true);
	assert.equal(matches({ exitCode: { ne: 2 } }, obs), false);
	assert.equal(matches({ elapsedMs: { gt: 4000 } }, obs), true);
	assert.equal(matches({ elapsedMs: { lt: 4000 } }, obs), false);
	assert.equal(matches({ "json.conclusion": { in: ["failure", "cancelled"] } }, obs), true);
	assert.equal(matches({ "json.conclusion": { in: ["success"] } }, obs), false);
});

test("all and any combine nested conditions", () => {
	const done = { json: { status: "completed", conclusion: "failure" } };
	const failed = { all: [{ "json.status": { eq: "completed" } }, { "json.conclusion": { ne: "success" } }] };
	assert.equal(matches(failed, done), true);
	assert.equal(matches({ any: [{ exitCode: { eq: 0 } }, { "json.status": { eq: "completed" } }] }, done), true);
	assert.equal(matches({ any: [{ exitCode: { eq: 0 } }, { "json.status": { eq: "queued" } }] }, done), false);
});

test("validate reports unknown operators, bad regex and malformed combinators", () => {
	assert.deepEqual(validate({ exitCode: { eq: 0 } }), []);
	assert.deepEqual(validate({ all: [{ "json.status": { in: ["a"] } }, { stdout: { regex: "ok" } }] }), []);
	assert.match(validate({ exitCode: { equals: 0 } })[0], /unknown operator "equals" on "exitCode"/);
	assert.match(validate({ stdout: { regex: "(" } })[0], /invalid regex on "stdout"/);
	assert.match(validate({ any: { exitCode: { eq: 0 } } })[0], /"any" must be a non-empty array/);
	assert.match(validate({ "json.x": { in: "a" } })[0], /"in" on "json.x" must be an array/);
	assert.match(validate({ exitCode: 0 })[0], /"exitCode" must be an object of operators/);
	assert.match(validate({})[0], /empty condition/);
});

test("a field absent from the observation never matches, not even ne", () => {
	const lineEvent = { event: "line", line: "build ok" };
	assert.equal(matches({ exitCode: { ne: 0 } }, lineEvent), false);
	assert.equal(matches({ "json.conclusion": { ne: "success" } }, lineEvent), false);
	assert.equal(matches({ exitCode: { ne: 0 } }, { exitCode: null }), false);
});
