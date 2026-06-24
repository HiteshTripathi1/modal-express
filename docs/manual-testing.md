# Manual Testing — Clone a Repo & Replicate `npm run sandbox` via the API

`npm run sandbox` is a one-shot CLI (`src/modal-sandbox.ts` → `preview-runner.ts`)
that does five things in order:

1. **Create** a sandbox — image with git + pnpm, a port tunneled out, the git
   token injected as a Secret
2. **Clone** a (private) git repo into it, after setting the git credential
   helper + commit identity
3. **Write** the app's `.env` file (optional — gitignored, so not in the clone)
4. **Install** dependencies
5. **Start** the dev server → return the public tunnel URL

This guide does the **same five steps by hand**, one request each, so you can
pause and test every route along the way using Postman.

> **Shortcut:** `POST /previews` collapses all five into a single call — see
> [the end](#shortcut-post-previews). The walkthrough below is the manual
> version for testing routes in isolation.

---

## Postman setup

All requests use **raw → JSON** bodies. Set these **collection variables**:

| Variable | Value |
| --- | --- |
| `baseUrl` | `http://localhost:3001/api` |
| `repoUrl` | `https://github.com/HiteshTripathi1/tenant-app.git` |
| `gitToken` | your GitHub PAT, e.g. `ghp_xxxxxxxx` |
| `sandboxId` | (left blank — filled in after Step 1) |

Start the API first:

```bash
npm install
cp .env.example .env        # fill in MODAL_TOKEN_ID / MODAL_TOKEN_SECRET
npm run dev                 # API on http://localhost:3001/api
```

**Tip:** in Postman, add this to the **Create Sandbox** request's *Tests* tab to
auto-save the id so every later request just works:

```js
pm.collectionVariables.set("sandboxId", pm.response.json().sandboxId);
```

---

## Two meanings of "env" (read this first)

The word `env` means **two different things**:

- **Environment variables** (`process.env` / `$VAR`) — values in the container's
  environment, in memory. Git reads the **token** and **identity** from here.
- **The boilerplate's `.env` file** — an actual file on disk (e.g.
  `/workspace/repo/.env`) that the app's framework (Vite/Next) reads. Usually
  gitignored, so absent from the clone — you write it yourself.

| Where | `env` does what | Writes a file? |
| --- | --- | --- |
| `POST /sandboxes` | Injected as a Modal Secret → **environment variables** | ❌ No |
| `POST /previews` | **Both** — env vars **and** a `.env` file in the app dir | ✅ Yes |
| `POST /sandboxes/:id/publish` | **Both** — build-time `.env` + Worker `--var`s | ✅ Yes |

So on **create**, `env` gives you env vars (perfect for the git token/identity).
The app's `.env` **file** is a separate step (Step 3).

---

## Step 0 — Health check

**GET** `{{baseUrl}}/health`

Response:

```json
{ "status": "ok" }
```

---

## Step 1 — Create the sandbox (with git token + identity)

**POST** `{{baseUrl}}/sandboxes`

Body:

```json
{
  "encryptedPorts": [5173],
  "workdir": "/workspace",
  "timeoutMs": 1800000,
  "env": {
    "GIT_TOKEN": "{{gitToken}}",
    "GIT_USER_NAME": "Hitesh Tripathi",
    "GIT_USER_EMAIL": "hitesh@example.com"
  }
}
```

Response (save `sandboxId` → `{{sandboxId}}`):

```json
{ "sandboxId": "sb-xxxxxxxx" }
```

Why these values:

- **No `image` field** — the create route now defaults to the shared **dev image**
  (`node:22-slim` with **git + pnpm baked in**). Modal builds it once and caches
  it, so every sandbox boots with git/pnpm already present — **no per-sandbox
  `apt-get`**. (Pass `"image": "..."` only if you want a different base, in which
  case you'd have to install git yourself.)
- **`env`** — the git token + identity, injected as a **sandbox-level Modal
  Secret**, so they're present in **every** later `/exec` (this is what lets a
  future `git push` work). The corepack/pnpm non-interactive vars
  (`COREPACK_ENABLE_DOWNLOAD_PROMPT`, `pnpm_config_dangerously_allow_all_builds`)
  are **merged in automatically** by the route — you don't need to pass them.
- **`timeoutMs: 1800000`** — 30 min, matching the CLI's `DEFAULT_TIMEOUT_MS`.

> **Private repo:** the token is **required** — without it the clone fails with
> `fatal: could not read Username ... No such device or address` (git can't
> prompt in a sandbox). Use the exact key name `GIT_TOKEN`.

---

