/**
 * Standalone CLI flow (`npm run sandbox`).
 *
 * One-shot alternative to the REST API: reads config from .env, clones a repo
 * into a Modal Sandbox, runs the dev server, prints the public tunnel URL, and
 * keeps it alive until Ctrl+C (which terminates the sandbox).
 *
 * Shares the exact preview logic with the API via src/modal/preview-runner.ts.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreview, type PreviewResult } from './modal/preview-runner.js';
import type { Sandbox } from './modal/modal.types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(join(__dirname, '..', '.env'));
} catch {
  // No .env — rely on the ambient environment.
}

/** Parse a dotenv file into a flat map (KEY=VALUE lines; # comments ignored). */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

async function main() {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    throw new Error(
      'Missing MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (set in .env). ' +
        'Create a token at https://modal.com/settings/tokens',
    );
  }
  const repoUrl = process.env.GIT_REPO_URL;
  if (!repoUrl) {
    throw new Error('Missing GIT_REPO_URL in .env (e.g. https://github.com/owner/repo.git)');
  }

  // Optionally inject an env file into the cloned app (e.g. the tenant's .env,
  // which is gitignored and so absent from the clone).
  let injectEnv: Record<string, string> | undefined;
  if (process.env.INJECT_ENV_FILE) {
    injectEnv = parseEnvFile(readFileSync(process.env.INJECT_ENV_FILE, 'utf8'));
    console.log(
      `  Injecting ${Object.keys(injectEnv).length} env var(s) from ${process.env.INJECT_ENV_FILE}`,
    );
  }

  // ModalClient reads MODAL_TOKEN_ID/SECRET from the environment.
  const { ModalClient } = await import('modal');
  const client = new ModalClient();

  // Capture the sandbox the moment it is created (not just after runPreview
  // returns), so stopping the process during startup still tears it down.
  let sandbox: Sandbox | undefined;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) process.exit(1); // a second Ctrl+C force-quits
    shuttingDown = true;
    if (sandbox) {
      console.log(`\n→ ${signal} received — terminating sandbox ${sandbox.sandboxId}...`);
      try {
        await sandbox.terminate();
        console.log('  Sandbox terminated.');
      } catch (err) {
        console.error('  Failed to terminate sandbox:', (err as Error).message);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  let result: PreviewResult;
  try {
    result = await runPreview(
      client,
      {
        repoUrl,
        token: process.env.GIT_TOKEN || undefined,
        branch: process.env.GIT_BRANCH || undefined,
        subdir: process.env.APP_SUBDIR || undefined,
        port: process.env.DEV_PORT ? Number(process.env.DEV_PORT) : undefined,
        installCmd: process.env.INSTALL_CMD || undefined,
        devCmd: process.env.DEV_CMD || undefined,
        userName: process.env.GIT_USER_NAME || undefined,
        userEmail: process.env.GIT_USER_EMAIL || undefined,
        env: injectEnv,
        envFile: process.env.INJECT_ENV_NAME || undefined,
      },
      {
        log: (m) => console.log('  ' + m),
        onSandboxCreated: (sb) => {
          sandbox = sb;
        },
      },
    );
  } catch (err) {
    // Startup failed after the sandbox was created — don't leave it running.
    if (sandbox) {
      console.error(`→ Startup failed — terminating sandbox ${sandbox.sandboxId}...`);
      try {
        await sandbox.terminate();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  const t = result.timings;
  console.log('\n' + '='.repeat(60));
  console.log('  ✅ App is live in a Modal Sandbox:');
  console.log('     ' + result.url);
  console.log(`  ⏱  Started in ${(t.totalMs / 1000).toFixed(1)}s`);
  console.log(
    `     create ${t.createMs}ms · clone ${t.cloneMs}ms · ` +
      `install ${t.installMs}ms · dev ${t.devReadyMs}ms`,
  );
  console.log('  Press Ctrl+C to terminate the sandbox.');
  console.log('='.repeat(60) + '\n');

  // Keep the process (and the sandbox) alive until interrupted.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('\n✗ Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
