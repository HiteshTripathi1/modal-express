/**
 * Benchmark: baked-image cold-start vs current clone+install cold-start.
 *
 * 1. BAKE once: create sandbox from devImage → clone + install the boilerplate →
 *    snapshotFilesystem() → a reusable Image (repo + node_modules baked in).
 * 2. BAKED starts (xN): create a fresh sandbox FROM that image → start dev →
 *    measure time until the preview URL returns 200.
 * 3. CURRENT starts (xM): full clone + install + dev each time → time to 200.
 *
 * Run: npx tsx src/bench-image.ts
 */
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devImage, PREVIEW_ENV, DEFAULT_TIMEOUT_MS } from './modal/preview-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(__dirname, '..', '.env')); } catch {}

const WORKSPACE = '/workspace';
const REPO_DIR = `${WORKSPACE}/repo`;
const REPO = process.env.GIT_REPO_URL!;
const TOKEN = process.env.GIT_TOKEN;
const PORT = Number(process.env.DEV_PORT ?? 3000);
const INSTALL = process.env.INSTALL_CMD ?? 'npm install --no-fund --no-audit';
const DEV = process.env.DEV_CMD ?? 'npm run dev';
const BAKED_RUNS = 3;
const CURRENT_RUNS = 2;

const now = () => Date.now();
function pollUntil200(url: string, timeoutMs = 90000): number {
  const start = now();
  for (;;) {
    try {
      const code = execSync(`curl -s -o /dev/null -m 10 -w "%{http_code}" "${url}"`, {
        encoding: 'utf8',
      }).trim();
      if (code === '200') return now() - start;
    } catch { /* not up yet */ }
    if (now() - start > timeoutMs) throw new Error(`URL never returned 200 within ${timeoutMs}ms: ${url}`);
    execSync('sleep 1');
  }
}

async function cloneInto(sandbox: any, gitSecret: any) {
  const script = `
set -e
git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f'
rm -rf "${REPO_DIR}"
git clone --depth 1 "$GIT_REPO_URL" "${REPO_DIR}"
`;
  const p = await sandbox.exec(['sh', '-c', script], {
    workdir: WORKSPACE,
    env: { GIT_REPO_URL: REPO },
    secrets: gitSecret ? [gitSecret] : [],
    stdout: 'pipe', stderr: 'pipe',
  });
  if ((await p.wait()) !== 0) throw new Error('clone failed: ' + (await p.stderr.readText()));
}

async function install(sandbox: any) {
  const p = await sandbox.exec(['sh', '-c', INSTALL], { workdir: REPO_DIR, stdout: 'pipe', stderr: 'pipe' });
  if ((await p.wait()) !== 0) throw new Error('install failed: ' + (await p.stderr.readText()));
}

async function startDevAndGetUrl(sandbox: any): Promise<string> {
  const devCommand = `${DEV} -- --port=${PORT}`;
  await sandbox.exec(['sh', '-c', devCommand], { workdir: REPO_DIR, stdout: 'pipe', stderr: 'pipe' });
  const tunnels = await sandbox.tunnels();
  const url = tunnels[PORT]?.url;
  if (!url) throw new Error('no tunnel url for port ' + PORT);
  return url;
}