## Step 2 — Configure git + clone

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/exec`

git + pnpm are already in the image, so this command just sets up git and clones:
set the credential helper (feeds `$GIT_TOKEN` to git on demand), set the commit
identity, then clone. All values come from the env injected in Step 1.

Body:

```json
{
  "command": [
    "sh",
    "-c",
    "git config --global credential.helper '!f() { echo username=x-access-token; echo \"password=$GIT_TOKEN\"; }; f' && git config --global user.name \"$GIT_USER_NAME\" && git config --global user.email \"$GIT_USER_EMAIL\" && rm -rf /workspace/repo && git clone --depth 1 https://github.com/HiteshTripathi1/tenant-app.git /workspace/repo"
  ]
}
```

Response:

```json
{
  "exitCode": 0,
  "stdout": "",
  "stderr": "Cloning into '/workspace/repo'...\n"
}
```

Verify it landed — **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/files/list?path=/workspace/repo`

Because `$GIT_TOKEN` and the identity are **sandbox-level** and the git config is
`--global`, a later commit + push just works (same `/exec` endpoint):

```json
{ "command": ["sh", "-c", "cd /workspace/repo && git add -A && git commit -m 'msg' && git push"] }
```

---

## Step 3 — Write the app's `.env` file (optional)

The repo's `.env` is gitignored, so the clone won't have it. The CLI writes it
via the filesystem; the manual equivalent is a file write.

**PUT** `{{baseUrl}}/sandboxes/{{sandboxId}}/files`

Body:

```json
{
  "path": "/workspace/repo/.env",
  "content": "VITE_API_URL=https://api.example.com\n"
}
```

Response:

```json
{ "path": "/workspace/repo/.env", "bytes": 38 }
```

(Remember: this is the **file** the app reads — different from the env vars in
Step 1, which are for git.)

---

## Step 4 — Install dependencies

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/exec`

Body:

```json
{
  "command": ["sh", "-c", "pnpm install"],
  "workdir": "/workspace/repo"
}
```

Response:

```json
{ "exitCode": 0, "stdout": "...", "stderr": "..." }
```

(Can take 10–60s. If the app lives in a subfolder, set `workdir` to
`/workspace/repo/<subdir>`.)

---

## Step 5 — Start the dev server & get the URL

The dev server runs forever, and `/exec` **waits** for the command to finish — so
start it in the **background** with `nohup ... &` or the request hangs. (The CLI
starts it without awaiting; backgrounding is the manual equivalent.)

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/exec`

Body:

```json
{
  "command": ["sh", "-c", "nohup pnpm run dev > /tmp/dev.log 2>&1 &"],
  "workdir": "/workspace/repo"
}
```

Give it a few seconds, then fetch the public tunnel URL —
**GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/tunnels`

```json
{ "5173": { "url": "https://<random>.modal.host" } }
```

Open that `url` — the cloned app is live. 🎉

Dev server not up yet? Tail the log — **POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/exec`

```json
{ "command": ["sh", "-c", "cat /tmp/dev.log"] }
```

That's the full `npm run sandbox` flow, reproduced route by route.

---

## Now test the rest of the routes

### Lifecycle & status

- **GET** `{{baseUrl}}/sandboxes` — list all tracked sandboxes
- **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}` — status `{ sandboxId, exitCode, tunnels }`

### File toolkit (paths must be absolute, `..`-free)

- **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/files?path=/workspace/repo/package.json` — read a file
- **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/files?path=/workspace/repo/package.json&start=1&end=10&numbered=1` — read a line range
- **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/stat?path=/workspace/repo/package.json` — metadata
- **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/exists?path=/workspace/repo/package.json` — existence
- **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/tree?path=/workspace/repo&depth=2` — recursive tree
- **GET** `{{baseUrl}}/sandboxes/{{sandboxId}}/glob?pattern=**/*.ts&path=/workspace/repo` — find by name

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/search` — grep contents

```json
{ "query": "import", "path": "/workspace/repo", "maxResults": 50 }
```

### Targeted edits — PATCH

**PATCH** `{{baseUrl}}/sandboxes/{{sandboxId}}/files`

One body, discriminated by `op`. Returns `{ changed, totalLines, before, after }`.
Add `"dryRun": true` to preview without writing.

```json
{ "path": "/workspace/repo/.env", "op": "replace", "oldString": "api.example.com", "newString": "api.prod.com" }
```

Other ops (same endpoint, swap the body):

```json
{ "path": "...", "op": "replaceLines", "start": 1, "end": 2, "content": "x\n" }
{ "path": "...", "op": "insert", "line": 1, "content": "top\n" }
{ "path": "...", "op": "delete", "start": 1, "end": 1 }
{ "path": "...", "op": "append", "content": "end\n" }
{ "path": "...", "op": "prepend", "content": "start\n" }
```

(`replace` → 400 if `oldString` is missing or non-unique unless `"replaceAll": true`.
`insert` line 0/1 = prepend, past EOF = append.)

### Directory management

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/mkdir`

```json
{ "path": "/workspace/repo/newdir" }
```

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/move`

```json
{ "from": "/workspace/repo/newdir", "to": "/workspace/repo/renamed" }
```

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/copy`

