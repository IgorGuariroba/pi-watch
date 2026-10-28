import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { matches, validate, type Condition } from "./condition.ts";

export interface ManagerOptions {
	logDir: string;
	minIntervalMs?: number;
	defaultIntervalMs?: number;
	maxTimeoutMs?: number;
	maxActive?: number;
	defaultExecTimeoutMs?: number;
	batchWindowMs?: number;
	tailLines?: number;
	tailBytes?: number;
}

export interface ProcessSpec {
	cmd: string;
	cwd?: string;
	env?: Record<string, string>;
	name?: string;
}

export interface ProcessInfo {
	id: string;
	name: string;
	cmd: string;
	pid: number | undefined;
	status: "running" | "exited";
	exitCode: number | null;
	signal: string | null;
	startedAt: number;
	endedAt?: number;
	logPath: string;
}

export type Source =
	| { kind: "process"; id: string }
	| {
			kind: "poll";
			cmd: string;
			intervalMs?: number;
			cwd?: string;
			execTimeoutMs?: number;
			backoff?: { factor: number; maxIntervalMs: number };
	  };

export interface WatchSpec {
	goal: string;
	source: Source;
	success: Condition;
	failure?: Condition;
	timeoutMs: number;
}

export type Outcome = "success" | "failure" | "timeout" | "error";

export interface WatchResult {
	watchId: string;
	goal: string;
	outcome: Outcome;
	reason: string;
	observation: Record<string, unknown>;
	tail: string;
	elapsedMs: number;
}

export interface WatchInfo {
	id: string;
	goal: string;
	source: Source;
	createdAt: number;
	timeoutMs: number;
}

interface ProcState {
	info: ProcessInfo;
	child: ChildProcess;
	lines: string[];
	log: WriteStream;
}

interface WatchState {
	info: WatchInfo;
	spec: WatchSpec;
	deadline?: NodeJS.Timeout;
	pollTimer?: NodeJS.Timeout;
	pollChild?: ChildProcess;
	attempt: number;
	lastTail: string;
	lastObservation?: Record<string, unknown>;
}

const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

export class WatchManager {
	private opts: Required<ManagerOptions>;
	private procs = new Map<string, ProcState>();
	private watches = new Map<string, WatchState>();
	private listeners = new Set<(batch: WatchResult[]) => void>();
	private pending: WatchResult[] = [];
	private batchTimer: NodeJS.Timeout | undefined;
	private seq = 0;

	constructor(opts: ManagerOptions) {
		this.opts = { maxTimeoutMs: 2 * 60 * 60 * 1000, maxActive: 10, minIntervalMs: 2000, defaultIntervalMs: 15000, defaultExecTimeoutMs: 30000, batchWindowMs: 2000, tailLines: 50, tailBytes: 4096, ...opts };
		mkdirSync(this.opts.logDir, { recursive: true });
	}

