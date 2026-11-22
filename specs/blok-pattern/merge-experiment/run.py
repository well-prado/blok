#!/usr/bin/env python3
"""Does one folder per unit remove merge conflicts between parallel branches?

N agents each add one unit of work on their own branch, then the branches merge
into main one at a time. Two layouts are compared:

  registry  A node folder, a workflow file, and a hand-edited `src/Workflows.ts`
            that every branch has to touch. It copies the shape of
            `triggers/http/src/Workflows.ts`.
  pattern   One folder per unit and nothing registered by hand.

Everything runs in throwaway git repositories under a temp directory, which is
removed at the end. Nothing in this checkout is touched.

    python3 run.py
"""

import json
import os
import random
import re
import shutil
import subprocess
import tempfile

UNITS = [
    ("billing", "charge-card"), ("billing", "refund-payment"), ("billing", "issue-invoice"), ("billing", "apply-coupon"),
    ("orders", "validate-order"), ("orders", "price-order"), ("orders", "reserve-stock"), ("orders", "cancel-order"),
    ("auth", "verify-token"), ("auth", "rotate-session"), ("auth", "send-reset-link"), ("auth", "check-permission"),
    ("notify", "send-email"), ("notify", "send-sms"), ("notify", "post-webhook"), ("notify", "digest-daily"),
]
SMALL_REGISTRY = ["countries-helper", "empty", "eval-run"]


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}\n{result.stdout}\n{result.stderr}")
    return result


def init(root, name):
    repo = os.path.join(root, name)
    os.makedirs(repo)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "experiment@example.invalid")
    git(repo, "config", "user.name", "experiment")
    git(repo, "config", "commit.gpgsign", "false")
    return repo


def write(repo, path, text):
    full = os.path.join(repo, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as handle:
        handle.write(text)


def camel(name):
    return re.sub(r"-(\w)", lambda match: match.group(1).upper(), name)


def registry_source(names):
    imports = "".join(f'import {camel(n)} from "./workflows/{n}.js";\n' for n in names)
    entries = "".join(f'\t"{n}": {camel(n)},\n' for n in names)
    return (
        'import type Workflows from "./runner/types/Workflows.js";\n'
        + imports
        + "\nconst workflows: Workflows = {\n"
        + entries
        + "};\n\nexport default workflows;\n"
    )


def add_to_registry(text, name, strategy):
    """Insert one import and one map entry, the way an author or an agent would."""
    new_import = f'import {camel(name)} from "./workflows/{name}.js";'
    new_entry = f'\t"{name}": {camel(name)},'
    lines = text.split("\n")
    imports = [i for i, line in enumerate(lines) if line.startswith("import ") and "./workflows/" in line]
    map_open = next(i for i, line in enumerate(lines) if line.startswith("const workflows"))
    map_close = next(i for i, line in enumerate(lines) if line == "};")
    if strategy == "append":
        entry_at, import_at = map_close, imports[-1] + 1
    else:  # "alphabetical": the tidiest thing a branch can do
        entry_at = next((i for i in range(map_open + 1, map_close) if lines[i].strip() > new_entry.strip()), map_close)
        import_at = next((i for i in imports if lines[i] > new_import), imports[-1] + 1)
    lines.insert(entry_at, new_entry)
    lines.insert(import_at, new_import)
    return "\n".join(lines)


def merge_all(repo, branches):
    """Merge each branch into main. Returns how many merges stopped on a conflict."""
    conflicted = 0
    for branch in branches:
        result = git(repo, "merge", "--no-ff", "-q", "-m", f"merge {branch}", branch, check=False)
        if result.returncode == 0:
            continue
        conflicted += 1
        for path in git(repo, "diff", "--name-only", "--diff-filter=U").stdout.split():
            # Resolve the way a careful person would: keep both sides.
            full = os.path.join(repo, path)
            with open(full) as handle:
                kept = [line for line in handle.read().split("\n") if not re.match(r"^(<<<<<<<|=======|>>>>>>>)", line)]
            with open(full, "w") as handle:
                handle.write("\n".join(kept))
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"merge {branch} (conflict resolved by hand)")
    return conflicted


