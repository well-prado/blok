# H1-01 durable interaction and approval suspension

Policy `ask` is a control-flow boundary, not a process-local pause. The
runner-facing `InteractionSuspensionPort` therefore has a durable adapter:
`DurableInteractionPort` persists an immutable interaction record before the
policy call returns its typed control signal.

The reference `InMemoryInteractionStore` defines the contract expected from
SQLite and Postgres adapters. Records move from `pending` to exactly one
terminal state: `answered`, `denied`, `expired`, or `cancelled`. Every mutation
uses an expected sequence, binds the actor to the requesting principal, and
returns a cloned snapshot. Repeating the same answer is idempotent; a stale,
conflicting, unauthorized, or oversized answer is rejected without changing
state.

The store intentionally does not resume a runner by itself. A control-plane
adapter will consume a terminal record, rehydrate the persisted workflow cursor
and state snapshot, then resume after the suspended policy step. That resume
operation must claim the interaction transactionally and re-authorize the
effect; it must never rerun committed pre-suspension steps. Nested and parallel
resume cursors remain owned by the existing runner cursor machinery.

Provider adapters are out of scope for this reference implementation. Their
contract tests must cover crash points before/after persistence, duplicate
answers, expiry, cancellation, principal mismatch, and process restart.
