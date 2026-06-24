/**
 * AI-friendly file toolkit on top of the Modal sandbox filesystem:
 * partial reads, targeted edits (string + line based), a folder tree,
 * search/glob, and basic file management.
 *
 * Reads/edits use read-whole → manipulate in Node → write-back (deterministic).
 * Tree uses recursive listFiles. Search/glob/mkdir/move/copy shell out via exec.
 */
import { posix as path } from 'node:path';
import { httpError } from '../middleware/error.js';
import { exec, getSandbox } from './sandbox-service.js';
import type { Sandbox } from './modal.types.js';

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB
const TREE_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'build',
  'coverage',
  '.cache',
]);

// --- path safety ---

/** Require an absolute path with no ".." segment. */
export function safePath(p: unknown): string {
  if (typeof p !== 'string' || p === '') throw httpError(400, 'path is required');
  if (!p.startsWith('/')) throw httpError(400, `path must be absolute: ${p}`);
  if (p.split('/').includes('..')) throw httpError(400, `path must not contain "..": ${p}`);
  return p;
}

// --- line helpers ---

/** Split text into lines, treating a single trailing newline as a terminator. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  return lines;
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const text = lines.join('\n');
  return trailingNewline && lines.length > 0 ? text + '\n' : text;
}

function numbered(lines: string[], startLine: number) {
  return lines.map((text, i) => ({ line: startLine + i, text }));
}

// --- filesystem wrappers (map SDK errors to HTTP) ---

function mapFsError(err: unknown, p: string) {
  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  if (/NotFound/i.test(name) || /not found/i.test(msg)) return httpError(404, `Not found: ${p}`);
  if (/IsADirectory/i.test(name)) return httpError(400, `Is a directory: ${p}`);
  if (/NotADirectory/i.test(name)) return httpError(400, `Not a directory: ${p}`);
  if (/TooLarge/i.test(name)) return httpError(400, `File too large to read: ${p}`);
  return httpError(502, `Filesystem error on ${p}: ${msg}`);
}

async function statRaw(sandbox: Sandbox, p: string) {
  try {
    return await sandbox.filesystem.stat(p);
  } catch (err) {
    throw mapFsError(err, p);
  }
}

async function readTextSafe(sandbox: Sandbox, p: string) {
  try {
    return await sandbox.filesystem.readText(p);
  } catch (err) {
    throw mapFsError(err, p);
  }
}

async function writeTextSafe(sandbox: Sandbox, p: string, content: string) {
  try {
    await sandbox.filesystem.writeText(content, p);
  } catch (err) {
    throw mapFsError(err, p);
  }
}

// --- read & orient ---

export async function read(
  id: string,
  rawPath: string,
  opts: { start?: number; end?: number; numbered?: boolean },
) {
  const p = safePath(rawPath);
  const sandbox = await getSandbox(id);

  const wholeFile = opts.start == null && opts.end == null;
  if (wholeFile) {
    const info = await statRaw(sandbox, p);
    if (info.type === 'directory') {
      throw httpError(400, `${p} is a directory; use /tree or /files/list`);
    }
    if (info.size > MAX_READ_BYTES) {
      throw httpError(
        400,
        `File is ${info.size} bytes (> ${MAX_READ_BYTES}); pass start/end to read a line range`,
      );
    }
  }

  const text = await readTextSafe(sandbox, p);
  const lines = splitLines(text);
  const total = lines.length;
  const start = opts.start ?? 1;
  const end = opts.end ?? total;
  if (start < 1) throw httpError(400, 'start must be >= 1');
  if (end < start) throw httpError(400, 'end must be >= start');

  const slice = lines.slice(start - 1, end);
  const content = opts.numbered
    ? numbered(slice, start)
        .map((l) => `${l.line}\t${l.text}`)
        .join('\n')
    : slice.join('\n');

  return { path: p, totalLines: total, start, end: Math.min(end, total), content };
}

export async function stat(id: string, rawPath: string) {
  const p = safePath(rawPath);
  const sandbox = await getSandbox(id);
  const info = await statRaw(sandbox, p);
  return {
    path: info.path,
    name: info.name,
    type: info.type,
    size: info.size,
    mtime: info.modifiedTime,
    permissions: info.permissions,
  };
}

export async function exists(id: string, rawPath: string) {
  const p = safePath(rawPath);
  const sandbox = await getSandbox(id);
  try {
    await sandbox.filesystem.stat(p);
    return { path: p, exists: true };
  } catch {
    return { path: p, exists: false };
  }
}

// --- tree ---

interface TreeNode {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  path: string;
  truncated?: boolean;
  children?: TreeNode[];
}

export async function tree(
  id: string,
  rawPath: string,
  opts: { depth?: number; hidden?: boolean },
) {
  const p = safePath(rawPath);
  const sandbox = await getSandbox(id);
  const root = await buildNode(sandbox, p, path.basename(p) || p, opts.depth ?? 3, !!opts.hidden);
  return { path: p, tree: root, text: renderTree(root) };
}

async function buildNode(
  sandbox: Sandbox,
  dirPath: string,
  name: string,
  depth: number,
  hidden: boolean,
): Promise<TreeNode> {
  const node: TreeNode = { name, type: 'directory', path: dirPath, children: [] };
  if (depth <= 0) {
    node.truncated = true;
    return node;
  }
  let entries;
  try {
    entries = await sandbox.filesystem.listFiles(dirPath);
  } catch (err) {
    throw mapFsError(err, dirPath);
  }
  for (const e of entries) {
    if (!hidden && e.name.startsWith('.')) continue;
    if (e.type === 'directory') {
      if (TREE_IGNORE.has(e.name)) {
        node.children!.push({ name: e.name, type: 'directory', path: e.path, truncated: true });
        continue;
      }
      node.children!.push(await buildNode(sandbox, e.path, e.name, depth - 1, hidden));
    } else {
      node.children!.push({ name: e.name, type: e.type, path: e.path });
    }
  }
  return node;
}

function renderTree(node: TreeNode, prefix = '', isRoot = true): string {
  let out = isRoot ? `${node.name}/\n` : '';
  const children = node.children ?? [];
  children.forEach((child, i) => {
    const last = i === children.length - 1;
    const label =
      child.name +
      (child.type === 'directory' ? '/' : '') +
      (child.truncated ? ' …' : '');
    out += `${prefix}${last ? '└── ' : '├── '}${label}\n`;
    if (child.children?.length) {
      out += renderTree(child, prefix + (last ? '    ' : '│   '), false);
    }
  });
  return out;
}

// --- edit ---

export type EditBody =
  | { op: 'replace'; path: string; oldString: string; newString: string; replaceAll?: boolean; dryRun?: boolean }
  | { op: 'replaceLines'; path: string; start: number; end: number; content: string; dryRun?: boolean }
  | { op: 'insert'; path: string; line: number; content: string; dryRun?: boolean }
  | { op: 'delete'; path: string; start: number; end: number; dryRun?: boolean }
  | { op: 'append'; path: string; content: string; dryRun?: boolean }
  | { op: 'prepend'; path: string; content: string; dryRun?: boolean };

export async function edit(id: string, body: EditBody) {
  const p = safePath(body.path);
  const sandbox = await getSandbox(id);
  const text = await readTextSafe(sandbox, p);

  const { newText, ...result } = applyEdit(text, body);
  if (result.changed && !body.dryRun) {
    await writeTextSafe(sandbox, p, newText);
  }
  return { path: p, op: body.op, dryRun: !!body.dryRun, ...result };
}

/**
 * Pure edit: apply an op to file text and report what changed. No IO, so it is
 * unit-testable in isolation.
 */
