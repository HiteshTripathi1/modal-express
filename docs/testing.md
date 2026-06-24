# Testing — formats & cases verified

All cases below were run **live** against a Modal preview of the boilerplate
(clone → install → dev → public tunnel URL), hitting the running API. Status =
HTTP status returned; ✅ = response payload matched the expectation.

## Lifecycle & status

| Case | Call | Result |
|---|---|---|
| Create preview | `POST /previews` | `201` → `{ sandboxId, url, port, timings }` ✅ |
| Create sandbox | `POST /sandboxes` | `201` → `{ sandboxId }` ✅ |
| List | `GET /sandboxes` | `200` → array with `meta` ✅ |
| Status | `GET /sandboxes/:id` | `200` → `{ sandboxId, exitCode, tunnels }` ✅ |
| Tunnels | `GET /sandboxes/:id/tunnels` | `200` → `{ <port>: url }` ✅ |
| Terminate | `DELETE /sandboxes/:id` | `204` ✅ |
| Exec | `POST /sandboxes/:id/exec` | `201` → `{ exitCode, stdout, stderr }` ✅ |
| Unknown sandbox | `GET /sandboxes/sb-bad` | `404` → `{ message, error:"Not Found", statusCode }` ✅ |

## File reads (multiple formats)

| Format | Call | Result |
|---|---|---|
| Whole file | `GET /sandboxes/:id/files?path=…` | `200` → `{ path, totalLines, start, end, content }` (caps at 2 MB) ✅ |
| Line range | `…/files?path=…&start=1&end=12` | returns only that slice ✅ |
| Numbered | `…&numbered=1` | content prefixed `N\t<line>` ✅ |
| List dir | `GET /sandboxes/:id/files/list?path=…` | array of entries `{ name, path, type, size, … }` ✅ |
| Stat | `GET /sandboxes/:id/stat?path=…` | `{ path, name, type, size, mtime, permissions }` ✅ |
| Exists (true) | `GET /sandboxes/:id/exists?path=<real>` | `{ path, exists:true }` ✅ |
| Exists (false) | `…?path=<missing>` | `{ path, exists:false }` ✅ |
| Tree | `GET /sandboxes/:id/tree?path=…&depth=2` | nested tree + ASCII `text`, ignores `node_modules`/`.git` ✅ |

## Edits — `PATCH /sandboxes/:id/files` (all 6 ops + dryRun)

Each returns `{ changed, totalLines, before, after }`. Verified on a scratch file:

| op | body | Result |
|---|---|---|
| `replace` | `{ oldString, newString, replaceAll? }` | replaces; `400` if not found / non-unique ✅ |
| `replaceLines` | `{ start, end, content }` | swaps the range ✅ |
| `insert` | `{ line, content }` | inserts at line ✅ |
| `append` | `{ content }` | appends ✅ |
| `prepend` | `{ content }` | prepends ✅ |
| `delete` | `{ start, end }` | removes the range ✅ |
| `dryRun:true` | any op | reports `changed/before/after` **without writing** ✅ |

## Search / glob / file management

| Case | Call | Result |
|---|---|---|
| grep (fixed) | `POST /search { query, path, ignoreCase, glob }` | `{ matches:[{file,line,text}], truncated }` ✅ |
| grep (regex) | `…{ regex:true }` | extended-regex match ✅ |
| validation | `POST /search {}` | `400` → `{ message:["query: Required"], … }` ✅ |
| glob | `GET /glob?pattern=*.tsx&path=…` | `{ files, truncated }` ✅ |
| mkdir | `POST /mkdir { path }` | `201` → `{ path }` ✅ |
| copy | `POST /copy { from, to }` | `201` → `{ from, to }` ✅ |
| move | `POST /move { from, to }` | `200` → `{ from, to }` ✅ |
| delete | `DELETE /files?path=…` | `204` ✅ |

Paths must be absolute and `..`-free (else `400`).

## Sandbox URL propagation (live preview reflects edits)

Edited `src/routes/index.tsx`'s `<h1>` via `PATCH /files`, then polled the public
tunnel URL: **the change appeared in the served SSR HTML in ~1 second.** Vite picks
up the API file-write and re-renders. (Use `curl`/`fetch` to read the URL — Python
`urllib` can't reach `*.modal.host`; and `grep -a` when scanning the HTML, which
`grep` otherwise treats as binary.)

## Auth (API key)

| Case | Result |
|---|---|
| No key → `GET /sandboxes` | `401` → `{ message, error:"Unauthorized", statusCode:401 }` ✅ |
| Wrong key | `401` ✅ |
| `Authorization: Bearer <key>` | `200` ✅ |
| `x-api-key: <key>` | `200` ✅ |
| Base `GET /api` (public) | `200` (no key) ✅ |
| `GET /api/health` (public) | `200` (no key) ✅ |
| CORS preflight `OPTIONS` (no key) | `204` ✅ |

## Component tagger (Lovable-style)

With `DEV_CMD=npm run dev:tagger -w @tanstart/web`, the served HTML carries
`data-tsd-source="<file>:<line>:<col>"` on elements (e.g.
`<h1 … data-tsd-source="/src/routes/index.tsx:31:7">`), and `n0-tagger` writes its
`tailwind.config.lov.json`. ✅ — this is what maps a click in the preview to a
source location for editing.

## Boilerplate sandbox-readiness (Yotta `tanstack-stadcn-starter`)

- `apps/web/vite.config.ts` sets `server: { host:true, allowedHosts:true }` → tunnel-ready ✅
- env vars are `.optional()` → no startup crash when unset ✅
- workspace packages (`n0-tagger`, `@tanstart/server`) export `./src/index.ts` → no missing-`dist` trap ✅
- **monorepo:** dev must target the workspace (`npm run dev:tagger -w @tanstart/web`) so the appended `--port` reaches vite; the root script nests `npm run` and would swallow it ✅
- Cloudflare publish: **not configured** in the boilerplate (no `@cloudflare/vite-plugin`, no `wrangler.jsonc`) — would need adding before `POST /publish` works.

## Error shape (consistent)

`{ message, error, statusCode }` — `message` is a string, or an array of
validation messages for `400`s.
