# @blokjs/auth

The server half of Blok's auth starter kit: password hashing, the
login / register / logout / password-reset nodes, login throttling, and a
six-method `UserStore` with a SQLite default and a Neon/Postgres adapter.

**No ORM.** The store is an interface you implement over whatever database your
app already has — `pg`, Drizzle and a hand-rolled adapter are all a few lines
below.

## Install

```bash
bun add @blokjs/auth @blokjs/session
```

```bash
BLOK_SESSION_SECRET=$(openssl rand -base64 32)   # session cookie + reset tokens
BLOK_FLASH_SECRET=$(openssl rand -base64 32)     # validation errors across a redirect
```

Both are required. A missing one is a boot error that names the variable and
prints a `Fix:` line.

## Wire it up

```ts
// src/Nodes.ts
import { AUTH_NODES } from "@blokjs/auth";
import { SESSION_NODES } from "@blokjs/session";
export default { ...SESSION_NODES, ...AUTH_NODES, ...myNodes };

// src/Workflows.ts
import { AUTH_KIT_CHAIN, authKitMiddleware } from "@blokjs/auth";
import { authWorkflows } from "@blokjs/auth/examples";
export default { ...(await authKitMiddleware()), ...(await authWorkflows()) };
setGlobalMiddleware([...AUTH_KIT_CHAIN]);
```

That gives you eleven routes — `GET/POST /login`, `POST /logout`,
`GET/POST /register`, `GET/POST /forgot-password`,
`GET/POST /reset-password/:token` and a guarded `GET /dashboard` — plus the
middleware chain (`inertia.session` → `inertia.shared` → `inertia.csrf`, with
`inertia.auth` per route).

Guard your own routes with the same middleware:

```ts
import { AUTH_GUARD } from "@blokjs/auth";
trigger: http.get("/orders", { middleware: [AUTH_GUARD] })
```

## The workflows are the docs

`@blokjs/auth/examples` is not a snippet — the integration tests register that
exact map through a live `HttpTrigger`. Read
[`src/examples/workflows.ts`](./src/examples/workflows.ts) for the form pattern:

1. `@blokjs/validate` checks the body and returns `{ ok, data, errors }` — it
   never throws, because a form failure is data.
2. `branch()` on `checked.ok` splits the arms.
3. The failure arm bounces back with the errors; the success arm runs the auth
   node, which answers `303`.

## `UserStore`

For a serverless deployment, set `BLOK_SERVERLESS=1` and
`BLOK_DATABASE_URL` (or explicitly set `BLOK_AUTH_STORE=postgres` and
`BLOK_AUTH_DATABASE_URL`). The built-in `PostgresUserStore` creates its schema
before the first operation, uses one pooled connection per warm Function by
default, atomically consumes password-reset tokens, and retries transient Neon
failover errors. Set `BLOK_AUTH_PG_SSL=true` for verified TLS. Keep preview and
production URLs and session secrets separate.

```ts
interface UserStore {
  findByEmail(email: string): Promise<AuthUser | undefined>;
  findById(id: string): Promise<AuthUser | undefined>;
  create(user: NewUser): Promise<AuthUser>;          // throws DuplicateEmailError
  updatePassword(id: string, passwordHash: string): Promise<void>;
  createResetToken(record: ResetTokenRecord): Promise<void>;
  consumeResetToken(tokenHash: string): Promise<{ userId: string } | undefined>;
}
```

Three rules an implementation must honour:

- **Email matches case-insensitively.** Run every lookup and insert through
  `normalizeEmail()`.
- **`create` rejects a duplicate email** — throw `DuplicateEmailError`. Never
  silently overwrite a password.
- **Reset tokens are stored hashed and consumed exactly once.**
  `consumeResetToken` deletes *before* it checks the expiry, so a replay finds
  nothing.

The default is `SqliteUserStore` at `.blok/auth.db` (`BLOK_AUTH_SQLITE_PATH`),
on `bun:sqlite` under Bun and the `better-sqlite3` optional peer under Node.
`MemoryUserStore` is the `NODE_ENV=test` default.

### Postgres, on `pg`

```ts
import { Pool } from "pg";
import { configureAuth, normalizeEmail, DuplicateEmailError } from "@blokjs/auth";
import { randomUUID } from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// CREATE TABLE users (
//   id uuid PRIMARY KEY, name text NOT NULL, email citext NOT NULL UNIQUE,
//   password_hash text NOT NULL, created_at bigint NOT NULL);
// CREATE TABLE password_resets (
//   token_hash text PRIMARY KEY, user_id uuid NOT NULL, expires_at bigint NOT NULL);

const row = (r) => r && { id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash, createdAt: Number(r.created_at) };

configureAuth({
  users: {
    async findByEmail(email) {
      const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [normalizeEmail(email)]);
      return row(rows[0]);
    },
    async findById(id) {
      const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
      return row(rows[0]);
    },
    async create({ name, email, passwordHash }) {
      const user = { id: randomUUID(), name, email: normalizeEmail(email), passwordHash, createdAt: Date.now() };
      try {
        await pool.query(
          "INSERT INTO users (id, name, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)",
          [user.id, user.name, user.email, user.passwordHash, user.createdAt],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new DuplicateEmailError(user.email);
        throw error;
      }
      return user;
    },
    async updatePassword(id, passwordHash) {
      await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, id]);
    },
    async createResetToken({ userId, tokenHash, expiresAt }) {
      await pool.query(
        "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2,$3) " +
          "ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at",
        [tokenHash, userId, expiresAt],
      );
    },
    async consumeResetToken(tokenHash) {
      // DELETE … RETURNING makes single-use atomic: two concurrent resets, one winner.
      const { rows } = await pool.query(
        "DELETE FROM password_resets WHERE token_hash = $1 RETURNING user_id, expires_at",
        [tokenHash],
      );
      const found = rows[0];
      if (!found || Number(found.expires_at) <= Date.now()) return undefined;
      return { userId: found.user_id };
    },
  },
});
```

