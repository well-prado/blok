// A Python project. blokctl does not read Python: it asks the project's own kernel, `python -m blok`,
// which answers in JSON. The contracts come back in the same form the TypeScript kernel gives, so
// everything after this file is the same for both languages.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Schema, type Unit, blok, todo } from "@blokjs/kernel";
import { pyprojectSettings } from "./language.ts";

/** The command that runs Python for this project: its own virtual environment when it has one. */
export function pythonCommand(root: string, env: Record<string, string | undefined> = process.env): string[] {
	const configured = pyprojectSettings(root)?.python?.trim();
	if (configured) return configured.split(/\s+/);
	const local = join(root, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
	if (existsSync(local)) return [local];
	if (existsSync(join(root, "uv.lock")) && spawnSync("uv", ["--version"], { env }).status === 0) {
		return ["uv", "run", "python"];
	}
	return [process.platform === "win32" ? "python" : "python3"];
}

export interface KernelRun {
	command: string;
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

/** Runs the project's Python with these arguments, from the project's root. */
export function python(root: string, args: string[]): KernelRun {
	const [command, ...first] = pythonCommand(root);
	const run = spawnSync(command, [...first, ...args], {
		cwd: root,
		encoding: "utf8",
		// A node folder is somebody's work. The interpreter's cache files do not belong in it.
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		command: [command, ...first].join(" "),
		status: run.status,
		stdout: run.stdout ?? "",
		stderr: run.stderr ?? "",
		error: run.error,
	};
}

/** Asks the project's kernel a question and reads its answer. Throws a sentence when it cannot be asked. */
export function askKernel<T>(root: string, dir: string, args: string[]): T {
	const run = python(root, ["-m", "blok", ...args, "--dir", dir]);
	if (run.error) {
		throw new Error(
			`Python could not be run as "${run.command}": ${run.error.message}. Install Python 3.11 or newer, or say where it is with \`python = "..."\` under [tool.blok] in pyproject.toml.`,
		);
	}
	if (/No module named '?blok'?/.test(run.stderr)) {
		throw new Error(
			`The Python that "${run.command}" runs has no Blok kernel. Add "blok-kernel" to the project's dependencies and install them.`,
		);
	}
	try {
		return JSON.parse(run.stdout) as T;
	} catch {
		const said = run.stderr.trim().split("\n").slice(-12).join("\n");
		throw new Error(`"${run.command} -m blok ${args[0]}" did not answer. This is what it printed:\n${said}`);
	}
}

/** A node's contract as a kernel prints it. */
interface Printed {
	id: string;
	description?: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	errors: string[];
	errorMeanings: Record<string, string>;
	effects: string[];
	idempotent: boolean;
	implemented: boolean;
	fingerprint: string;
}

/** A schema that is already JSON Schema. It checks nothing: the node runs in its own language, which does. */
const given = (shape: Record<string, unknown>): Schema => ({
	"~standard": {
		version: 1,
		vendor: "blok",
		validate: (value) => ({ value }),
		jsonSchema: { input: () => shape, output: () => shape },
	},
});

export interface PythonNodes {
	nodes: Map<string, Unit>;
	problems: string[];
	/** What the kernel calls each contract, for it to compare when it loads what was built. */
	fingerprints: Record<string, string>;
}

/**
 * Every node of a Python project, as a unit this tool can check workflows against. Such a unit has the
 * node's whole contract and none of its logic.
 */
export function pythonNodes(root: string, dir: string): PythonNodes {
	const said = askKernel<{ nodes: Printed[]; problems: string[] }>(root, dir, ["contracts"]);
	const { node } = blok<unknown>();
	const nodes = new Map<string, Unit>();
	const fingerprints: Record<string, string> = {};
	const problems = [...said.problems];
	for (const printed of said.nodes) {
		try {
			nodes.set(
				printed.id,
				node({
					id: printed.id,
					description: printed.description,
					input: given(printed.input),
					output: given(printed.output),
					errors: Object.keys(printed.errorMeanings).length > 0 ? printed.errorMeanings : printed.errors,
					effects: printed.effects,
					idempotent: printed.idempotent,
					run: printed.implemented
						? () => {
								throw new Error(`${printed.id} is written in Python. Run it with "blokctl run".`);
							}
						: todo,
				}),
			);
			fingerprints[printed.id] = printed.fingerprint;
		} catch (err) {
			problems.push((err as Error).message);
		}
	}
	return { nodes, problems, fingerprints };
}

// ---- what `init` and `new` write ---------------------------------------------------------

const snake = (text: string) => text.replaceAll("-", "_");

/** The Python kernel this version of blokctl goes with. */
export const PYTHON_KERNEL = "3.0.0a0";

export const pyproject = (name: string) => `[project]
name = "${name}"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "blok-kernel[fastapi]>=${PYTHON_KERNEL}",
    "uvicorn>=0.30",
]

[dependency-groups]
dev = ["pytest>=8"]

# blokctl reads this table. \`dir\` is the folder that holds nodes/ and workflows/.
[tool.blok]
dir = "."

[tool.pytest.ini_options]
# The project folder is where \`ports\` is imported from. Every node has a test_node.py, so they are told apart by path.
pythonpath = ["."]
addopts = "--import-mode=importlib"
`;

export const pythonPorts = `"""Ports: everything a node may reach outside itself, such as a database, a payment provider or a mailer.

A node only sees these classes. What is behind them is decided where the app starts.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass
class Clock:
    now: Callable[[], datetime]


@dataclass
class Ports:
    clock: Clock


def memory_ports(*, now: Callable[[], datetime] | None = None) -> Ports:
    """A fresh in-memory set of ports. The app runs on it until real ones exist, and each test calls it,
    so that nothing one test stores is seen by another."""
    return Ports(clock=Clock(now=now or (lambda: datetime.now(timezone.utc))))


ports = memory_ports()
`;

export const pythonApp = `import os
from contextlib import asynccontextmanager
from pathlib import Path

from blok import load_app
from blok.cron import start_cron
from blok.fastapi import blok_fastapi
from fastapi import FastAPI

from ports import ports

# Loads the nodes and the built workflows once. Everything below starts from it.
blok = load_app(Path(__file__).parent, ports=ports, env=os.environ)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Every workflow with a cron trigger runs on its schedule. With none, this does nothing.
    jobs = await start_cron(blok)
    yield
    await jobs.stop()


app = FastAPI(lifespan=lifespan)
# Every workflow with an HTTP trigger becomes a route. The rest of this server is yours.
blok_fastapi(app, blok)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "3000")))
`;

/** The lines that put Blok's routes on a FastAPI app, as shown to someone who already has one. */
export const pythonMount = (dir: string) => [
	"from blok import load_app",
	"from blok.fastapi import blok_fastapi",
	`blok_fastapi(app, load_app(${dir}, ports=ports, env=os.environ))`,
];

export function pythonNodeFile(
	id: string,
	name: string,
	body?: { description: string; input: string; output: string; run: string },
): string {
	if (body) {
		return `from pydantic import BaseModel, Field

from blok import Ctx, node
from ports import Ports


${body.input}


${body.output}


${body.run}


${snake(name)} = node(
    id="${id}",
    description="${body.description}",
    input=Input,
    output=Output,
    run=run,
)
`;
	}
	return `from pydantic import BaseModel

from blok import Ctx, node, todo
from ports import Ports


class Input(BaseModel):
    pass


class Output(BaseModel):
    pass


# The contract below is enough to wire this node into a workflow. Write the logic here, and pass \`run=run\`:
#
#   def run(input: Input, ctx: Ctx[Ports]) -> Output: ...


${snake(name)} = node(
    id="${id}",
    description="Say in one sentence what this node does.",
    input=Input,
    output=Output,
    # Business failures a workflow may react to, each with when it happens:
    #   errors={"card_declined": "The provider refused the card."},
    # \`ctx.fail()\` refuses a code that is not listed here.
    errors={},
    run=todo,
)
`;
}

export function pythonTestFile(
	id: string,
	name: string,
	sample?: { ports: string; input: string; output: string },
): string {
	return `${sample ? "from datetime import datetime, timezone\n\n" : ""}from blok.testing import call, node_beside
from ports import memory_ports

${snake(name)} = node_beside(__file__)


def test_it_answers_with_what_its_contract_promises():
    # Fresh ports for every test, so nothing one test stores is seen by another.
    output = call(${snake(name)}, ${sample?.input ?? "{}"}, ports=${sample?.ports ?? "memory_ports()"})
    assert output == ${sample?.output ?? "{}"}


# One test for each error in the contract:
#
#   with pytest.raises(BlokError) as refused:
#       call(${snake(name)}, {...}, ports=memory_ports())
#   assert refused.value.code == "the_error_code"
`;
}

/** The part of the rules page that shows how a node and its test are written. */
export const pythonNodeRules = (at: (path: string) => string) => `### Writing a node

\`\`\`python
from pydantic import BaseModel, Field

from blok import Ctx, node
from ports import Ports


class Input(BaseModel):
    order_id: str
    amount_cents: int = Field(gt=0)
    token: str


class Output(BaseModel):
    receipt_id: str


async def run(input: Input, ctx: Ctx[Ports]) -> Output:
    result = await ctx.ports.payments.charge(input.token, input.amount_cents)
    if not result.ok:
        raise ctx.fail("card_declined", result.reason)
    return Output(receipt_id=result.id)


charge_card = node(
    id="billing/charge-card@1",
    description="Charges a card token for an order.",
    input=Input,
    output=Output,
    errors={"card_declined": "The provider refused the card."},
    run=run,
)
\`\`\`

This is an example. The ports of this project are in \`${at("ports/__init__.py")}\`, and they are the ones to use.

- A node file defines one node, with \`node(...)\`. The name of the variable is yours. The folder may have a hyphen, as in \`charge-card\`: node files are loaded by their path and never imported by name.
- \`input\` reaches \`run\` as an \`Input\`, already checked. It is checked as JSON, so text is not a number: \`"5"\` is refused where the model says \`int\`. What \`run\` returns is checked against \`Output\`, and may be an \`Output\` or a dict with its fields.
- \`ctx\` holds \`ports\`, \`fail\` and \`log\`. \`run\` may be \`async def\` or a plain \`def\`. A plain one runs on a thread, so it may block.
- A node that is not written yet has \`run=todo\`, with \`todo\` imported from \`blok\`. Remove that import when you write the logic.
- Anything raised that is not a \`ctx.fail(...)\` is an unexpected failure: the caller gets a 500 with the error \`unexpected\` and no detail. What was raised goes to the server's log.
- \`Input\` and \`Output\` must be describable as JSON Schema: fields of plain kinds, lists, dicts and other models. A model that contains itself cannot be a contract. Use \`Field(description="...")\` on a field whose meaning is not obvious from its name.
- A field's name in the model is its name everywhere: in the workflow, in the request and in the answer.
- A caller that sends a wrong or missing field gets a 400 with the error \`invalid_input\` on its own. Do not write a node to validate a request.
- \`raise ctx.fail("card_declined", "The bank refused the card.")\` ends the node with that error. The caller receives the code and the message, so write the message for them and put nothing secret in it.
- Optional: \`idempotent=True\` with \`retries=2\` runs the node again when it fails unexpectedly, which is only right when running it twice does no harm. \`timeout_ms\` stops it after that long. \`effects\` names the ports it uses, such as \`effects=["payments"]\`. Nothing reads it but people.

Its test goes beside it, in \`test_node.py\`, and runs with pytest:

\`\`\`python
import pytest

from blok import BlokError
from blok.testing import call, node_beside
from ports import memory_ports

charge_card = node_beside(__file__)


def test_it_charges_the_card_and_answers_with_the_receipt():
    # Fresh ports for every test, so nothing one test stores is seen by another.
    output = call(charge_card, {"order_id": "o_1", "amount_cents": 500, "token": "tok_ok"}, ports=memory_ports())
    # What the in-memory port answers is decided in ${at("ports/__init__.py")}. Read it there, do not guess it.
    assert output == {"receipt_id": "rc_1"}


def test_it_fails_with_card_declined_when_the_provider_refuses():
    # A business failure raises a BlokError whose \`code\` is the one from the contract.
    with pytest.raises(BlokError) as refused:
        call(charge_card, {"order_id": "o_1", "amount_cents": 500, "token": "tok_bad"}, ports=memory_ports())
    assert refused.value.code == "card_declined"
\`\`\`
`;

/** The part of the rules page that shows what starts schedules, queues and tools. */
export const pythonStartRules = `A route is served as soon as the server mounts Blok. A schedule, a queue and a tool each need one line where the app starts, in \`app.py\`. A workflow whose line is missing never runs and never complains, so \`blokctl check\` reminds you of the line when the project has such a trigger:

\`\`\`python
from blok import load_app
from blok.cron import start_cron
from blok.queue import start_queues

blok = load_app(Path(__file__).parent, ports=ports, env=os.environ)
await start_cron(blok)  # every cron trigger
await start_queues(blok, subscribe=subscribe)  # every queue trigger. \`subscribe(queue, handle, concurrency)\` connects your broker.
\`\`\`

Tools are served by a file of their own, which the agent's program starts. It needs the package \`mcp\`, version 2 or newer:

\`\`\`python
from blok.mcp import blok_mcp

server = blok_mcp(blok, name="my-api", version="1.0.0")
\`\`\`

- A node puts a message on a queue through a port, like everything else outside. Until there is a broker, \`memory_queue()\` from \`blok.queue\` is a queue inside the process: give its \`send\` to the port and its \`subscribe\` to \`start_queues\`.`;
