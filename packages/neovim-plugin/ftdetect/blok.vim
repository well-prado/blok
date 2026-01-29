" Filetype detection for Blok workflow JSON files
autocmd BufRead,BufNewFile */workflows/*.json setfiletype blok-workflow
autocmd BufRead,BufNewFile */workflows/json/*.json setfiletype blok-workflow
autocmd BufRead,BufNewFile *.workflow.json setfiletype blok-workflow
