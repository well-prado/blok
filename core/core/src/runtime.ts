/**
 * @blokjs/core/runtime — the HEAVY engine surface.
 *
 * Re-exports the full `@blokjs/runner` barrel (Runner, Configuration,
 * TriggerBase, adapters, tracing, RuntimeRegistry, …). This subpath DOES pull
 * grpc/otel/sqlite — that's expected; it's the runtime, not the authoring DSL.
 * Keep authoring imports on the `.` entry so they stay light.
 */
export * from "@blokjs/runner";
