// Phase 4 from the author's side: the same commands on a project whose nodes are written in Python.
// blokctl reads no Python. It asks the project's own kernel, so these tests need `python/.venv`,
// which `bun run test` makes before they run.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { languageOf, pyprojectSettings } from "../src/language.ts";
import { blokctl, cleanUp, folder, write } from "./helpers.ts";

afterAll(cleanUp);
setDefaultTimeout(60_000);

const repo = join(import.meta.dirname, "..", "..", "..");
const PYTHON = join(repo, "python", ".venv", "bin", "python");
const FIXTURE = join(repo, "python", "tests", "fixture");
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const json = (dir: string, file: string) => JSON.parse(read(dir, file));

if (!existsSync(PYTHON)) {
	throw new Error(`These tests need the Python kernel's environment at ${PYTHON}. Run "uv sync" in python/.`);
}

/** A project made by `blokctl init <name> --lang python`, told to use this repo's Python and kernel. */
function project(name = "shop"): string {
	const parent = folder();
	const made = blokctl(parent, ["init", name, "--lang", "python"]);
	if (made.exit !== 0) throw new Error(made.err);
	const dir = join(parent, name);
	writeFileSync(
		join(dir, "pyproject.toml"),
		read(dir, "pyproject.toml").replace('dir = "."', `dir = "."\npython = "${PYTHON}"`),
	);
	return dir;
}

test("a project is Python when its pyproject.toml says so, or when that is all it has", () => {
	const dir = folder();
	expect(languageOf(dir).name).toBe("typescript");
	write(dir, "pyproject.toml", '[project]\nname = "x"\n');
	expect(languageOf(dir).name).toBe("python");
	expect(pyprojectSettings(dir)).toBeUndefined();
	// A repo with both is TypeScript, unless its pyproject.toml has the table blokctl writes.
	write(dir, "package.json", "{}");
	expect(languageOf(dir).name).toBe("typescript");
	write(
		dir,
		"pyproject.toml",
		'[project]\nname = "x"\n\n[tool.blok]  # read by blokctl\ndir = "src" # where\npython = \'uv run python\'\nlist = ["no"]\n\n[tool.other]\ndir = "elsewhere"\n',
	);
	expect(languageOf(dir).name).toBe("python");
	expect(pyprojectSettings(dir)).toEqual({ dir: "src", python: "uv run python" });
});

test("init --lang python starts a project that lines up, and says how to run it", () => {
	const parent = folder();
	const made = blokctl(parent, ["init", "shop", "--lang", "python"]);
	expect(made).toMatchObject({ exit: 0, err: "" });
	expect(made.out).toBe(
		[
			"Added:",
			"  pyproject.toml",
			"  app.py",
			"  ports/__init__.py",
			"  nodes/hello/greet/v1/node.py",
			"  nodes/hello/greet/v1/test_node.py",
			"  workflows/hello.pkl",
			"  AGENTS.md",
			"  .gitignore",
			"",
			"Next:",
			"  cd shop",
			"  uv sync",
			"  blokctl dev -- uv run python app.py",
			"  Then open http://localhost:3000/hello?name=Ada",
		].join("\n"),
	);
	const dir = join(parent, "shop");
	expect(pyprojectSettings(dir)).toEqual({ dir: "." });
	expect(read(dir, "pyproject.toml")).toContain('"blok-kernel[fastapi]>=3.0.0a0"');
	expect(read(dir, ".gitignore")).toBe(".venv/\n__pycache__/\n.blok/\n");
	// No file of a TypeScript project, and nothing left of TypeScript in the rules page.
	expect(readdirSync(dir).sort()).toEqual(
		[".gitignore", "AGENTS.md", "app.py", "nodes", "ports", "pyproject.toml", "workflows"].sort(),
	);
	const rules = read(dir, "AGENTS.md");
	for (const gone of [
		"node.ts",
		"zod",
		"#blok",
		"npx",
		"bunx",
		"node.test.ts",
		"@blokjs/kernel",
		"startCron",
		"ports/index.ts",
	]) {
		expect({ gone, there: rules.includes(gone) }).toEqual({ gone, there: false });
	}
	for (const there of [
		"nodes/<module>/<node>/v<N>/node.py",
		"ports/__init__.py",
		"A node whose logic is not written yet has `run=todo`.",
		'raise ctx.fail("card_declined", result.reason)',
		"Its test goes beside it, in `test_node.py`",
		"await start_cron(blok)  # every cron trigger",
		"calls `start_cron` in one of them",
		"### Writing a workflow",
		"- A queue hands a message over at least once.",
		"Run them as `blokctl ...`.",
	]) {
		expect({ there, found: rules.includes(there) }).toEqual({ there, found: true });
	}

	expect(blokctl(parent, ["init", "again", "--lang", "ruby"])).toMatchObject({
		exit: 1,
		err: '"ruby" is not a language blokctl knows. Use typescript or python.',
	});
	expect(blokctl(parent, ["init", "again", "--lang", "python", "--server", "express"])).toMatchObject({
		exit: 1,
		err: '"express" is not a server blokctl knows for Python. It writes a FastAPI app.',
	});
	expect(blokctl(parent, ["init", "--lang", "python"])).toMatchObject({
		exit: 1,
		err: 'There is no pyproject.toml here. Run "blokctl init <name> --lang python" to start a new project.',
	});
});

