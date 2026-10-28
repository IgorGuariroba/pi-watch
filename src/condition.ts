export type Condition = Record<string, any>;

function resolvePath(obj: unknown, path: string): unknown {
	let cur: any = obj;
	for (const key of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = cur[key];
	}
	return cur;
}

export function matches(condition: Condition, observation: Record<string, unknown>): boolean {
	return Object.entries(condition).every(([field, ops]) => {
		if (field === "all") return (ops as Condition[]).every((c) => matches(c, observation));
		if (field === "any") return (ops as Condition[]).some((c) => matches(c, observation));
		const actual = resolvePath(observation, field);
		// Different events carry different fields (a "line" has no exitCode): absent never matches.
		if (actual === undefined || actual === null) return false;
		return Object.entries(ops as Record<string, unknown>).every(([op, expected]) => {
			if (op === "eq") return actual === expected;
			if (op === "regex") return typeof actual === "string" && new RegExp(String(expected)).test(actual);
			if (op === "ne") return actual !== expected;
			if (op === "gt") return typeof actual === "number" && actual > Number(expected);
			if (op === "lt") return typeof actual === "number" && actual < Number(expected);
			if (op === "in") return Array.isArray(expected) && expected.includes(actual);
			if (op === "contains") return typeof actual === "string" && actual.includes(String(expected));
			return false;
		});
	});
}

const OPERATORS = new Set(["eq", "ne", "gt", "lt", "in", "regex", "contains"]);

export function validate(condition: unknown, errors: string[] = []): string[] {
	if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
		errors.push("condition must be an object");
		return errors;
	}
	if (Object.keys(condition).length === 0) errors.push("empty condition");
	for (const [field, ops] of Object.entries(condition)) {
		if (field === "all" || field === "any") {
			if (!Array.isArray(ops) || ops.length === 0) errors.push(`"${field}" must be a non-empty array of conditions`);
			else for (const c of ops) validate(c, errors);
			continue;
		}
		if (ops === null || typeof ops !== "object" || Array.isArray(ops)) {
			errors.push(`"${field}" must be an object of operators, e.g. { "${field}": { "eq": ... } }`);
			continue;
		}
		for (const [op, expected] of Object.entries(ops)) {
			if (!OPERATORS.has(op)) errors.push(`unknown operator "${op}" on "${field}" (use ${[...OPERATORS].join(", ")})`);
			else if (op === "in" && !Array.isArray(expected)) errors.push(`"in" on "${field}" must be an array`);
			else if (op === "regex") {
				try {
					new RegExp(String(expected));
				} catch (e) {
					errors.push(`invalid regex on "${field}": ${(e as Error).message}`);
				}
			}
		}
	}
	return errors;
}