export function applyEdit(text: string, body: EditBody) {
  const trailing = text.endsWith('\n');
  const oldLines = splitLines(text);

  let newText: string;

  if (body.op === 'replace') {
    const count = countOccurrences(text, body.oldString);
    if (count === 0) throw httpError(400, 'oldString not found in file');
    if (count > 1 && !body.replaceAll) {
      throw httpError(
        400,
        `oldString is not unique (${count} matches); set replaceAll or add more surrounding context`,
      );
    }
    newText = body.replaceAll
      ? text.split(body.oldString).join(body.newString)
      : replaceOnce(text, body.oldString, body.newString);
  } else {
    const lines = [...oldLines];
    const len = lines.length;
    if (body.op === 'replaceLines') {
      assertRange(body.start, body.end, len);
      lines.splice(body.start - 1, Math.min(body.end, len) - body.start + 1, ...splitLines(body.content));
    } else if (body.op === 'insert') {
      const idx = body.line <= 1 ? 0 : Math.min(body.line - 1, len);
      lines.splice(idx, 0, ...splitLines(body.content));
    } else if (body.op === 'delete') {
      assertRange(body.start, body.end, len);
      lines.splice(body.start - 1, Math.min(body.end, len) - body.start + 1);
    } else if (body.op === 'append') {
      lines.push(...splitLines(body.content));
    } else if (body.op === 'prepend') {
      lines.unshift(...splitLines(body.content));
    }
    newText = joinLines(lines, trailing);
  }

  const newLines = splitLines(newText);
  const region = changedRegion(oldLines, newLines);

  return {
    newText,
    changed: newText !== text,
    totalLines: newLines.length,
    before: numbered(oldLines.slice(region.start, region.endOld + 1), region.start + 1),
    after: numbered(newLines.slice(region.start, region.endNew + 1), region.start + 1),
  };
}

