export type GuardResult = { block: false } | { block: true; reason: string };

const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
const SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
const LOOP = /\b(for|while|until)\b[\s\S]*?\bdo\b[\s\S]*?\bdone\b/g;

/** Blank out quoted strings and comments so only executable words remain. */
function stripInert(cmd: string): string {
	return cmd
		.replace(/'[^']*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/(^|\s)#[^\n]*/g, "$1");
}

export function checkCommand(raw: string, opts: { thresholdS: number }): GuardResult {
	const cmd = stripInert(raw);
	for (const loop of cmd.matchAll(LOOP)) {
		if (/\bsleep\s+\d/.test(loop[0])) {
			return { block: true, reason: `polling loop with sleep (\`${loop[1]} … sleep … done\`)` };
		}
	}
	for (const m of cmd.matchAll(SLEEP)) {
		const seconds = Number(m[1]) * UNIT_SECONDS[m[2]];
		if (seconds >= opts.thresholdS) return { block: true, reason: `\`sleep ${m[1]}${m[2]}\` (≥ ${opts.thresholdS}s)` };
	}
	return { block: false };
}
