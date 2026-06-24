import { Router } from 'express';
import { createPreview } from '../modal/preview-service.js';
import { createPreviewSchema } from '../modal/schemas.js';
import { asyncHandler, validate } from '../middleware/validate.js';
import { httpError } from '../middleware/error.js';
import { config } from '../config.js';

const router = Router();

// POST /previews — spin up a live preview from a git repo:
// create sandbox → clone → install → start dev server → return the tunnel URL.
// Repo/token/port/commands fall back to .env defaults (config.preview) when the
// body omits them, so a browser client can POST `{}` and never hold the git token.
router.post(
  '/',
  validate(createPreviewSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const opts = {
      ...b,
      repoUrl: b.repoUrl ?? config.preview.repoUrl,
      token: b.token ?? config.preview.token,
      port: b.port ?? config.preview.port,
      installCmd: b.installCmd ?? config.preview.installCmd,
      devCmd: b.devCmd ?? config.preview.devCmd,
    };
    if (!opts.repoUrl) {
      throw httpError(400, 'repoUrl is required (in the body or via GIT_REPO_URL in .env)');
    }
    res.status(201).json(await createPreview(opts));
  }),
);

export default router;