def registry_layout(root, strategy, agents, existing):
    repo = init(root, f"registry-{strategy}-{agents}-{len(existing)}")
    names = sorted(existing)
    write(repo, "src/Workflows.ts", registry_source(names))
    for name in names:
        write(repo, f"src/workflows/{name}.ts", f"export default {{ name: '{name}' }};\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    branches = []
    for module, name in UNITS[:agents]:
        branch = f"agent/{module}-{name}"
        branches.append(branch)
        git(repo, "checkout", "-q", "-b", branch, "main")
        write(repo, f"src/nodes/{name}/index.ts", f"export default {{ name: '{name}' }};\n")
        write(repo, f"src/workflows/{name}.ts", f"export default {{ name: '{name}' }};\n")
        registry = os.path.join(repo, "src/Workflows.ts")
        with open(registry) as handle:
            current = handle.read()
        with open(registry, "w") as handle:
            handle.write(add_to_registry(current, name, strategy))
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"add {name}")
    git(repo, "checkout", "-q", "main")
    conflicted = merge_all(repo, branches)
    with open(os.path.join(repo, "src/Workflows.ts")) as handle:
        final = handle.read()
    # Guard against a silently lossy merge: every branch's work must be present at the end.
    assert all(f'"{name}": {camel(name)},' in final for _, name in UNITS[:agents]), "a registry entry went missing"
    return conflicted


def pattern_layout(root, agents, octopus=False):
    repo = init(root, f"pattern-{'octopus' if octopus else 'serial'}-{agents}")
    write(repo, "nodes/README.md", "one folder per unit\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    branches = []
    for module, name in UNITS[:agents]:
        branch = f"agent/{module}-{name}"
        branches.append(branch)
        git(repo, "checkout", "-q", "-b", branch, "main")
        write(repo, f"nodes/{module}/{name}/v1/node.ts", f"export default {{ id: '{module}.{name}@1' }};\n")
        write(repo, f"nodes/{module}/{name}/v1/node.test.ts", f"// contract test for {module}.{name}@1\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"add {module}.{name}@1")
    git(repo, "checkout", "-q", "main")
    if octopus:
        conflicted = 0 if git(repo, "merge", "-q", "-m", "merge every agent at once", *branches, check=False).returncode == 0 else 1
    else:
        conflicted = merge_all(repo, branches)
    present = sum(os.path.exists(os.path.join(repo, f"nodes/{m}/{n}/v1/node.ts")) for m, n in UNITS[:agents])
    assert present == agents, "a unit folder went missing"
    return conflicted


def version_race(root, agents):
    """The pattern's own failure mode: every branch creates v2 of the same node without a plan."""
    repo = init(root, f"version-race-{agents}")
    write(repo, "nodes/billing/charge-card/v1/node.ts", "export default { id: 'billing.charge-card@1' };\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    branches = []
    for i in range(agents):
        branch = f"agent/feature-{i}"
        branches.append(branch)
        git(repo, "checkout", "-q", "-b", branch, "main")
        write(repo, "nodes/billing/charge-card/v2/node.ts", f"export default {{ id: 'billing.charge-card@2', changeFor: 'feature-{i}' }};\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"v2 for feature {i}")
    git(repo, "checkout", "-q", "main")
    return merge_all(repo, branches)


def large_registry():
    """40 existing entries spread across the alphabet: the fairest case for alphabetical inserts."""
    rng = random.Random(7)
    verbs = (
        "archive assign audit batch build close collect compute confirm create decode deliver enqueue export fetch "
        "filter generate hash import index join list lock map merge normalize open parse publish queue rank read "
        "render resolve sync tag track update upload verify"
    ).split()
    nouns = "account report ticket user file lead cart plan team log".split()
    return [f"{verb}-{rng.choice(nouns)}" for verb in verbs]


def main():
    root = tempfile.mkdtemp(prefix="blok-merge-experiment-")
    try:
        big = large_registry()
        rows = []
        for agents in (2, 4, 8, 16):
            rows.append({
                "agents": agents,
                "registry_append_3_entries": registry_layout(root, "append", agents, SMALL_REGISTRY),
                "registry_alphabetical_3_entries": registry_layout(root, "alphabetical", agents, SMALL_REGISTRY),
                "registry_append_40_entries": registry_layout(root, "append", agents, big),
                "registry_alphabetical_40_entries": registry_layout(root, "alphabetical", agents, big),
                "pattern": pattern_layout(root, agents),
            })
        result = {
            "git": git(root, "--version").stdout.strip(),
            "conflicted_merges_by_layout": rows,
            "pattern_octopus_merge_of_16": pattern_layout(root, 16, octopus=True),
            "version_race_4_branches": version_race(root, 4),
        }
        print(json.dumps(result, indent=2))
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
