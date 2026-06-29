/**
 * @blokjs/core/runtime — the HEAVY engine surface.
 *
 * Re-exports the full `@blokjs/runner` barrel (Runner, Configuration,
 * TriggerBase, adapters, tracing, RuntimeRegistry, …) AND the `@blokjs/shared`
 * primitives (Context, mapper, NodeBase, error envelopes, …) so a migration off
 * the standalone `@blokjs/runner` / `@blokjs/shared` packages has a single
 * target (#374/#378). The two barrels share no export names (verified), so the
 * `export *` merge is unambiguous. This subpath DOES pull grpc/otel/sqlite —
 * that's expected; it's the runtime, not the authoring DSL. Keep authoring
 * imports on the `.` entry so they stay light.
 */
export * from "@blokjs/runner";
export * from "@blokjs/shared";
