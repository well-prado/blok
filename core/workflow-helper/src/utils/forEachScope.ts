type StepLike = Record<string, unknown>;

interface NamedPath {
	name: string;
	path: string;
}

export function assertNoForEachStateKeyCollisions(steps: unknown[], owner: string): void {
	const stepIds = new Map<string, string>();
	collectStepIds(steps, stepIds, "steps");
	checkForEachScopes(steps, stepIds, [], "steps", owner);
}

function collectStepIds(steps: unknown[], out: Map<string, string>, path: string): void {
	for (let i = 0; i < steps.length; i++) {
		const raw = steps[i];
		if (!isPlainObject(raw)) continue;
		const step = raw as StepLike;
		const stepPath = `${path}[${i}]`;
		const id = pickString(step.id) ?? pickString(step.name);
		if (id && !out.has(id)) out.set(id, stepPath);
		for (const block of childBlocks(step, stepPath)) {
			collectStepIds(block.steps, out, block.path);
		}
	}
}

function checkForEachScopes(
	steps: unknown[],
	stepIds: Map<string, string>,
	ancestorKeys: NamedPath[],
	path: string,
	owner: string,
): void {
	for (let i = 0; i < steps.length; i++) {
		const raw = steps[i];
		if (!isPlainObject(raw)) continue;
		const step = raw as StepLike;
		const stepPath = `${path}[${i}]`;
		const nextAncestors = [...ancestorKeys];

		if (isPlainObject(step.forEach)) {
			const fe = step.forEach as StepLike;
			const as = pickString(fe.as);
			if (as) {
				for (const key of [
					{ name: as, path: `${stepPath}.forEach.as` },
					{ name: `${as}Index`, path: `${stepPath}.forEach.as + "Index"` },
				]) {
					const stepIdPath = stepIds.get(key.name);
					if (stepIdPath !== undefined) {
						throw new Error(
							`${owner}: forEach state key "${key.name}" at ${key.path} collides with step id "${key.name}" at ${stepIdPath}. forEach iteration variables share ctx.state with step outputs; rename \`as\` or the step id. If a step needs a shared downstream state key, give it a unique id and use \`as:\`.`,
						);
					}
					const ancestor = ancestorKeys.find((candidate) => candidate.name === key.name);
					if (ancestor) {
						throw new Error(
							`${owner}: forEach state key "${key.name}" at ${key.path} collides with surrounding forEach state key at ${ancestor.path}. Nested forEach item handles share the same ctx.state namespace; choose a distinct \`as\` name.`,
						);
					}
					nextAncestors.push(key);
				}
			}
		}

		for (const block of childBlocks(step, stepPath)) {
			checkForEachScopes(block.steps, stepIds, nextAncestors, block.path, owner);
		}
	}
}

function childBlocks(step: StepLike, stepPath: string): Array<{ steps: unknown[]; path: string }> {
	const blocks: Array<{ steps: unknown[]; path: string }> = [];
	if (isPlainObject(step.branch)) {
		const branch = step.branch as StepLike;
		if (Array.isArray(branch.then)) blocks.push({ steps: branch.then, path: `${stepPath}.branch.then` });
		if (Array.isArray(branch.else)) blocks.push({ steps: branch.else, path: `${stepPath}.branch.else` });
	}
	if (isPlainObject(step.forEach)) {
		const fe = step.forEach as StepLike;
		if (Array.isArray(fe.do)) blocks.push({ steps: fe.do, path: `${stepPath}.forEach.do` });
	}
	if (isPlainObject(step.loop)) {
		const loop = step.loop as StepLike;
		if (Array.isArray(loop.do)) blocks.push({ steps: loop.do, path: `${stepPath}.loop.do` });
	}
	if (isPlainObject(step.switch)) {
		const sw = step.switch as StepLike;
		if (Array.isArray(sw.cases)) {
			for (let ci = 0; ci < sw.cases.length; ci++) {
				const c = sw.cases[ci];
				if (isPlainObject(c) && Array.isArray((c as StepLike).do)) {
					blocks.push({ steps: (c as { do: unknown[] }).do, path: `${stepPath}.switch.cases[${ci}].do` });
				}
			}
		}
		if (Array.isArray(sw.default)) blocks.push({ steps: sw.default, path: `${stepPath}.switch.default` });
	}
	if (isPlainObject(step.tryCatch)) {
		const tc = step.tryCatch as StepLike;
		if (Array.isArray(tc.try)) blocks.push({ steps: tc.try, path: `${stepPath}.tryCatch.try` });
		if (Array.isArray(tc.catch)) blocks.push({ steps: tc.catch, path: `${stepPath}.tryCatch.catch` });
		if (Array.isArray(tc.finally)) blocks.push({ steps: tc.finally, path: `${stepPath}.tryCatch.finally` });
	}
	return blocks;
}

function isPlainObject(value: unknown): value is StepLike {
	if (value === null || value === undefined) return false;
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
