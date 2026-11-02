import type { GuardResult } from "./sleep-guard.ts";
import { stripInert } from "./sleep-guard.ts";

/** Commands that usually run long. Opt-in: `npm test` in a tiny project is a false positive. */
export const DEFAULT_LONG_COMMANDS =
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|stryker)\b|\bcargo\s+(?:build|test)\b|\bdocker\s+(?:compose\s+)?build\b|\bgh\s+run\s+watch\b/;

export type BashGuardOptions = {
	/** Block when the requested bash `timeout` (seconds) is above this. 0 disables. */
	timeoutThresholdS: number;
	/** Block commands matching this regex. undefined disables. */
	longCommands?: RegExp;
};

/** `sudo` as a command word (start, or after `;`, `&`, `|`, `(`, `{`), ignoring quoted text and comments. */
const SUDO = /(?:^|[;&|({])\s*sudo\b/;

/**
 * True when the command runs sudo. Its long wait is the user typing the password in the TUI prompt,
 * and process_start has no TTY/askpass, so sudo must stay in bash.
 */
export function isSudo(command: unknown): boolean {
	return SUDO.test(stripInert(String(command ?? "")));
}

export function checkBashCall(input: { command?: unknown; timeout?: unknown }, opts: BashGuardOptions): GuardResult {
	if (isSudo(input.command)) return { block: false };
	const timeout = Number(input.timeout);
	if (opts.timeoutThresholdS > 0 && Number.isFinite(timeout) && timeout > opts.timeoutThresholdS) {
		return { block: true, reason: `bash \`timeout: ${timeout}\` (> ${opts.timeoutThresholdS}s) means you expect it to run long` };
	}
	if (opts.longCommands) {
		const m = stripInert(String(input.command ?? "")).match(opts.longCommands);
		if (m) return { block: true, reason: `\`${m[0]}\` is a known long-running command` };
	}
	return { block: false };
}

/** Hint appended to a bash result that took long, or undefined when below the threshold (0 disables). */
export function slowBashHint(elapsedMs: number, thresholdS: number, command?: unknown): string | undefined {
	if (isSudo(command)) return undefined;
	if (thresholdS <= 0 || elapsedMs < thresholdS * 1000) return undefined;
	return `[pi-watch] This bash call blocked the turn for ${Math.round(elapsedMs / 1000)}s. Next time run long commands with process_start and an inline watch (e.g. success { exitCode: { eq: 0 } }), then end your turn — you will be woken up with the result.`;
}

/** Parse PI_WATCH_LONG_COMMANDS: unset/"0" → off, "1" → default list, anything else → custom regex. */
export function parseLongCommands(value: string | undefined): RegExp | undefined {
	if (!value || value === "0") return undefined;
	if (value === "1") return DEFAULT_LONG_COMMANDS;
	return new RegExp(value);
}