test("the commands read a Python project through its own kernel", () => {
	const dir = project();
	expect(blokctl(dir, ["check"])).toMatchObject({ exit: 0, out: "1 node and 1 workflow line up." });
	const listed = JSON.parse(blokctl(dir, ["list", "--json"]).out);
	expect(listed.nodes).toMatchObject([
		{
			id: "hello/greet@1",
			description: "Builds a greeting for a name.",
			input: { type: "object", properties: { name: { type: "string", default: "world", minLength: 1 } } },
			output: { type: "object", required: ["message", "at"], additionalProperties: false },
			implemented: true,
			pkl: { import: "blok/hello.pkl", step: "hello.Greet" },
		},
	]);
	expect(listed.workflows[0]).toMatchObject({ id: "workflows/hello@1", startedBy: ["GET /hello"] });
	// The typed Pkl steps are generated from what the kernel printed.
	expect(read(dir, "workflows/blok/hello.pkl")).toContain(
		"class GreetOutputs {\n  hidden step: String\n  message: Workflow.StringRef",
	);

	// One node runs from the command line, and so does a workflow, with the project's own ports.
	const node = JSON.parse(blokctl(dir, ["run", "hello/greet", "--input", '{"name":"Ada"}', "--json"]).out);
	expect(node).toMatchObject({ ok: true, id: "hello/greet@1", output: { message: "Hello, Ada!" } });
	expect(node.spans).toMatchObject([{ id: "hello/greet@1", kind: "node", attempts: 1, ok: true }]);
	const workflow = blokctl(dir, ["run", "hello", "--input", '{"query":{"name":"Bo"}}']);
	expect(workflow.exit).toBe(0);
	expect(workflow.out).toContain('"message": "Hello, Bo!"');
	expect(workflow.out).toMatch(
		/What ran:\n {2}ok {2}hello\/greet@1 \(step "greeting"\) {2}[\d.]+ms\n {2}ok {2}workflows\/hello@1/,
	);
	expect(blokctl(dir, ["run", "hello/greet", "--input", '{"name":5}'])).toMatchObject({
		exit: 1,
		err: expect.stringContaining(
			'hello/greet@1 failed with "invalid_input" at hello/greet@1: name: Input should be a valid string',
		),
	});
	expect(blokctl(dir, ["run", "nothing"])).toMatchObject({
		exit: 1,
		err: '"nothing" is not a node or a workflow. Run "blokctl list" to see them.',
	});

	// The build writes what a kernel that does not check workflows needs to know.
	expect(blokctl(dir, ["build"])).toMatchObject({ exit: 0 });
	const built = json(dir, ".blok/app.json");
	expect(built).toMatchObject({ blok: 1, language: "python" });
	expect(Object.keys(built.nodes)).toEqual(["hello/greet@1"]);
	expect(built.nodes["hello/greet@1"]).toMatch(/^[0-9a-f]{64}$/);
	expect(built.workflows["workflows/hello@1"]).toMatchObject({
		file: "workflows/hello.json",
		request: { properties: { query: { properties: { name: { type: "string" } } } } },
		errors: [],
	});
});

