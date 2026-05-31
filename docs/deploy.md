# Deploy runbook — friboard.com (AWS S3 + CloudFront)

**Status:** documentation only. No AWS resources are created or modified by code in this repo. Ervin owns the AWS account and provisions resources manually. `bin/deploy.sh` is committed but **not** executed from this repo until Ervin confirms infrastructure is in place and sets the required env vars.

## Target topology

```
  visitor → friboard.com (Route 53 ALIAS)
                       → CloudFront distribution (global edge, ACM cert in us-east-1)
                       → S3 bucket  s3://friboard-com-www  (eu-central-1, Frankfurt)
                          via Origin Access Control (OAC)
```

## Pre-deploy build sanity (local)

Run before any deploy to catch broken builds early:

```sh
npm ci
npm run check
npm run lint
npm run test:unit -- --run
npm run build

# verify build/ exists and is reasonable
test -d build || { echo "build/ missing"; exit 1; }
du -sh build/
ls -la build/index.html

# spot-check gzip size of the entry HTML
gzip -k build/index.html && ls -la build/index.html*
rm -f build/index.html.gz
```

`build/` must contain at least: `index.html`, `privacy.html`, `imprint.html`, `sitemap.xml`, `robots.txt`, `og-image.png`, `og-image.svg`, `favicon.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, and the hashed `_app/` directory of compiled assets.

`adapter-static` writes prerendered routes as `<route>.html` (e.g. `privacy.html`), not `<route>/index.html`. CloudFront needs a small viewer-request function to map `/privacy` → `/privacy.html` — see "CloudFront URL rewrite function" below.

---

## Manual one-time AWS console work

These steps are done once by Ervin, in the AWS Console (or CLI), and are **not** repeated by `bin/deploy.sh`.

### 1. S3 bucket

Region: `eu-central-1` (Frankfurt — closest EU GDPR-resident region with full CloudFront origin support).

```sh
aws s3api create-bucket \
  --bucket friboard-com-www \
  --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1
