/**
 * Composed preview flow: create sandbox → clone → install → start dev server →
 * return the public tunnel URL. Delegates to the shared preview-runner.
 */
import { getClient } from './client.js';
import * as registry from './registry.js';
import { runPreview, type PreviewOptions } from './preview-runner.js';

export async function createPreview(opts: PreviewOptions) {
  const client = await getClient();
  const result = await runPreview(client, opts, {
    log: (m) => console.log(m),
    // Track the sandbox as soon as it exists, so it is cleaned up on shutdown
    // even if a later step (clone/install) fails.
    onSandboxCreated: (sandbox) =>
      registry.track(sandbox, { kind: 'preview', repoUrl: opts.repoUrl }),
  });
  return {
    sandboxId: result.sandboxId,
    url: result.url,
    port: result.port,
    timings: result.timings,
  };
}