async function main() {
  const { ModalClient } = await import('modal');
  const client: any = new ModalClient();
  const app = await client.apps.fromName('modal-sandbox-api', { createIfMissing: true });
  const gitSecret = TOKEN ? await client.secrets.fromObject({ GIT_TOKEN: TOKEN }) : undefined;

  console.log(`Repo: ${REPO}\nDev:  ${DEV} -- --port=${PORT}\n`);

  // ---- 1. BAKE ----
  console.log('=== BAKE (clone + install + snapshot) ===');
  const tBake = now();
  const baker = await client.sandboxes.create(app, devImage(client), {
    encryptedPorts: [PORT], workdir: WORKSPACE, timeoutMs: DEFAULT_TIMEOUT_MS,
    secrets: gitSecret ? [gitSecret] : [], env: PREVIEW_ENV,
  });
  let bakedImage: any, bakedImageId = '';
  try {
    const tClone = now(); await cloneInto(baker, gitSecret); const cloneMs = now() - tClone;
    const tInst = now(); await install(baker); const instMs = now() - tInst;
    const tSnap = now(); bakedImage = await baker.snapshotFilesystem(); const snapMs = now() - tSnap;
    bakedImageId = bakedImage.imageId;
    console.log(`  clone ${cloneMs}ms · install ${instMs}ms · snapshot ${snapMs}ms · total ${now() - tBake}ms`);
    console.log(`  baked imageId: ${bakedImageId}\n`);
  } finally {
    await baker.terminate().catch(() => {});
  }

  // ---- 2. BAKED cold-starts ----
  console.log(`=== BAKED cold-starts (from snapshot image) x${BAKED_RUNS} ===`);
  const bakedResults: number[] = [];
  for (let i = 0; i < BAKED_RUNS; i++) {
    const t0 = now();
    const sb = await client.sandboxes.create(app, bakedImage, {
      encryptedPorts: [PORT], workdir: WORKSPACE, timeoutMs: DEFAULT_TIMEOUT_MS, env: PREVIEW_ENV,
    });
    try {
      const createMs = now() - t0;
      const url = await startDevAndGetUrl(sb);
      const to200 = pollUntil200(url);
      const total = now() - t0;
      bakedResults.push(total);
      console.log(`  run ${i + 1}: total ${total}ms  (create ${createMs}ms · dev→200 ${to200}ms)${i === 0 ? '  [first = image pull]' : ''}`);
    } finally {
      await sb.terminate().catch(() => {});
    }
  }

  // ---- 3. CURRENT cold-starts ----
  console.log(`\n=== CURRENT cold-starts (clone + install + dev) x${CURRENT_RUNS} ===`);
  const currentResults: number[] = [];
  for (let i = 0; i < CURRENT_RUNS; i++) {
    const t0 = now();
    const sb = await client.sandboxes.create(app, devImage(client), {
      encryptedPorts: [PORT], workdir: WORKSPACE, timeoutMs: DEFAULT_TIMEOUT_MS,
      secrets: gitSecret ? [gitSecret] : [], env: PREVIEW_ENV,
    });
    try {
      const createMs = now() - t0;
      const tc = now(); await cloneInto(sb, gitSecret); const cloneMs = now() - tc;
      const ti = now(); await install(sb); const instMs = now() - ti;
      const url = await startDevAndGetUrl(sb);
      const to200 = pollUntil200(url);
      const total = now() - t0;
      currentResults.push(total);
      console.log(`  run ${i + 1}: total ${total}ms  (create ${createMs} · clone ${cloneMs} · install ${instMs} · dev→200 ${now() - t0 - createMs - cloneMs - instMs})`);
    } finally {
      await sb.terminate().catch(() => {});
    }
  }

  // ---- summary ----
  const avg = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const warmBaked = bakedResults.slice(1); // exclude first (image pull)
  console.log('\n' + '='.repeat(56));
  console.log('  SUMMARY (time until preview URL returns 200)');
  console.log('  CURRENT (clone+install+dev): avg ' + avg(currentResults) + 'ms  ' + JSON.stringify(currentResults));
  console.log('  BAKED   (from image, all):   avg ' + avg(bakedResults) + 'ms  ' + JSON.stringify(bakedResults));
  if (warmBaked.length) console.log('  BAKED   (warm, excl. 1st):   avg ' + avg(warmBaked) + 'ms  ' + JSON.stringify(warmBaked));
  const speedup = (avg(currentResults) / avg(warmBaked.length ? warmBaked : bakedResults)).toFixed(1);
  console.log(`  → baked (warm) is ~${speedup}x faster`);
  console.log('='.repeat(56));
}

main().then(() => process.exit(0)).catch((e) => { console.error('✗', e); process.exit(1); });
