jsr.io blocks WebFetch. The "How we built JSR" fetch already gave me the API architecture and the search snippets covered immutability/yank. I have enough to write the brief.

## How they do it (concrete)

**npm**
- **API surface:** Plain HTTP/JSON over a CouchDB-derived registry. `GET /{pkg}` returns the full "packument" (all versions, `dist-tags`, `time`); `GET /{pkg}/{version}` returns one version's manifest with a `dist.tarball` URL + `dist.integrity` (SRI hash). `PUT /{pkg}` publishes (tarball base64-embedded in the JSON body). Dist-tags managed via `/-/package/{pkg}/dist-tags`. ([api-docs.npmjs.com](https://api-docs.npmjs.com/))
- **Versioning/resolution:** Strict semver; clients resolve a range (`^1.2.0`) against the packument to the highest satisfying version. **dist-tags** are named aliases to versions (`latest`, `next`, `rc`) that share a namespace with semver, so tag names can't be valid semver. ([npm semver docs](https://docs.npmjs.com/about-semantic-versioning/), [dist-tags](https://dev.to/nop33/using-npm-distribution-tags-the-right-way-562f))
- **Namespacing:** Flat global names + optional `@scope/name` for orgs/users. Scopes are first-come.
- **Security:** **Provenance** via Sigstore — on `npm publish --provenance` from GitHub Actions/GitLab CI, the CI's OIDC token is exchanged at Sigstore's **Fulcio** CA for a single-use short-lived X.509 cert (key deleted immediately); a SLSA provenance statement (subject = pkg SHA512, materials = repo URI + commit SHA, build = workflow path/env) is signed and logged to **Rekor**, a tamper-evident transparency log. Consumers verify with `npm audit signatures`; npmjs.com shows a provenance badge. ([GitHub blog](https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/), [Sigstore blog](https://blog.sigstore.dev/npm-provenance-ga/))
- **Malicious-package handling:** Reactive. **Unpublish** allowed only <72h, or later only if zero dependents + <300 weekly downloads + single owner; otherwise deprecate-only. Detection is mostly third-party (Socket/Snyk/Aikido scan install scripts, obfuscation, exfiltration, typosquats). ([unpublish policy](https://docs.npmjs.com/policies/unpublish/))
- **Client UX:** CLI-first (`npm install`), lockfile (`package-lock.json`) pins resolved versions + integrity hashes.

**JSR (Deno)**
- **Architecture:** Rust/Hyper API on Cloud Run + Postgres metadata; modules stored as-is in a bucket behind a Google L7 LB + CDN, so "only if Google goes down does JSR go down" — custom code is off the hot path. Also emits **npm-compatible tarballs** (transpiled `.js` + `.d.ts`) so Node tooling can consume JSR packages. ([How we built JSR](https://deno.com/blog/how-we-built-jsr))
- **Publish flow:** Server-side **module-graph analysis** in Rust validates the code is valid JS/TS and that all imports resolve; the CLI rewrites imports to explicit, versioned specifiers (`import "chalk"` → `import "npm:chalk@^5"`). Background workers build docs + a **package score**. No tarball of pre-built arbitrary code; **no install scripts at all**. ([How we built JSR](https://deno.com/blog/how-we-built-jsr), [Deno blog](https://deno.com/blog/jsr_open_beta))
- **Namespacing:** **Scopes are mandatory** (`@scope/pkg`) — no flat global names, which structurally kills a class of typosquatting.
- **Versioning:** Semver ranges in the specifier; **versions are fully immutable** — once published, bytes are permanent. No dist-tags; no hard delete — you **yank** (hide from default view, still resolvable by existing dependents). Token-less publish from GitHub Actions + Sigstore provenance, secure-by-default, HTTPS-only. ([immutability](https://jsr.io/docs/immutability), [Socket](https://socket.dev/blog/jsr-new-javascript-package-registry))

**VS Code Marketplace** (the visual-install model)
- **Publishing:** `vsce publish` with auto-increment semver; pre-release channel via `--pre-release` (1.63+). Versions are **single-use** — a deleted version number can never be reused.
- **Verified publisher:** blue check requires domain-ownership proof **+ extension/domain both ≥6 months old** — a reputation gate, not a code-trust gate.
- **Security pipeline (server-side, gated before public visibility):** Marketplace **signs every extension** (VS Code verifies the signature at install); **secret scanning** blocks publish on detected credentials; **malware scan** across multiple AV engines holds the extension until clear; **dynamic detection** runs the extension in a sandbox/clean-room VM. ([publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [MS security blog](https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace))
- **Install UX:** Visual gallery inside the IDE — search, README/changelog/rating preview, one-click install, auto-update on by default.

## Patterns worth stealing for Blok

- **Immutable versions + yank, not delete (JSR).** Best default for a marketplace people build on. Eliminates the "left-pad" and dependency-confusion-via-unpublish failure mode. Give yourself yank (hide) for bad publishes; never reuse a version number.
- **Mandatory scopes (JSR) over first-come flat names (npm).** `@blok/http-trigger`, `@acme/stripe-node`. Structurally defeats typosquatting and makes ownership/provenance legible. This is the single highest-leverage namespacing decision.
- **Sigstore keyless provenance (npm + JSR).** Reuse it wholesale. OIDC→Fulcio→Rekor needs no key management and gives "this node was built from commit X of repo Y by CI" for free — exactly the trust signal an AI-assembled backend needs.
- **Server-side validation as a publish gate (JSR module-graph analysis; VS Code malware/secret/dynamic scans).** Blok's equivalent: at publish, validate the node's Zod input/output schemas parse, the `defineNode` contract is met, declared runtime is real, no secret leakage, and (cross-runtime) the manifest matches the artifact. Reject before it's public.
- **Compute a package score + generate docs at publish (JSR).** Blok nodes are self-describing (Zod schemas) — auto-render the node's input/output contract, examples, and a quality score in the registry website. Huge for discovery + AI consumption.
- **Integrity hashes in the lockfile (npm SRI / `dist.integrity`).** Pin `(node, version, hash)` so installs are reproducible and tamper-evident.
- **Dual-surface install (VS Code visual + npm CLI).** Mirror it: `blokctl add @blok/stripe-node` AND a one-click "Add to workflow" in Studio's node palette resolve to the same registry artifact.

## Pitfalls / criticisms to avoid

- **npm's reactive-only malware posture.** Most compromises are caught by *third parties*, hours after publish, via auto-updated install scripts. Lesson: **Blok nodes must have no arbitrary install-time code execution** (JSR's stance). A node is data (schema + runtime artifact), not an install script.
- **npm unpublish/dependency-confusion hole.** Unpublishing a public name lets an attacker re-claim it; flat names + first-come make confusion attacks trivial. Mandatory scopes + immutability + no-reclaim close this.
- **VS Code "verified ✓" theater.** Researchers (OX, Aqua, Wiz) showed the blue check proves *domain ownership*, not that the code is safe; >550 secrets leaked across 500+ extensions, themes can still bundle malware, and a **leaked publisher PAT auto-pushes malware to the entire install base** because auto-update is on. Lessons: (1) don't let a verification badge imply code safety — separate "publisher identity verified" from "artifact scanned/provenanced"; (2) treat publish tokens as the crown-jewel attack surface — prefer OIDC token-less publish over long-lived PATs, and give tokens identifiable prefixes for secret-scanning; (3) be cautious with auto-update of nodes that execute code.
- **JSR dual-publish friction + `slow-types` bouncer + no dist-tags.** Immutability is "great for trust, inconvenient for typos"; the lack of dist-tags removes a useful release-channel primitive. Lesson for Blok: keep immutability/yank, but **do** offer release channels (a dist-tag-like `latest`/`next`/`beta` pointer) — they're orthogonal to immutability and authors want them.
- **Ecosystem fragmentation.** JSR's biggest practical drag is being a *second* place to publish. Don't strand Blok in its own island — see below.

## Specific lessons for the Blok vision

**Can Blok nodes literally BE npm packages? Partially — and you should lean on npm rather than rebuild it.**

- **Node packaging:** A TS/Node Blok node *can* be a normal npm package (`@blok/...` scope, semver, provenance, lockfile integrity all work today). The hard part is **multi-runtime** (Go/Rust/Java/C#/PHP/Ruby/Python): npm is JS-centric and won't host or resolve a Go binary node cleanly. So:
  - **Reuse npm's *protocol and tooling* shape** (semver, scopes, SRI integrity, Sigstore provenance, dist-tags-as-channels, a CouchDB-style `GET /{scope}/{name}` packument that lists versions + per-version artifact URLs + hashes). An npm-shaped read API means existing tooling/mental models transfer and an AI already "knows" it.
  - **Build a thin Blok registry** (JSR's architecture is the blueprint: small stateless API + Postgres metadata + CDN-fronted object storage; custom code off the hot path) because you need things npm can't express: a **manifest that declares which runtime(s) a node targets**, the Zod (or cross-runtime schema) contract, and **per-runtime artifacts under one logical version**. One package `@blok/stripe@1.2.0` may carry a Node entry *and* a Go binary.
  - **Don't rebuild the JS path — federate to it.** For pure-Node nodes, let the artifact be (or mirror to) an npm tarball; resolve npm deps through npm. JSR proves you can be a distinct registry while staying npm-compatible via generated tarballs — do the same so a Blok node's JS deps aren't stranded.

- **Workflows are the easy case:** a workflow is a manifest (DAG + node refs). Treat it as a small immutable, scoped, provenanced artifact in the same registry — no runtime artifact, just JSON/TS + a list of node dependencies to resolve.

- **AI-native / MCP:** the npm-shaped read API doubles as the MCP surface — `search`, `resolve(scope/name, range)`, `get-contract(node)` (return the Zod schema so the AI can wire inputs), `provenance(node)`. The publish gate (schema validation + provenance) is what lets an AI *trust* an unknown node enough to install it autonomously.

- **Install UX:** ship both from day one — `blokctl add @blok/stripe-node` (npm-install ergonomics) and Studio's visual palette "Add" button hitting the same `resolve`+`integrity` path (VS Code model). One resolution path, two front doors.

**Concrete recommendation:** Build a **JSR-architected, npm-protocol-compatible** Blok registry with **mandatory scopes, immutable versions + yank, Sigstore keyless provenance, a server-side publish gate (schema + secret + manifest validation, zero install scripts), and a multi-runtime manifest**. Reuse npm wholesale for the pure-Node artifact path and federate to it; don't reimplement semver, integrity, or signing.

## Uncertainty flags

- **JSR's exact API endpoint paths and manifest JSON shapes** I could not confirm — `jsr.io/docs/api` and `jsr.io/docs/immutability` return **403 to automated fetch**. JSR architecture/immutability/yank claims come from Deno's own engineering blog and secondary coverage (Socket, PkgPulse), not the primary API reference; verify endpoint shapes directly at `jsr.io/docs/api` before relying on them.
- **npm registry API specifics** (packument shape) are from the standard CouchDB-derived design and `api-docs.npmjs.com`; I did not re-fetch the full schema this session.
- Whether npm would *cleanly* host non-JS runtime artifacts is my assessment (it won't, without abusing tarballs), not a cited npm policy.

## Sources

- npm Registry API — https://api-docs.npmjs.com/
- npm semver / scopes / dist-tags — https://docs.npmjs.com/about-semantic-versioning/ , https://www.w3resource.com/npm/how-to-use-semantic-versioning-work-with-scoped-packages-and-label-packages-with-dist-tags.php , https://dev.to/nop33/using-npm-distribution-tags-the-right-way-562f
- npm provenance (GitHub blog) — https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/
- npm provenance GA (Sigstore) — https://blog.sigstore.dev/npm-provenance-ga/
- npm generating provenance — https://docs.npmjs.com/generating-provenance-statements/
- npm unpublish policy — https://docs.npmjs.com/policies/unpublish/
- Dependency confusion / typosquatting — https://blog.gitguardian.com/protecting-your-software-supply-chain-understanding-typosquatting-and-dependency-confusion-attacks/
- JSR open beta — https://deno.com/blog/jsr_open_beta
- How we built JSR — https://deno.com/blog/how-we-built-jsr
- JSR vs npm — https://www.pkgpulse.com/guides/jsr-vs-npm-javascript-package-registries-2026
- JSR npm compatibility — https://jsr.io/docs/npm-compatibility
- Socket on JSR — https://socket.dev/blog/jsr-new-javascript-package-registry
- VS Code publishing extensions — https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- VS Code Marketplace security & trust — https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace
- VS Code extension runtime security — https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
- Wiz: supply-chain risk in VS Code marketplaces — https://www.wiz.io/blog/supply-chain-risk-in-vscode-extension-marketplaces
- OX Security: verified-symbol exploitation — https://www.ox.security/blog/can-you-trust-that-verified-symbol-exploiting-ide-extensions-is-easier-than-it-should-be/
- Aqua: can you trust VS Code extensions — https://www.aquasec.com/blog/can-you-trust-your-vscode-extensions/