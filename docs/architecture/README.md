# Blok Architecture

This directory is the canonical home for repository-wide architecture.
Implementation issues and pull requests may refine an accepted decision, but
they must not silently contradict it.

## Architecture programs

- [Coding harness and enforced agent workflows](agent-harness/README.md)
- [Observability](observability.md)
- [Security model](security-model.md)
- [Trigger system](trigger-system.md)
- [WASI Component Model runtime](runtime/adr/0001-wasi-component-runtime.md)
- [ADR 0016 — Selectable JavaScript execution runtimes](adr-0016-javascript-runtimes.md)
- [ADR 0016 conformance evidence](adr-0016-javascript-runtimes-conformance.md)

## Decision governance

Architecture-affecting work must follow this sequence:

1. Add or amend an ADR under the applicable `docs/architecture/*/adr/`
   directory.
2. Link the ADR from the implementation issue.
3. State the ADR conformance evidence in the pull request.
4. Add automated conformance coverage where the decision is machine-testable.
5. Supersede an accepted ADR explicitly; never rewrite history so a reversed
   decision appears to have always been true.

An architecture-affecting pull request is incomplete when its documentation,
tests, or runtime behavior disagree with the accepted ADRs.
