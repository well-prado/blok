# blok.nvim

Language support for Blok workflow JSON files in Neovim.

## Features

- LSP integration via `blok-lsp` (diagnostics, completion, hover, go-to-definition)
- Filetype detection for workflow JSON files
- Syntax highlighting
- Keymaps for CLI commands (graph, profile, cost)

## Requirements

- Neovim 0.9+
- `blok-lsp` binary on your PATH: `npm install -g @blokjs/lsp-server`
- Optional: [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig) (recommended)

## Installation

### lazy.nvim

```lua
{
    "blok-dev/blok.nvim",
    ft = "blok-workflow",
    opts = {},
}
```

### packer.nvim

```lua
use {
    "blok-dev/blok.nvim",
    config = function()
        require("blok").setup()
    end,
}
```

## Configuration

```lua
require("blok").setup({
    lsp = {
        cmd = { "blok-lsp", "--stdio" },
        filetypes = { "blok-workflow" },
        root_markers = { "package.json", ".git" },
    },
    keymaps = {
        graph = "<leader>bv",   -- Show dependency graph
        profile = "<leader>bp", -- Show performance profile
        cost = "<leader>bc",    -- Show cost estimate
    },
})
```

## Keymaps

| Keymap | Action |
|--------|--------|
| `<leader>bv` | Show workflow dependency graph |
| `<leader>bp` | Show performance profile |
| `<leader>bc` | Show cost estimate |

## File matching

The plugin sets the `blok-workflow` filetype for:
- Any `.json` file under a `workflows/` directory
- Files matching `*.workflow.json`

## Plain Vim / coc.nvim

For plain Vim users with coc.nvim, add to your `coc-settings.json`:

```json
{
    "languageserver": {
        "blok": {
            "command": "blok-lsp",
            "args": ["--stdio"],
            "filetypes": ["json"],
            "rootPatterns": ["package.json", ".git"]
        }
    }
}
```
