---
"@blokjs/trigger-sse": patch
"@blokjs/trigger-websocket": patch
"@blokjs/trigger-mcp": patch
"@blokjs/trigger-webhook": patch
---

Trigger constructors no longer require the caller's `Hono` to be the *same copy
on disk* as the trigger's.

`hono`'s public types include a `unique symbol` (`HonoRequest[GET_MATCH_RESULT]`),
so two installs of hono — even at identical versions — produce two nominally
distinct `Hono` types. `SSETrigger`/`WebSocketTrigger`/`McpTrigger`/
`WebhookTrigger` declared `constructor(app: Hono<any, any, any>)`, so a generated
project that builds `new Hono()` from its own `node_modules/hono` failed `tsc`
outright whenever the trigger package's `hono` resolved elsewhere:

```
error TS2345: Argument of type 'Hono<BlankEnv, BlankSchema, "/">' is not
assignable to parameter of type 'Hono<any, any, any>'.
  Property '[GET_MATCH_RESULT]' is missing in type 'HonoRequest<any, any>' …
```

That is every `blokctl create --local` scaffold whose trigger set includes sse,
websocket, mcp or webhook (the `file:` link makes tsc resolve the trigger's
`hono` through the monorepo realpath), and any npm tree where hono lands nested
rather than hoisted.

Fixes #886. The constructors now take the structural slice of Hono they actually call
(`get`/`post`/`all`), the same treatment the cross-package `HttpTriggerLike`
parameter already had. Any concrete `Hono` still satisfies it, the `app` field
keeps its real `Hono` type internally, and there is no runtime change.
