import { describe, expect, it } from "vitest";
import { resolveSpecifier, rewriteFile } from "../../../scripts/fix-esm-extensions";

/**
 * #687 — the file-vs-directory decision is the whole risk in this codemod.
 * Guess wrong and `./hmr` becomes `./hmr.js` (a file that does not exist)
 * instead of `./hmr/index.js`, which is worse than the extensionless
 * specifier it replaced: it turns a load error into a *different* load error
 * that now looks deliberate.
 *
 * `exists` is injected, so these assert the rules directly against a synthetic
 * tree with no fixture files on disk.
 */
const tree = (...files: string[]) => {
	const set = new Set(files);
	return (p: string) => set.has(p);
};

describe("resolveSpecifier", () => {
	it("adds .js for a sibling file", () => {
		expect(resolveSpecifier("/d/index.js", "./Configuration", tree("/d/Configuration.js"))).toBe("./Configuration.js");
	});

	it("adds /index.js for a directory", () => {
		expect(resolveSpecifier("/d/index.js", "./hmr", tree("/d/hmr/index.js"))).toBe("./hmr/index.js");
	});

	it("prefers the sibling file when a same-named directory also exists", () => {
		const both = tree("/d/hmr.js", "/d/hmr/index.js");
		expect(resolveSpecifier("/d/index.js", "./hmr", both)).toBe("./hmr.js");
	});

	it("resolves parent-relative specifiers", () => {
		expect(resolveSpecifier("/d/a/b.js", "../types/Node", tree("/d/types/Node.js"))).toBe("../types/Node.js");
	});

	it("treats bare '.' and '..' as directories, never as files", () => {
		// The trap: `"." + ".js"` is `"..js"`. `RunnerNodeBase.d.ts` really does
		// carry `import(".")`, so this is not hypothetical.
		expect(resolveSpecifier("/d/x.d.ts", ".", tree("/d/index.d.ts", "/d.js"))).toBe("./index.js");
		expect(resolveSpecifier("/d/a/x.d.ts", "..", tree("/d/index.d.ts"))).toBe("../index.js");
	});

	it("collapses a trailing slash instead of doubling it", () => {
		expect(resolveSpecifier("/d/index.js", "./hmr/", tree("/d/hmr/index.js"))).toBe("./hmr/index.js");
	});

	it("resolves a declaration file against .d.ts but still emits .js", () => {
		expect(resolveSpecifier("/d/index.d.ts", "./Configuration", tree("/d/Configuration.d.ts"))).toBe(
			"./Configuration.js",
		);
		expect(resolveSpecifier("/d/index.d.ts", "./hmr", tree("/d/hmr/index.d.ts"))).toBe("./hmr/index.js");
	});

	it("leaves bare specifiers and already-explicit relative ones alone", () => {
		const all = () => true;
		expect(resolveSpecifier("/d/index.js", "@blokjs/shared", all)).toBeNull();
		expect(resolveSpecifier("/d/index.js", "node:path", all)).toBeNull();
		expect(resolveSpecifier("/d/index.js", "./Configuration.js", all)).toBeNull();
		expect(resolveSpecifier("/d/index.js", "./schema.json", all)).toBeNull();
	});

	it("returns null rather than guessing when nothing matches", () => {
		expect(resolveSpecifier("/d/index.js", "./gone", tree())).toBeNull();
	});
});

describe("rewriteFile", () => {
	const exists = tree("/d/Configuration.js", "/d/hmr/index.js", "/d/side.js", "/d/lazy.js", "/d/T.js");

	it("covers every specifier position tsc can emit", () => {
		const source = [
			`import Configuration from "./Configuration";`,
			`export * from "./hmr";`,
			`export { a } from "./Configuration";`,
			`import "./side";`,
			`const m = await import("./lazy");`,
			`import type { T } from "./T";`,
		].join("\n");
		const { text, changed, unresolved } = rewriteFile("/d/index.js", source, exists);
		expect(unresolved).toEqual([]);
		expect(changed).toBe(6);
		expect(text).toContain(`from "./Configuration.js"`);
		expect(text).toContain(`export * from "./hmr/index.js"`);
		expect(text).toContain(`import "./side.js"`);
		expect(text).toContain(`import("./lazy.js")`);
		expect(text).toContain(`from "./T.js"`);
	});

	it("rewrites inline import() type references in declaration files", () => {
		const { text, changed } = rewriteFile("/d/x.d.ts", `type A = import("./T").Foo;`, tree("/d/T.d.ts"));
		expect(changed).toBe(1);
		expect(text).toBe(`type A = import("./T.js").Foo;`);
	});

	it("does not touch string data that merely looks like an import", () => {
		const source = `const template = 'import X from "./Configuration"';`;
		const { text, changed } = rewriteFile("/d/index.js", source, exists);
		expect(changed).toBe(0);
		expect(text).toBe(source);
	});

	it("reports an unresolvable specifier instead of inventing an extension", () => {
		const { changed, unresolved } = rewriteFile("/d/index.js", `import "./missing";`, exists);
		expect(changed).toBe(0);
		expect(unresolved).toEqual(["./missing"]);
	});
});
