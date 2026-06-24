/**
 * Sandbox operations — thin async functions over the Modal SDK.
 * Errors bubble up to the error middleware (→ 500) unless a specific status is
 * thrown (404 for an unknown sandbox, 502 for a failed build/deploy).
 */
import { getClient } from './client.js';
import * as registry from './registry.js';
import { DEFAULT_IMAGE, DEFAULT_TIMEOUT_MS, PREVIEW_ENV, devImage } from './preview-runner.js';
import { httpError } from '../middleware/error.js';
import { config } from '../config.js';
import * as cloudflare from './cloudflare.js';
import type { Sandbox } from './modal.types.js';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateSandboxOptions {
  image?: string;
  encryptedPorts?: number[];
  timeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
}

export interface PublishOptions {
  accountId?: string;
  apiToken: string;
  dispatchNamespace?: string;
  scriptName: string;
  subdir?: string;
  buildCmd?: string;
  deployCmd?: string;
  baseDomain?: string;
  customDomain?: string;
  zoneId?: string;
  zoneName?: string;
  env?: Record<string, string>;
  /** Filename for the build-time env file written into the app dir (default `.env`). */
  envFile?: string;
}

// --- lifecycle ---

export async function createSandbox(opts: CreateSandboxOptions) {
  const client = await getClient();
  const app = await client.apps.fromName('modal-sandbox-api', { createIfMissing: true });
  // Default to the shared dev image (git + pnpm baked in, cached by Modal) so a
  // freshly created sandbox can clone/install with no per-sandbox apt-get. An
  // explicit `image` override falls back to a plain registry pull.
  const image = opts.image ? client.images.fromRegistry(opts.image) : devImage(client);
  // Inject any provided env vars as a Modal Secret (encrypted at rest). Merge in
  // PREVIEW_ENV so pnpm/corepack run non-interactively (caller env wins).
  const env = { ...PREVIEW_ENV, ...opts.env };
  const secrets = [await client.secrets.fromObject(env)];
  const sandbox = await client.sandboxes.create(app, image, {
    encryptedPorts: opts.encryptedPorts,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workdir: opts.workdir,
    secrets,
  });
  registry.track(sandbox, { image: opts.image ?? DEFAULT_IMAGE });
  return { sandboxId: sandbox.sandboxId };
}

/** Resolve a sandbox from the registry, falling back to Modal's fromId(). */
export async function getSandbox(id: string): Promise<Sandbox> {
  const entry = registry.getEntry(id);
  if (entry) return entry.sandbox;
  try {
    const client = await getClient();
    const sandbox = await client.sandboxes.fromId(id);
    registry.track(sandbox, { reattached: true });
    return sandbox;
  } catch {
    throw httpError(404, `Sandbox ${id} not found`);
  }
}

export async function terminate(id: string) {
  await getSandbox(id); // 404 if unknown
  await registry.terminate(id);
}

export function list() {
  return registry.list();
}

export async function status(id: string) {
  const sandbox = await getSandbox(id);
  const exitCode = await sandbox.poll();
  return { sandboxId: id, exitCode, tunnels: await readTunnels(sandbox) };
}

// --- exec ---