### Drizzle — when your app grows

Drizzle is **not a dependency of this package**; it is the documented path for
an app that already has a schema and wants typed queries. The `UserStore` shape
does not change:

```ts
import { and, eq } from "drizzle-orm";
import { configureAuth, normalizeEmail } from "@blokjs/auth";
import { db } from "./db";
import { passwordResets, users } from "./schema";

configureAuth({
  users: {
    findByEmail: (email) => db.query.users.findFirst({ where: eq(users.email, normalizeEmail(email)) }),
    findById: (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
    create: async (user) => (await db.insert(users).values({ ...user, email: normalizeEmail(user.email) }).returning())[0],
    updatePassword: async (id, passwordHash) => { await db.update(users).set({ passwordHash }).where(eq(users.id, id)); },
    createResetToken: async (record) => { await db.insert(passwordResets).values(record).onConflictDoUpdate({ target: passwordResets.tokenHash, set: record }); },
    consumeResetToken: async (tokenHash) => {
      const [spent] = await db.delete(passwordResets).where(eq(passwordResets.tokenHash, tokenHash)).returning();
      return spent && spent.expiresAt > Date.now() ? { userId: spent.userId } : undefined;
    },
  },
});
```

TypeORM and MikroORM are out: both are class- and decorator-based, which Blok's
node model (`defineNode()` + Zod) is not.

## Passwords

`scrypt` from `node:crypto`, at `N=32768, r=8, p=1, keylen=64` — OWASP's
`2^15/8/1` row, about 32 MiB and ~100 ms per hash. The stored format is
self-describing (`scrypt$N$r$p$salt$hash`), so raising the cost later still
verifies every existing password.

**Not argon2id**, deliberately: every way to get it is worse here. `argon2` and
`@node-rs/argon2` are native addons (a starter kit that fails to install is not
a starter kit), and `Bun.password`'s built-in argon2id only exists under Bun —
a project that hashes under `bun run dev` and deploys to Node could not verify a
single password. An app that wants argon2id installs its own hasher and stores
the digest through the same `UserStore`.

## Throttling

Five failed logins per minute per **IP + email** (`configureAuth({ throttleLimit,
throttleWindow })`), counted *before* the hash so a throttled attempt costs no
CPU. Keyed by both so one attacker cannot lock a victim out of their own
account, and one shared NAT does not throttle an office.

**Ceiling: one process.** Five replicas means five buckets. To make the limit
fleet-wide, implement `ThrottleBackend` over Redis (`INCR` + `EXPIRE`, which is
atomic) and pass it to `setThrottleBackend()`.

## Password resets

The raw token is 32 random bytes and exists only in the link. What the store
holds is `HMAC-SHA256(token, BLOK_SESSION_SECRET)` — hashed at rest so a leaked
table yields no working links, and keyed so an attacker who can write rows still
cannot mint one. Single-use (deleted before anything is checked) and expiring
(`resetTokenTtl`, default one hour).

The kit cannot send email, so delivery is a seam. Left unset, the link is
logged, the way Laravel's `log` mail driver works:

```ts
configureAuth({
  sendResetLink: async ({ email, url }) => sendMail(email, `Reset your password: https://app.example.com${url}`),
});
```

The raw token is passed to that callback and to nothing else — it never becomes
a workflow step output, so it cannot land in `ctx.state`, a trace, or DevTools.

## Security notes

- Session cookie: `HttpOnly`, `SameSite=Lax`, signed, rotated on login and
  registration (session fixation), cleared on logout.
- CSRF: double-submit via `inertia.csrf`; the token is rotated on login,
  registration, logout and password reset.
- Logout sets `clearHistory`, so the pages behind the Back button stop being
  decryptable.
- Failed logins answer with one message on the `email` field whether the address
  exists or not, and an unknown address still pays for a decoy hash — the form
  cannot enumerate accounts by content *or* by timing. `/forgot-password` gives
  the same neutral answer for the same reason.
- Passwords never reach a log: the trace sanitizer redacts `password`, `token`,
  `session`, `cookie` and `csrf` fields, and no node here prints a credential.

## Environment

See [`.env.example`](./.env.example).
