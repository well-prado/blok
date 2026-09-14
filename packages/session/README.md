# @blokjs/session

Signed, `HttpOnly` server-side sessions for Blok.

The cookie carries an opaque, signed session id and **nothing else** — every
byte of session data lives in a pluggable store, so a stolen cookie is
revocable and a tampered one is simply signed out.

Independent of `@blokjs/auth`: anything that needs per-visitor server state can
use it on its own.

## Install

```bash
bun add @blokjs/session
```

Set the secret (there is no default — a missing value is a boot error naming the
variable):

```bash
BLOK_SESSION_SECRET=$(openssl rand -base64 32)
```

## Wire it up

```ts
// src/Nodes.ts
import { SESSION_NODES } from "@blokjs/session";
export default { ...SESSION_NODES, ...myNodes };

// src/Workflows.ts
import { createSessionMiddleware } from "@blokjs/session";
export default { "inertia.session": await createSessionMiddleware(), ...myWorkflows };
setGlobalMiddleware(["inertia.session"]);
```

The middleware runs one step, id `session`, whose output lands in
`ctx.state.session` as `{ id, data }`. It must run **before** `inertia.shared`,
because that is where the `auth` step reads the signed-in user id from.

> **Reserved step id:** `session`. Step ids are one flat namespace shared with
> the page workflow.

## Nodes

| `use:` ref | What it does |
|---|---|
| `@blokjs/session.load` | Read the signed cookie + store into `ctx.state.session`. What the middleware runs. |
| `@blokjs/session.get` | The whole data bag, or the value at `key`. |
| `@blokjs/session.set` | Merge values in. Creates a session (and its cookie) when there is none. |
| `@blokjs/session.forget` | Remove one `key`, or destroy the whole session when no key is given. |
| `@blokjs/session.regenerate` | Rotate the id, keeping the data. The anti-session-fixation step. |

From node code, the same operations are plain functions: `loadSession(ctx)`,
`saveSession(ctx, patch)`, `startSession(ctx, data)`, `regenerateSession(ctx)`,
`destroySession(ctx)`.

## Stores

| Backend | Selected when | Notes |
|---|---|---|
| `memory` | `BLOK_SESSION_STORE=memory`, or `NODE_ENV=test` | Dev and tests. Not durable, not shared. |
| `sqlite` | the default | `bun:sqlite` under Bun, else the `better-sqlite3` optional peer. File at `BLOK_SESSION_SQLITE_PATH` (default `.blok/sessions.db`). |
| `redis` | `REDIS_URL` is set | `ioredis` optional peer. The only backend that is correct across replicas. |

Or bring your own — the contract is three methods:

```ts
configureSession({
  store: {
    async read(id) { /* … */ },
    async write(record) { /* … */ },
    async destroy(id) { /* … */ },
  },
});
```

Expiry is enforced on **read** in every backend, so a stale row can never
authenticate anyone even if a sweep has not run.

## Cookie

`blok_session=<id>.<hmac>; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600`

`SameSite=Lax` rather than `Strict`: `Strict` drops the cookie on a top-level
navigation from another origin, so a user following a link into the app looks
logged out. `Lax` still withholds it from cross-site POSTs, and
[`@blokjs/inertia`'s CSRF double-submit](../../nodes/web/inertia/README.md)
covers what remains. `Secure` is off by default and forced on `SameSite=None`;
set it explicitly in production:

```ts
configureSession({ cookie: { secure: true }, ttl: 60 * 60 * 8 });
```

## Environment

See [`.env.example`](./.env.example).
