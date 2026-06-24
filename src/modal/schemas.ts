/**
 * Request body schemas (zod) — the functional replacement for the NestJS
 * class-validator DTOs. Unknown keys are stripped (zod's default), mirroring the
 * old `whitelist: true` ValidationPipe behaviour.
 */
import { z } from 'zod';

const envRecord = z.record(z.string(), z.string());

export const createSandboxSchema = z.object({
  image: z.string().optional(),
  encryptedPorts: z.array(z.number().int()).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  workdir: z.string().optional(),
  /** Env vars injected into the sandbox as a Modal Secret (→ process.env). */
  env: envRecord.optional(),
});

export const execCommandSchema = z.object({
  /** Command as argv, e.g. ["sh", "-c", "ls -la"]. */
  command: z.array(z.string()).min(1, 'command should not be empty'),
  workdir: z.string().optional(),
  env: envRecord.optional(),
});

export const writeFileSchema = z.object({
  /** Absolute path inside the sandbox. */
  path: z.string(),
  content: z.string(),
});

export const publishSchema = z.object({
  /** Cloudflare account id. Optional — an account-scoped token lets wrangler infer it. */
  accountId: z.string().optional(),
  /** Cloudflare API token. Optional — falls back to CLOUDFLARE_API_TOKEN in .env. */
  apiToken: z.string().optional(),
  /** Workers for Platforms dispatch namespace. Omit for a free *.workers.dev deploy. */
  dispatchNamespace: z.string().optional(),
  /** Script name in the namespace = the tenant slug (stable across redeploys). */
  scriptName: z.string(),
  subdir: z.string().optional(),
  buildCmd: z.string().optional(),
  deployCmd: z.string().optional(),
  baseDomain: z.string().optional(),
  /** Free path: bind the deployed Worker to a custom subdomain, e.g. "poc-test.zenixai.tech". */
  customDomain: z.string().optional(),
  /** Zone for the custom domain. If omitted, derived from customDomain's last two labels. */
  zoneId: z.string().optional(),
  zoneName: z.string().optional(),
  /** Per-tenant config: written as a build-time .env AND set as Worker vars (`--var KEY:value`). */
  env: envRecord.optional(),
  /** Filename for the build-time env file (default `.env`). */
  envFile: z.string().optional(),
});

/** POST /projects — create a project from a prompt (Lovable-style). */
export const createProjectSchema = z.object({
  /** Natural-language description of the app to build. */
  prompt: z.string().min(1, 'prompt is required'),
  /** Optional display name. */
  name: z.string().optional(),
  /** Optional repo override; defaults to GIT_REPO_URL (the boilerplate) from .env. */
  repoUrl: z.string().optional(),
});

export const createPreviewSchema = z.object({
  /** Git repo to clone, e.g. https://github.com/owner/repo.git.
   *  Optional: falls back to GIT_REPO_URL in .env (so a browser client can omit it). */
  repoUrl: z.string().optional(),
  /** GitHub token for private repos (passed as a Modal Secret, never persisted). */
  token: z.string().optional(),
  branch: z.string().optional(),
  subdir: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  installCmd: z.string().optional(),
  devCmd: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  /** Env vars for the cloned app, written to `envFile` in the app dir. */
  env: envRecord.optional(),
  /** Filename for the materialized env file (default `.env`). */
  envFile: z.string().optional(),
});

// --- AI file toolkit ---

const editBase = { path: z.string(), dryRun: z.boolean().optional() };

/** PATCH /files — one body, discriminated by `op`. */
export const editSchema = z.discriminatedUnion('op', [
  // string-match edit (old_string -> new_string)
  z.object({
    ...editBase,
    op: z.literal('replace'),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  // replace a 1-based inclusive line range
  z.object({
    ...editBase,
    op: z.literal('replaceLines'),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
    content: z.string(),
  }),
  // insert before `line` (0 or 1 => prepend; beyond EOF => append)
  z.object({
    ...editBase,
    op: z.literal('insert'),
    line: z.number().int().min(0),
    content: z.string(),
  }),
  // delete a 1-based inclusive line range
  z.object({
    ...editBase,
    op: z.literal('delete'),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  }),
  z.object({ ...editBase, op: z.literal('append'), content: z.string() }),
  z.object({ ...editBase, op: z.literal('prepend'), content: z.string() }),
]);

export const searchSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  regex: z.boolean().optional(),
  ignoreCase: z.boolean().optional(),
  glob: z.string().optional(),
  maxResults: z.number().int().min(1).max(2000).optional(),
});

export const mkdirSchema = z.object({ path: z.string() });
export const moveSchema = z.object({ from: z.string(), to: z.string() });
export const copySchema = z.object({ from: z.string(), to: z.string() });

/** Rename/set a deployment's public domain. */
export const setDomainSchema = z.object({
  domain: z.string(),
  zoneId: z.string().optional(),
  zoneName: z.string().optional(),
});
