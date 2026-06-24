/**
 * Project service — the lifecycle layer the frontend talks to. A project is
 * created from a prompt (instant), then a sandbox is provisioned for it on a
 * separate call (the slow ~20s boot), mirroring a Lovable-style two-step flow:
 *
 *   1. createProject(prompt)        -> { id, status: 'created' }      (instant)
 *   2. initSandbox(id)              -> { sandboxId, previewUrl, ... }  (~20s)
 *
 * Once a sandbox exists, all file/exec operations are done through the existing
 * /sandboxes/:id/* endpoints using the returned sandboxId.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { httpError } from '../middleware/error.js';
import { getClient } from './client.js';
import * as registry from './registry.js';
import { runPreview } from './preview-runner.js';
import * as sandboxService from './sandbox-service.js';
import * as store from './project-store.js';
import type { Project } from './project-store.js';

/** Public view of a project (identical today, but a single place to shape output). */
function view(p: Project) {
  return p;
}

export function createProject(input: { prompt: string; name?: string; repoUrl?: string }) {
  const repoUrl = input.repoUrl ?? config.preview.repoUrl;
  if (!repoUrl) {
    throw httpError(400, 'No repoUrl: pass one in the body or set GIT_REPO_URL in .env');
  }
  const now = new Date().toISOString();
  const project: Project = {
    id: `proj_${randomUUID().slice(0, 8)}`,
    name: input.name,
    prompt: input.prompt,
    repoUrl,
    sandboxId: null,
    previewUrl: null,
    port: null,
    status: 'created',
    createdAt: now,
    updatedAt: now,
  };
  store.insert(project);
  return view(project);
}

/**
 * Provision the project's sandbox: clone the repo, install, start the dev server,
 * and record the tunnel URL. Idempotent for an already-running project. Uses the
 * boilerplate defaults from .env (repo/token/port/install/dev) so the frontend
 * passes nothing sensitive.
 */
export async function initSandbox(id: string) {
  const project = store.get(id);
  if (!project) throw httpError(404, `Project ${id} not found`);
  if (project.status === 'running' && project.sandboxId) {
    return view(project); // already booted — return current sandbox info
  }

  store.update(id, { status: 'initializing', error: undefined });
  try {
    const client = await getClient();
    const result = await runPreview(
      client,
      {
        repoUrl: project.repoUrl,
        token: config.preview.token,
        port: config.preview.port ?? 3000,
        installCmd: config.preview.installCmd,
        devCmd: config.preview.devCmd,
      },
      {
        log: (m) => console.log(`[project ${id}] ${m}`),
        onSandboxCreated: (sandbox) =>
          registry.track(sandbox, { kind: 'project', projectId: id, repoUrl: project.repoUrl }),
      },
    );
    return view(
      store.update(id, {
        sandboxId: result.sandboxId,
        previewUrl: result.url,
        port: result.port,
        status: 'running',
      })!,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.update(id, { status: 'error', error: message });
    throw httpError(502, `Sandbox init failed: ${message}`);
  }
}

export function getProject(id: string) {
  const p = store.get(id);
  if (!p) throw httpError(404, `Project ${id} not found`);
  return view(p);
}

export function listProjects() {
  return store.all().map(view);
}

export async function removeProject(id: string) {
  const p = store.get(id);
  if (!p) throw httpError(404, `Project ${id} not found`);
  if (p.sandboxId) {
    // Best-effort teardown — a dead/expired sandbox shouldn't block deletion.
    try {
      await sandboxService.terminate(p.sandboxId);
    } catch {
      /* already gone */
    }
  }
  store.remove(id);
}
