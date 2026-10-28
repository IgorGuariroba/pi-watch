import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchManager, type WatchResult } from "../src/watch-manager.ts";

let managers: WatchManager[] = [];
afterEach(() => {
	for (const m of managers) m.shutdown();
	managers = [];
});

function makeManager(opts: Partial<ConstructorParameters<typeof WatchManager>[0]> = {}) {
	const m = new WatchManager({
		logDir: mkdtempSync(join(tmpdir(), "pi-watch-test-")),
		minIntervalMs: 0,
		batchWindowMs: 20,
		...opts,
	});
	managers.push(m);
	return m;
}

function nextBatch(m: WatchManager): Promise<WatchResult[]> {
	return new Promise((resolve) => {
		const off = m.onSettled((batch) => {
			off();
			resolve(batch);
		});
	});
}

test("process exiting 0 settles a success watch", async () => {
	const m = makeManager();
	const proc = m.startProcess({ cmd: "echo building; exit 0" });
	m.createWatch({
		goal: "build finishes",
		source: { kind: "process", id: proc.id },
		success: { exitCode: { eq: 0 } },
		timeoutMs: 5000,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "success");
	assert.equal(result.goal, "build finishes");
	assert.equal(result.observation.exitCode, 0);
	assert.match(result.tail, /building/);
});

test("process exiting without matching success settles as failure with output tail", async () => {
	const m = makeManager();
	const proc = m.startProcess({ cmd: "echo 'FAIL src/a.test.ts' >&2; exit 1" });
	m.createWatch({
		goal: "tests pass",
		source: { kind: "process", id: proc.id },
		success: { exitCode: { eq: 0 } },
		timeoutMs: 5000,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "failure");
	assert.match(result.reason, /exited .*without matching success/);
	assert.equal(result.observation.exitCode, 1);
	assert.match(result.tail, /FAIL src\/a.test.ts/);
});

test("a matching output line settles while the process keeps running", async () => {
	const m = makeManager();
	const proc = m.startProcess({ cmd: "echo booting; echo 'Listening on :3000'; sleep 30" });
	m.createWatch({
		goal: "dev server up",
		source: { kind: "process", id: proc.id },
		success: { line: { regex: "Listening on :\\d+" } },
		failure: { line: { contains: "EADDRINUSE" } },
		timeoutMs: 5000,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "success");
	assert.equal(result.observation.line, "Listening on :3000");
	assert.equal(m.listProcesses()[0].status, "running");
});

test("watch on an already-exited process settles immediately", async () => {
	const m = makeManager();
	const proc = m.startProcess({ cmd: "exit 0" });
	while (m.listProcesses()[0].status === "running") await new Promise((r) => setTimeout(r, 10));
	m.createWatch({
		goal: "late watch",
		source: { kind: "process", id: proc.id },
		success: { exitCode: { eq: 0 } },
		timeoutMs: 5000,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "success");
});

test("deadline expiring settles as timeout and leaves the process running", async () => {
	const m = makeManager();
	const proc = m.startProcess({ cmd: "echo still working; sleep 30" });
	m.createWatch({
		goal: "slow job",
		source: { kind: "process", id: proc.id },
		success: { exitCode: { eq: 0 } },
		timeoutMs: 150,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "timeout");
	assert.match(result.reason, /no success within 150ms/);
	assert.match(result.tail, /still working/);
	assert.equal(m.listProcesses()[0].status, "running");
});

function fakeRegistry(readyOnAttempt: number): string {
	const counter = join(mkdtempSync(join(tmpdir(), "pi-watch-reg-")), "n");
	return `n=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 )); echo $n > ${counter}; [ $n -ge ${readyOnAttempt} ] && echo 0.2.0 || echo 0.1.0`;
}

test("poll reruns the command until stdout matches", async () => {
	const m = makeManager();
	m.createWatch({
		goal: "npm shows 0.2.0",
		source: { kind: "poll", cmd: fakeRegistry(3), intervalMs: 20 },
		success: { stdout: { eq: "0.2.0" } },
		timeoutMs: 5000,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "success");
	assert.equal(result.observation.stdout, "0.2.0");
	assert.equal(result.observation.attempt, 3);
});

test("poll parses json stdout so CI status can drive success and failure", async () => {
	const m = makeManager();
	m.createWatch({
		goal: "CI run 42 green",
		source: { kind: "poll", cmd: `echo '{"status":"completed","conclusion":"failure"}'`, intervalMs: 20 },
		success: { all: [{ "json.status": { eq: "completed" } }, { "json.conclusion": { eq: "success" } }] },
		failure: { all: [{ "json.status": { eq: "completed" } }, { "json.conclusion": { ne: "success" } }] },
		timeoutMs: 5000,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "failure");
	assert.equal(result.reason, "failure condition matched");
	assert.deepEqual(result.observation.json, { status: "completed", conclusion: "failure" });
});

test("poll command that cannot run settles as error right away", async () => {
	const m = makeManager();
	m.createWatch({
		goal: "typo",
		source: { kind: "poll", cmd: "definitely-not-a-command-xyz --version", intervalMs: 20 },
		success: { exitCode: { eq: 0 } },
		timeoutMs: 5000,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "error");
	assert.equal(result.observation.attempt, 1);
	assert.match(result.tail, /definitely-not-a-command-xyz/);
});

test("watches settling within the batch window are delivered together", async () => {
	const m = makeManager({ batchWindowMs: 200 });
	const a = m.startProcess({ cmd: "exit 0" });
	const b = m.startProcess({ cmd: "sleep 0.05; exit 3" });
	for (const p of [a, b])
		m.createWatch({ goal: p.id, source: { kind: "process", id: p.id }, success: { exitCode: { eq: 0 } }, timeoutMs: 5000 });
	let calls = 0;
	m.onSettled(() => calls++);
	const batch = await nextBatch(m);
	assert.deepEqual(batch.map((r) => r.outcome).sort(), ["failure", "success"]);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(calls, 1);
});

test("createWatch rejects bad specs with actionable messages", () => {
	const m = makeManager({ maxTimeoutMs: 60_000, maxActive: 1 });
	const proc = m.startProcess({ cmd: "sleep 30" });
	const ok = { goal: "g", source: { kind: "process" as const, id: proc.id }, success: { exitCode: { eq: 0 } }, timeoutMs: 1000 };
	assert.throws(() => m.createWatch({ ...ok, timeoutMs: undefined as any }), /timeoutMs is required/);
	assert.throws(() => m.createWatch({ ...ok, timeoutMs: 120_000 }), /timeoutMs 120000 exceeds the maximum of 60000/);
	assert.throws(() => m.createWatch({ ...ok, success: { exitCode: { equals: 0 } } }), /success: unknown operator "equals"/);
	assert.throws(() => m.createWatch({ ...ok, failure: { stdout: { regex: "(" } } }), /failure: invalid regex/);
	assert.throws(() => m.createWatch({ ...ok, source: { kind: "process", id: "p999" } }), /unknown process "p999"/);
	assert.throws(() => m.createWatch({ ...ok, goal: " " }), /goal is required/);
	m.createWatch(ok);
	assert.throws(() => m.createWatch(ok), /limit of 1 active watches reached/);
});

test("cancelled watch never settles and leaves the list", async () => {
	const m = makeManager();
	const w = m.createWatch({
		goal: "never",
		source: { kind: "poll", cmd: "echo 0.1.0", intervalMs: 10 },
		success: { stdout: { eq: "0.2.0" } },
		timeoutMs: 100,
	});
	assert.deepEqual(m.listWatches().map((x) => x.id), [w.id]);
	assert.equal(m.cancel(w.id), true);
	assert.equal(m.cancel(w.id), false);
	assert.deepEqual(m.listWatches(), []);
	let settled = false;
	m.onSettled(() => (settled = true));
	await new Promise((r) => setTimeout(r, 250));
	assert.equal(settled, false);
});

test("killProcess terminates the process and its watch settles as failure", async () => {
	const m = makeManager();
	const proc = m.startProcess({ cmd: "sleep 30" });
	m.createWatch({ goal: "g", source: { kind: "process", id: proc.id }, success: { exitCode: { eq: 0 } }, timeoutMs: 5000 });
	assert.equal(m.killProcess(proc.id), true);
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "failure");
	assert.match(result.reason, /killed by SIGTERM/);
	assert.equal(m.listProcesses()[0].status, "exited");
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("shutdown kills the whole process group, grandchildren included", async () => {
	const m = makeManager();
	const proc = m.startProcess({ cmd: "sleep 30 & echo $!; wait" });
	while (!m.logs(proc.id).text.trim()) await new Promise((r) => setTimeout(r, 10));
	const grandchild = Number(m.logs(proc.id).text.trim());
	assert.equal(alive(grandchild), true);
	m.shutdown();
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(alive(proc.pid!), false);
	assert.equal(alive(grandchild), false);
});

test("logs reads the full file with tail and grep beyond the in-memory tail", async () => {
	const m = makeManager({ tailLines: 5 });
	const proc = m.startProcess({ cmd: "echo 'error TS2304: early failure'; seq 1 200" });
	m.createWatch({ goal: "g", source: { kind: "process", id: proc.id }, success: { exitCode: { eq: 0 } }, timeoutMs: 5000 });
	const [result] = await nextBatch(m);
	assert.doesNotMatch(result.tail, /TS2304/);
	assert.equal(result.tail.split("\n").length, 5);
	const all = m.logs(proc.id);
	assert.equal(all.totalLines, 201);
	assert.equal(m.logs(proc.id, { grep: "TS\\d+" }).text, "error TS2304: early failure");
	assert.equal(m.logs(proc.id, { tail: 2 }).text, "199\n200");
	assert.throws(() => m.logs("p999"), /unknown process/);
});

test("poll timeout reports the last observation and attempt count", async () => {
	const m = makeManager();
	m.createWatch({
		goal: "npm shows 0.2.0",
		source: { kind: "poll", cmd: "echo 0.1.0", intervalMs: 20 },
		success: { stdout: { eq: "0.2.0" } },
		timeoutMs: 200,
	});
	const [result] = await nextBatch(m);
	assert.equal(result.outcome, "timeout");
	assert.equal(result.observation.stdout, "0.1.0");
	assert.ok((result.observation.attempt as number) >= 3);
	assert.equal(result.tail, "0.1.0");
});

async function attemptsWithin(m: WatchManager, source: any, windowMs: number): Promise<number> {
	m.createWatch({ goal: "g", source, success: { stdout: { eq: "never" } }, timeoutMs: windowMs });
	const [result] = await nextBatch(m);
	return result.observation.attempt as number;
}

test("intervalMs is clamped to the minimum", async () => {
	const m = makeManager({ minIntervalMs: 100 });
	const n = await attemptsWithin(m, { kind: "poll", cmd: "echo x", intervalMs: 1 }, 350);
	assert.ok(n <= 4, `expected <= 4 attempts, got ${n}`);
});

test("backoff grows the interval up to its cap", async () => {
	const m = makeManager();
	const flat = await attemptsWithin(m, { kind: "poll", cmd: "echo x", intervalMs: 20 }, 400);
	const backoff = await attemptsWithin(
		m,
		{ kind: "poll", cmd: "echo x", intervalMs: 20, backoff: { factor: 3, maxIntervalMs: 10_000 } },
		400,
	);
	assert.ok(flat >= 8, `flat polling should retry often, got ${flat}`);
	assert.ok(backoff <= 5, `backoff should retry rarely, got ${backoff}`);
});
