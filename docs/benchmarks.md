# Benchmarks — sandbox cold-start (baked image vs clone+install)

**Goal:** how fast does each *new* sandbox boot the preview? Metric = time from
`sandbox.create` until the **preview URL returns `200`**.

Boilerplate: `tanstack-stadcn-starter` (npm monorepo, `dev:tagger -w @tanstart/web`),
dev port 3000. Measured with `src/bench-image.ts` and `src/bench-docker.ts`.

## One-time bake cost (`npm run bake`)

```
clone 2.5s · install 12.8s · snapshot 5.0s ≈ 22s   (paid once per boilerplate version)
→ produces a Modal image id (BAKED_IMAGE_ID), reused by every new sandbox
```

## Cold-start comparison

| Approach | First / cold start | Warm start | Notes |
|---|---|---|---|
| **Current** (clone + install + dev) | **~22s** | **~22s every time** | install (~14s) paid on *every* sandbox |
| **Modal snapshot** (`snapshotFilesystem`) | **~6s** | **~5.7s** | native; create ≈0.7s, rest is vite boot |
| **Docker registry** (`fromRegistry`) | **~32s** (Modal pulls ~500 MB from Docker Hub) | **~4.4s** | slow first pull, then cached = same as snapshot |

### Raw runs
- **Current:** 21.9s, 22.6s → avg **22.2s** (`create 1.3 · clone 3.1 · install 14.2 · dev→200 3.3`)
- **Modal snapshot:** 6.0s, 7.0s, 4.3s → warm avg **5.7s** (`create ~0.7s`)
- **Docker registry:** 31.6s (first, `create 25.6s` = pull), 4.7s, 4.2s → warm avg **4.4s** (`create ~0.7s`)

## Conclusions

- **Baking is ~4–5× faster than clone+install** (~6s vs ~22s), and the floor is now
  vite's own ~2–4s boot — not the install.
- **Warm, Modal-snapshot ≈ Docker-registry** (both `create ~0.7s`). They converge
  because Modal caches the pulled Docker image as a Modal image.
- The only real differences:
  - **Cold/first start:** snapshot ~6s vs Docker ~32s (the one-time pull).
  - **Ownership:** Docker image is yours (won't be GC'd); the Modal snapshot lives
    in your Modal account and *could* be garbage-collected if unused.

## Recommendation

- **Speed + simplicity → Modal snapshot** (`BAKED_IMAGE_ID` in `.env`; `npm run sandbox`
  boots from it via `runBakedPreview`). Faster cold, no registry to maintain.
- **Durability ("what if Modal deletes it") → keep the snapshot + add a self-healing
  fallback** (on image-miss → clone+install + auto re-bake) and/or a periodic re-bake.
  Same speed, no external pipeline, never crashes.
- **Docker registry** only if you must *own/move* the image outside Modal — accept the
  slow first pull and the build/push step.

## Cost note

Modal bills mainly for **compute** (per-second while a sandbox runs). Baking *reduces*
cost by removing ~16s of billed install from every preview. Image storage is small.
The lever to watch is **sandbox uptime** — terminate idle previews (the registry +
`DELETE` endpoints already do this).
