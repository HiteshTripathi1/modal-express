/**
 * In-memory registry of live sandboxes, keyed by sandbox id. Just a module-level
 * Map and a few functions.
 *
 * `terminateAll()` is wired to SIGINT/SIGTERM in src/index.ts so no sandbox keeps
 * running — and billing — after the server stops.
 */
import type { Sandbox } from './modal.types.js';

interface SandboxEntry {
  sandbox: Sandbox;
  createdAt: string;
  meta: Record<string, unknown>;
}

const entries = new Map<string, SandboxEntry>();

export function track(sandbox: Sandbox, meta: Record<string, unknown> = {}) {
  entries.set(sandbox.sandboxId, { sandbox, createdAt: new Date().toISOString(), meta });
}

export function getEntry(id: string) {
  return entries.get(id);
}

export function list() {
  return [...entries.values()].map((e) => ({
    sandboxId: e.sandbox.sandboxId,
    createdAt: e.createdAt,
    meta: e.meta,
  }));
}

/** Terminate one tracked sandbox and drop it from the registry. */
export async function terminate(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  try {
    await entry.sandbox.terminate();
  } finally {
    entries.delete(id);
  }
}

/** Terminate every tracked sandbox. Best-effort: one failure won't stop the rest. */
export async function terminateAll() {
  const ids = [...entries.keys()];
  if (ids.length === 0) return;
  console.log(`Terminating ${ids.length} sandbox(es) on shutdown...`);
  await Promise.allSettled(ids.map((id) => entries.get(id)?.sandbox.terminate()));
  entries.clear();
}
