# Deploy runbook — friboard.com (AWS S3 + CloudFront + Lightsail)

**Status:** documentation only. No AWS resources are created or modified by code in this repo. Ervin owns the AWS account and provisions resources manually. `bin/deploy.sh` is committed but **not** executed from this repo until Ervin confirms infrastructure is in place and sets the required env vars.

> **Phase 2 update (2026-05-31).** The repo now uses `@sveltejs/adapter-node` (was `adapter-static`). `npm run build` produces a Node-runnable `build/` with `build/index.js` as the entry, but every route is _also_ prerendered to static HTML when `export const prerender = true` is set on its `+page.ts`. The Phase 2 site has **two deploy surfaces**:
>
> - **Static surface** — `/`, `/privacy`, `/imprint` plus all hashed `_app/immutable/*` assets, favicons, and OG images. Still hosted on S3 + CloudFront exactly as in Phase 1.
> - **Dynamic surface** — `/quote` (form, SSR) and `/api/*` (quote submission + operator-pull). Requires a Node runtime. Phase 2 conservative target: **AWS Lightsail container service** in `eu-central-1` (Frankfurt). Rejected alternatives: `adapter-vercel` and `adapter-cloudflare` (AWS-only mandate, see `e2e-shop` memory).
>
> The static and dynamic surfaces share a single CloudFront distribution: dynamic paths are routed to the Lightsail origin via an additional cache behavior. See [Phase 2 — dynamic surface](#phase-2--dynamic-surface) below.

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

---

## Phase 2 — dynamic surface

Phase 2 introduces the `/quote` form and a small API surface. Static delivery (Phase 1) does not change; this section describes the additional Node runtime.

### Build output

`adapter-node` writes a self-contained Node application to `build/`:

- `build/index.js` — entry point. Run with `node build`.
- `build/handler.js` — middleware-style handler if you want to embed it in a custom server.
- `build/client/` and `build/server/` — bundled client and server code.
- Prerendered routes (`/`, `/privacy`, `/imprint`) are still written as static HTML alongside the server bundle. They can be uploaded to S3 the same way as before; the Node runtime only needs to serve `/quote` and `/api/*`.

### Runtime target — AWS Lightsail (conservative choice)

Phase 2 v1 deploys the Node runtime to **AWS Lightsail container service** in `eu-central-1` (Frankfurt):

- Lightsail "Nano" or "Micro" container plan is sufficient for low traffic.
- Stays inside the AWS account (consistent with the `e2e-shop` AWS-only mandate).
- Cheaper and simpler than ECS / App Runner for a single small Node app at this scale.
- Has a managed HTTPS endpoint that CloudFront can use as a custom origin.

Alternatives considered:

- **adapter-vercel / adapter-cloudflare** — rejected. The shop platform is committed to AWS.
- **AWS App Runner / ECS Fargate** — overkill for one small Node service; revisit at the 2.0 cutover.
- **EC2 + systemd** — viable but higher operational burden than Lightsail.

### Container

Minimal `Dockerfile` (not yet committed — sketch only):

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY build ./build
ENV NODE_ENV=production
ENV PORT=3000
ENV ABERP_SITE_QUOTE_DIR=/var/aberp/quotes
EXPOSE 3000
CMD ["node", "build"]
```

### Env vars (Lightsail container service env)

| Variable               | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `PORT`                 | Node listen port. Default `3000`. Lightsail expects this on the container. |
| `NODE_ENV`             | `production`.                                                              |
| `ABERP_SITE_QUOTE_DIR` | Path where quote submissions are staged. Default `./data/quotes`.          |

### Persistent storage (REQUIRED — non-negotiable)

`ABERP_SITE_QUOTE_DIR` **must** point at a persistent volume mount, not the container's ephemeral filesystem. If the container restarts, in-flight quote submissions and any not-yet-pulled metadata.json files **will be lost**, including customer PII and CAD-as-IP.

Lightsail container service does not offer persistent volumes natively. Two acceptable patterns:

1. **EFS via a small EC2 sidecar** — mount EFS on an EC2 instance, expose it to Lightsail over the VPC peering link. Operationally heavier.
2. **Block storage on a Lightsail instance (not container)** — drop Lightsail container service and use a Lightsail Linux instance + attached block storage volume instead. Simpler. **Recommended for Phase 2.**

Pick the second option unless there's a specific reason not to. The container service is convenient but loses to durability requirements here.

### Backup

`data/quotes/` is the ground truth for any quote that hasn't been pulled into ABERP yet. Until the 2.0 cutover that closes the operator-pull loop, the simplest backup is `rsync` to a private S3 bucket:

```sh
# Run from the Lightsail host on a cron (every 15 minutes is fine for this volume).
aws s3 sync /var/aberp/quotes "s3://friboard-com-quotes-backup" \
  --storage-class STANDARD_IA \
  --exact-timestamps
```

Encrypt the backup bucket with SSE-KMS, region `eu-central-1`, block all public access, and set a lifecycle rule that transitions to Glacier after 30 days.

### CloudFront routing

Add one extra cache behavior to the existing distribution:

| Path pattern | Origin                   | Cache policy    |
| ------------ | ------------------------ | --------------- |
| `/quote`     | Lightsail HTTPS endpoint | CachingDisabled |
| `/quote/*`   | Lightsail HTTPS endpoint | CachingDisabled |
| `/api/*`     | Lightsail HTTPS endpoint | CachingDisabled |

Use a managed origin request policy that forwards all viewer headers, cookies, and query params. Disable caching for the dynamic surface — the form is per-session and the API is non-idempotent.

The Phase 1 viewer-request function (rewriting `/privacy` → `/privacy.html`) **must not** rewrite `/quote` or `/api/*`. Update the function so the rewrite is only applied to the explicit prerendered paths.

### Operator-pull endpoint security caveat

`GET /api/quotes` lists every submitted quote and returns full metadata (including customer name, email, and the file list). **It has no authentication in Phase 2 v1.** Before exposing the dynamic surface to the internet:

1. Restrict the CloudFront origin to require a custom header (e.g. `X-Friboard-Auth`) that the Lightsail app validates, OR
2. Add a per-request API key check on `/api/quotes` (single shared secret in env), OR
3. Block `/api/quotes` at the CloudFront edge entirely and tunnel into Lightsail over SSM/SSH to fetch.

Option 2 is the cheapest stop-gap. Authentication design is finalised at the 2.0 cutover when ABERP becomes the consumer.

### Pre-deploy build sanity (Phase 2 addendum)

In addition to the Phase 1 build sanity:

```sh
npm run build

# verify the Node entry exists
test -f build/index.js || { echo "build/index.js missing"; exit 1; }

# verify the prerendered routes still ship as HTML
test -f build/client/index.html || true   # not guaranteed by adapter-node, depends on prerender output dir
ls build/prerendered/pages 2>/dev/null    # adapter-node puts prerendered HTML under build/prerendered

# smoke-test the runtime locally
PORT=3001 ABERP_SITE_QUOTE_DIR=/tmp/aberp-smoke node build &
SMOKE_PID=$!
sleep 2
curl -fsS http://localhost:3001/ > /dev/null
curl -fsS http://localhost:3001/quote > /dev/null
kill "$SMOKE_PID"
rm -rf /tmp/aberp-smoke
```

### Not in scope of Phase 2 v1

The following are deferred to Phase 3:

- **Authentication on `/api/quotes`** — Phase 2 v1 is localhost-only, then guarded at the CloudFront edge by a custom header on the first internet deploy. Real auth lands at the 2.0 cutover when ABERP polls.
- **Virus / malware scanning of uploaded CAD** — defer until upload volume justifies a ClamAV sidecar or a third-party scan API.
- **Rate limiting on `POST /api/quote`** — would need a shared KV store (Redis / DynamoDB). Defer; CloudFront WAF rate limit is the cheap stop-gap if abuse appears.
- **Encryption at rest beyond underlying disk encryption** — CAD-as-IP risk is acknowledged; per-quote envelope encryption is a Phase 3 design item.
- **Automated retention / erasure** — privacy policy currently says retention is operator-determined; an automated TTL is a Phase 3 deliverable.
- **Customer / operator email notifications** — Phase 2 v1 has no SMTP integration. The operator polls `GET /api/quotes`; customer follow-up is manual via the email address they provided.
