# CloudFront behaviour configuration

The friboard.com distribution serves two origins:

- **S3** — `friboard-com-www.s3.eu-central-1.amazonaws.com` via Origin Access
  Control (OAC). Holds the static surface and the prerendered HTML.
- **Lightsail** — `<static-ip>` on port `80` (with nginx) or `3000` (Node
  directly). Serves the dynamic surface.

Behaviours are evaluated top-to-bottom by path-pattern specificity (CloudFront
uses precedence, not insertion order, but listing them in this order matches
how the rules read).

## Behaviour table

| Path pattern         | Origin        | Cache policy       | Origin request policy       | Viewer protocol policy | Notes                                                         |
| -------------------- | ------------- | ------------------ | --------------------------- | ---------------------- | ------------------------------------------------------------- |
| `/_app/*`            | S3            | `CachingOptimized` | `CORS-S3Origin`             | Redirect to HTTPS      | Vite-hashed bundles — 1y immutable.                           |
| `/favicon*`          | S3            | `CachingOptimized` | `CORS-S3Origin`             | Redirect to HTTPS      |                                                               |
| `/og-image*`         | S3            | `CachingOptimized` | `CORS-S3Origin`             | Redirect to HTTPS      |                                                               |
| `/apple-touch-icon*` | S3            | `CachingOptimized` | `CORS-S3Origin`             | Redirect to HTTPS      |                                                               |
| `/robots.txt`        | S3            | `CachingDisabled`  | `CORS-S3Origin`             | Redirect to HTTPS      |                                                               |
| `/sitemap.xml`       | S3            | `CachingDisabled`  | `CORS-S3Origin`             | Redirect to HTTPS      |                                                               |
| `/privacy*`          | S3            | `CachingDisabled`  | `CORS-S3Origin`             | Redirect to HTTPS      | Keep the viewer-request rewrite (`/privacy → /privacy.html`). |
| `/imprint*`          | S3            | `CachingDisabled`  | `CORS-S3Origin`             | Redirect to HTTPS      | Ditto.                                                        |
| `/quote*`            | **Lightsail** | `CachingDisabled`  | `AllViewerExceptHostHeader` | Redirect to HTTPS      | SSR-rendered form.                                            |
| `/api/*`             | **Lightsail** | `CachingDisabled`  | `AllViewer`                 | Redirect to HTTPS      | Forward all headers/cookies/query.                            |
| `/admin*`            | **Lightsail** | `CachingDisabled`  | `AllViewer`                 | Redirect to HTTPS      | Forward cookies for session.                                  |
| `*` (default)        | S3            | `CachingOptimized` | `CORS-S3Origin`             | Redirect to HTTPS      | Catch-all; prerendered home + favicons fall through here.     |

Managed policy names match the AWS-managed set as of 2026 — use the console's
managed-policy picker (don't hand-type IDs).

## Lightsail origin — origin settings

When you add the Lightsail origin:

- **Origin domain:** `<static-ip>` (the Lightsail static IP) — CloudFront
  accepts a bare IP as a custom origin.
- **Protocol:** HTTP only (the Lightsail box has no TLS termination at v1).
- **HTTP port:** `80` if you put nginx in front; `3000` if Node is bound to
  `0.0.0.0:3000` directly.
- **Origin shield:** off (low traffic, no need).
- **Origin connection attempts:** 3, timeout 10s, response timeout 30s
  (defaults are fine).
- **Custom headers** — **THIS IS LOAD-BEARING**:
  - Header name: `X-CloudFront-Secret`
  - Value: the same `openssl rand -hex 32` value you put into
    `/etc/aberp-site.env` as `CLOUDFRONT_SHARED_SECRET`.
  - `src/hooks.server.ts` rejects any request to `/api/*` or `/admin/*`
    without this header → no direct hit on the Lightsail box from the
    public internet succeeds, even though it's IP-reachable.

This pattern is preferred over a CloudFront IP-prefix-list allowlist on the
Lightsail console firewall because (a) Lightsail's network firewall doesn't
support prefix lists, and (b) the CloudFront IP ranges change monthly. The
shared secret is per-distribution forever.

## S3 origin — origin settings

- **Origin domain:** `<bucket>.s3.eu-central-1.amazonaws.com` (the regional
  REST endpoint, **not** the legacy website endpoint).
- **Origin access:** Origin Access Control (OAC). Create a new OAC if needed;
  signing behaviour "Sign requests (recommended)"; origin type S3.
- After save, CloudFront shows a bucket-policy snippet to paste into the S3
  bucket policy. Paste it.

## Viewer-request CloudFront Function

Carry over the function from Phase 1 that rewrites `/privacy` → `/privacy.html`
and `/imprint` → `/imprint.html`. Update it to NOT rewrite `/quote*`,
`/api/*`, `/admin*` (just leave those URIs alone — the dynamic origin handles
them as-is).

```js
function handler(event) {
	var req = event.request;
	var uri = req.uri;

	// Only rewrite the prerendered "extensionless" pages.
	if (uri === '/privacy' || uri === '/privacy/') {
		req.uri = '/privacy.html';
		return req;
	}
	if (uri === '/imprint' || uri === '/imprint/') {
		req.uri = '/imprint.html';
		return req;
	}
	// Default: pass through unchanged. /_app/*, /quote*, /api/*, /admin* all
	// pass through here without modification.
	return req;
}
```

Attach to the **default** behaviour (`*`) only — not to the
`/privacy*` / `/imprint*` overrides, since those will hit the rewritten URI
on the next pass anyway.

## Distribution-level settings

- **Price class:** PriceClass_100 (NA + EU only) — EU-first audience.
- **Alternate domain names:** `friboard.com`, `www.friboard.com`.
- **SSL certificate:** the ACM cert (us-east-1) for both names.
- **Security policy:** TLSv1.2_2021.
- **HTTP versions:** HTTP/2 + HTTP/3.
- **IPv6:** on.
- **Standard logging:** optional. If on, 30-day lifecycle on the log bucket
  (per `docs/privacy.md`).

## Quick smoke tests after configuration

```sh
# Static — should hit S3, cacheable.
curl -sIo /dev/null -w '%{http_code} %{header_age}\n' https://friboard.com/
curl -sIo /dev/null -w '%{http_code} %{header_age}\n' https://friboard.com/privacy
curl -sIo /dev/null -w '%{http_code}\n' https://friboard.com/favicon.svg

# Dynamic — should hit Lightsail.
curl -sIo /dev/null -w '%{http_code}\n' https://friboard.com/quote

# /api/quote (public POST) — should succeed without auth.
curl -sIo /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"email":"smoke@example.com"}' \
  https://friboard.com/api/quote -w '%{http_code}\n'
# Expect 400-ish (validation error) — proves it reached the Node server.

# /api/quotes (operator GET) — should 401 without bearer.
curl -sIo /dev/null https://friboard.com/api/quotes -w '%{http_code}\n'
# Expect 401.

# /api/quotes with admin bearer — should 200.
curl -sIo /dev/null \
  -H "Authorization: Bearer $ABERP_SITE_ADMIN_TOKEN" \
  https://friboard.com/api/quotes -w '%{http_code}\n'
```

If `/quote` returns 403 with body `forbidden: missing origin signature`, the
shared-secret header didn't make it through — re-check the CloudFront origin's
custom-headers config and that `/etc/aberp-site.env` on the Lightsail box has
the same `CLOUDFRONT_SHARED_SECRET` value (and you restarted the service).
