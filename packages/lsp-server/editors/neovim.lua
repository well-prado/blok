-- Blok Workflow LSP - Neovim Configuration
--
-- Add this to your Neovim config (init.lua or lua/plugins/blok.lua)
-- Requires: nvim-lspconfig (https://github.com/neovim/nvim-lspconfig)
--
-- Option 1: Install globally
--   npm install -g @blok/lsp-server
--
-- Option 2: Use from project
--   npx blok-lsp (runs from node_modules)

local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

-- Register the Blok LSP server if not already registered
if not configs.blok_lsp then
	configs.blok_lsp = {
		default_config = {
			-- Use global install or npx
			cmd = { "blok-lsp", "--stdio" },
			-- Alternative: use npx (slower startup, no global install needed)
			-- cmd = { "npx", "blok-lsp", "--stdio" },
			filetypes = { "json" },
			root_dir = lspconfig.util.root_pattern(
				"nanoservice.json",
				"nanoctl.config.ts",
				"nanoctl.config.js",
				"package.json"
			),
			settings = {
				blok = {
					workflowGlob = "**/workflows/**/*.json",
					maxDiagnostics = 100,
				},
			},
			-- Only activate for workflow JSON files
			on_new_config = function(new_config, new_root_dir)
				-- The LSP server itself filters by file path pattern
			end,
		},
	}
end

-- Setup the LSP server
lspconfig.blok_lsp.setup({
	on_attach = function(client, bufnr)
		-- Enable completion triggered by <c-x><c-o>
		vim.bo[bufnr].omnifunc = "v:lua.vim.lsp.omnifunc"

		-- Keybindings for LSP features
		local opts = { buffer = bufnr, noremap = true, silent = true }
		vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
		vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, opts)
		vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, opts)
		vim.keymap.set("n", "]d", vim.diagnostic.goto_next, opts)
		vim.keymap.set("n", "<leader>e", vim.diagnostic.open_float, opts)
	end,
	capabilities = vim.lsp.protocol.make_client_capabilities(),
})
