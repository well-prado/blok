# ADR 0005 — Event-sourced agent sessions

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Workflow replay starts a new run and is not arbitrary process restoration.
Agent sessions need durable turns, streaming facts, steering, approvals,
compaction, forks, background jobs, costs, and recovery across application
restarts.

## Decision

Store sessions as an append-only event log with deterministic folds for current
state. Events distinguish model-visible transcript facts from operational facts
such as policy decisions, budgets, approvals, workflow lineage, and UI state.
Large artifacts are content-addressed references, not inline unbounded payloads.

Each event is ordered within a session and carries session, turn, actor,
causation, correlation, schema version, and timestamp metadata. Checkpoints are
derived acceleration artifacts; the event log remains authoritative. Workflow
runs link to sessions and turns without replacing the session model.

## Consequences

- Resume, fork, compaction, and audit can be reconstructed without hidden live
  mirrors.
- SQLite is the local reference store and Postgres is the distributed reference
  store, both behind one contract.
- Schema evolution and corrupt-tail recovery require explicit tests.
- Hidden model reasoning is not stored as a required product artifact; durable
  records contain observable messages, decisions, summaries, calls, and
  evidence.
