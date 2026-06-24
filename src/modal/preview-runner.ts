/**
 * Framework-agnostic preview flow shared by the Express API (ModalService) and
 * the standalone CLI (src/modal-sandbox.ts).
 *
 * It receives an already-constructed Modal client, so it needs no runtime
 * `import('modal')` of its own — the same source is used by both the long-lived
 * server and the one-shot CLI.
 */
import type { ModalClient, Sandbox } from './modal.types.js';

export const DEFAULT_IMAGE = 'node:22-slim';
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WORKSPACE = '/workspace';
const REPO_DIR = `${WORKSPACE}/repo`;

// Env applied to dev sandboxes so pnpm/corepack work non-interactively.
export const PREVIEW_ENV: Record<string, string> = {
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  // pnpm reads its own settings from pnpm_config_* (not npm_config_*).
  pnpm_config_dangerously_allow_all_builds: 'true',
};

/**
 * The shared dev image: `node:22-slim` with git + pnpm (via corepack) baked in.
 *
 * Modal builds this once and **caches** it, so every sandbox created from it
 * boots with git/pnpm already present — no per-sandbox `apt-get`/`corepack`
 * exec. Used by both the preview flow and the plain `POST /sandboxes` create
 * route (so manual testing gets the same fast, batteries-included image).
 */
export function devImage(client: ModalClient) {
  return client.images.fromRegistry(DEFAULT_IMAGE).dockerfileCommands([
    'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*',
    'RUN corepack enable',
  ]);
}

export interface PreviewOptions {
  repoUrl: string;
  token?: string;
  branch?: string;
  subdir?: string;
  port?: number;
  installCmd?: string;
  devCmd?: string;
  userName?: string;
  userEmail?: string;
  /**
   * Env vars to provide to the cloned app (e.g. the gitignored .env contents).
   * Injected as a Modal Secret (→ process.env) AND written to `envFile` so a
   * dev server that reads the file picks them up.
   */
  env?: Record<string, string>;
  /** Filename for the materialized env file, relative to the app dir. Default `.env`. */
  envFile?: string;
  /**
   * If set, boot the sandbox FROM this baked image (repo + node_modules already
   * inside) and skip clone+install — see runBakedPreview().
   */
  bakedImageId?: string;
}

export interface PreviewTimings {
  /** Image build + sandbox creation. */
  createMs: number;
  /** git config + clone. */
  cloneMs: number;
  /** Dependency install. */
  installMs: number;
  /** Dev server launch + tunnel URL resolution. */
  devReadyMs: number;
  /** End-to-end startup time. */
  totalMs: number;
}

export interface PreviewResult {
  sandboxId: string;
  url: string;
  port: number;
  timings: PreviewTimings;
  sandbox: Sandbox;
}

export interface PreviewHooks {
  /** Progress messages (API logs them; CLI prints them). */
  log?: (message: string) => void;
  /** Called as soon as the sandbox exists, so callers can track it for cleanup. */
  onSandboxCreated?: (sandbox: Sandbox) => void;
}

/** Drain a process stream to the log callback so a full pipe never blocks it. */
function drain(stream: ReadableStream<string>, log: (m: string) => void, prefix: string): void {
  void (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) log(`${prefix} ${value.trimEnd()}`);
      }
    } catch {
      /* stream closed on teardown */
    }
  })();
}

/**
 * Create a sandbox, clone a (private) git repo, install deps, start the dev
 * server, and return the public tunnel URL. Throws plain Errors; callers map
 * them to their own error types.
 */
