# ABERP-site

Stage 2 customer-facing storefront for **friboard.com** — Áben's custom manufacturing offering. Sibling to ABERP (the back-office invoicing/ledger system).

This repo is internal code under the Áben umbrella; the customer surface lives at **friboard.com**.

## Status

Phase 1 — landing page only. RainEffect WebGL integration, real wordmark asset, quote form, and CAD upload are later sessions.

## Design doc

See `../ABERP/docs/e2e-shop/ground-zero.md` (in the ABERP repo) for the authoritative Stage 2 design: domain decision, brand, MVP scope, stack, RainEffect adaptation, architecture, quote engine decomposition, hosting, GDPR, and roadmap.

## Dev quickstart

```sh
npm install
cp .env.example .env   # provides BODY_SIZE_LIMIT, dev admin token, etc.
npm run dev            # http://localhost:5173
npm run check          # svelte-check (type-check)
npm run build          # adapter-node output in build/
npm run test:unit -- --run
```

`.env.example` pins `BODY_SIZE_LIMIT=52428800` (50 MB). Without it, adapter-node
defaults to 512 KB and every CAD upload 413s before the handler runs. The
canonical local-dev quote-form command is:

```sh
BODY_SIZE_LIMIT=52428800 ABERP_SITE_ADMIN_TOKEN=dev npm run build && \
  BODY_SIZE_LIMIT=52428800 ABERP_SITE_ADMIN_TOKEN=dev node build/index.js
```

## Production target

AWS S3 + CloudFront, region `eu-central-1` (Frankfurt). See [`docs/deploy.md`](docs/deploy.md) for the eventual deploy runbook. Build output (`build/`) is fully static via `@sveltejs/adapter-static`.