export async function exec(
  id: string,
  command: string[],
  opts: { workdir?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const sandbox = await getSandbox(id);
  const proc = await sandbox.exec(command, {
    workdir: opts.workdir,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([proc.stdout.readText(), proc.stderr.readText()]);
  const exitCode = await proc.wait();
  return { exitCode, stdout, stderr };
}

// --- files ---

export async function readFile(id: string, path: string) {
  const sandbox = await getSandbox(id);
  return sandbox.filesystem.readText(path);
}

export async function writeFile(id: string, path: string, content: string) {
  const sandbox = await getSandbox(id);
  await sandbox.filesystem.writeText(content, path);
}

export async function listFiles(id: string, path: string) {
  const sandbox = await getSandbox(id);
  const files = await sandbox.filesystem.listFiles(path);
  return files.map((f) => ({ ...f }));
}

export async function removeFile(id: string, path: string) {
  const sandbox = await getSandbox(id);
  await sandbox.filesystem.remove(path, { recursive: true });
}

// --- tunnels ---

export async function tunnels(id: string) {
  return readTunnels(await getSandbox(id));
}

async function readTunnels(sandbox: Sandbox): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const [port, tunnel] of Object.entries(await sandbox.tunnels())) {
    out[Number(port)] = tunnel.url;
  }
  return out;
}

// --- publish (build + deploy to Cloudflare) ---

/**
 * Build the cloned app and deploy it to Cloudflare via wrangler inside the
 * sandbox. The Cloudflare token is passed ONLY as the deploy command's env —
 * never persisted. Redeploying with the same scriptName updates in place.
 */
export async function publish(id: string, opts: PublishOptions) {
  // Cloudflare creds: request body wins, else fall back to .env.
  const apiToken = opts.apiToken ?? config.cloudflare.apiToken;
  const accountId = opts.accountId ?? config.cloudflare.accountId;
  const zoneId = opts.zoneId ?? config.cloudflare.zoneId;

  if (!apiToken) {
    throw httpError(
      400,
      'Cloudflare API token required: set CLOUDFLARE_API_TOKEN in .env or pass apiToken in the body',
    );
  }
  if (opts.customDomain && opts.dispatchNamespace) {
    throw httpError(
      400,
      'Use either dispatchNamespace (Workers for Platforms) or customDomain (free custom domain), not both',
    );
  }
  if (opts.customDomain && !accountId) {
    throw httpError(
      400,
      'accountId is required when customDomain is set (set CLOUDFLARE_ACCOUNT_ID in .env or pass accountId)',
    );
  }
  if (opts.customDomain) {
    cloudflare.validateSubdomainLabel(opts.customDomain.split('.')[0]);
  }

  const appDir = opts.subdir ? `/workspace/repo/${opts.subdir}` : '/workspace/repo';
  const buildCmd = opts.buildCmd ?? 'pnpm build';
  const useNamespace = !!opts.dispatchNamespace;
  // Per-tenant config → `--var KEY:$KEY` (value comes from the exec env).
  const vars = opts.env ?? {};
  const varFlags = Object.keys(vars)
    .map((k) => `--var "${k}:$${k}"`)
    .join(' ');
  const baseDeploy = useNamespace
    ? 'pnpm exec wrangler deploy --dispatch-namespace "$DISPATCH_NAMESPACE" --name "$SCRIPT_NAME"'
    : 'pnpm exec wrangler deploy --name "$SCRIPT_NAME"';
  const deployCmd = opts.deployCmd ?? (varFlags ? `${baseDeploy} ${varFlags}` : baseDeploy);
  const baseDomain = opts.baseDomain ?? 'n0.app';

  // 0. Materialize the app's env file before building (it is gitignored, so not
  // in the clone). This is how build-time config (e.g. Vite's VITE_*/import.meta.env)
  // reaches the bundle. Runtime config for the Worker is set separately via the
  // --var flags below. Both come from `opts.env`.
  if (Object.keys(vars).length > 0) {
    const sandbox = await getSandbox(id);
    const envFileName = opts.envFile ?? '.env';
    const content = Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
    await sandbox.filesystem.writeText(content, `${appDir}/${envFileName}`);
  }

  // 1. Build (env also passed to the process for non-Vite build tooling).
  const build = await exec(id, ['sh', '-c', buildCmd], { workdir: appDir, env: vars });
  if (build.exitCode !== 0) {
    throw httpError(502, `Build failed (exit ${build.exitCode}): ${build.stderr.slice(-2000)}`);
  }

  // 2. Deploy. Token + account injected ONLY here, for this one process.
  const deploy = await exec(id, ['sh', '-c', deployCmd], {
    workdir: appDir,
    env: {
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId ?? '',
      DISPATCH_NAMESPACE: opts.dispatchNamespace ?? '',
      SCRIPT_NAME: opts.scriptName,
      ...vars,
    },
  });
  if (deploy.exitCode !== 0) {
    throw httpError(502, `Deploy failed (exit ${deploy.exitCode}): ${deploy.stderr.slice(-2000)}`);
  }

  // 3. Optionally bind a custom subdomain (free path) to the deployed Worker.
  const customDomain = opts.customDomain
    ? await cloudflare.attachDomain(
        { apiToken, accountId: accountId! },
        opts.customDomain,
        opts.scriptName,
        { zoneId, zoneName: opts.zoneName },
      )
    : null;

  const workersDevUrl = deploy.stdout.match(/https?:\/\/[^\s]+\.workers\.dev/);
  const url =
    customDomain ??
    (useNamespace ? `https://${opts.scriptName}.${baseDomain}` : (workersDevUrl?.[0] ?? null));

  return { scriptName: opts.scriptName, url, customDomain, output: deploy.stdout.slice(-1000) };
}