function countOccurrences(text: string, sub: string): number {
  if (sub === '') return 0;
  return text.split(sub).length - 1;
}

function replaceOnce(text: string, sub: string, rep: string): string {
  const i = text.indexOf(sub);
  return text.slice(0, i) + rep + text.slice(i + sub.length);
}

function assertRange(start: number, end: number, len: number) {
  if (start < 1 || end < start) throw httpError(400, `invalid line range ${start}-${end}`);
  if (start > len) throw httpError(400, `start ${start} is past end of file (${len} lines)`);
}

/** First/last differing line indices between two line arrays. */
function changedRegion(oldLines: string[], newLines: string[]) {
  let start = 0;
  const min = Math.min(oldLines.length, newLines.length);
  while (start < min && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }
  return { start, endOld, endNew };
}

// --- search & glob ---

export async function search(
  id: string,
  opts: {
    query: string;
    path?: string;
    regex?: boolean;
    ignoreCase?: boolean;
    glob?: string;
    maxResults?: number;
  },
) {
  const p = safePath(opts.path ?? '/workspace');
  const max = opts.maxResults ?? 200;
  const flags = ['-rnI', opts.regex ? '-E' : '-F'];
  if (opts.ignoreCase) flags.push('-i');
  const include = opts.glob ? '--include="$GLOB"' : '';
  const cmd =
    `grep ${flags.join(' ')} ${include} --exclude-dir=node_modules --exclude-dir=.git ` +
    `-e "$Q" -- "$P" 2>/dev/null | head -n ${max + 1} || true`;

  const env: Record<string, string> = { Q: opts.query, P: p };
  if (opts.glob) env.GLOB = opts.glob;

  const { stdout } = await exec(id, ['sh', '-c', cmd], { env });
  const rows = stdout.split('\n').filter(Boolean);
  return { matches: rows.slice(0, max).map(parseGrepLine), truncated: rows.length > max };
}

function parseGrepLine(line: string) {
  const a = line.indexOf(':');
  const b = line.indexOf(':', a + 1);
  if (a === -1 || b === -1) return { file: '', line: 0, text: line };
  return { file: line.slice(0, a), line: Number(line.slice(a + 1, b)) || 0, text: line.slice(b + 1) };
}

export async function glob(
  id: string,
  opts: { pattern: string; path?: string; maxResults?: number },
) {
  const p = safePath(opts.path ?? '/workspace');
  const max = opts.maxResults ?? 500;
  const cmd =
    `find "$P" -type f -name "$PAT" -not -path '*/node_modules/*' -not -path '*/.git/*' ` +
    `2>/dev/null | head -n ${max + 1} || true`;

  const { stdout } = await exec(id, ['sh', '-c', cmd], { env: { P: p, PAT: opts.pattern } });
  const files = stdout.split('\n').filter(Boolean);
  return { files: files.slice(0, max), truncated: files.length > max };
}

// --- file management ---

export async function mkdir(id: string, rawPath: string) {
  const p = safePath(rawPath);
  await runShell(id, 'mkdir -p "$P"', { P: p });
  return { path: p };
}

export async function move(id: string, rawFrom: string, rawTo: string) {
  const from = safePath(rawFrom);
  const to = safePath(rawTo);
  await runShell(id, 'mkdir -p "$(dirname "$TO")" && mv "$FROM" "$TO"', { FROM: from, TO: to });
  return { from, to };
}

export async function copy(id: string, rawFrom: string, rawTo: string) {
  const from = safePath(rawFrom);
  const to = safePath(rawTo);
  await runShell(id, 'mkdir -p "$(dirname "$TO")" && cp -r "$FROM" "$TO"', { FROM: from, TO: to });
  return { from, to };
}

async function runShell(id: string, cmd: string, env: Record<string, string>) {
  const { exitCode, stderr } = await exec(id, ['sh', '-c', cmd], { env });
  if (exitCode !== 0) {
    throw httpError(400, stderr.trim() || `command failed (exit ${exitCode})`);
  }
}
