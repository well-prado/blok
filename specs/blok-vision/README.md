# Blok Platform Vision — Spec Suite

The strategic plan to evolve Blok into the best AI-native modular workflow platform: a visual Studio editor, an npm-like registry/marketplace for nodes **and** workflows, modular triggers, cross-runtime node packaging, and an MCP + Skills surface so an AI can assemble a backend in a day.

**Start with [S0 — Master Vision & Roadmap](./S0-master-vision.md)** — north star, the dependency graph, the phased roadmap, the D1–D8 decisions register, the business decisions you must make, and how this beats n8n / Trigger.dev / Windmill.

## The suite

| Spec | Title | Phase | Depends on |
|---|---|---|---|
| [S0](./S0-master-vision.md) | Master Vision & Roadmap | — | — |
| [S1](./S1-workflow-json-ir.md) | Workflow JSON IR + Published Schema | 1 | — |
| [S2](./S2-node-identity-versioning.md) | Node Identity, Scoping & Versioning | 1 | S1 |
| [S3](./S3-expression-ergonomics.md) | Expression & Authoring Ergonomics | 1 | — |
| [S7](./S7-module-descriptor.md) | Generalized Module-Descriptor Contract | 1 | — |
| [S4](./S4-studio-visual-editing.md) | Studio Visual Editing — Canvas, Palette, Inspector | 2 | S1 |
| [S5](./S5-studio-authoring-ux.md) | Studio Authoring UX — Connect-Picker, Preview, Run-One-Step, Replay | 2 | S4, S3 |
| [S6](./S6-registry-architecture.md) | The Blok Registry — Architecture | 2 | S2 |
| [S8](./S8-modular-triggers.md) | Modular Triggers | 2 | S7 |
| [S9](./S9-node-packaging-multiruntime.md) | Node Packaging & Multi-Runtime Distribution | 3 | S2, S6 |
| [S10](./S10-managed-connections-auth.md) | Managed Connections — the Auth Primitive | 3 | S6 |
| [S11](./S11-ai-native-mcp-skills.md) | AI-Native Surface — MCP + Skills | 3 | S2, S6, S7 |
| [S12](./S12-marketplace-trust-licensing.md) | Marketplace Trust, Verification & Licensing | 3 | S6 |

## Cross-cutting decisions (D1–D8)

Full rationale in [S0](./S0-master-vision.md#decisions-register-d1d8) and [`_research-dossier.md`](./_research-dossier.md).

- **D1** Format: TS canonical + a published JSON IR the canvas/registry/AI consume losslessly.
- **D2** Canvas positions ephemeral (dagre); optional pass-through `ui:{x,y}` later.
- **D3** Registry: thin, **npm-protocol-compatible**, JSR-architected; federate to npm for the JS path.
- **D4** Mandatory scopes `@scope/node@version`; version-pinned `use:` refs; semver the workflow schema.
- **D5** Keep the typed `$` proxy; fix the branch `when` footgun; add connect-picker + live preview; defer CEL/JSONata.
- **D6** Generalize the observability module descriptor into one contract reused by triggers/nodes/runtimes.
- **D7** `blokctl` is the single kernel; MCP + Skills are thin layers over it.
- **D8** A multi-runtime node = N single-language implementations under one manifest entry (not one binary).

## Decisions that need your sign-off

1. **License / commercial model** (S0 → Decision A) — decide the open/closed boundary up front; don't paywall reliability.
2. **Build vs. extend the registry backend** (S0 → Decision B) — gates S6 → S9/S10/S11.
3. **Accept the D8 multi-runtime split** — reframes "one node, all runtimes" → "one entry, N implementations."

## Provenance

Authored spec-first via deep research: a 17-agent discovery pass (current-state code maps + competitor analysis of n8n, Trigger.dev, Windmill, durable-execution, no-code marketplaces, registry design, AI-native/MCP, formats/expressions) → the [dossier](./_research-dossier.md), then a 25-agent draft → adversarial-harden authoring pass. Raw briefs in [`research/`](./research/).
