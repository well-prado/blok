import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

type Ref = { $ref: { step: string; path: Array<string | number> } };
type Step = { id: string; use?: string; inputs?: unknown; branch?: { when: unknown; then: Step[]; else?: Step[] } };
type Builder = { scope: string; parent?: Builder; root: RootBuilder; steps: Step[] };
type RootBuilder = Builder & { ids: Set<string> };
type Store = { stack: Builder[] };
type MaybePromise<T> = T | Promise<T>;

const HANDLE = Symbol("handle");
const builders = new AsyncLocalStorage<Store>();
let scopeId = 0;

function rootBuilder(): RootBuilder {
	const root = { scope: "root", steps: [], ids: new Set<string>() } as RootBuilder;
	root.root = root;
	return root;
}

function current(): Builder {
	const stack = builders.getStore()?.stack;
	const builder = stack?.[stack.length - 1];
	if (!builder) throw new Error("step() must be called inside workflow(..., callback).");
	return builder;
}

function child(parent: Builder, label: string): Builder {
	return { scope: `${label}-${++scopeId}`, parent, root: parent.root, steps: [] };
}

async function withBuilder<T>(builder: Builder, cb: () => MaybePromise<T>): Promise<T> {
	const store = builders.getStore();
	if (!store) throw new Error("No active workflow builder.");
	store.stack.push(builder);
	try {
		return await cb();
	} finally {
		store.stack.pop();
	}
}

function register(id: string): void {
	const ids = current().root.ids;
	if (ids.has(id)) throw new Error(`Duplicate step id "${id}". Step ids are flat per workflow.`);
	ids.add(id);
}

function canRead(from: Builder, at: Builder): boolean {
	for (let cursor: Builder | undefined = at; cursor; cursor = cursor.parent) {
		if (cursor === from) return true;
	}
	return false;
}

function handle(stepId: string, owner: Builder, path: Array<string | number> = []): unknown {
	return new Proxy(() => undefined, {
		get(_target, key) {
			if (key === HANDLE) return { stepId, owner, path };
			if (key === "then") return undefined;
			if (typeof key === "symbol") return undefined;
			return handle(stepId, owner, [...path, /^\d+$/.test(key) ? Number(key) : key]);
		},
	});
}

function ref(value: unknown): unknown {
	if (typeof value === "function") {
		const meta = (value as { [HANDLE]?: { stepId: string; owner: Builder; path: Array<string | number> } })[HANDLE];
		if (meta) {
			if (!canRead(meta.owner, current())) {
				throw new Error(`Handle from step "${meta.stepId}" is not readable from this branch scope.`);
			}
			return { $ref: { step: meta.stepId, path: meta.path } } satisfies Ref;
		}
	}
	if (Array.isArray(value)) return value.map(ref);
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ref(item)]));
	}
	return value;
}

function step(id: string, use: string, inputs?: unknown): unknown {
	const builder = current();
	register(id);
	builder.steps.push({ id, use, inputs: ref(inputs) });
	return handle(id, builder);
}

async function branch(
	id: string,
	when: unknown,
	arms: { then: () => MaybePromise<void>; else?: () => MaybePromise<void> },
) {
	const parent = current();
	register(id);
	const thenBuilder = child(parent, `${id}-then`);
	const elseBuilder = child(parent, `${id}-else`);
	await withBuilder(thenBuilder, arms.then);
	if (arms.else) await withBuilder(elseBuilder, arms.else);
	parent.steps.push({
		id,
		branch: { when: ref(when), then: thenBuilder.steps, ...(arms.else ? { else: elseBuilder.steps } : {}) },
	});
}

async function forEach(id: string, source: unknown, as: string, body: (item: unknown) => MaybePromise<void>) {
	const parent = current();
	register(id);
	const bodyBuilder = child(parent, `${id}-body`);
	const item = handle(as, bodyBuilder);
	await withBuilder(bodyBuilder, () => body(item));
	parent.steps.push({ id, branch: { when: ref(source), then: bodyBuilder.steps } });
	return item;
}

async function workflow(id: string, cb: () => MaybePromise<void>): Promise<{ id: string; steps: Step[] }> {
	const root = rootBuilder();
	return await builders.run({ stack: [root] }, async () => {
		await cb();
		return { id, steps: root.steps };
	});
}

assert.throws(() => step("nope", "node"), /inside workflow/);

const branched = await workflow("outer-handle", async () => {
	const validate = step("validate", "validator", { body: "req.body" });
	await branch("route", (validate as { ok: unknown }).ok, {
		then: () => {
			step("ok", "respond", { productId: (validate as { productId: unknown }).productId });
		},
		else: () => {
			step("no", "respond", { productId: (validate as { productId: unknown }).productId });
		},
	});
});
assert.equal(branched.steps[1]?.branch?.then.length, 1);
assert.deepEqual(branched.steps[1]?.branch?.then[0]?.inputs, {
	productId: { $ref: { step: "validate", path: ["productId"] } },
});

await assert.rejects(
	() =>
		workflow("cross-arm", async () => {
			let thenOnly: unknown;
			await branch("route", true, {
				then: () => {
					thenOnly = step("then-only", "node");
				},
				else: () => {
					step("bad", "node", { value: (thenOnly as { value: unknown }).value });
				},
			});
		}),
	/not readable/,
);

await assert.rejects(
	() =>
		workflow("duplicate", async () => {
			await branch("route", true, {
				then: () => {
					step("same", "node");
				},
				else: () => {
					step("same", "node");
				},
			});
		}),
	/Duplicate step id "same"/,
);

const deferred = await workflow("deferred", async () => {
	const make = () => step("late", "node");
	await branch("route", true, { then: () => void make() });
});
assert.equal(deferred.steps[0]?.branch?.then[0]?.id, "late");

const afterAwait = await workflow("after-await", async () => {
	await Promise.resolve();
	step("after", "node");
});
assert.equal(afterAwait.steps[0]?.id, "after");

const [a, b] = await Promise.all([
	workflow("a", async () => step("same", "node")),
	workflow("b", async () => step("same", "node")),
]);
assert.equal(a.steps[0]?.id, "same");
assert.equal(b.steps[0]?.id, "same");

let leakedItem: unknown;
const looped = await workflow("loop", async () => {
	leakedItem = await forEach("items", step("load", "node"), "item", (item) => {
		step("inside-loop", "node", { sku: (item as { sku: unknown }).sku });
	});
	assert.throws(() => ref((leakedItem as { sku: unknown }).sku), /not readable/);
});
assert.deepEqual(looped.steps[1]?.branch?.then[0]?.inputs, {
	sku: { $ref: { step: "item", path: ["sku"] } },
});

console.log("0003-step-builder-stack-probe: ok");
