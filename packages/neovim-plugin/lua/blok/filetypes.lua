local M = {}

--- Setup filetype detection for Blok workflow files
function M.setup()
	vim.filetype.add({
		pattern = {
			-- Match files under workflows/ directory
			[".*/workflows/.+%.json"] = "blok-workflow",
			[".*/workflows/json/.+%.json"] = "blok-workflow",
			-- Match *.workflow.json files
			[".*%.workflow%.json"] = "blok-workflow",
		},
	})
end

return M
