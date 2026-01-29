local M = {}

--- Default configuration
M.config = {
	lsp = {
		cmd = { "blok-lsp", "--stdio" },
		filetypes = { "blok-workflow" },
		root_markers = { "package.json", ".git" },
	},
	keymaps = {
		graph = "<leader>bv",
		profile = "<leader>bp",
		cost = "<leader>bc",
	},
}

--- Setup the Blok plugin
--- @param opts table|nil Optional configuration overrides
function M.setup(opts)
	opts = opts or {}
	M.config = vim.tbl_deep_extend("force", M.config, opts)

	-- Register filetype detection
	require("blok.filetypes").setup()

	-- Setup LSP
	require("blok.lsp").setup(M.config.lsp)

	-- Register keymaps
	M._setup_keymaps()
end

--- Setup keymaps for Blok CLI integration
function M._setup_keymaps()
	local keymaps = M.config.keymaps

	if keymaps.graph then
		vim.keymap.set("n", keymaps.graph, function()
			vim.cmd("terminal nanoctl graph --format ascii")
		end, { desc = "Blok: Show dependency graph" })
	end

	if keymaps.profile then
		vim.keymap.set("n", keymaps.profile, function()
			vim.cmd("terminal nanoctl profile --format table")
		end, { desc = "Blok: Show performance profile" })
	end

	if keymaps.cost then
		vim.keymap.set("n", keymaps.cost, function()
			vim.cmd("terminal nanoctl cost --format table")
		end, { desc = "Blok: Show cost estimate" })
	end
end

return M
