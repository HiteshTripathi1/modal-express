/**
 * Tiny JSON-file store for Projects — the persistent half of the project ⇄
 * sandbox architecture. A Project is the durable record (prompt, repo, and the
 * id/url of its current sandbox); the sandbox itself is ephemeral and lives in
 * the in-memory registry. Loaded once at startup, rewritten on every mutation.
 *
 * Note: the git token is NEVER stored here — it is read from .env only when a
 * sandbox is provisioned, so no secret is written to disk.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProjectStatus = 'created' | 'initializing' | 'running' | 'error';

export interface Project {
  id: string;
  name?: string;
  /** The natural-language description of the app to build (Lovable-style). */
  prompt: string;
  /** Repo cloned into the sandbox (defaults to the boilerplate from .env). */
  repoUrl: string;
  /** Set once a sandbox is provisioned. */
  sandboxId: string | null;
  previewUrl: string | null;
  port: number | null;
  status: ProjectStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'projects.json');

function loadAll(): Project[] {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Project[];
  } catch {
    return [];
  }
}

let projects: Project[] = loadAll();

function persist() {
  writeFileSync(FILE, JSON.stringify(projects, null, 2));
}

export function all(): Project[] {
  return projects;
}

export function get(id: string): Project | undefined {
  return projects.find((p) => p.id === id);
}

export function insert(project: Project): Project {
  projects.push(project);
  persist();
  return project;
}

export function update(id: string, patch: Partial<Project>): Project | undefined {
  const p = get(id);
  if (!p) return undefined;
  Object.assign(p, patch, { updatedAt: new Date().toISOString() });
  persist();
  return p;
}

export function remove(id: string): boolean {
  const i = projects.findIndex((p) => p.id === id);
  if (i < 0) return false;
  projects.splice(i, 1);
  persist();
  return true;
}
