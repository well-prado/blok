# Coding Harness Roadmap

This roadmap is dependency-ordered. Individual issues may proceed in parallel
only when their prerequisites are complete and their files do not overlap.

## Phase 0 — governance and contracts

1. [#914 Architecture governance and conformance check](https://github.com/well-prado/blok/issues/914).
2. [#915 Structured capability/effect manifest](https://github.com/well-prado/blok/issues/915).
3. [#916 Pre-execution policy pipeline](https://github.com/well-prado/blok/issues/916).
4. [#917 Secret references and capability injection](https://github.com/well-prado/blok/issues/917).

## Phase 1 — enforceable workflows

5. [#918 Durable interaction/approval suspension](https://github.com/well-prado/blok/issues/918).
6. [#919 Evidence, assertion, and approval primitives](https://github.com/well-prado/blok/issues/919).
7. [#920 Enforcement profiles and workflow binding rules](https://github.com/well-prado/blok/issues/920).
8. [#921 Permission inheritance for branches and sub-workflows](https://github.com/well-prado/blok/issues/921).

## Phase 2 — harness runtime

9. [#922 Event-sourced agent session store](https://github.com/well-prado/blok/issues/922).
10. [#923 Harness control-plane protocol and gRPC server](https://github.com/well-prado/blok/issues/923).
11. [#924 Provider-neutral agent kernel and model contract](https://github.com/well-prado/blok/issues/924).
12. [#925 Constrained Code Mode runtime](https://github.com/well-prado/blok/issues/925).
13. [#926 Generated Code Mode workflow SDK](https://github.com/well-prado/blok/issues/926).

## Phase 3 — coding capabilities and intelligence

14. [#927 Workspace filesystem capability](https://github.com/well-prado/blok/issues/927).
15. [#928 Git/worktree and bounded process capabilities](https://github.com/well-prado/blok/issues/928).
16. [#929 Graph-provider contract and Tetrix adapter](https://github.com/well-prado/blok/issues/929).
17. [#930 Context assembly, provenance, freshness, and compaction](https://github.com/well-prado/blok/issues/930).

## Phase 4 — desktop and proof

18. [#931 Tauri 2 trusted host and Blok sidecar supervision](https://github.com/well-prado/blok/issues/931).
19. [#932 Harness desktop vertical slice](https://github.com/well-prado/blok/issues/932).
20. [#933 Security, recovery, parallelism, and workflow-adherence campaign](https://github.com/well-prado/blok/issues/933).

## Release gate

The first harness release is blocked until all of these hold:

- no capability can execute without declared effects and a policy decision;
- strict workflows cannot skip required transitions;
- a child or parallel branch cannot widen permissions;
- Code Mode has no ambient OS/network/secret access;
- every mutating action is attributable to a session, turn, workflow, step,
  principal, policy decision, and artifact version;
- crash/restart tests recover sessions and suspended interactions without
  duplicating committed effects;
- stale graph results cannot cause a write without an authoritative source
  re-read and content/version check;
- malicious-repository and prompt-injection tests cannot bypass policy;
- the reference `understand -> plan -> approve -> implement -> test -> review`
  workflow passes the conformance suite.
