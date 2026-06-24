# AI File Toolkit — Modal Sandbox API (Express)

Date: 2026-06-20

Goal: give an AI agent easy, fine-grained access to files inside a Modal sandbox —
partial reads, targeted edits, a folder tree, and search — beyond the current
whole-file read/write/list/remove.

## SDK reality (what we build on)

`SandboxFilesystem` only exposes: `readText`/`readBytes`, `writeText`/`writeBytes`,
`listFiles` (single directory, sorted by name), `stat`, `remove`. No native
partial read, line seek, mkdir, move, copy, or grep.

`FileInfo = { name, path, type: 'file'|'directory'|'symlink', size, mode,
permissions, owner, group, modifiedTime (epoch seconds), symlinkTarget }`.

Strategy:
- **Reads / edits** → read the whole file, manipulate in Node, write it back
  (deterministic; no shell-quoting bugs).
- **Tree** → recursive `listFiles` (depth cap + ignore list).
- **Search / glob / mkdir / move / copy** → `exec` shell commands.
- **exists** → `stat` wrapped in try/catch.

## Endpoints (all under `/api/sandboxes/:id`)

### Read & orient
- `GET /files?path=&start=&end=&numbered=` — optional 1-based inclusive line
  range; `numbered=1` prefixes `N\t`. → `{ path, totalLines, start, end, content }`.
  No range returns the whole file (back-compatible).
- `GET /stat?path=` → `{ path, type, size, mtime }` (mtime = modifiedTime).
- `GET /exists?path=` → `{ path, exists }`.
- `GET /tree?path=&depth=&hidden=` → `{ path, tree, text }`. `tree` is nested
  `{ name, type, children? }`; `text` is an ASCII render. Ignores
  `node_modules`, `.git`, `dist`, `.next`, `build`, `coverage`, `.cache`.

### Edit — `PATCH /files`, discriminated by `op` (all accept `dryRun`)
- `replace` `{ path, op, oldString, newString, replaceAll?, dryRun? }`
  — errors 400 if `oldString` is missing or non-unique (unless `replaceAll`).
- `replaceLines` `{ path, op, start, end, content, dryRun? }`
- `insert` `{ path, op, line, content, dryRun? }` (insert before `line`; `0`/over-length clamps)
- `delete` `{ path, op, start, end, dryRun? }`
- `append` / `prepend` `{ path, op, content, dryRun? }`
- Response: `{ path, op, changed, totalLines, before, after }` where `before`/`after`
  are the changed line span (numbered) so the agent sees exactly what changed.
- `PUT /files` is unchanged = full create/overwrite.

### Search
- `POST /search` `{ query, path?, regex?, ignoreCase?, glob?, maxResults? }`
  → `{ matches: [{ file, line, text }], truncated }`. `grep -rn` via exec; fixed
  string by default, `-E` when `regex`. No matches = empty (not an error).
- `GET /glob?pattern=&path=&maxResults=` → `{ files, truncated }`. `find -name`
  via exec, excluding `node_modules`/`.git`.

### File management
- `POST /mkdir` `{ path }` → `{ path }` (`mkdir -p`).
- `POST /move` `{ from, to }` → `{ from, to }` (`mkdir -p $(dirname to) && mv`).
- `POST /copy` `{ from, to }` → `{ from, to }` (`mkdir -p $(dirname to) && cp -r`).
- Remove already exists: `DELETE /files?path=`.

## Cross-cutting

- **Path safety**: absolute paths only; reject any `..` segment (400).
- **Read-size guard**: whole-file read of > 2 MB without a range → 400 asking for
  a line range (the SDK also enforces its own read limit).
- **Errors** reuse `httpError`: unknown sandbox → 404; bad edit (string not
  found/ambiguous, invalid range) or unsafe path → 400; failed shell op → 400 with stderr.
- **Line model**: split on `\r?\n`; a trailing newline is preserved on write.

## Code layout

- New logic in `src/modal/files-service.ts`.
- `src/modal/sandbox-service.ts` exports `getSandbox(id)` (was private `resolve`)
  and already exports `exec` — both reused by files-service.
- Schemas added to `src/modal/schemas.ts`; routes added to `src/routes/sandboxes.ts`.
- Postman collection + README extended.

## Out of scope (YAGNI for now)

Unified-diff/patch application, binary download/upload (base64), file watch.