test("the gate for one node runs its tests with pytest, and the briefs speak Python", () => {
	const dir = project();
	expect(blokctl(dir, ["new", "node", "billing/charge-card"])).toMatchObject({
		exit: 0,
		out: [
			"Created billing/charge-card@1:",
			"  nodes/billing/charge-card/v1/node.py",
			"  nodes/billing/charge-card/v1/test_node.py",
			"Its contract is empty and its logic is `todo`. Fill in the input and output first.",
		].join("\n"),
	});
	expect(read(dir, "nodes/billing/charge-card/v1/node.py")).toContain(
		'charge_card = node(\n    id="billing/charge-card@1",',
	);
	expect(blokctl(dir, ["status"]).out).toContain(
		"1 of 2 nodes is still empty:\n  billing/charge-card@1  nodes/billing/charge-card/v1",
	);

	// Empty: the gate says so, in the words of the language.
	const empty = blokctl(dir, ["check", "billing/charge-card"]);
	expect(empty.exit).toBe(1);
	expect(empty.err).toContain("billing/charge-card@1 is still empty. Replace `run=todo` with its logic.");
	const brief = blokctl(dir, ["prompt", "build", "billing/charge-card"]).out;
	for (const there of [
		"1. Replace `run=todo` in nodes/billing/charge-card/v1/node.py with the logic",
		"which is typed in ports/__init__.py",
		"Make the test in nodes/billing/charge-card/v1/test_node.py pass.",
		"3. Run `blokctl check billing/charge-card@1` from the folder that holds pyproject.toml.",
		"It runs the node's tests and compares its contract with what was locked.",
		"do not edit pyproject.toml",
	]) {
		expect({ there, found: brief.includes(there) }).toEqual({ there, found: true });
	}
	const design = blokctl(dir, ["prompt", "design"]).out;
	expect(design).toContain("1. ports/__init__.py: the `Ports` class and the classes it is made of.");
	expect(design).toContain(
		"In each node.py fill in `description`, `input`, `output` and `errors`, and leave `run=todo`.",
	);
	expect(design).toContain("4. One test beside each node, in test_node.py,");
	expect(design).not.toMatch(/node\.ts|npx|bunx|\.describe\(\)|app\.ts/);

	// Written, with a test that passes: done.
	write(
		dir,
		"nodes/billing/charge-card/v1/node.py",
		`from pydantic import BaseModel

from blok import Ctx, node
from ports import Ports


class Input(BaseModel):
    token: str


class Output(BaseModel):
    receipt_id: str


def run(input: Input, ctx: Ctx[Ports]) -> Output:
    if input.token != "tok_ok":
        raise ctx.fail("card_declined", "The bank refused the card.")
    return Output(receipt_id="rc_1")


charge_card = node(
    id="billing/charge-card@1",
    description="Charges a card.",
    input=Input,
    output=Output,
    errors={"card_declined": "The provider refused the card."},
    run=run,
)
`,
	);
	const tested = (body: string) =>
		write(
			dir,
			"nodes/billing/charge-card/v1/test_node.py",
			`import pytest

from blok import BlokError
from blok.testing import call, node_beside
from ports import memory_ports

charge_card = node_beside(__file__)


def test_it_charges():
    assert call(charge_card, {"token": "tok_ok"}, ports=memory_ports()) == ${body}


def test_it_refuses():
    with pytest.raises(BlokError) as refused:
        call(charge_card, {"token": "tok_bad"}, ports=memory_ports())
    assert refused.value.code == "card_declined"
`,
		);
	tested('{"receipt_id": "rc_1"}');
	expect(blokctl(dir, ["lock"]).exit).toBe(0);
	expect(blokctl(dir, ["check", "billing/charge-card"])).toMatchObject({
		exit: 0,
		out: "2 nodes and 1 workflow line up.\nbilling/charge-card@1 is done: its logic is written, its 2 tests pass and its contract is what contract.json promises.",
	});
	expect(blokctl(dir, ["check", "--tests"])).toMatchObject({
		exit: 0,
		out: expect.stringContaining("3 node tests pass."),
	});

	// A test that fails stops the gate, and what pytest printed is shown.
	tested('{"receipt_id": "rc_2"}');
	const failing = blokctl(dir, ["check", "billing/charge-card"]);
	expect(failing.exit).toBe(1);
	expect(failing.err).toContain("billing/charge-card@1: its tests fail. This is what");
	expect(failing.err).toContain("test_it_charges");
	tested('{"receipt_id": "rc_1"}');

	// A contract that drifts from what was locked is refused, as in TypeScript.
	const file = join(dir, "nodes/billing/charge-card/v1/node.py");
	writeFileSync(file, readFileSync(file, "utf8").replaceAll("receipt_id", "receipt"));
	const drifted = blokctl(dir, ["check"]);
	expect(drifted.exit).toBe(1);
	expect(drifted.err).toContain("billing/charge-card@1: its output is not what contract.json promises.");

	// The next version is a copy with the new id, and the first one is untouched.
	writeFileSync(file, readFileSync(file, "utf8").replaceAll("receipt", "receipt_id"));
	expect(blokctl(dir, ["new", "version", "billing/charge-card"]).exit).toBe(0);
	expect(read(dir, "nodes/billing/charge-card/v2/node.py")).toContain('id="billing/charge-card@2"');
	expect(existsSync(join(dir, "nodes/billing/charge-card/v2/contract.json"))).toBe(false);
	expect(blokctl(dir, ["check"])).toMatchObject({ exit: 0, out: "3 nodes and 1 workflow line up." });
});

