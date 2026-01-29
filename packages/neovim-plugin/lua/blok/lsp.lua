local M = {}

--- Setup LSP for Blok workflow files
--- @param lsp_config table LSP configuration
function M.setup(lsp_config)
	-- Try nvim-lspconfig first (recommended)
	local ok, lspconfig = pcall(require, "lspconfig")
	if ok then
		local configs = require("lspconfig.configs")

		if not configs.blok_lsp then
			configs.blok_lsp = {
				default_config = {
					cmd = lsp_config.cmd,
					filetypes = lsp_config.filetypes,
					root_dir = function(fname)
						return lspconfig.util.root_pattern(unpack(lsp_config.root_markers))(fname)
							or lspconfig.util.find_git_ancestor(fname)
							or vim.fn.getcwd()
					end,
					settings = {},
				},
			}
		end

		lspconfig.blok_lsp.setup({})
		return
	end

	-- Fallback: use vim.lsp.start directly (Neovim 0.10+)
	vim.api.nvim_create_autocmd("FileType", {
		pattern = lsp_config.filetypes,
		callback = function(args)
			vim.lsp.start({
				name = "blok-lsp",
				cmd = lsp_config.cmd,
				root_dir = vim.fs.dirname(
					vim.fs.find(lsp_config.root_markers, {
						upward = true,
						path = vim.fs.dirname(args.file),
					})[1] or args.file
				),
			})
		end,
	})
end

return M
