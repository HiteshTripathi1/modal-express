/**
 * Cloudflare Workers Custom Domains: validate a subdomain label, list/attach/
 * detach domains bound to a Worker. Used by publish() (attach) and the rename
 * endpoint (attach new + detach old).
 */
import { httpError } from '../middleware/error.js';
import { config } from '../config.js';

const API = 'https://api.cloudflare.com/client/v4';

// Labels we never let a tenant claim (infra/brand surfaces + the internal separator).
const RESERVED = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'static', 'cdn', 'assets', 'project',
  'preview', 'dashboard', 'dash', 'status', 'docs', 'blog', 'staging', 'prod',
  'test', 'dev', 'zenix', 'zenixai',
]);

/** Validate a subdomain LABEL (the part before your base domain). Throws 400. */
export function validateSubdomainLabel(label: string): void {
  if (!label) throw httpError(400, 'Subdomain is required');
  if (label.length > 45) throw httpError(400, 'Must be less than 45 characters');
  if (!/^[a-z]/.test(label)) throw httpError(400, 'Must start with a lowercase letter');
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw httpError(400, 'Only lowercase letters, digits, and hyphens are allowed');
  }
  if (label.startsWith('-') || label.endsWith('-')) {
    throw httpError(400, 'Cannot start or end with a hyphen');
  }
  if (label.includes('--')) throw httpError(400, 'Cannot contain consecutive hyphens');
  if (RESERVED.has(label)) throw httpError(400, 'This subdomain is reserved and cannot be used');
}

export interface Creds {
  apiToken: string;
  accountId: string;
}

/** Read Cloudflare creds from .env (config), or 400 if missing. */
export function cfCreds(): Creds {
  const apiToken = config.cloudflare.apiToken;
  const accountId = config.cloudflare.accountId;
  if (!apiToken) throw httpError(400, 'CLOUDFLARE_API_TOKEN required in .env');
  if (!accountId) throw httpError(400, 'CLOUDFLARE_ACCOUNT_ID required in .env');
  return { apiToken, accountId };
}

async function cf(
  creds: Creds,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/accounts/${creds.accountId}${path}`, {
    method: init.method,
    body: init.body,
    headers: { Authorization: `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.success === false) {
    throw httpError(
      502,
      `Cloudflare API ${path} failed (${res.status}): ${JSON.stringify(json.errors ?? json)}`,
    );
  }
  return json;
}

export interface DomainBinding {
  id: string;
  hostname: string;
  service: string;
}

/** List custom domains, optionally filtered by service (worker) or hostname. */
export async function listDomains(
  creds: Creds,
  filter: { service?: string; hostname?: string } = {},
): Promise<DomainBinding[]> {
  const qs = new URLSearchParams();
  if (filter.service) qs.set('service', filter.service);
  if (filter.hostname) qs.set('hostname', filter.hostname);
  const q = qs.toString() ? `?${qs}` : '';
  const json = await cf(creds, `/workers/domains${q}`);
  return (json.result as DomainBinding[]) ?? [];
}

/** Bind a hostname to a Worker (creates DNS + cert). Idempotent. Returns the https URL. */
export async function attachDomain(
  creds: Creds,
  hostname: string,
  service: string,
  zone: { zoneId?: string; zoneName?: string } = {},
): Promise<string> {
  const z = zone.zoneId
    ? { zone_id: zone.zoneId }
    : { zone_name: zone.zoneName ?? hostname.split('.').slice(-2).join('.') };
  await cf(creds, '/workers/domains', {
    method: 'PUT',
    body: JSON.stringify({ hostname, service, environment: 'production', ...z }),
  });
  return `https://${hostname}`;
}

/** Delete a custom domain binding by its id. */
export async function deleteDomain(creds: Creds, id: string): Promise<void> {
  await cf(creds, `/workers/domains/${id}`, { method: 'DELETE' });
}
