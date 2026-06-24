import { Router } from 'express';
import * as modal from '../modal/sandbox-service.js';
import * as files from '../modal/files-service.js';
import {
  copySchema,
  createSandboxSchema,
  editSchema,
  execCommandSchema,
  mkdirSchema,
  moveSchema,
  publishSchema,
  searchSchema,
  writeFileSchema,
} from '../modal/schemas.js';
import { asyncHandler, validate } from '../middleware/validate.js';
import { httpError } from '../middleware/error.js';

const router = Router();

/** Read a required `?key=` query param or 400. */
function requireQuery(value: unknown, key: string): string {
  if (typeof value !== 'string' || value === '') {
    throw httpError(400, `Query param "${key}" is required`);
  }
  return value;
}

const requirePath = (value: unknown) => requireQuery(value, 'path');

/** Parse an optional integer query param. */
function intQuery(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw httpError(400, `Expected an integer, got "${value}"`);
  return n;
}

const boolQuery = (value: unknown) => value === '1' || value === 'true';

// --- lifecycle ---

// POST /sandboxes — create a sandbox.
router.post(
  '/',
  validate(createSandboxSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await modal.createSandbox(req.body));
  }),
);

// GET /sandboxes — list tracked sandboxes.
router.get('/', (_req, res) => {
  res.json(modal.list());
});

// GET /sandboxes/:id — status (exitCode + tunnels).
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await modal.status(req.params.id as string));
  }),
);

// DELETE /sandboxes/:id — terminate.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await modal.terminate(req.params.id as string);
    res.status(204).send();
  }),
);

// --- exec ---

// POST /sandboxes/:id/exec — run a command and wait.
router.post(
  '/:id/exec',
  validate(execCommandSchema),
  asyncHandler(async (req, res) => {
    const { command, workdir, env } = req.body;
    res.status(201).json(await modal.exec(req.params.id as string, command, { workdir, env }));
  }),
);

// --- files ---

// GET /sandboxes/:id/files/list?path=... — list a directory.
router.get(
  '/:id/files/list',
  asyncHandler(async (req, res) => {
    const path = requirePath(req.query.path);
    res.json(await modal.listFiles(req.params.id as string, path));
  }),
);

// GET /sandboxes/:id/files?path=&start=&end=&numbered= — read a file (or line range).
router.get(
  '/:id/files',
  asyncHandler(async (req, res) => {
    const path = requirePath(req.query.path);
    res.json(
      await files.read(req.params.id as string, path, {
        start: intQuery(req.query.start),
        end: intQuery(req.query.end),
        numbered: boolQuery(req.query.numbered),
      }),
    );
  }),
);

// PATCH /sandboxes/:id/files — targeted edit (string- or line-based).
router.patch(
  '/:id/files',
  validate(editSchema),
  asyncHandler(async (req, res) => {
    res.json(await files.edit(req.params.id as string, req.body));
  }),
);

// PUT /sandboxes/:id/files — write a file.
router.put(
  '/:id/files',
  validate(writeFileSchema),
  asyncHandler(async (req, res) => {
    const { path, content } = req.body;
    await modal.writeFile(req.params.id as string, path, content);
    res.json({ path, bytes: Buffer.byteLength(content) });
  }),
);

// DELETE /sandboxes/:id/files?path=... — remove a file or directory.
router.delete(
  '/:id/files',
  asyncHandler(async (req, res) => {
    const path = requirePath(req.query.path);
    await modal.removeFile(req.params.id as string, path);
    res.status(204).send();
  }),
);

// --- file toolkit (stat / tree / search / management) ---

// GET /sandboxes/:id/stat?path=... — file metadata.
router.get(
  '/:id/stat',
  asyncHandler(async (req, res) => {
    res.json(await files.stat(req.params.id as string, requirePath(req.query.path)));
  }),
);

// GET /sandboxes/:id/exists?path=... — existence check.
router.get(
  '/:id/exists',
  asyncHandler(async (req, res) => {
    res.json(await files.exists(req.params.id as string, requirePath(req.query.path)));
  }),
);

// GET /sandboxes/:id/tree?path=&depth=&hidden= — recursive folder tree.
router.get(
  '/:id/tree',
  asyncHandler(async (req, res) => {
    const path = typeof req.query.path === 'string' && req.query.path ? req.query.path : '/workspace';
    res.json(
      await files.tree(req.params.id as string, path, {
        depth: intQuery(req.query.depth),
        hidden: boolQuery(req.query.hidden),
      }),
    );
  }),
);

// POST /sandboxes/:id/search — grep file contents.
router.post(
  '/:id/search',
  validate(searchSchema),
  asyncHandler(async (req, res) => {
    res.json(await files.search(req.params.id as string, req.body));
  }),
);

// GET /sandboxes/:id/glob?pattern=&path=&maxResults= — find files by name.
router.get(
  '/:id/glob',
  asyncHandler(async (req, res) => {
    const pattern = requireQuery(req.query.pattern, 'pattern');
    const path = typeof req.query.path === 'string' && req.query.path ? req.query.path : undefined;
    res.json(
      await files.glob(req.params.id as string, {
        pattern,
        path,
        maxResults: intQuery(req.query.maxResults),
      }),
    );
  }),
);

// POST /sandboxes/:id/mkdir — create a directory (mkdir -p).
router.post(
  '/:id/mkdir',
  validate(mkdirSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await files.mkdir(req.params.id as string, req.body.path));
  }),
);

// POST /sandboxes/:id/move — move/rename a file or directory.
router.post(
  '/:id/move',
  validate(moveSchema),
  asyncHandler(async (req, res) => {
    res.json(await files.move(req.params.id as string, req.body.from, req.body.to));
  }),
);

// POST /sandboxes/:id/copy — copy a file or directory.
router.post(
  '/:id/copy',
  validate(copySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await files.copy(req.params.id as string, req.body.from, req.body.to));
  }),
);

// --- tunnels ---

// GET /sandboxes/:id/tunnels — public tunnel URL per exposed port.
router.get(
  '/:id/tunnels',
  asyncHandler(async (req, res) => {
    res.json(await modal.tunnels(req.params.id as string));
  }),
);

// --- publish (build + deploy to Cloudflare) ---

// POST /sandboxes/:id/publish — build the cloned app and deploy it.
router.post(
  '/:id/publish',
  validate(publishSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await modal.publish(req.params.id as string, req.body));
  }),
);

export default router;
