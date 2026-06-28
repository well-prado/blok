import assert from "node:assert/strict";
import Mapper from "../../../core/shared/src/utils/Mapper";
import { unwrapProxies } from "../../../core/workflow-helper/src/proxy/$";

type Path = Array<string | number>;
type Handle = { step: string; path: Path };
const HANDLE = Symbol("handle");

function handle(step: string, path: Path = []): unknown {
	return new Proxy(() => undefined, {
		get(_target, key) {
			if (key === HANDLE) return { step, path } satisfies Handle;
			if (key === "then" || typeof key === "symbol") return undefined;
			return handle(step, [...path, /^\d+$/.test(key) ? Number(key) : key]);
		},
	});
}

function req(path: Path = []): unknown {
	return new Proxy(() => undefined, {
		get(_target, key) {
			if (key === HANDLE) return { step: "$request", path } satisfies Handle;
			if (key === "then" || typeof key === "symbol") return undefined;
			return req([...path, /^\d+$/.test(key) ? Number(key) : key]);
		},
	});
}

function js(strings: TemplateStringsArray, ...values: unknown[]): string {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		out += operand(values[i]) + (strings[i + 1] ?? "");
	}
	return `js/${out}`;
}

function operand(value: unknown): string {
	if (typeof value === "function") {
		const meta = (value as { [HANDLE]?: Handle })[HANDLE];
		if (meta) {
			const root =
				meta.step === "$request" ? ["ctx", "request", ...meta.path] : ["ctx", "state", meta.step, ...meta.path];
			return pathToExpr(root);
		}
	}
	return JSON.stringify(value);
}

function pathToExpr(parts: Path): string {
	return parts
		.map((part, index) => {
			if (typeof part === "number") return `[${part}]`;
			if (index === 0) return part;
			return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`;
		})
		.join("");
}

function resolve(input: Record<string, unknown>, ctx: Record<string, unknown>): Record<string, unknown> {
	const compiled = unwrapProxies(input) as Record<string, unknown>;
	Mapper.replaceObjectStrings(compiled, ctx as never, {});
	return compiled;
}

const request = req() as {
	body: { tenantId: string; items: unknown[]; message: string };
	params: { sessionId: string };
};
const item = handle("item") as { id: string };
const itemIndex = handle("itemIndex") as unknown as number;
const history = handle("load-history") as { value?: Array<{ role: string; content: string }> };
const agent = handle("agent") as { fullText: string };

const ctx = {
	request: {
		body: { tenantId: "", items: [{ id: "a" }], message: "hello" },
		params: { sessionId: "s1" },
	},
	state: {
		item: { id: "item-1" },
		itemIndex: 7,
		"load-history": { value: [{ role: "assistant", content: "hi" }] },
		agent: { fullText: "done" },
	},
};

const input = {
	tenant: js`${request.body.tenantId} || 'default'`,
	items: js`Array.isArray(${request.body.items}) ? ${request.body.items} : []`,
	key: js`'agent:' + ${request.params.sessionId} + ':history'`,
	dedup: js`${request.body.tenantId} + ':' + (${item.id} ? ${item.id} : ${itemIndex})`,
	messages: js`[...(${history.value} || []), { role: 'user', content: ${request.body.message} }, { role: 'assistant', content: ${agent.fullText} }]`,
	object: js`({ echo: ${request.body}, at: 123 })`,
};

const compiled = unwrapProxies(input);
assert.deepEqual(compiled, input);

const resolved = resolve(input, ctx);
assert.equal(resolved.tenant, "default");
assert.deepEqual(resolved.items, [{ id: "a" }]);
assert.equal(resolved.key, "agent:s1:history");
assert.equal(resolved.dedup, ":item-1");
assert.deepEqual(resolved.messages, [
	{ role: "assistant", content: "hi" },
	{ role: "user", content: "hello" },
	{ role: "assistant", content: "done" },
]);
assert.deepEqual(resolved.object, { echo: ctx.request.body, at: 123 });

console.log("0008-non-structural-expression-escape-probe: ok");
