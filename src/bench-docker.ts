/**
 * Benchmark: cold-start from a Docker Hub registry image (pulled by Modal).
 * Measures the first run (includes Modal pulling the image from Docker Hub) and
 * warm runs (image cached on Modal). Compare against the snapshot/current numbers.
 *
 * Run: REGISTRY_USERNAME=... REGISTRY_PASSWORD=... npx tsx src/bench-docker.ts
 */
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_ENV, DEFAULT_TIMEOUT_MS } from './modal/preview-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(__dirname, '..', '.env')); } catch {}

const TAG = process.env.REGISTRY_TAG ?? 'docker.io/hiteshtripathi1/tanstack-baked:latest';
const WORKSPACE = '/workspace';
const REPO_DIR = `${WORKSPACE}/repo`;
const PORT = Number(process.env.DEV_PORT ?? 3000);
const DEV = process.env.DEV_CMD ?? 'npm run dev';
const RUNS = 3;

const now = () => Date.now();
function pollUntil200(url: string, timeoutMs = 120000): number {
  const start = now();
  for (;;) {
    try {
      const code = execSync(`curl -s -o /dev/null -m 10 -w "%{http_code}" "${url}"`, { encoding: 'utf8' }).trim();
      if (code === '200') return now() - start;
    } catch { /* not up */ }
    if (now() - start > timeoutMs) throw new Error(`no 200 within ${timeoutMs}ms: ${url}`);
    execSync('sleep 1');
  }
}

async function main() {
  const user = process.env.REGISTRY_USERNAME;
  const pass = process.env.REGISTRY_PASSWORD;
  if (!user || !pass) throw new Error('Set REGISTRY_USERNAME and REGISTRY_PASSWORD');

  const { ModalClient } = await import('modal');
  const client: any = new ModalClient();
  const app = await client.apps.fromName('modal-sandbox-api', { createIfMissing: true });
  const regSecret = await client.secrets.fromObject({ REGISTRY_USERNAME: user, REGISTRY_PASSWORD: pass });
  const image = client.images.fromRegistry(TAG, regSecret);

  console.log(`Image: ${TAG}\nDev:   ${DEV} -- --port=${PORT}\n`);
  const results: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = now();
    const sb = await client.sandboxes.create(app, image, {
      encryptedPorts: [PORT], workdir: WORKSPACE, timeoutMs: DEFAULT_TIMEOUT_MS, env: PREVIEW_ENV,
    });
    try {
      const createMs = now() - t0;
      const devCommand = `${DEV} -- --port=${PORT}`;
      await sb.exec(['sh', '-c', devCommand], { workdir: REPO_DIR, stdout: 'pipe', stderr: 'pipe' });
      const tunnels = await sb.tunnels();
      const url = tunnels[PORT]?.url;
      if (!url) throw new Error('no tunnel url');
      const to200 = pollUntil200(url);
      const total = now() - t0;
      results.push(total);
      console.log(`  run ${i + 1}: total ${total}ms  (create ${createMs}ms · dev→200 ${to200}ms)${i === 0 ? '  [first = Modal pulls image from Docker Hub]' : ''}`);
    } finally {
      await sb.terminate().catch(() => {});
    }
  }
  const warm = results.slice(1);
  const avg = (a: number[]) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  console.log('\n=== DOCKER REGISTRY cold-starts ===');
  console.log('  all runs:        ' + JSON.stringify(results));
  console.log('  first (w/ pull): ' + results[0] + 'ms');
  console.log('  warm (excl 1st): avg ' + avg(warm) + 'ms  ' + JSON.stringify(warm));
}

main().then(() => process.exit(0)).catch((e) => { console.error('✗', e); process.exit(1); });