	onSettled(cb: (batch: WatchResult[]) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	startProcess(spec: ProcessSpec): ProcessInfo {
		const id = `p${++this.seq}`;
		const logPath = join(this.opts.logDir, `${id}.log`);
		const log = createWriteStream(logPath);
		const child = spawn(SHELL, ["-c", spec.cmd], {
			cwd: spec.cwd,
			env: { ...process.env, ...spec.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const info: ProcessInfo = {
			id,
			name: spec.name ?? spec.cmd.slice(0, 40),
			cmd: spec.cmd,
			pid: child.pid,
			status: "running",
			exitCode: null,
			signal: null,
			startedAt: Date.now(),
			logPath,
		};
		const state: ProcState = { info, child, lines: [], log };
		this.procs.set(id, state);
		for (const [streamName, stream] of [["stdout", child.stdout!], ["stderr", child.stderr!]] as const) {
			let buf = "";
			stream.on("data", (chunk: Buffer) => {
				log.write(chunk);
				buf += chunk.toString();
				const parts = buf.split("\n");
				buf = parts.pop()!;
				for (const line of parts) this.onLine(state, line, streamName);
			});
			stream.on("end", () => {
				if (buf) this.onLine(state, buf, streamName);
				buf = "";
			});
		}
		child.on("close", (code, signal) => {
			info.status = "exited";
			info.exitCode = code;
			info.signal = signal;
			info.endedAt = Date.now();
			log.end();
			this.onExit(state);
		});
		return { ...info };
	}

	createWatch(spec: WatchSpec): WatchInfo {
		this.validateWatch(spec);
		const id = `w${++this.seq}`;
		const info: WatchInfo = { id, goal: spec.goal, source: spec.source, createdAt: Date.now(), timeoutMs: spec.timeoutMs };
		const w: WatchState = { info, spec, attempt: 0, lastTail: "" };
		this.watches.set(id, w);
		w.deadline = setTimeout(() => {
			const proc = spec.source.kind === "process" ? this.procs.get(spec.source.id) : undefined;
			this.settle(w, "timeout", `no success within ${humanMs(spec.timeoutMs)}`, { ...w.lastObservation, event: "timeout" }, proc);
		}, spec.timeoutMs);
		if (spec.source.kind === "process") {
			const proc = this.procs.get(spec.source.id);
			if (proc?.info.status === "exited") this.evaluateExit(w, proc);
		} else {
			this.pollOnce(w);
		}
		return { ...info };
	}

	listWatches(): WatchInfo[] {
		return [...this.watches.values()].map((w) => ({ ...w.info }));
	}

	cancel(watchId: string): boolean {
		const w = this.watches.get(watchId);
		if (!w) return false;
		this.watches.delete(watchId);
		this.stopWatch(w);
		return true;
	}

	killProcess(procId: string, graceMs = 3000): boolean {
		const p = this.procs.get(procId);
		if (!p || p.info.status !== "running") return false;
		killGroup(p.info.pid, "SIGTERM");
		setTimeout(() => {
			if (p.info.status === "running") killGroup(p.info.pid, "SIGKILL");
		}, graceMs).unref();
		return true;
	}

	logs(procId: string, opts: { tail?: number; grep?: string } = {}): { text: string; logPath: string; totalLines: number } {
		const p = this.procs.get(procId);
		if (!p) throw new Error(`unknown process "${procId}"`);
		let lines = existsSync(p.info.logPath) ? readFileSync(p.info.logPath, "utf8").split("\n") : [];
		if (lines.at(-1) === "") lines.pop();
		const totalLines = lines.length;
		if (opts.grep) {
			const re = new RegExp(opts.grep);
			lines = lines.filter((l) => re.test(l));
		}
		if (opts.tail) lines = lines.slice(-opts.tail);
		return { text: lines.join("\n"), logPath: p.info.logPath, totalLines };
	}

	listProcesses(): ProcessInfo[] {
		return [...this.procs.values()].map((p) => ({ ...p.info }));
	}

	private validateWatch(spec: WatchSpec): void {
		const max = this.opts.maxTimeoutMs;
		if (!spec.goal?.trim()) throw new Error("goal is required: describe what you are waiting for");
		if (typeof spec.timeoutMs !== "number" || !(spec.timeoutMs > 0))
			throw new Error("timeoutMs is required: estimate how long this should take at most");
		if (spec.timeoutMs > max)
			throw new Error(`timeoutMs ${spec.timeoutMs} exceeds the maximum of ${max} (PI_WATCH_MAX_TIMEOUT_MS)`);
		const errors = [
			...validate(spec.success).map((e) => `success: ${e}`),
			...(spec.failure ? validate(spec.failure).map((e) => `failure: ${e}`) : []),
		];
		if (errors.length) throw new Error(`invalid condition: ${errors.join("; ")}`);
		if (spec.source.kind === "process" && !this.procs.has(spec.source.id))
			throw new Error(`unknown process "${spec.source.id}" (start it with process_start first)`);
		if (this.watches.size >= this.opts.maxActive)
			throw new Error(`limit of ${this.opts.maxActive} active watches reached; cancel one with watch_cancel`);
	}

	shutdown(): void {
		for (const p of this.procs.values()) {
			if (p.info.status !== "running") continue;
			killGroup(p.info.pid, "SIGTERM");
			setTimeout(() => killGroup(p.info.pid, "SIGKILL"), 500);
		}
		for (const w of this.watches.values()) this.stopWatch(w);
		this.watches.clear();
		clearTimeout(this.batchTimer);
	}

	private onLine(state: ProcState, line: string, stream: "stdout" | "stderr"): void {
		state.lines.push(line);
		if (state.lines.length > this.opts.tailLines) state.lines.shift();
		const observation = { event: "line", line, stream, elapsedMs: Date.now() - state.info.startedAt };
		for (const w of this.watchesOn(state.info.id)) {
			if (matches(w.spec.success, observation)) this.settle(w, "success", "success condition matched", observation, state);
			else if (w.spec.failure && matches(w.spec.failure, observation))
				this.settle(w, "failure", "failure condition matched", observation, state);
		}
	}

	private pollOnce(w: WatchState): void {
		const source = w.spec.source;
		if (source.kind !== "poll" || !this.watches.has(w.info.id)) return;
		w.attempt++;
		const attempt = w.attempt;
		const child = spawn(SHELL, ["-c", source.cmd], {
			cwd: source.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		w.pollChild = child;
		let stdout = "";
		let stderr = "";
		child.stdout!.on("data", (c: Buffer) => (stdout = (stdout + c.toString()).slice(-64 * 1024)));
		child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-64 * 1024)));
		let execTimedOut = false;
		const execTimer = setTimeout(() => {
			execTimedOut = true;
			killGroup(child.pid);
		}, source.execTimeoutMs ?? this.opts.defaultExecTimeoutMs);
		child.on("close", (code) => {
			clearTimeout(execTimer);
			w.pollChild = undefined;
			if (!this.watches.has(w.info.id)) return;
			const observation: Record<string, unknown> = {
				event: "poll",
				attempt,
				exitCode: code,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				execTimedOut,
				elapsedMs: Date.now() - w.info.createdAt,
			};
			try {
				observation.json = JSON.parse(stdout);
			} catch {}
			w.lastObservation = observation;
			w.lastTail = tailText([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), this.opts.tailLines, this.opts.tailBytes);
			if (matches(w.spec.success, observation)) return this.settle(w, "success", "success condition matched", observation);
			if (w.spec.failure && matches(w.spec.failure, observation))
				return this.settle(w, "failure", "failure condition matched", observation);
			if (code === 126 || code === 127)
				return this.settle(w, "error", `poll command could not run (exit ${code})`, observation);
			const base = Math.max(this.opts.minIntervalMs, source.intervalMs ?? this.opts.defaultIntervalMs);
			const delay = source.backoff
				? Math.min(source.backoff.maxIntervalMs, base * source.backoff.factor ** (attempt - 1))
				: base;
			w.pollTimer = setTimeout(() => this.pollOnce(w), delay);
		});
	}

	private watchesOn(procId: string): WatchState[] {
		return [...this.watches.values()].filter((w) => w.spec.source.kind === "process" && w.spec.source.id === procId);
	}

	private onExit(state: ProcState): void {
		for (const w of this.watchesOn(state.info.id)) this.evaluateExit(w, state);
	}

	private evaluateExit(w: WatchState, state: ProcState): void {
		const observation = {
			event: "exit",
			exitCode: state.info.exitCode,
			signal: state.info.signal,
			elapsedMs: (state.info.endedAt ?? Date.now()) - state.info.startedAt,
		};
		if (matches(w.spec.success, observation)) this.settle(w, "success", "success condition matched", observation, state);
		else if (w.spec.failure && matches(w.spec.failure, observation))
			this.settle(w, "failure", "failure condition matched", observation, state);
		else {
			const how = state.info.signal ? `killed by ${state.info.signal}` : `exited with code ${state.info.exitCode}`;
			this.settle(w, "failure", `process ${how} without matching success`, observation, state);
		}
	}

	private stopWatch(w: WatchState): void {
		clearTimeout(w.deadline);
		clearTimeout(w.pollTimer);
		killGroup(w.pollChild?.pid);
	}

	private settle(w: WatchState, outcome: Outcome, reason: string, observation: Record<string, unknown>, proc?: ProcState) {
		if (!this.watches.delete(w.info.id)) return;
		this.stopWatch(w);
		this.pending.push({
			watchId: w.info.id,
			goal: w.spec.goal,
			outcome,
			reason,
			observation,
			tail: proc ? tailText(proc.lines.join("\n"), this.opts.tailLines, this.opts.tailBytes) : w.lastTail,
			elapsedMs: Date.now() - w.info.createdAt,
		});
		if (!this.batchTimer) {
			this.batchTimer = setTimeout(() => {
				this.batchTimer = undefined;
				const batch = this.pending;
				this.pending = [];
				for (const l of [...this.listeners]) l(batch);
			}, this.opts.batchWindowMs);
		}
	}
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {}
}

function tailText(text: string, maxLines: number, maxBytes: number): string {
	let out = text.split("\n").slice(-maxLines).join("\n");
	if (out.length > maxBytes) out = "…" + out.slice(-maxBytes);
	return out;
}

function humanMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
