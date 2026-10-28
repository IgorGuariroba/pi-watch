import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { checkCommand } from "./sleep-guard.ts";
import { WatchManager, type WatchResult, type WatchSpec } from "./watch-manager.ts";

const MESSAGE_TYPE = "pi-watch";
const ICON: Record<WatchResult["outcome"], string> = { success: "✅", failure: "❌", timeout: "⌛", error: "❗" };

const env = process.env;
const MAX_TIMEOUT_MS = Number(env.PI_WATCH_MAX_TIMEOUT_MS) || 2 * 60 * 60 * 1000;
const SLEEP_THRESHOLD_S = Number(env.PI_WATCH_SLEEP_THRESHOLD_S) || 10;
const BLOCK_SLEEP = env.PI_WATCH_BLOCK_SLEEP !== "0";

const Condition = (description: string) =>
	Type.Record(Type.String(), Type.Any(), {
		description: `${description}. Shape: { "<field>": { "<op>": value }, ... } (all fields must match) or { "all": [cond...] } / { "any": [cond...] }. Ops: eq, ne, gt, lt, in (array), regex, contains. Fields: exitCode, stdout, stderr, json.<path> (stdout parsed as JSON), line (process output line), stream, signal, elapsedMs, attempt.`,
	});

const WatchFields = {
	goal: Type.String({
		description: "What you are waiting for, in your own words. It is echoed back to you when the watch settles.",
	}),
	success: Condition("Condition that means the goal was reached"),
	failure: Type.Optional(Condition("Condition that means the goal will not be reached; settles immediately as failure")),
	timeoutMs: Type.Number({
		description: `Required. Your estimate of the longest this should take, in ms (max ${MAX_TIMEOUT_MS}). When it expires the watch settles as "timeout" with the last observation.`,
	}),
};

const PollSchema = Type.Object({
	cmd: Type.String({ description: "Shell command run on each attempt. Keep it fast and side-effect free (a status check)." }),
	intervalMs: Type.Optional(Type.Number({ description: "Delay between attempts (default 15000, min 2000)" })),
	cwd: Type.Optional(Type.String()),
	execTimeoutMs: Type.Optional(Type.Number({ description: "Per-attempt timeout (default 30000)" })),
	backoff: Type.Optional(
		Type.Object({ factor: Type.Number(), maxIntervalMs: Type.Number() }, { description: "Grow the interval each attempt" }),
	),
});

const GUIDELINES = [
	"Never wait inside bash with `sleep N` or `for/while/until ... sleep ... done` loops: they block the turn, hit the bash timeout and waste context. Register a watch and end your turn instead; you will be woken up with the result.",
	"Long-running command (tests, build, deploy script, `gh run watch`): process_start with an inline `watch` (e.g. success { exitCode: { eq: 0 } }). For a server, wait for a line: success { line: { regex: \"Listening on\" } }.",
	"External state that changes on its own (npm registry propagation, CI status, deploy health, PR merged): watch_create with `poll` and a cheap status command. Examples: npm → poll.cmd `npm view <pkg> version --prefer-online`, success { stdout: { eq: \"1.2.3\" } }; GitHub Actions → `gh run view <id> --json status,conclusion`, success { all: [{ \"json.status\": { eq: \"completed\" } }, { \"json.conclusion\": { eq: \"success\" } }] }, failure { all: [{ \"json.status\": { eq: \"completed\" } }, { \"json.conclusion\": { ne: \"success\" } }] }; HTTP → `curl -s -o /dev/null -w '%{http_code}' <url>`, success { stdout: { eq: \"200\" } }.",
	"Always set timeoutMs to a realistic estimate and add a failure condition when one exists, so the wait can never hang forever.",
	"After registering a watch, tell the user what you are waiting for and END YOUR TURN. Do not call watch_list repeatedly to check progress; the result is delivered to you automatically.",
];