export async function runPreview(
  client: ModalClient,
  opts: PreviewOptions,
  hooks: PreviewHooks = {},
): Promise<PreviewResult> {
  const log = hooks.log ?? (() => {});
  const port = opts.port ?? 5173;
  const installCmd = opts.installCmd ?? 'pnpm install';
  const devCmd = opts.devCmd ?? 'pnpm run dev';

  const t0 = Date.now();
  const app = await client.apps.fromName('modal-sandbox-api', { createIfMissing: true });

  // Image with git + pnpm (via corepack) — built once, then cached by Modal.
  log(`Building image (git + pnpm) from ${DEFAULT_IMAGE}...`);
  const image = devImage(client);

  // Git token travels as a Modal Secret (encrypted at rest, injected as a
  // container env var for the clone), never baked into the image or repo.
  const gitSecret = opts.token
    ? await client.secrets.fromObject({ GIT_TOKEN: opts.token })
    : undefined;
  const hasEnv = !!opts.env && Object.keys(opts.env).length > 0;

  log(`Creating sandbox (tunneling port ${port})...`);
  const sandbox = await client.sandboxes.create(app, image, {
    encryptedPorts: [port],
    workdir: WORKSPACE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    secrets: gitSecret ? [gitSecret] : [],
    env: PREVIEW_ENV,
  });
  hooks.onSandboxCreated?.(sandbox);
  const createMs = Date.now() - t0;
  log(`Sandbox ${sandbox.sandboxId} created (${createMs} ms).`);

  // 1. git config + clone (token via credential helper, never persisted).
  const tClone = Date.now();
  log('Configuring git and cloning repo...');
  const cloneScript = `
set -e
git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f'
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
rm -rf "${REPO_DIR}"
if [ -n "$GIT_BRANCH" ]; then
  git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_REPO_URL" "${REPO_DIR}"
else
  git clone --depth 1 "$GIT_REPO_URL" "${REPO_DIR}"
fi
`;
  const clone = await sandbox.exec(['sh', '-c', cloneScript], {
    workdir: WORKSPACE,
    env: {
      GIT_REPO_URL: opts.repoUrl,
      GIT_BRANCH: opts.branch ?? '',
      GIT_USER_NAME: opts.userName ?? 'Modal Sandbox',
      GIT_USER_EMAIL: opts.userEmail ?? 'sandbox@modal.local',
    },
    secrets: gitSecret ? [gitSecret] : [],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const cloneCode = await clone.wait();
  if (cloneCode !== 0) {
    const stderr = await clone.stderr.readText();
    throw new Error(`git clone failed (exit ${cloneCode}): ${stderr}`);
  }
  const cloneMs = Date.now() - tClone;
  log(`Cloned (${cloneMs} ms).`);

  const appDir = opts.subdir ? `${REPO_DIR}/${opts.subdir}` : REPO_DIR;

  // Materialize the app's env file (it is gitignored, so not in the clone).
  // This is how the app actually receives config: under the Cloudflare/workerd
  // dev runtime the SSR code does NOT see the Node container's env vars, so the
  // framework reads this file. Written via the filesystem API (not logged).
  if (hasEnv) {
    const envFile = opts.envFile ?? '.env';
    const content =
      Object.entries(opts.env!)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n';
    await sandbox.filesystem.writeText(content, `${appDir}/${envFile}`);
    log(`Wrote ${Object.keys(opts.env!).length} env var(s) to ${envFile}.`);
  }

  // 2. install (blocking).
  const tInstall = Date.now();
  log(`Installing dependencies in ${appDir} ...`);
  const install = await sandbox.exec(['sh', '-c', installCmd], {
    workdir: appDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drain(install.stdout, log, '[install]');
  drain(install.stderr, log, '[install]');
  const installCode = await install.wait();
  if (installCode !== 0) {
    throw new Error(`install failed (exit ${installCode})`);
  }
  const installMs = Date.now() - tInstall;
  log(`Installed (${installMs} ms).`);

  // 3. start dev server (long-running, not awaited).
  //
  // The express server owns the dev port: it appends `--port` (from DEV_PORT) so
  // the dev server matches the tunnel, regardless of the repo's default port.
  // The repo is responsible for binding 0.0.0.0 and allowing the tunnel host
  // (Vite `server.host` / `allowedHosts` in its own config). The flag is
  // forwarded through the package-manager run script via the `--` separator.
  const tDev = Date.now();
  const devCommand = `${devCmd} -- --port=${port}`;
  log(`Starting dev server: ${devCommand}`);
  const dev = await sandbox.exec(['sh', '-c', devCommand], {
    workdir: appDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drain(dev.stdout, log, '[dev]');
  drain(dev.stderr, log, '[dev]');

  // 4. resolve tunnel URL.
  const tunnels = await sandbox.tunnels();
  const url = tunnels[port]?.url;
  if (!url) {
    throw new Error(`No tunnel URL for port ${port}`);
  }
  const devReadyMs = Date.now() - tDev;
  const totalMs = Date.now() - t0;

  const timings: PreviewTimings = { createMs, cloneMs, installMs, devReadyMs, totalMs };
  log(
    `Ready in ${totalMs} ms ` +
      `(create ${createMs} / clone ${cloneMs} / install ${installMs} / dev ${devReadyMs}).`,
  );

  return { sandboxId: sandbox.sandboxId, url, port, timings, sandbox };
}

/**
 * Fast path: boot a sandbox FROM a baked image (created by `npm run bake` /
 * snapshotFilesystem) that already contains the repo + node_modules, then start
 * the dev server. No clone, no install — just create → dev → tunnel.
 */
export async function runBakedPreview(
  client: ModalClient,
  opts: PreviewOptions & { bakedImageId: string },
  hooks: PreviewHooks = {},
): Promise<PreviewResult> {
  const log = hooks.log ?? (() => {});
  const port = opts.port ?? 5173;
  const devCmd = opts.devCmd ?? 'pnpm run dev';

  const t0 = Date.now();
  const app = await client.apps.fromName('modal-sandbox-api', { createIfMissing: true });

  log(`Using baked image ${opts.bakedImageId} (skipping clone + install)...`);
  const image = await client.images.fromId(opts.bakedImageId);

  log(`Creating sandbox (tunneling port ${port})...`);
  const sandbox = await client.sandboxes.create(app, image, {
    encryptedPorts: [port],
    workdir: WORKSPACE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env: PREVIEW_ENV,
  });
  hooks.onSandboxCreated?.(sandbox);
  const createMs = Date.now() - t0;
  log(`Sandbox ${sandbox.sandboxId} created (${createMs} ms).`);

  const appDir = opts.subdir ? `${REPO_DIR}/${opts.subdir}` : REPO_DIR;

  // Optional: overlay env into the baked repo (the repo dir already exists).
  if (opts.env && Object.keys(opts.env).length > 0) {
    const envFile = opts.envFile ?? '.env';
    const content = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    await sandbox.filesystem.writeText(content, `${appDir}/${envFile}`);
    log(`Wrote ${Object.keys(opts.env).length} env var(s) to ${envFile}.`);
  }

  const tDev = Date.now();
  const devCommand = `${devCmd} -- --port=${port}`;
  log(`Starting dev server: ${devCommand}`);
  const dev = await sandbox.exec(['sh', '-c', devCommand], {
    workdir: appDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drain(dev.stdout, log, '[dev]');
  drain(dev.stderr, log, '[dev]');

  const tunnels = await sandbox.tunnels();
  const url = tunnels[port]?.url;
  if (!url) throw new Error(`No tunnel URL for port ${port}`);
  const devReadyMs = Date.now() - tDev;
  const totalMs = Date.now() - t0;

  const timings: PreviewTimings = { createMs, cloneMs: 0, installMs: 0, devReadyMs, totalMs };
  log(`Ready in ${totalMs} ms (create ${createMs} / dev ${devReadyMs}) [baked].`);
  return { sandboxId: sandbox.sandboxId, url, port, timings, sandbox };
}
