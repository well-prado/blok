" Vim syntax file for Blok workflow JSON files
" Language: Blok Workflow JSON
" Maintainer: Blok Team

if exists("b:current_syntax")
  finish
endif

" Base JSON syntax
runtime! syntax/json.vim
unlet b:current_syntax

" Workflow top-level keys
syntax match blokTopKey /"\(name\|version\|description\|trigger\|steps\|nodes\)"\ze\s*:/ contained containedin=jsonObject
highlight link blokTopKey Keyword

" Trigger types
syntax match blokTriggerType /"\(http\|cron\|webhook\|websocket\|queue\|grpc\|pubsub\|sse\|worker\|manual\)"\ze\s*:/ contained containedin=jsonObject
highlight link blokTriggerType Type

" HTTP methods
syntax match blokHttpMethod /"\(GET\|POST\|PUT\|DELETE\|PATCH\|HEAD\|OPTIONS\)"/ contained containedin=jsonString
highlight link blokHttpMethod Constant

" Step properties
syntax match blokStepProp /"\(node\|type\|runtime\|conditions\|inputs\|outputs\)"\ze\s*:/ contained containedin=jsonObject
highlight link blokStepProp Identifier

" Runtime types
syntax match blokRuntime /"\(local\|module\|runtime\.\w\+\)"/ contained containedin=jsonString
highlight link blokRuntime Special

" Condition keywords
syntax match blokCondition /"\(if\|else\|else-if\|switch\|case\)"\ze\s*:/ contained containedin=jsonObject
highlight link blokCondition Conditional

let b:current_syntax = "blok-workflow"