```

Then in the console:

- **Block Public Access:** all four toggles ON. The bucket is private. CloudFront reads it via OAC.
- **Bucket versioning:** enabled (cheap insurance — quick rollback by re-pointing CloudFront at a prior object version is not automatic, but versioning at least preserves the artifact).
- **Default encryption:** SSE-S3 (no extra cost).

Bucket policy is added in step 3 after the CloudFront distribution exists, so it can reference the distribution ARN.

### 2. ACM certificate

CloudFront only accepts certs in `us-east-1` (N. Virginia). The cert is metadata only — no visitor traffic transits that region.

In ACM console (`us-east-1`):

- Request a public certificate.
- Domain names: `friboard.com` and `www.friboard.com`.
- Validation method: **DNS** (Route 53 — ACM offers a one-click "Create record in Route 53" button once the hosted zone exists).

### 3. CloudFront distribution

- **Origin:**
  - Origin domain: `friboard-com-www.s3.eu-central-1.amazonaws.com` (the regional S3 REST endpoint, **not** the legacy website endpoint).
  - Origin access: **Origin Access Control (OAC)** — AWS 2024+ best practice. Create a new OAC with signing behaviour "Sign requests (recommended)" and origin type S3.
  - When you save, CloudFront shows a banner with the bucket-policy snippet to paste into the S3 bucket policy. Do that — it grants `s3:GetObject` to the distribution's principal only.
- **Default cache behavior:**
  - Viewer protocol policy: **Redirect HTTP to HTTPS.**
  - Allowed HTTP methods: `GET, HEAD`.
  - Compress objects automatically: **Yes** (Gzip + Brotli).
  - Cache policy: `CachingOptimized` (managed) — fine for hashed assets in `_app/immutable/*`.
- **Additional cache behaviors** — override for files that must not be cached long-term:
  | Path pattern | Cache policy |
  |---|---|
  | `/index.html` | `CachingDisabled` (managed) |
  | `/robots.txt` | `CachingDisabled` |
  | `/sitemap.xml` | `CachingDisabled` |
  | `/privacy*` | `CachingDisabled` |
  | `/imprint*` | `CachingDisabled` |
- **Default root object:** `index.html`.
- **Viewer-request function** — see "CloudFront URL rewrite function" below; attach to the default behavior. Required so `/privacy` (without `.html`) resolves to the `privacy.html` object in S3.
- **Custom error responses** — return a 404 page rather than a silent SPA fallback (we do not have a SPA — every route is prerendered):
  - 404 → `/index.html`, response code 404, error caching min TTL 0. _(Pragmatic placeholder until we ship a dedicated 404 page.)_
- **Settings:**
  - Price class: "Use only North America and Europe" (PriceClass_100) — visitor base is EU-first, cheap.
  - Alternate domain names (CNAMEs): `friboard.com`, `www.friboard.com`.
  - SSL certificate: the ACM cert created in step 2.
  - Security policy: **TLSv1.2_2021**.
  - Supported HTTP versions: **HTTP/2 and HTTP/3** both enabled.
  - IPv6: enabled.
  - Standard logging: optional. If enabled, log to a separate bucket with a 30-day lifecycle rule (see `docs/privacy.md` and `docs/analytics.md`).

### 4. Route 53

In the `friboard.com` hosted zone:

- `A` ALIAS at apex (`friboard.com`) → the CloudFront distribution.
- `AAAA` ALIAS at apex → the CloudFront distribution (IPv6).
- For `www.friboard.com`, the cleanest option is:
  - Create a second small CloudFront distribution OR an S3 redirect bucket that returns `301 → https://friboard.com/`.
  - Point `www.friboard.com` `A`/`AAAA` ALIAS at that. This keeps the primary distribution single-host.
  - Cheaper alternative for Phase 1: register both names on the main CloudFront distribution and accept that `www.` resolves to the same content. Re-evaluate during Phase 2 SEO pass.

---

## Automatable: routine deploys

Wrapped in [`bin/deploy.sh`](../bin/deploy.sh). The script refuses to run unless `ABERP_SITE_BUCKET` and `ABERP_SITE_DIST` are set.

The semantics mirror the CloudFront cache-control behaviors:

```sh
# 1. Build fresh
npm run build

# 2. Sync immutable, hashed assets with long cache
#    Everything except HTML, robots.txt, sitemap.xml.
aws s3 sync build/ "s3://${ABERP_SITE_BUCKET}" \
  --delete \
  --cache-control 'public, max-age=31536000, immutable' \
  --exclude index.html \
  --exclude '*.html' \
  --exclude robots.txt \
  --exclude sitemap.xml

# 3. Upload HTML and the meta files with no-cache
#    Each --cache-control overrides the bucket default.
aws s3 cp build/index.html "s3://${ABERP_SITE_BUCKET}/index.html" \
  --cache-control 'public, max-age=0, must-revalidate' \
  --content-type 'text/html; charset=utf-8'

aws s3 cp build/privacy.html "s3://${ABERP_SITE_BUCKET}/privacy.html" \
  --cache-control 'public, max-age=0, must-revalidate' \
  --content-type 'text/html; charset=utf-8'

aws s3 cp build/imprint.html "s3://${ABERP_SITE_BUCKET}/imprint.html" \
  --cache-control 'public, max-age=0, must-revalidate' \
  --content-type 'text/html; charset=utf-8'

aws s3 cp build/robots.txt "s3://${ABERP_SITE_BUCKET}/robots.txt" \
  --cache-control 'public, max-age=0, must-revalidate' \
  --content-type 'text/plain; charset=utf-8'

aws s3 cp build/sitemap.xml "s3://${ABERP_SITE_BUCKET}/sitemap.xml" \
  --cache-control 'public, max-age=0, must-revalidate' \
  --content-type 'application/xml; charset=utf-8'

# 4. Invalidate the CloudFront cache for the no-cache paths only
aws cloudfront create-invalidation \
  --distribution-id "${ABERP_SITE_DIST}" \
  --paths '/' '/index.html' '/robots.txt' '/sitemap.xml' '/privacy' '/privacy.html' '/imprint' '/imprint.html'
```

Targeted invalidation (versus `/*`) keeps the bill predictable as traffic grows.

---

## CloudFront URL rewrite function

`adapter-static` writes `/privacy` to `privacy.html`, but visitors hit `/privacy` (no extension). A small CloudFront Function on the default behavior's viewer-request event rewrites the URI before S3 sees it.

Create a CloudFront Function (Functions → Create function, runtime `cloudfront-js-2.0`):

```js
function handler(event) {
	var req = event.request;
	var uri = req.uri;

	// /privacy -> /privacy.html ; /imprint -> /imprint.html
	if (uri === '/privacy' || uri === '/imprint') {
		req.uri = uri + '.html';
	}

	// trailing-slash variants: /privacy/ -> /privacy.html
	if (uri === '/privacy/' || uri === '/imprint/') {
		req.uri = uri.slice(0, -1) + '.html';
	}

	return req;
}
```

Publish it, then attach to the distribution's default behavior under "Function associations" → "Viewer request". Update the list of paths in the function as new routes are added; revisit if Phase 2 introduces more than a handful of static routes (consider migrating to per-route trailing-slash + Lambda@Edge).

---

## Caching strategy summary

| Path                         | S3 `Cache-Control`                    | CloudFront policy          |
| ---------------------------- | ------------------------------------- | -------------------------- |
| `_app/immutable/*` (hashed)  | `public, max-age=31536000, immutable` | CachingOptimized           |
| `index.html`, `*/index.html` | `public, max-age=0, must-revalidate`  | CachingDisabled (per-path) |
| `robots.txt`, `sitemap.xml`  | `public, max-age=0, must-revalidate`  | CachingDisabled (per-path) |
| `og-image.png`, favicons     | inherits S3 default (immutable)       | CachingOptimized           |

Hashed assets can cache for a year safely because Vite re-hashes on every change. HTML must roundtrip every request so an emergency content change ships without a manual invalidation.

---

## GDPR notes (operational)

- All visitor-serving infrastructure is in the EU (S3 `eu-central-1`, CloudFront edges constrained by `PriceClass_100`). The ACM cert in `us-east-1` is metadata only.
- No analytics, cookies, or PII collection in Phase 1 — see [`docs/analytics.md`](analytics.md) and [`docs/privacy.md`](privacy.md).
- If CloudFront standard logs are enabled, set a **30-day lifecycle rule** on the log bucket. Document the retention in the privacy policy if longer than 30 days.

---

## Not in scope of this runbook

- CI/CD pipeline. Phase 1 ships from a developer machine (Cut A of the ground-zero design).
- Staging environment.
- WAF rules — revisit once Phase 2 quote form accepts file uploads.
- Log shipping / observability — Phase 2+ concern.
- `www.` → apex redirect via separate CloudFront — deferred.

---

## Rollback

There is no automated rollback in Phase 1. If a bad deploy ships:

1. `git checkout` the prior known-good commit.
2. Re-run `bin/deploy.sh`.
3. `aws cloudfront create-invalidation --distribution-id "$ABERP_SITE_DIST" --paths '/*'` (broad invalidation acceptable for emergency rollback).

S3 bucket versioning preserves the prior object versions for forensics but is not used in this rollback path.
