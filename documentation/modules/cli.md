# Module Reference: CLI (blokctl)

> **Package:** `blokctl`
> **Path:** `packages/cli/`
> **Purpose:** Command-line tool for creating, developing, generating, building, and deploying Blok projects

## What It Does

The `blokctl` CLI is the primary developer interface for Blok. It handles project scaffolding, node/workflow creation, AI-powered code generation, development server, building, deploying, and operational monitoring.

## Installation

```bash
# Global install
npm install -g blokctl

# Or use npx (recommended)
npx blokctl@latest create project
```

## Command Reference

### Project Management
| Command | Description |
|---------|-------------|
| `blokctl create project` | Create a new Blok project |
| `blokctl create node` | Create a new node |
| `blokctl create workflow` | Create a new workflow |
| `blokctl install node <name>` | Install a node from the registry |
| `blokctl install workflow <name>` | Install a workflow from the registry |

### Development
| Command | Description |
|---------|-------------|
| `blokctl dev` | Start development server with HMR |
| `blokctl build` | Build the project for production |
| `blokctl deploy` | Deploy to production |

### AI Code Generation
| Command | Description |
|---------|-------------|
| `blokctl generate ai-node <description>` | Generate a node from natural language |
| `blokctl generate ai-workflow <description>` | Generate a workflow from natural language |
| `blokctl generate ai-trigger <description>` | Generate a trigger from natural language |
| `blokctl generate ai-runtime <description>` | Generate a runtime adapter from natural language |

### Operations
| Command | Description |
|---------|-------------|
| `blokctl monitor` | Open the monitoring dashboard |
| `blokctl profile` | Profile workflow performance |
| `blokctl graph` | Visualize workflow dependency graph |
| `blokctl cost` | Estimate workflow execution costs |

### Migration
| Command | Description |
|---------|-------------|
| `blokctl migrate` | Run migration tools |
| `blokctl migrate node` | Migrate class-based node to function-first |

### Marketplace
| Command | Description |
|---------|-------------|
| `blokctl marketplace runtime` | Browse/install runtime adapters |
| `blokctl publish node` | Publish a node to the registry |
| `blokctl publish workflow` | Publish a workflow to the registry |

### Search
| Command | Description |
|---------|-------------|
| `blokctl search nodes <query>` | Search for nodes |
| `blokctl search workflows <query>` | Search for workflows |
| `blokctl search docs <query>` | Search documentation |

## Source Structure

```
packages/cli/src/
├── index.ts                        # CLI entry point (command registration)
├── commands/
│   ├── build/index.ts              # Build command
│   ├── config/index.ts             # Configuration management
│   ├── cost/index.ts               # Cost estimation
│   ├── create/
│   │   ├── project.ts              # Create project
│   │   ├── node.ts                 # Create node (--style=function|class)
│   │   ├── workflow.ts             # Create workflow
│   │   └── utils/Examples.ts       # Example templates
│   ├── deploy/index.ts             # Deployment
│   ├── dev/index.ts                # Dev server with HMR
│   ├── generate/
│   │   ├── index.ts                # Generate command entry
│   │   ├── NodeGenerator.ts        # AI node generation
│   │   ├── WorkflowGenerator.ts    # AI workflow generation
│   │   ├── TriggerGenerator.ts     # AI trigger generation
│   │   ├── RuntimeGenerator.ts     # AI runtime generation
│   │   ├── NodeFileWriter.ts       # Writes generated code to disk
│   │   ├── GenerationAnalytics.ts  # Tracks generation success/failure
│   │   ├── PromptVersioning.ts     # Manages prompt versions
│   │   ├── prompts/                # System prompts for AI generation
│   │   │   ├── create-fn-node.system.ts
│   │   │   ├── create-workflow.system.ts
│   │   │   ├── create-trigger.system.ts
│   │   │   └── create-runtime.system.ts
│   │   └── validators/             # Validation for generated code
│   │       ├── CompilationValidator.ts
│   │       ├── NodeValidator.ts
│   │       └── WorkflowValidator.ts
│   ├── graph/index.ts              # Dependency graph visualization
│   ├── install/                    # Package installation
│   ├── login/index.ts              # Authentication
│   ├── logout/index.ts
│   ├── marketplace/runtime.ts      # Runtime marketplace
│   ├── migrate/                    # Migration tools
│   ├── monitor/                    # Monitoring dashboard (React TUI)
│   ├── profile/index.ts            # Performance profiling
│   ├── publish/                    # Registry publishing
│   └── search/                     # Search functionality
└── services/
    ├── commander.ts                # CLI framework
    ├── constants.ts                # CLI constants
    ├── local-token-manager.ts      # Auth token storage
    ├── package-manager.ts          # npm/pnpm/yarn abstraction
    ├── posthog.ts                  # Usage analytics
    ├── registry-manager.ts         # Registry API client
    ├── utils.ts                    # Utility functions
    └── workflow-loader.ts          # Workflow file loader
```

## AI Generation System

The AI generation system uses carefully crafted system prompts to generate valid Blok code:

### Prompt Files
| File | Purpose |
|------|---------|
| `create-fn-node.system.ts` | Generates function-first nodes with Zod schemas |
| `create-workflow.system.ts` | Generates workflow JSON/TypeScript structures |
| `create-trigger.system.ts` | Generates trigger classes extending TriggerBase |
| `create-runtime.system.ts` | Generates runtime adapters for new languages |

### Validators
| File | Purpose |
|------|---------|
| `CompilationValidator.ts` | Validates TypeScript compilation |
| `NodeValidator.ts` | Validates node structure and schemas |
| `WorkflowValidator.ts` | Validates workflow JSON structure |

### Analytics
- `GenerationAnalytics.ts` — Tracks success rate, token usage, latency
- `PromptVersioning.ts` — Manages prompt versions for A/B testing

## What to Document

1. **Every command** with flags, options, and examples
2. **Project creation flow** — Interactive CLI walkthrough
3. **Node creation** — Both function-first and class-based templates
4. **AI generation** — How it works, example prompts, tips
5. **Dev server** — HMR features, configuration
6. **Monitoring dashboard** — Features and usage
7. **Migration tools** — Class → function conversion
8. **Marketplace** — Publishing and installing packages
