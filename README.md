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
npm run dev      # http://localhost:5173
npm run check    # svelte-check (type-check)
npm run build    # static build/ for S3+CloudFront
npm run test:unit -- --run
```

## Production target

AWS S3 + CloudFront, region `eu-central-1` (Frankfurt). See [`docs/deploy.md`](docs/deploy.md) for the eventual deploy runbook. Build output (`build/`) is fully static via `@sveltejs/adapter-static`.
