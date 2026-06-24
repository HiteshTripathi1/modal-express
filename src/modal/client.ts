/**
 * Lazily loads the ESM-only `modal` SDK and builds a single shared client.
 * The client reads MODAL_TOKEN_ID / MODAL_TOKEN_SECRET from the environment.
 */
import { config } from '../config.js';
import { httpError } from '../middleware/error.js';
import type { ModalClient } from './modal.types.js';

let clientPromise: Promise<ModalClient> | undefined;

export function getClient(): Promise<ModalClient> {
  if (!clientPromise) {
    if (!config.modalTokenId || !config.modalTokenSecret) {
      throw httpError(500, 'Missing MODAL_TOKEN_ID / MODAL_TOKEN_SECRET. Set them in .env.');
    }
    clientPromise = (async () => {
      const sdk = await import('modal');
      return new sdk.ModalClient();
    })();
  }
  return clientPromise;
}
