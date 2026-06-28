// Throwaway probe for ADR 0001 — proves how the REAL Mapper treats a
// structural {$ref} vs a lowered js/ string, and that Option C's load-boundary
// lowering pass resolves end-to-end. Run: `bun specs/blok-vision/adr/0001-probe.ts`
// Not wired into the build.
import Mapper from "../../../core/shared/src/utils/Mapper";

const ctx: any = {
	state: { validate: { productId: "P-123", qty: 4 }, checkStock: { inStock: true } },
	request: { body: { sku: "X" }, method: "POST" },
	workflow_name: "probe",
};
const J = (x: any) => JSON.stringify(x);

// S1: structural {$ref} fed straight through TODAY's mapper (claim under test)
const s1: any = { url: { $ref: { step: "validate", path: ["productId"] } } };
Mapper.replaceObjectStrings(s1, ctx, ctx);
console.log("S1 {$ref} through real mapper ->", J(s1)); // unchanged — NOT resolved

// S2: lowered js/ string (Option A / Option C runtime form)
const s2: any = { url: "js/ctx.state.validate.productId", qty: "js/ctx.state.validate.qty" };
Mapper.replaceObjectStrings(s2, ctx, ctx);
console.log("S2 js/ strings through real mapper ->", J(s2), "| typeof qty =", typeof s2.qty);

// Option C load-boundary lowering: {$ref} -> js/ string, then mapper
function lowerRefs(node: any): any {
	if (Array.isArray(node)) return node.map(lowerRefs);
	if (node && typeof node === "object") {
		const keys = Object.keys(node);
		if (keys.length === 1 && keys[0] === "$ref" && node.$ref && typeof node.$ref.step === "string") {
			const { step, path } = node.$ref as { step: string; path?: (string | number)[] };
			const suffix = (path ?? []).map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("");
			return `js/ctx.state.${step}${suffix}`;
		}
		const out: any = {};
		for (const k of keys) out[k] = lowerRefs(node[k]);
		return out;
	}
	return node;
}
const irInput: any = {
	url: { $ref: { step: "validate", path: ["productId"] } },
	whole: { $ref: { step: "validate", path: [] } }, // whole-output ref
	list: [{ $ref: { step: "validate", path: ["qty"] } }, "static"], // ref in array
	nested: { inner: { $ref: { step: "checkStock", path: ["inStock"] } } }, // ref in object
};
const lowered = lowerRefs(irInput);
console.log("S3 after lowering   ->", J(lowered));
Mapper.replaceObjectStrings(lowered, ctx, ctx);
console.log(
	"S3 after mapper     ->",
	J(lowered),
	"| typeof list[0] =",
	typeof lowered.list[0],
	"| whole =",
	J(lowered.whole),
);

// S4: branch.when wire form — raw ctx string, bypasses the Mapper entirely
const whenRaw = "ctx.state.checkStock.inStock === true";
console.log("S4 branch.when raw-ctx eval ->", Function("ctx", `"use strict";return (${whenRaw});`)(ctx));