```json
{ "from": "/workspace/repo/renamed", "to": "/workspace/repo/renamed-copy" }
```

**DELETE** `{{baseUrl}}/sandboxes/{{sandboxId}}/files?path=/workspace/repo/renamed-copy` — remove (204)

### Publish — build & deploy to Cloudflare

Needs Cloudflare creds in `.env` (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
or passed in the body. `scriptName` is the stable Worker name.

**POST** `{{baseUrl}}/sandboxes/{{sandboxId}}/publish`

```json
{ "scriptName": "poc-test", "customDomain": "poc-test.zenixai.tech", "buildCmd": "pnpm build" }
```

Response `{ scriptName, url, customDomain, output }` (502 if build/deploy fails).

Manage the published domain afterwards:

- **GET** `{{baseUrl}}/deployments/poc-test/domains` → `{ scriptName, domains:[...] }`
- **PUT** `{{baseUrl}}/deployments/poc-test/domain` (409 if domain belongs to another Worker):

```json
{ "domain": "poc-test-2.zenixai.tech" }
```

### Clean up

**DELETE** `{{baseUrl}}/sandboxes/{{sandboxId}}` — terminate (204)

---

## Route reference

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness |
| POST | `/sandboxes` | Create sandbox (201) |
| GET | `/sandboxes` | List tracked |
| GET | `/sandboxes/:id` | Status (exitCode + tunnels) |
| DELETE | `/sandboxes/:id` | Terminate (204) |
| POST | `/sandboxes/:id/exec` | Run a command and wait (201) |
| GET | `/sandboxes/:id/files/list?path=` | List a directory |
| GET | `/sandboxes/:id/files?path=&start=&end=&numbered=` | Read file / line range |
| PUT | `/sandboxes/:id/files` | Write a whole file |
| PATCH | `/sandboxes/:id/files` | Targeted edit |
| DELETE | `/sandboxes/:id/files?path=` | Remove file/dir (204) |
| GET | `/sandboxes/:id/stat?path=` | File metadata |
| GET | `/sandboxes/:id/exists?path=` | Existence check |
| GET | `/sandboxes/:id/tree?path=&depth=&hidden=` | Recursive tree |
| POST | `/sandboxes/:id/search` | grep contents |
| GET | `/sandboxes/:id/glob?pattern=&path=` | Find files by name |
| POST | `/sandboxes/:id/mkdir` | `mkdir -p` (201) |
| POST | `/sandboxes/:id/move` | Move / rename |
| POST | `/sandboxes/:id/copy` | Copy recursive (201) |
| GET | `/sandboxes/:id/tunnels` | Public tunnel URL per port |
| POST | `/sandboxes/:id/publish` | Build + deploy (201) |
| POST | `/previews` | Clone → dev server → URL, all-in-one (201) |
| GET | `/deployments/:scriptName/domains` | List bound domains |
| PUT | `/deployments/:scriptName/domain` | Rename public domain |

---

## Shortcut: `POST /previews`

Collapses Steps 1–5 into one call (spins up its own sandbox with git + pnpm
preinstalled, sets the credential helper from `token`, clones, writes the `.env`
file from `env`, installs, starts the dev server, and returns the URL).

**POST** `{{baseUrl}}/previews`

```json
{
  "repoUrl": "{{repoUrl}}",
  "token": "{{gitToken}}",
  "port": 5173,
  "userName": "Hitesh Tripathi",
  "userEmail": "hitesh@example.com",
  "env": { "VITE_API_URL": "https://api.example.com" }
}
```

Response:

```json
{ "sandboxId": "sb-...", "url": "https://<random>.modal.host" }
```

Body fields: `repoUrl` (required), `token` (private repos), `branch`, `subdir`,
`port`, `installCmd`, `devCmd`, `userName`, `userEmail`, `env` (written to the
`.env` file), `envFile` (default `.env`). Note here `env` is the **app's `.env`
file**, while `token`/`userName`/`userEmail` are the git settings — the endpoint
splits them for you. Use the returned `sandboxId` as `{{sandboxId}}` to test the
routes above.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `fatal: could not read Username ... No such device or address` (exit 128) | Private repo, no token. Put `GIT_TOKEN` in the create `env` (Step 1). |
| `git: not found` / `pnpm: not found` | You passed an explicit `"image"` (which skips the dev image). Drop it to get the git+pnpm image, or install them yourself in Step 2. |
| `/exec` request hangs forever | Long-running command (dev server) not backgrounded. Use `nohup ... &` (Step 5). |
| App loads but missing config | The `.env` **file** wasn't written. Do Step 3. |
| `404 Sandbox <id> not found` | Wrong/expired id, or the sandbox hit its `timeoutMs`. |
| `502 Build failed` / `Deploy failed` on publish | Check the `stderr` tail in the response. |
