import { Router } from 'express';
import * as cloudflare from '../modal/cloudflare.js';
import { setDomainSchema } from '../modal/schemas.js';
import { asyncHandler, validate } from '../middleware/validate.js';
import { httpError } from '../middleware/error.js';

const router = Router();

// GET /deployments/:scriptName/domains — list custom domains bound to a Worker.
router.get(
  '/:scriptName/domains',
  asyncHandler(async (req, res) => {
    const scriptName = req.params.scriptName as string;
    const creds = cloudflare.cfCreds();
    const domains = await cloudflare.listDomains(creds, { service: scriptName });
    res.json({ scriptName, domains: domains.map((d) => d.hostname) });
  }),
);

// PUT /deployments/:scriptName/domain — rename/set the public domain.
// Attaches the new domain to the Worker and detaches the old one(s) → old URL 404s.
router.put(
  '/:scriptName/domain',
  validate(setDomainSchema),
  asyncHandler(async (req, res) => {
    const scriptName = req.params.scriptName as string;
    const { domain, zoneId, zoneName } = req.body;

    // Same validation as publish (RFC-1035 + reserved + no `--`).
    cloudflare.validateSubdomainLabel(domain.split('.')[0]);

    const creds = cloudflare.cfCreds();

    // Uniqueness: reject if the hostname is already bound to a DIFFERENT Worker.
    const existing = await cloudflare.listDomains(creds, { hostname: domain });
    if (existing.some((d) => d.service !== scriptName)) {
      throw httpError(409, `"${domain}" is already in use by another project`);
    }

    // Attach the new domain, then release every other domain on this Worker.
    const url = await cloudflare.attachDomain(creds, domain, scriptName, { zoneId, zoneName });
    const current = await cloudflare.listDomains(creds, { service: scriptName });
    const removed: string[] = [];
    for (const d of current) {
      if (d.hostname !== domain) {
        await cloudflare.deleteDomain(creds, d.id);
        removed.push(d.hostname);
      }
    }

    res.json({ scriptName, domain: url, removed });
  }),
);

export default router;