test("a node file that cannot be loaded, or sits in the wrong place, is a problem in a sentence", () => {
	const dir = project();
	write(dir, "nodes/billing/broken/v1/node.py", "import nothing_like_this\n");
	write(dir, "nodes/billing/v1/node.py", read(dir, "nodes/hello/greet/v1/node.py"));
	write(dir, "nodes/billing/refund/v1/node.py", read(dir, "nodes/hello/greet/v1/node.py"));
	const checked = blokctl(dir, ["check"]);
	expect(checked.exit).toBe(1);
	expect(checked.err).toBe(
		[
			"3 problems:",
			"- billing/broken/v1/node.py could not be loaded: ModuleNotFoundError(\"No module named 'nothing_like_this'\")",
			'- billing/refund/v1/node.py declares "hello/greet@1", but its path says "billing/refund@1".',
			"- billing/v1/node.py is not where a node goes. A node lives at <module>/<node>/v<N>/node.py.",
		].join("\n"),
	);
});

test("without a kernel to ask, the command says what to install", () => {
	const dir = project();
	// A Python that runs and has no Blok in it.
	const bare = Bun.which("python3");
	if (!bare) throw new Error("This test needs a python3 on the PATH.");
	writeFileSync(join(dir, "pyproject.toml"), read(dir, "pyproject.toml").replace(PYTHON, `${bare} -S`));
	expect(blokctl(dir, ["check"])).toMatchObject({
		exit: 1,
		err: `1 problem:\n- The Python that "${bare} -S" runs has no Blok kernel. Add "blok-kernel" to the project's dependencies and install them.`,
	});
	writeFileSync(join(dir, "pyproject.toml"), read(dir, "pyproject.toml").replace(`${bare} -S`, "/nowhere/python"));
	const missing = blokctl(dir, ["check"]);
	expect(missing.exit).toBe(1);
	expect(missing.err).toContain('Python could not be run as "/nowhere/python"');
	const doctor = blokctl(dir, ["doctor"]);
	expect(doctor.exit).toBe(1);
	expect(doctor.err).toContain('PROBLEM Python: Python could not be run as "/nowhere/python".');
});

test("doctor says what a Python project needs", () => {
	const dir = project();
	const said = blokctl(dir, ["doctor"]);
	expect(said.exit).toBe(0);
	expect(said.out).toMatch(/ok {6}Python: Python 3\.\d+\.\d+, run as ".*python"\./);
	expect(said.out).toContain("ok      Project: pyproject.toml has a [tool.blok] table.");
	expect(said.out).toContain("ok      blok-kernel: Installed, 3.0.0a0, the version this blokctl goes with.");
	expect(said.out).not.toContain("Node");
});

test("the fixture the Python kernel's tests load is what the build writes today", () => {
	const dir = folder();
	cpSync(FIXTURE, dir, {
		recursive: true,
		filter: (source) => !/(^|\/)(\.blok|__pycache__|blok)$/.test(source.slice(FIXTURE.length)),
	});
	// The copy is somewhere else, so it is told where the Python with the kernel is.
	writeFileSync(join(dir, "pyproject.toml"), read(dir, "pyproject.toml").replace("../../.venv/bin/python", PYTHON));
	expect(blokctl(dir, ["build"])).toMatchObject({ exit: 0, err: "" });
	const fresh = (file: string) => ({ file, content: json(dir, `.blok/${file}`) });
	const kept = (file: string) => ({ file, content: json(FIXTURE, `built/${file}`) });
	// When this fails: cd python/tests/fixture && blokctl build && rm -rf built && cp -R .blok built
	for (const file of [
		"app.json",
		"openapi.json",
		...readdirSync(join(dir, ".blok/workflows")).map((name) => `workflows/${name}`),
	]) {
		expect(kept(file)).toEqual(fresh(file));
	}
	expect(readdirSync(join(FIXTURE, "built/workflows")).sort()).toEqual(
		readdirSync(join(dir, ".blok/workflows")).sort(),
	);
});
