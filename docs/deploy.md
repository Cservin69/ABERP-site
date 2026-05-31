# Deploy runbook — friboard.com (AWS S3 + CloudFront)

**Status:** documentation only. No AWS resources are created or modified by code in this repo. Ervin owns the AWS account and provisions resources manually.

## Target topology

```
  visitor → friboard.com (Route 53 ALIAS)
                       → CloudFront distribution (global edge)
                       → S3 bucket  s3://friboard-com-www  (eu-central-1, Frankfurt)
```

## One-time AWS setup (manual, Ervin's account)

1. **S3 bucket** — `friboard-com-www` in `eu-central-1`. Block all public access. Bucket policy grants read only to the CloudFront Origin Access Control (OAC).
2. **ACM certificate** — request `friboard.com` + `www.friboard.com` in **`us-east-1`** (CloudFront requires certs in N. Virginia). DNS-validate via Route 53.
3. **CloudFront distribution** — origin = the S3 bucket via OAC (not the legacy website endpoint). Default root object = `index.html`. Custom error response: `404 → /404.html` with HTTP 200 (SvelteKit static prerender semantics; revisit if a real SPA fallback is needed in later phases). Attach the ACM cert; alternate domain names = `friboard.com`, `www.friboard.com`. Compress objects automatically.
4. **Route 53** — hosted zone for `friboard.com`. `A` ALIAS at apex → CloudFront. `A` ALIAS at `www` → CloudFront (or 301 redirect via S3+CloudFront if Ervin prefers apex-only).

Bucket name is a placeholder — Ervin to confirm. The S3 bucket name is global, so register the chosen name early.

## Build & sync

```sh
npm ci
npm run build                              # outputs to build/
aws s3 sync build/ s3://friboard-com-www \
  --delete \
  --cache-control 'public, max-age=300' \
  --region eu-central-1
aws cloudfront create-invalidation \
  --distribution-id <CF_DIST_ID> \
  --paths '/*'
```

A future PR will wrap this into a `scripts/deploy.sh` once the bucket + distribution exist. **Not in this PR** — no AWS CLI invocations should ship until Ervin confirms the resources are in place.

## Caching strategy (Phase 1)

- **HTML**: `max-age=300` (5 min) so an emergency content change propagates fast without a manual invalidation.
- **Hashed JS/CSS assets** (Vite puts a hash in the filename): `max-age=31536000, immutable`. The `aws s3 sync` example above is conservative across the board; tighten to per-prefix headers once the asset directory layout is stable.
- CloudFront invalidation `/*` on every deploy keeps things simple while traffic is low; switch to targeted invalidation when bills demand.

## GDPR notes

- All hosting in EU (S3 `eu-central-1`, CloudFront edges chosen via geo). The ACM cert in `us-east-1` is metadata only — no visitor traffic transits that region.
- No analytics, no cookies, no form input that captures PII in Phase 1. The CTA is a `mailto:` link, so the visitor's email client (not friboard.com) sends the email.

## Not in scope of this runbook

- CI/CD pipeline (manual deploy from a developer machine is fine for Phase 1 — Cut A of the ground-zero design doc).
- Staging environment.
- WAF rules — revisit once the quote form (Phase 2) accepts file uploads.
- Log shipping / observability — Phase 2+ concern.
