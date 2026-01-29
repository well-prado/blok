# Module Reference: IDE Integration

> **Path:** `packages/vscode-extension/`, `packages/lsp-server/`, `packages/intellij-plugin/`, `packages/neovim-plugin/`, `packages/syntax/`
> **Purpose:** IDE support with diagnostics, completion, hover docs, snippets, and syntax highlighting

## What It Does

Blok provides IDE integration through a Language Server Protocol (LSP) implementation and native plugins for VS Code, IntelliJ, and Neovim. These provide real-time workflow validation, code completion, hover documentation, and code snippets.

## VS Code Extension (`packages/vscode-extension/`)

### Features
- **Workflow diagnostics** — Real-time validation of workflow JSON files
- **Hover documentation** — Hover over node names to see descriptions
- **Code completion** — Auto-complete node names, trigger types, step properties
- **Snippets** — TypeScript and workflow JSON snippets
- **Tree views** — Workflow and runtime explorer panels
- **AI commands** — Generate nodes/workflows from the command palette

### Source Files
```
packages/vscode-extension/
├── src/
│   ├── extension.ts                              # Extension entry point
│   ├── providers/
│   │   ├── WorkflowCompletionProvider.ts         # Code completion
│   │   ├── WorkflowDiagnostics.ts                # Error diagnostics
│   │   └── WorkflowHoverProvider.ts              # Hover documentation
│   ├── views/
│   │   ├── WorkflowTreeProvider.ts               # Workflow explorer tree
│   │   └── RuntimeTreeProvider.ts                # Runtime explorer tree
│   ├── commands/
│   │   └── index.ts                              # Command palette commands
│   └── __tests__/                                # Unit tests
├── schemas/
│   └── workflow.schema.json                      # JSON Schema for validation
├── snippets/
│   ├── typescript.json                           # TS snippets (defineNode, etc.)
│   └── workflow.json                             # Workflow JSON snippets
└── package.json                                  # Extension manifest
```

### Snippets Available
| Prefix | Description |
|--------|-------------|
| `blok-node` | Function-first node template |
| `blok-workflow` | Workflow JSON template |
| `blok-trigger-http` | HTTP trigger config |
| `blok-step` | Workflow step template |
| `blok-if-else` | Conditional step template |

## LSP Server (`packages/lsp-server/`)

### Features
- **Diagnostics** — Validates workflow JSON structure
- **Completion** — Node names, properties, trigger types
- **Hover** — Node descriptions, type information
- **Constants** — Shared constants for all editors

### Source Files
```
packages/lsp-server/
├── src/
│   ├── server.ts                    # LSP server entry point
│   ├── completion.ts                # Auto-completion provider
│   ├── diagnostics.ts               # Diagnostic provider
│   ├── hover.ts                     # Hover information provider
│   └── constants.ts                 # Shared constants
├── editors/
│   ├── emacs-lsp.el                 # Emacs LSP config
│   ├── helix-languages.toml         # Helix editor config
│   ├── neovim.lua                   # Neovim LSP config
│   └── sublime-lsp.json             # Sublime Text config
└── package.json
```

## IntelliJ Plugin (`packages/intellij-plugin/`)

### Features
- LSP client for JetBrains IDEs (IntelliJ, WebStorm, etc.)
- Workflow file support
- Syntax highlighting

### Source Files
```
packages/intellij-plugin/
├── src/main/java/com/blok/intellij/
│   └── BlokLspServerFactory.java    # LSP server factory
├── src/main/resources/META-INF/
│   └── plugin.xml                   # Plugin descriptor
├── build.gradle.kts                 # Gradle build
├── gradle.properties
├── settings.gradle.kts
└── README.md
```

## Neovim Plugin (`packages/neovim-plugin/`)

### Features
- LSP client integration
- File type detection
- Syntax highlighting
- Custom Blok commands

### Source Files
```
packages/neovim-plugin/
├── lua/blok/
│   ├── init.lua                     # Plugin entry point
│   ├── lsp.lua                      # LSP client setup
│   └── filetypes.lua                # File type detection
├── ftdetect/
│   └── blok.vim                     # VimL file type detection
├── syntax/
│   └── blok-workflow.vim            # Syntax highlighting
├── doc/
│   └── blok.txt                     # Vim help documentation
└── README.md
```

## Syntax Highlighting (`packages/syntax/`)

### TextMate Grammar
```
packages/syntax/
├── syntaxes/
│   └── blok-workflow.tmLanguage.json  # TextMate grammar for workflow files
├── language-configuration.json        # Language features (brackets, comments)
└── package.json
```

## What to Document

1. **VS Code extension** — Installation, features, configuration
2. **IntelliJ plugin** — Installation for JetBrains IDEs
3. **Neovim setup** — LSP client configuration
4. **LSP server** — Manual setup for other editors (Emacs, Sublime, Helix)
5. **Available snippets** — Full snippet reference
6. **Workflow schema** — JSON Schema for external tools
7. **Troubleshooting** — Common IDE issues