function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function compactObservation(obs: Record<string, unknown>): string {
	const { stdout, stderr, json, ...rest } = obs;
	const shown: Record<string, unknown> = { ...rest };
	if (json !== undefined) shown.json = json;
	else if (typeof stdout === "string" && stdout.length <= 200 && stdout) shown.stdout = stdout;
	const text = JSON.stringify(shown);
	return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

export function formatResults(results: WatchResult[]): string {
	const head =
		results.length === 1 ? "[pi-watch] A watch you registered has settled:" : `[pi-watch] ${results.length} watches you registered have settled:`;
	const blocks = results.map((r) => {
		const lines = [
			`${ICON[r.outcome]} ${r.outcome.toUpperCase()} — goal: "${r.goal}" (${r.watchId}, after ${fmtMs(r.elapsedMs)})`,
			`reason: ${r.reason}`,
			`observation: ${compactObservation(r.observation)}`,
		];
		if (r.tail) lines.push("output tail:", r.tail.replace(/^/gm, "  "));
		return lines.join("\n");
	});
	return [head, ...blocks, "Continue the task based on this result."].join("\n\n");
}

export default function piWatch(pi: ExtensionAPI) {
	let manager: WatchManager | undefined;
	let ctxRef: ExtensionContext | undefined;
	let statusTimer: NodeJS.Timeout | undefined;
	let lastStatus: string | undefined;

	const setStatus = (value: string | undefined) => {
		if (value === lastStatus || !ctxRef?.hasUI) return;
		lastStatus = value;
		ctxRef.ui.setStatus(MESSAGE_TYPE, value);
	};

	const mgr = (): WatchManager => {
		if (!manager) throw new Error("pi-watch is not active in this session yet");
		return manager;
	};

	const refreshStatus = () => {
		if (!manager) return;
		const watches = manager.listWatches();
		const running = manager.listProcesses().filter((p) => p.status === "running").length;
		if (!watches.length && !running) return setStatus(undefined);
		const parts = [];
		if (watches.length) {
			const oldest = Math.min(...watches.map((w) => w.createdAt));
			parts.push(`${watches.length} watch${watches.length > 1 ? "es" : ""} · ${fmtMs(Date.now() - oldest)}`);
		}
		if (running) parts.push(`${running} proc`);
		setStatus(`⏳ ${parts.join(" · ")}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		manager = new WatchManager({
			logDir: join(tmpdir(), "pi-watch", String(process.pid)),
			maxTimeoutMs: MAX_TIMEOUT_MS,
		});
		manager.onSettled((results) => {
			pi.sendMessage(
				{ customType: MESSAGE_TYPE, content: formatResults(results), display: true, details: { results } },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			refreshStatus();
		});
		statusTimer = setInterval(refreshStatus, 1000);
		statusTimer.unref();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearInterval(statusTimer);
		if (!manager) return;
		const active = manager.listWatches().length;
		const running = manager.listProcesses().filter((p) => p.status === "running").length;
		manager.shutdown();
		manager = undefined;
		if ((active || running) && ctx.hasUI)
			ctx.ui.notify(`pi-watch: cancelled ${active} watch(es) and stopped ${running} process(es)`, "warning");
		setStatus(undefined);
		lastStatus = undefined;
	});

	pi.on("tool_call", async (event) => {
		if (!BLOCK_SLEEP || event.toolName !== "bash") return undefined;
		const verdict = checkCommand(String((event.input as { command?: string }).command ?? ""), {
			thresholdS: SLEEP_THRESHOLD_S,
		});
		if (!verdict.block) return undefined;
		return {
			block: true,
			reason: `pi-watch blocked this bash call: ${verdict.reason}. Waiting inside bash blocks the turn. Use watch_create with a poll (e.g. poll.cmd = the status check, success = what "done" looks like, timeoutMs = your estimate) or process_start with an inline watch, then end your turn — you will be woken up with the result. (Disable with PI_WATCH_BLOCK_SLEEP=0.)`,
		};
	});

	pi.registerMessageRenderer<{ results: WatchResult[] }>(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const results = message.details?.results ?? [];
		const color = (o: WatchResult["outcome"]) => (o === "success" ? "success" : o === "timeout" ? "warning" : "error");
		const lines = [theme.fg("accent", theme.bold("⏰ pi-watch woke the agent"))];
		for (const r of results) {
			lines.push(
				`${ICON[r.outcome]} ${theme.fg(color(r.outcome), r.outcome.padEnd(7))} ${r.goal} ${theme.fg("dim", `· ${fmtMs(r.elapsedMs)} · ${r.reason}`)}`,
			);
			if (expanded && r.tail) lines.push(theme.fg("dim", r.tail.replace(/^/gm, "    ")));
		}
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

	pi.registerTool({
		name: "process_start",
		label: "Start process",
		description:
			"Start a shell command in the background and return immediately. Output goes to a log file. Pass `watch` to be woken up when it finishes (or prints a matching line) instead of waiting.",
		promptSnippet: "Run a long command in the background; optionally wake up when it finishes",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command (bash -c)" }),
			cwd: Type.Optional(Type.String()),
			name: Type.Optional(Type.String({ description: "Short label" })),
			env: Type.Optional(Type.Record(Type.String(), Type.String())),
			watch: Type.Optional(Type.Object(WatchFields, { description: "Register a watch on this process right away" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const m = mgr();
			const proc = m.startProcess({ cmd: params.cmd, cwd: params.cwd ?? ctx.cwd, name: params.name, env: params.env });
			let watchLine = "";
			if (params.watch) {
				try {
					const w = m.createWatch({ ...(params.watch as Omit<WatchSpec, "source">), source: { kind: "process", id: proc.id } });
					watchLine = `\nWatch ${w.id} registered (timeout ${fmtMs(w.timeoutMs)}). End your turn now; you will be woken up when it settles.`;
				} catch (e) {
					m.killProcess(proc.id, 0);
					throw new Error(`process not started: ${(e as Error).message}`);
				}
			}
			refreshStatus();
			return text(`Started ${proc.id} (pid ${proc.pid}): ${proc.cmd}\nLog: ${proc.logPath}${watchLine}`, { process: proc });
		},
	});

	pi.registerTool({
		name: "watch_create",
		label: "Create watch",
		description:
			"Wait for something without blocking the turn. Watch a background process (processId) or poll a status command (poll). When success, failure or timeoutMs is reached, you are woken up with the goal, outcome and observed data.",
		promptSnippet: "Wait for an external state/process without sleep: register goal + success/failure + timeoutMs",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			...WatchFields,
			processId: Type.Optional(Type.String({ description: "Watch a process started with process_start" })),
			poll: Type.Optional(PollSchema),
		}),
		async execute(_id, params) {
			const { processId, poll, ...rest } = params as any;
			if (!!processId === !!poll) throw new Error("set exactly one of processId or poll");
			const source = processId ? { kind: "process" as const, id: processId } : { kind: "poll" as const, ...poll };
			const w = mgr().createWatch({ ...rest, source });
			refreshStatus();
			return text(
				`Watch ${w.id} registered: "${w.goal}" (timeout ${fmtMs(w.timeoutMs)}). Tell the user what you are waiting for and end your turn; the result will be delivered to you automatically.`,
				{ watch: w },
			);
		},
	});

	pi.registerTool({
		name: "watch_list",
		label: "List watches",
		description: "List active watches. Not needed to get results — they are delivered automatically.",
		parameters: Type.Object({}),
		async execute() {
			const ws = mgr().listWatches();
			if (!ws.length) return text("No active watches.", { watches: [] });
			const lines = ws.map((w) => {
				const src = w.source.kind === "process" ? `process ${w.source.id}` : `poll \`${w.source.cmd}\``;
				return `${w.id}: "${w.goal}" — ${src}, ${fmtMs(Date.now() - w.createdAt)} of ${fmtMs(w.timeoutMs)}`;
			});
			return text(lines.join("\n"), { watches: ws });
		},
	});

	pi.registerTool({
		name: "watch_cancel",
		label: "Cancel watch",
		description: "Cancel an active watch. It will not wake you up.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params) {
			const ok = mgr().cancel(params.id);
			refreshStatus();
			if (!ok) throw new Error(`no active watch "${params.id}"`);
			return text(`Cancelled ${params.id}.`, undefined);
		},
	});

	pi.registerTool({
		name: "process_list",
		label: "List processes",
		description: "List background processes started with process_start.",
		parameters: Type.Object({}),
		async execute() {
			const ps = mgr().listProcesses();
			if (!ps.length) return text("No processes.", { processes: [] });
			const lines = ps.map((p) => {
				const state = p.status === "running" ? `running ${fmtMs(Date.now() - p.startedAt)}` : `exited ${p.signal ?? p.exitCode}`;
				return `${p.id} [${state}] ${p.cmd}  (log: ${p.logPath})`;
			});
			return text(lines.join("\n"), { processes: ps });
		},
	});

	pi.registerTool({
		name: "process_logs",
		label: "Process logs",
		description: "Read the log of a background process (stdout+stderr), optionally filtered by regex and/or limited to the last N lines.",
		parameters: Type.Object({
			id: Type.String(),
			tail: Type.Optional(Type.Number({ description: "Last N lines (default 100)" })),
			grep: Type.Optional(Type.String({ description: "Regex filter applied before tail" })),
		}),
		async execute(_id, params) {
			const r = mgr().logs(params.id, { tail: params.tail ?? 100, grep: params.grep });
			const body = r.text.length > 20_000 ? `…${r.text.slice(-20_000)}` : r.text;
			return text(`${body || "(no output)"}\n\n[${r.totalLines} lines total in ${r.logPath}]`, undefined);
		},
	});

	pi.registerTool({
		name: "process_kill",
		label: "Kill process",
		description: "Stop a background process (SIGTERM, then SIGKILL after 3s). Watches on it settle as failure.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params) {
			if (!mgr().killProcess(params.id)) throw new Error(`no running process "${params.id}"`);
			return text(`Sent SIGTERM to ${params.id}.`, undefined);
		},
	});

	pi.registerCommand("watches", {
		description: "List active watches and processes; pick one to cancel/kill",
		handler: async (_args, ctx) => {
			if (!manager) return;
			const ws = manager.listWatches();
			const ps = manager.listProcesses().filter((p) => p.status === "running");
			if (!ws.length && !ps.length) return ctx.ui.notify("pi-watch: nothing active", "info");
			const options = [
				...ws.map((w) => `cancel ${w.id} · ${w.goal} · ${fmtMs(Date.now() - w.createdAt)}/${fmtMs(w.timeoutMs)}`),
				...ps.map((p) => `kill ${p.id} · ${p.cmd.slice(0, 60)} · ${fmtMs(Date.now() - p.startedAt)}`),
			];
			const choice = await ctx.ui.select("pi-watch — select to cancel/kill (Esc to close)", options);
			if (!choice) return;
			const [action, id] = choice.split(" ");
			const ok = action === "cancel" ? manager.cancel(id) : manager.killProcess(id);
			ctx.ui.notify(ok ? `pi-watch: ${action} ${id}` : `pi-watch: ${id} already finished`, ok ? "info" : "warning");
			refreshStatus();
		},
	});
}
