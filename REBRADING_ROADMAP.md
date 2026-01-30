Good — 0.1.0 across the board. The plan already reflects that. Here's the summary:

CI/CD removed — all workflow files, CircleCI, GitLab CI, Travis, Jenkins, Changeset, and Dependabot configs are gone. Issue templates and PR template kept.

Rename plan ready — 8 steps covering:

27 package.json files (name + version reset to 0.1.0 + dependency references)
All source code imports (@blok/* → @blok/*)
CLI rename (blokctl → blokctl, .blokctl/ → .blok/)
Infrastructure/Docker references
Documentation
SDK READMEs
Example workflow JSON files
Lockfile regeneration
blokctl is confirmed available on npm.

Claude’s Plan
Plan: Rename blok → blok, blokctl → blokctl
Availability Check
blokctl on npm: Available (404 — not taken)
@blok/* scope: Already in use by this project (@blok/studio, @blok/lsp-server, @blok/syntax)
CI/CD Removal ✅
Already removed:

.github/workflows/ (all 8 workflow files)
.circleci/config.yml
.gitlab-ci.yml
.travis.yml
Jenkinsfile
.changeset/
.github/dependabot.yml
Kept: .github/ISSUE_TEMPLATE/ and .github/pull_request_template.md

Rename Mapping
Old	New
blok (root package)	blok
@blok/* (scope)	@blok/*
blokctl (CLI package + bin)	blokctl
.blokctl/ (config directory)	.blok/
nano-service (default project name)	blok-service
blok-http (Docker APP_NAME)	blok-http
Package Name Mapping (16 packages)
Old Name	New Name	New Version
blok	blok	0.1.0
blokctl	blokctl	0.1.0
@blok/runner	@blok/runner	0.1.0
@blok/shared	@blok/shared	0.1.0
@blok/helper	@blok/helper	0.1.0
@blok/if-else	@blok/if-else	0.1.0
@blok/api-call	@blok/api-call	0.1.0
@blok/react	@blok/react	0.1.0
@blok/trigger-cron	@blok/trigger-cron	0.1.0
@blok/trigger-grpc	@blok/trigger-grpc	0.1.0
@blok/trigger-http	@blok/trigger-http	0.1.0
@blok/trigger-pubsub	@blok/trigger-pubsub	0.1.0
@blok/trigger-queue	@blok/trigger-queue	0.1.0
@blok/trigger-sse	@blok/trigger-sse	0.1.0
@blok/trigger-webhook	@blok/trigger-webhook	0.1.0
@blok/trigger-websocket	@blok/trigger-websocket	0.1.0
@blok/trigger-worker	@blok/trigger-worker	0.1.0
Already using @blok/ (no rename needed, just reset version):
| @blok/studio | @blok/studio | 0.1.0 |
| @blok/lsp-server | @blok/lsp-server | 0.1.0 |
| @blok/syntax | @blok/syntax | 0.1.0 |
| blok-vscode | blok-vscode | 0.1.0 |

Step-by-Step Implementation
Step 1: Rename all package.json files (27 files)
For each package.json:

Update "name" field per mapping above
Reset "version" to "0.1.0"
Update all dependencies, devDependencies, peerDependencies that reference @blok/* → @blok/*
Update references to blokctl → blokctl
Update "bin" entry in CLI package: "blokctl" → "blokctl"
Update "description" fields that mention "blok" → "blok"
Update "keywords" arrays
Files:

package.json (root)
apps/studio/package.json
core/runner/package.json
core/shared/package.json
core/workflow-helper/package.json
nodes/control-flow/if-else@1.0.0/package.json
nodes/web/api-call@1.0.0/package.json
nodes/web/react@1.0.0/package.json
packages/cli/package.json
packages/lsp-server/package.json
packages/syntax/package.json
packages/vscode-extension/package.json
templates/node-function/package.json
templates/node-ui/package.json
templates/node/package.json
templates/ts-template/package.json
tests/integration/sdk-contract/package.json
triggers/cron/package.json
triggers/grpc/package.json
triggers/http/package.json
triggers/pubsub/package.json
triggers/queue/package.json
triggers/sse/package.json
triggers/webhook/package.json
triggers/websocket/package.json
triggers/worker/package.json
runtimes/python3/package.json
Step 2: Rename source code imports and references
Global search-and-replace across all .ts, .tsx, .js files:

@blok/ → @blok/ (in all import statements)
"blokctl" → "blokctl" (in string literals)
blokctl → blokctl (in CLI name constant, commander setup)
.blokctl → .blok (config directory paths)
nano-service → blok-service (default project name)
Key source files:

packages/cli/src/index.ts — CLI_NAME constant
packages/cli/src/commands/create/project.ts — .blokctl paths, nano-service default, HOME_DIR
packages/cli/src/commands/dev/index.ts — .blokctl config path
packages/cli/src/services/commander.ts — HOME_DIR with .blokctl
packages/cli/src/services/runtime-setup.ts — .blokctl paths
packages/cli/src/commands/create/utils/Examples.ts — .blokctl path references
packages/vscode-extension/package.json — workspaceContains:**/blokctl.config.*
packages/vscode-extension/src/commands/index.ts — getNanoctlPath()
packages/lsp-server/src/constants.ts — @blok/* node definitions
All trigger src/index.ts files — JSDoc @blok/* references
All node source files — imports from @blok/runner, @blok/shared, @blok/helper
core/runner/src/**/*.ts — any self-references
core/shared/src/**/*.ts — any self-references
Step 3: Rename workspace and build configs
Makefile — pnpm --filter blokctl → pnpm --filter blokctl
root package.json scripts — all --filter blokctl → --filter blokctl
VS Code snippets — packages/vscode-extension/snippets/typescript.json and workflow.json
Step 4: Rename infrastructure and Docker references
dockerfiles/Dockerfile — APP_NAME=blok-http → APP_NAME=blok-http
dockerfiles/Dockerfile.node — same
dockerfiles/Dockerfile.deploy.http — same
infra/metrics/prometheus.yml — blok-http:4000 → blok-http:4000
infra/metrics/docker-compose.yml — container name references
infra/metrics/dashboard.json — @blok/ references
infra/docker-compose.production.yml — service and env references
tests/e2e/ — APP_NAME and container references
sdk/javascript/nanosdk.js — x-blok-execute-node header
Step 5: Rename documentation
INSTRUCTIONS.md — blokctl commands
TRACE_UI_PROGRESS.md — blokctl references
COMMUNITY.md — package name tables
ROADMAP.md — import examples
PROGRESS.md — package references
documentation/modules/cli.md — "blokctl" title
docs/migration/class-to-function.md — import examples
docs/architecture/security-model.md — package references
docs/compliance/GDPR.md — import examples
All README.md files in SDKs (sdks/go/README.md, etc.)
packages/cli/CHANGELOG.md — header
Step 6: Rename SDK references
sdks/go/README.md — "blok-go" → "blok-go"
sdks/rust/README.md — "blok-rs" → "blok-rs"
sdks/ruby/README.md — gem "blok-ruby" → gem "blok-ruby"
sdks/java/README.md — Java SDK references
sdk/javascript/nanosdk.js — class name and header references
sdk/javascript/README.md — usage examples
Step 7: Rename example workflows
All JSON workflow files in examples/workflows/ that reference @blok/* node types:

user-registration.json
ecommerce-checkout.json
data-pipeline.json
webhook-processor.json
scheduled-report.json
Integration examples (sendgrid, stripe, aws-s3, etc.)
Step 8: Regenerate lockfile

pnpm install
This regenerates pnpm-lock.yaml with all new package names.

Verification
TypeScript compilation: npx tsc --noEmit in CLI package and root — zero errors
Biome lint: npx biome check — zero errors
Search for stragglers: grep -r "blok" --include="*.ts" --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.js" excluding node_modules, dist, pnpm-lock.yaml — should return zero results
Search for old CLI name: grep -r "blokctl" --include="*.ts" --include="*.json" --include="*.md" excluding node_modules, dist — should return zero results
Build CLI: cd packages/cli && pnpm run build — succeeds
Link CLI: npm link — blokctl --help works
Run tests: pnpm run test — all pass (existing tests should still work with renamed imports)
User approved the plan
Update Todos

Rename all package.json files (27 files) — names, versions, deps

Rename source code imports (@blok → @blok)

Rename CLI references (blokctl → blokctl, .blokctl → .blok)

Rename workspace and build configs (Makefile, root scripts, snippets)

Rename infrastructure and Docker references

Rename documentation files

Rename SDK references

Rename example workflow JSON files

Regenerate lockfile with pnpm install

Verify — TypeScript, Biome, grep for stragglers
Update Todos

Rename all package.json files (27 files) — names, versions, deps

Rename source code imports (@blok → @blok)

Rename CLI references (blokctl → blokctl, .blokctl → .blok)

Rename workspace and build configs (Makefile, root scripts, snippets)

Rename infrastructure and Docker references

Rename documentation files

Rename SDK references

Rename example workflow JSON files

Regenerate lockfile with pnpm install

Verify — TypeScript, Biome, grep for stragglers
I'll use a script to efficiently rename all package.json files in bulk — updating names, versions, and dependency references.