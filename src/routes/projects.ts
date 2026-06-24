import { Router } from 'express';
import * as projects from '../modal/project-service.js';
import { createProjectSchema } from '../modal/schemas.js';
import { asyncHandler, validate } from '../middleware/validate.js';

const router = Router();

// POST /projects — create a project from a prompt (instant; no sandbox yet).
router.post(
  '/',
  validate(createProjectSchema),
  (req, res) => {
    res.status(201).json(projects.createProject(req.body));
  },
);

// GET /projects — list all projects.
router.get('/', (_req, res) => {
  res.json(projects.listProjects());
});

// GET /projects/:id — one project (incl. sandbox info once initialized).
router.get('/:id', (req, res) => {
  res.json(projects.getProject(req.params.id as string));
});

// POST /projects/:id/sandbox — provision the sandbox: clone + install + dev +
// tunnel. Returns the preview URL and sandboxId (~20s). Use that sandboxId with
// the /sandboxes/:id/* endpoints for file/exec operations.
router.post(
  '/:id/sandbox',
  asyncHandler(async (req, res) => {
    res.status(201).json(await projects.initSandbox(req.params.id as string));
  }),
);

// DELETE /projects/:id — terminate the sandbox and remove the project.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await projects.removeProject(req.params.id as string);
    res.status(204).send();
  }),
);

export default router;
