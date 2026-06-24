# Modal Sandbox API — Express + TypeScript

Express port of the NestJS Modal POC. Same REST API, same `.env`, same Postman
collection — written in a plain functional Express style (exported functions, a
module-level registry, `zod` for validation; no classes/decorators/DI).

## Setup

```bash
npm install
cp .env.example .env   # then fill in MODAL_TOKEN_ID / MODAL_TOKEN_SECRET
npm run dev            # http://localhost:3001/api  (tsx watch)
```

Scripts:

| Script              | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Start the API with live reload (`tsx watch`)          |
| `npm start`         | Start the API once (`tsx`)                            |
| `npm run build`     | Compile to `dist/` (`tsc`)                            |
| `npm run start:prod`| Run the compiled build (`node dist/index.js`)         |
| `npm run sandbox`   | One-shot CLI: clone a repo → run it → print tunnel URL|
| `npm run typecheck` | Type-check without emitting                            |

## Endpoints

All under the `API_PREFIX` (default `api`).

| Method | Path                              | Description                                   |
| ------ | --------------------------------- | --------------------------------------------- |
| GET    | `/health`                         | Liveness check                                |
| POST   | `/sandboxes`                      | Create a sandbox                              |
| GET    | `/sandboxes`                      | List tracked sandboxes                        |
| GET    | `/sandboxes/:id`                  | Status (exitCode + tunnels)                   |
| DELETE | `/sandboxes/:id`                  | Terminate                                     |
| POST   | `/sandboxes/:id/exec`             | Run a command and wait                        |
| GET    | `/sandboxes/:id/files/list?path=` | List a directory                              |
| GET    | `/sandboxes/:id/tunnels`          | Public tunnel URL per exposed port            |
| POST   | `/sandboxes/:id/publish`          | Build the clone + deploy to Cloudflare        |
| POST   | `/previews`                       | Clone → install → dev server → tunnel URL     |

### File toolkit (AI-friendly file access)

| Method | Path                                          | Description                                              |
| ------ | --------------------------------------------- | ------------------------------------------------------- |
| GET    | `/sandboxes/:id/files?path=&start=&end=&numbered=` | Read a file or a 1-based line range (`numbered=1` adds line numbers; whole-file reads cap at 2 MB) |
| PUT    | `/sandboxes/:id/files`                        | Write/overwrite a whole file                            |
| PATCH  | `/sandboxes/:id/files`                        | Targeted edit — see ops below                           |
| DELETE | `/sandboxes/:id/files?path=`                  | Remove a file/dir (recursive)                           |
| GET    | `/sandboxes/:id/stat?path=`                   | `{ path, name, type, size, mtime, permissions }`        |
| GET    | `/sandboxes/:id/exists?path=`                 | `{ path, exists }`                                      |
| GET    | `/sandboxes/:id/tree?path=&depth=&hidden=`    | Recursive tree (nested + ASCII), ignores `node_modules`/`.git`/… |
| POST   | `/sandboxes/:id/search`                       | grep contents → `{ matches:[{file,line,text}], truncated }` |
| GET    | `/sandboxes/:id/glob?pattern=&path=`          | Find files by name → `{ files, truncated }`             |
| POST   | `/sandboxes/:id/mkdir`                         | `mkdir -p` `{ path }`                                   |
| POST   | `/sandboxes/:id/move`                          | Move/rename `{ from, to }`                              |
| POST   | `/sandboxes/:id/copy`                          | Copy (recursive) `{ from, to }`                         |

**`PATCH /files` ops** (body discriminated by `op`, all accept `dryRun`): each returns
`{ changed, totalLines, before, after }` so the change is visible.

- `replace` — `{ oldString, newString, replaceAll? }` (400 if missing / non-unique)
- `replaceLines` — `{ start, end, content }` · `insert` — `{ line, content }`
- `delete` — `{ start, end }` · `append` / `prepend` — `{ content }`

Paths must be absolute and `..`-free.

## Postman

Import `postman/modal-sandbox-api.postman_collection.json`. Set the `baseUrl`,
`repoUrl`, and `gitToken` collection variables. `POST /sandboxes` and
`POST /previews` auto-save the returned id so the follow-up requests just work.

## Publishing to Cloudflare

The Cloudflare credentials for `POST /sandboxes/:id/publish` resolve in this order:
**request body → `.env`**. So you can either pass them per request or set them once in `.env`:

```
CLOUDFLARE_API_TOKEN=...   # Workers Scripts:Edit + zone Workers Routes:Edit + DNS:Edit
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_ZONE_ID=...      # optional; derived from customDomain if omitted
```

Free custom-domain deploy (no Workers for Platforms): pass `customDomain` (e.g.
`poc-test.zenixai.tech`) — after `wrangler deploy`, the Worker is bound to that
subdomain via the Cloudflare API and the response `url` is the custom domain.

## Project layout

```
src/
  index.ts                 entry point (listen + graceful shutdown)
  app.ts                   express app + route mounting
  config.ts                .env loading (dotenv)
  middleware/
    validate.ts            zod validate() + asyncHandler()
    error.ts               httpError() helper + error -> JSON middleware
  routes/                  health / sandboxes / previews routers
  modal/
    client.ts              lazy Modal SDK client
    registry.ts            in-memory sandbox map
    schemas.ts             zod request schemas
    sandbox-service.ts     sandbox ops (create/exec/files/tunnels/publish)
    files-service.ts       AI file toolkit (read range/edit/tree/search/glob/mkdir/move/copy)
    preview-service.ts     composed preview flow
    preview-runner.ts      shared clone→install→dev runner (API + CLI)
    modal.types.ts         type-only access to the ESM modal SDK
  modal-sandbox.ts         standalone CLI (npm run sandbox)
```

Logging is just `console`; errors are plain `Error`s carrying a `status`
(via `httpError(status, message)`) that one middleware turns into JSON.
