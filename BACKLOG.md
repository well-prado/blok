# BACKLOG — Blok roadmap

**Last refreshed**: 2026-05-14 (cutting v0.6.0)
**Headline state**: the post-v0.5 actionable backlog is drained. Most items below are deferred-until-real-workload or speculative for v0.7+.

For the full account of what shipped between v0.4 and v0.6, see
[CHANGELOG.md](CHANGELOG.md). The reference docs under
[`docs/d/`](docs/d/) cover each feature with edge cases; the new
[v1 → v2 reliability migration guide](docs/c/migration-guides/v1-to-v2-reliability.mdx)
walks operators through opting into each primitive in 5-minute
recipes.

---

## Open items (deferred / speculative)

### C3 · Per-lease key model for high-cardinality NATS KV buckets

**Status**: deferred — no real workload demands it yet.
**Severity**: low for typical deployments (< 50 active leases per bucket).
**Effort estimate**: ~2 days, ~3 PRs (split storage model, migrate readers, migrate writers).

The current NATS KV concurrency backend stores one JSON document per `(workflowName, concurrencyKey)` bucket. At 50+ active leases per bucket, the doc grows past ~5KB and OCC retry rate climbs sharply (the LOAD-TESTS.md data is from a benchmark, not a real workload). Splitting to one KV entry per lease would scale flat but requires reader changes (filter prefix scan vs. one read) + a migration plan.

Revisit when a real deployment hits the 50-lease ceiling. The Redis backend's Lua scripts already use a per-bucket shape that scales better, so operators with high contention should prefer `BLOK_CONCURRENCY_BACKEND=redis` until C3 ships.

### v0.7 — speculative roadmap items

The following lived briefly on plan branches but did not make v0.6.0
and have no committed timeline. Listed for context, not as a commitment:

- **Step-level concurrency keys** — different invariant set from the trigger-level gate that ships today. Useful for inner-loop fairness when one workflow has multiple "hot" steps. Separate plan needed.
- **Cross-process latest-payload-wins debounce** — today's cross-process debounce backend has an "owner-local payload" semantic where coalesce pings on other processes write to the shared doc but their payloads are dropped. Lifting that requires a payload size cap in the doc + reading the latest on fire (subject to `BLOK_DISPATCH_PAYLOAD_MAX_BYTES`).
- **`wait.for("3 days")` as a literal step primitive** — the building blocks shipped in v0.6 (`wait` step, durable scheduler, state snapshot, re-entry, idempotency, cancellation). What's missing is the step shape: a `wait: { for, until }` field that on first invocation schedules + throws `DeferredDispatchSignal`, and on re-entry recognizes the resume sentinel. Estimated ~2-3 days; not started.
- **`mode: "throttle"` for triggers** — rate-cap variant of `debounce` (fire every N ms regardless of pings). Trigger.dev parity.
- **Capped exponential backoff with jitter for `onLimit: "queue"` re-defer** — today's fixed-1s gives a thundering-herd hop when a slot frees and many queued runs wake up. Future improvement: capped exponential + jitter OR wakeup-on-release (requires cross-process plumbing).
- **Dispatch-time payload merging** — each debounce ping CONTRIBUTES to the final payload (e.g., union of changed fields), not just OVERWRITES. v0.6 ships latest-wins.
- **Step-level OTel metrics** — today's metrics are gate-level (acquire / deny / release). Step-level (cache hit-rate, retry depth, timeout rate) would complement Studio for SLA dashboards.

### Closed: post-v0.5 actionable items

All of these shipped in v0.6.0:

- **D6** — opt-in per-`concurrency_key` labels on OTel counters (#106).
- **G2** — cross-process sub-workflow dispatch via HTTP self-call (#104) + the Studio `http` badge follow-up (#105).
- **I3** — v1 → v2 reliability primitives migration guide (#108).
- **E1 / E2 / E3 / E4 / F1 / F2** — Studio enhancements (scheduled runs, saved filters, sub-workflow depth, DAG view, indexed metadata, filter operators).
- **#100 / #103 / #107** — sample-body trifecta + re-record affordance.
- **#99** — sidebar lists registered-but-never-run workflows.
- **#102** — file-based routing default flip (breaking).

---

## Historical context

The original pre-v0.5 ROADMAP delivered Tier 1 (idempotency, retry, replay), Tier 2 (sub-workflows, concurrency, scheduling, observability, cancellation), and the wait-inside-primitives phases (1–4). Detailed PR-by-PR plans live in `~/.claude/plans/` for any agent that needs to retrace a specific decision.

The v0.4 → v0.6 jump is significant — it's the first release that exposes the full reliability surface to author code via the v2 step shape. Workflows on the v1 shape still load (the runner normalizes at load time), but new development should go straight to v2 + the `bunx blokctl migrate workflows` codemod.
