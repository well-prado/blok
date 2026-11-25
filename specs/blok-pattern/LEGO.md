# Blok as Lego: an app whose features share no file

[PATTERN.md](PATTERN.md) is one node and one workflow at a time. This page is the layer above it: how a whole app is put together so that each feature is a piece you can add, change or remove without touching any other, and so that many AI agents can build it at once without breaking each other's work.

It comes from a real app built by parallel agents. Its nodes and workflows never collided, because the kernel finds them by scanning folders. Every collision was somewhere else: in a file that listed everyone's entries.

## The rule

**A feature is a block. A block owns its files, and no file belongs to two blocks.**

If two features would ever need to edit the same file, the design is wrong. Fix the design with the patterns below; don't coordinate around it.

## What a block is

A block is one feature, in folders named after it. Nothing outside it refers to it by name.

| Piece | Where (`<block>` is the feature's name) |
|---|---|
| Its nodes | `nodes/<block>/<node>/v1/`, each with its own test |
| Its workflows | `workflows/<block>-*.pkl` |
| Its port, the interface to the outside world | `ports/<block>.ts` |
| Its adapter, the port's implementation | `adapters/<block>/` |
| Its wiring, adapter to port | `compose/<block>.ts` |
| Its test fake | `tests/support/ports/<block>.ts` |
| Its commands, keys and screens | its own file in each kind's folder |
| Its pure rules | `domain/<block>/` |
| Its contract, with numbered scenarios | `docs/contracts/<area>/<block>.md` |
| Its scenario tests | `tests/<block>.test.ts` |
| Its changelog and roadmap lines, its new dependencies | `changes/<task>.md`, a fragment named after the change |

Three things are then true, and each is checkable:

- **Adding** a block only adds files.
- **Removing** a block deletes its folders, and everything else still compiles and passes.
- **Changing** a block changes only its own files.

If one of them isn't true, there is a shared file to remove.

## Four patterns that remove every shared file

Each kind of shared file has a known cure.

1. **Discovery, never registration.** Nothing is added to a central list: a folder is scanned, and what is in it exists, as the kernel already does for nodes and workflows. Use it for ports, wiring, test fakes, commands, keys, screens and a tool's subcommands. A central `index.ts` that imports every block, a `switch` over every command, or one table of every key is a defect.
2. **Fragments, with the combined file generated.** Every list of everyone's entries (changelog, roadmap status, decision index, the list of scenarios still waiting for a test, an area's contract) is generated from per-block files, or written as one fragment per change, the way changesets and towncrier handle changelogs. The combined file is never edited by hand.
3. **One writer for what can't be split.** The dependency lockfile, and anything else truly single, is written only by the merge step, which lands one change at a time. A change declares what it needs in its fragment and never commits the file.
4. **A merge queue.** Main always passes: every change is brought up to the latest main and checked again before it lands, so two changes that each pass alone can't break main together (the rule bors gave the Rust project).

What stays shared is the rule documents: the project's rules for agents and its architecture overview. They change only when a rule changes, a person approves those changes, and they go one at a time.

## Planning work as blocks

An agent has to know which files it will touch before it starts. So every task names them:

- **Name only the block's own folders and files.** Never a whole layer (`tests/**`, `ports/**`), never a shared file.
- **If the work needs a shared file,** split that file first, as its own task, with one of the patterns above. Until then, mark the task shared, so it runs alone. A shared task means a pattern is missing.
- **Two tasks whose file lists can't name the same file run side by side.** That is what makes many parallel agents safe.
- **A real dependency is ordering, not conflict.** A block that needs another block's node says so, and waits for it.

## The proof that stops regression

Structure stops collisions. These stop a change from breaking something silently:

- **A contract with numbered scenarios** for every behaviour a person or another program relies on, each naming its test.
- **Red before green.** Every test is seen to fail with its rule switched off, then to pass. A test that can't fail on its promise is a finding, not a pass.
- **A gate with no model in it,** on every change: type check, tests, the checks below, a secret scan.
- **A fresh reviewer** that didn't write the change and takes none of its author's claims on trust. After a failed review, someone re-checks each finding and writes the exact fix list.
- **The merge queue,** so main stays green.

## The checks every Blok app should run

A rule that nothing checks drifts. Each of these runs on every change, and each is proven to fail when broken:

- **The pattern check:** every node in its folder, reaching the world only through ports; every node used by a workflow; pure rules free of input and output; each layer importing only what it may, in every import form.
- **The block check:** a file in a per-block folder imports no other block's file.
- **The shared-file check:** a change to a file every block shares fails unless its task says it is shared.
- **The fixture block:** a test adds a whole fake block (port, adapter, node, workflow, command, test) and fails if that had to touch any file outside the block.

## Starting a new app

1. Lay the folders out by block from the first commit: discovery for ports, wiring, fakes and commands; fragments for the changelog and the roadmap. Never write the central list "for now".
2. Add the checks above and the gate before the first feature.
3. Write the first feature as a block, with its contract and red-before-green tests, and add the fixture-block test.
4. Plan the roadmap as blocks: one task per block, its files named, its dependencies stated.
