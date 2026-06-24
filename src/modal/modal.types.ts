/**
 * Type-only access to the ESM-only `modal` SDK.
 *
 * The package is ESM-only; we load it at runtime via dynamic `import('modal')`
 * (see ModalService) so the rest of the app stays decoupled from its module
 * format. For types we derive everything from a *value-position* dynamic import
 * via `ReturnType<typeof loadSdk>`, which keeps a single (ESM) resolution mode.
 */
function loadSdk() {
  return import('modal');
}

export type ModalSdk = Awaited<ReturnType<typeof loadSdk>>;
export type ModalClient = InstanceType<ModalSdk['ModalClient']>;
export type Sandbox = Awaited<ReturnType<ModalClient['sandboxes']['create']>>;
export type Tunnel = Awaited<ReturnType<Sandbox['tunnels']>>[number];
export type Secret = Awaited<ReturnType<ModalClient['secrets']['fromObject']>>;
