/**
 * Bake the boilerplate into a reusable Modal image: create a sandbox → clone +
 * install the repo from .env → snapshotFilesystem() → write the resulting
 * imageId to .env as BAKED_IMAGE_ID. `npm run sandbox` then boots from it
 * (skipping clone + install).  Run: npm run bake
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devImage, PREVIEW_ENV, DEFAULT_TIMEOUT_MS } from './modal/preview-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
try { process.loadEnvFile(ENV_PATH); } catch {}

const WORKSPACE = '/workspace';
const REPO_DIR = `${WORKSPACE}/repo`;
const REPO = process.env.GIT_REPO_URL;
const TOKEN = process.env.GIT_TOKEN;
const INSTALL = process.env.INSTALL_CMD ?? 'npm install --no-fund --no-audit';

/** Upsert KEY=value in .env. */
function writeEnv(key: string, value: string) {
  let txt = '';
  try { txt = readFileSync(ENV_PATH, 'utf8'); } catch {}
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  txt = re.test(txt) ? txt.replace(re, line) : txt.replace(/\n*$/, '\n') + line + '\n';
  writeFileSync(ENV_PATH, txt);
}

async function main() {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    throw new Error('Missing MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in .env');
  }
  if (!REPO) throw new Error('Missing GIT_REPO_URL in .env');

  const { ModalClient } = await import('modal');
  const client: any = new ModalClient();
  const app = await client.apps.fromName('modal-sandbox-api', { createIfMissing: true });
  const gitSecret = TOKEN ? await client.secrets.fromObject({ GIT_TOKEN: TOKEN }) : undefined;

  console.log(`Baking ${REPO}\n  install: ${INSTALL}\n`);
  const t0 = Date.now();
  const sandbox = await client.sandboxes.create(app, devImage(client), {
    workdir: WORKSPACE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    secrets: gitSecret ? [gitSecret] : [],
    env: PREVIEW_ENV,
  });

  try {
    // clone
    const tc = Date.now();
    const cloneScript = `
set -e
git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f'
rm -rf "${REPO_DIR}"
git clone --depth 1 "$GIT_REPO_URL" "${REPO_DIR}"
`;
    const clone = await sandbox.exec(['sh', '-c', cloneScript], {
      workdir: WORKSPACE,
      env: { GIT_REPO_URL: REPO },
      secrets: gitSecret ? [gitSecret] : [],
      stdout: 'pipe', stderr: 'pipe',
    });
    if ((await clone.wait()) !== 0) throw new Error('clone failed: ' + (await clone.stderr.readText()));
    console.log(`  cloned (${Date.now() - tc} ms)`);

    // install
    const ti = Date.now();
    const install = await sandbox.exec(['sh', '-c', INSTALL], { workdir: REPO_DIR, stdout: 'pipe', stderr: 'pipe' });
    if ((await install.wait()) !== 0) throw new Error('install failed: ' + (await install.stderr.readText()));
    console.log(`  installed (${Date.now() - ti} ms)`);

    // snapshot → image
    const ts = Date.now();
    const image = await sandbox.snapshotFilesystem();
    const imageId = image.imageId as string;
    console.log(`  snapshot (${Date.now() - ts} ms)`);

    writeEnv('BAKED_IMAGE_ID', imageId);
    console.log(`\n✅ Baked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`   BAKED_IMAGE_ID=${imageId}  (written to .env)`);
    console.log(`   Now run:  npm run sandbox   (boots from this image — no clone/install)`);
  } finally {
    await sandbox.terminate().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('✗', e); process.exit(1); });
