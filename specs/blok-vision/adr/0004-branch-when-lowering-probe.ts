import assert from "node:assert/strict";

type Path = Array<string | number>;
type StepMeta = { id: string; as?: string; spread?: boolean };
type Handle = { kind: "handle"; step: StepMeta; path: Path };
type Op = { kind: "op"; op: "===" | "!==" | ">" | ">=" | "<" | "<="; left: Operand; right: Operand };
type Not = { kind: "not"; value: Operand };
type Operand = Handle | Op | Not | string | number | boolean | null;

function h(step: StepMeta, path: Path = []): Handle {
	return { kind: "handle", step, path };
}

function field(handle: Handle, ...path: Path): Handle {
	return { ...handle, path: [...handle.path, ...path] };
}

function eq(left: Operand, right: Operand): Op {
	return { kind: "op", op: "===", left, right };
}

function gt(left: Operand, right: Operand): Op {
	return { kind: "op", op: ">", left, right };
}

function not(value: Operand): Not {
	return { kind: "not", value };
}

function lowerWhen(value: Operand): string {
	if (typeof value === "object" && value !== null) {
		if ("kind" in value && value.kind === "op") return `${lowerWhen(value.left)} ${value.op} ${lowerWhen(value.right)}`;
		if ("kind" in value && value.kind === "not") return `!(${lowerWhen(value.value)})`;
		if ("kind" in value && value.kind === "handle") return lowerHandle(value);
	}
	return literal(value);
}

function lowerHandle(handle: Handle): string {
	const { step, path } = handle;
	if (step.spread) {
		if (path.length === 0) throw new Error(`Cannot use whole output of spread step "${step.id}" in branch condition.`);
		return pathToExpr(["ctx", "state", path[0], ...path.slice(1)]);
	}
	return pathToExpr(["ctx", "state", step.as ?? step.id, ...path]);
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

function literal(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	throw new Error(`Unsupported branch condition operand: ${String(value)}`);
}

function evalWhen(condition: string, state: Record<string, unknown>): unknown {
	return Function("ctx", `"use strict";return (${condition});`)({ state });
}

const stock = h({ id: "stock" });
assert.equal(lowerWhen(field(stock, "inStock")), "ctx.state.stock.inStock");
assert.equal(evalWhen(lowerWhen(field(stock, "inStock")), { stock: { inStock: true } }), true);

const isOk = h({ id: "is-ok" });
assert.equal(lowerWhen(isOk), 'ctx.state["is-ok"]');
assert.equal(evalWhen(lowerWhen(isOk), { "is-ok": false }), false);

const renamed = h({ id: "validate", as: "order" });
assert.equal(lowerWhen(field(renamed, "qty")), "ctx.state.order.qty");
assert.equal(evalWhen(lowerWhen(gt(field(renamed, "qty"), 2)), { order: { qty: 3 } }), true);

const spread = h({ id: "load", spread: true });
assert.equal(lowerWhen(field(spread, "user", "active")), "ctx.state.user.active");
assert.equal(evalWhen(lowerWhen(field(spread, "user", "active")), { user: { active: true } }), true);
assert.throws(() => lowerWhen(spread), /whole output of spread/);

const a = h({ id: "a" });
const b = h({ id: "b" });
assert.equal(lowerWhen(gt(field(a, "count"), field(b, "limit"))), "ctx.state.a.count > ctx.state.b.limit");
assert.equal(evalWhen(lowerWhen(gt(field(a, "count"), field(b, "limit"))), { a: { count: 5 }, b: { limit: 3 } }), true);

assert.equal(lowerWhen(eq(field(a, "status"), "ready")), 'ctx.state.a.status === "ready"');
assert.equal(evalWhen(lowerWhen(eq(field(a, "status"), "ready")), { a: { status: "ready" } }), true);

assert.equal(lowerWhen(not(field(a, "ok"))), "!(ctx.state.a.ok)");
assert.equal(evalWhen(lowerWhen(not(field(a, "ok"))), { a: { ok: false } }), true);

assert.equal(evalWhen(lowerWhen(field(a, "missing")), { a: {} }), undefined);
assert.throws(() => lowerWhen({ nope: true } as unknown as Operand), /Unsupported branch condition operand/);

console.log("0004-branch-when-lowering-probe: ok");
