# Blok IntelliJ Plugin

Language support for Blok workflow JSON files in IntelliJ IDEA, WebStorm, and other JetBrains IDEs.

## Features

- Diagnostics and validation for workflow JSON files
- Auto-completion for workflow keys, trigger types, and node references
- Hover documentation for workflow elements
- Go-to-definition for node references

## Requirements

- IntelliJ IDEA 2024.1+ (or any JetBrains IDE)
- [LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij) plugin installed
- `blok-lsp` binary available on your PATH

### Installing the LSP server

```bash
npm install -g @blokjs/lsp-server
```

## Development

### Prerequisites

- JDK 17+
- Gradle (wrapper included)

### Build

```bash
./gradlew buildPlugin
```

The plugin ZIP will be in `build/distributions/`.

### Run in sandbox IDE

```bash
./gradlew runIde
```

### Install manually

1. Build the plugin: `./gradlew buildPlugin`
2. In your JetBrains IDE: Settings > Plugins > Gear icon > Install Plugin from Disk
3. Select the ZIP from `build/distributions/`

## File matching

The plugin activates for:
- Any `.json` file under a `workflows/` directory
- Files matching `*.workflow.json`
