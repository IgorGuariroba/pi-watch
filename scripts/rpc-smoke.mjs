// Smoke test: drives a real Pi over RPC and checks that a watch wakes the agent.
// usage: node scripts/rpc-smoke.mjs "<prompt>" [expectedSettles=2] [model]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [prompt, expected = "2", model = "claude-subscription/claude-haiku-5-5"] = process.argv.slice(2);
const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-e", "./src/index.ts", "--model", model], {
	stdio: ["pipe", "pipe", "inherit"],
});
let settles = 0;
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
createInterface({ input: pi.stdout }).on("line", (line) => {
	let r;
	try { r = JSON.parse(line); } catch { return; }
	if (r.type === "tool_execution_start") console.log(stamp(), "tool", r.toolName, JSON.stringify(r.args).slice(0, 300));
	if (r.type === "tool_execution_end") console.log(stamp(), "  ->", JSON.stringify(r.result?.content?.[0]?.text ?? r.result).slice(0, 300), r.isError ? "(ERROR)" : "");
	if (r.type === "message_end" && r.message?.role === "custom") console.log(stamp(), "CUSTOM", r.message.customType, "\n" + r.message.content);
	if (r.type === "message_end" && r.message?.role === "assistant") {
		const txt = (r.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
		if (txt) console.log(stamp(), "ASSISTANT:", txt.slice(0, 400));
	}
	if (r.type === "agent_settled") {
		settles++;
		console.log(stamp(), "== settled", settles);
		if (settles >= Number(expected)) { pi.kill(); process.exit(0); }
	}
});
pi.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: prompt }) + "\n");
setTimeout(() => { console.log("TIMEOUT"); pi.kill(); process.exit(1); }, Number(process.env.SMOKE_TIMEOUT_MS) || 240_000);
