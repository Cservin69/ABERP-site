# ADR 0001 — CloudFront `/api/*` error pass-through

**Status:** Accepted (2026-06-05, S254 / PR-T).
**Walkthrough:** [`docs/walkthroughs/cloudfront-api-passthrough.md`](../walkthroughs/cloudfront-api-passthrough.md).

## Context

CloudFront's **CustomErrorResponses** are configured at the **distribution**
level, not at the cache-behavior level. When a distribution maps (say)
`403 → /index.html`, every origin behind that distribution — S3 _and_
Lightsail — has its 403 responses substituted for the contents of
`/index.html`.

The abenerp.com distribution carries two origins:

- **S3** (`abenerp-com-www`) — serves the static surface and prerendered HTML.
  4xx errors from S3 are XML by default; substituting them for a friendly
  HTML page is a UX win.
- **Lightsail** — serves `/quote*`, `/api/*`, `/admin*`. 4xx/5xx errors from
  `/api/*` are JSON-bodied (`{"error":"…"}`) by contract — every client of
  these endpoints uses `await res.json()` on the response.

S253 found the consequence: a legitimate `403` from `/api/quote` (origin
mismatch caught by the CSRF Origin allowlist) was swapped server-side by
CloudFront for the prerendered homepage HTML. The browser's `res.json()` call
threw `Unexpected token <`, the catch-block surfaced a generic
"Network error", and diagnosis took ~30 minutes for what should have been a
one-line server error in the browser console.

## Decision

**Stop using CloudFront's distribution-level CustomErrorResponses for any HTTP
status code that the API legitimately returns** (400, 401, 403, 500, 502,
503, 504). Keep `404 → /index.html` only — typo'd marketing URLs against the
S3 origin are the only error case where the substitution is a net win, and
genuine `/api/*` 404s (e.g. an unknown quote ID) are rare enough that
losing the JSON body for them is acceptable until the next round of work.

The fix is purely a CloudFront Console config change, applied by the operator
per the walkthrough. No code in this repo changes.

## Alternatives considered

### A. Per-behavior CustomErrorResponses for `/api/*`

The brief that scoped this work proposed this approach. **Not possible** —
CloudFront does not expose `CustomErrorResponses` on `CacheBehavior` in
either the Console or the API. There is no way to scope an error-page
substitution to one path pattern.

### B. Lambda@Edge `origin-response` interceptor

Attach a Lambda@Edge function on the `/api/*` behavior's `origin-response`
event that detects the substituted response and replaces it with the real
origin payload. Technically works, but:

- Adds a Lambda invocation to every `/api/*` response (latency tax, cost,
  cold-start risk).
- Requires deploying Lambda code from `us-east-1`, breaking the IaC-free
  AWS Console-only operating model (per `docs/deploy.md` opening note).
- Adds a moving part that future operators must understand and maintain.

Rejected — the trade is bad against simply removing the offending
substitution config.

### C. CloudFront Function on `viewer-response`

Wanted to use this; ruled out after checking the order of operations.
`viewer-response` fires **after** custom-error substitution. By the time the
function runs, the original origin body has already been discarded and
replaced. The function cannot undo the substitution.

### D. Rename the Node server's error codes

Make `/api/*` return non-standard codes (e.g. `422` instead of `403`) so
CloudFront's substitution rules don't match. **Rejected** — couples HTTP
semantics to a quirk of edge config and breaks legitimate clients that
inspect status codes.

### E. Suppress the body on the origin side

Have the Node server return 4xx/5xx with a content-length of 0 and rely on
CloudFront's substitution to provide a body. **Rejected** — kills the
machine-readable error contract that browser clients depend on.

## Consequences

### Positive

- `/api/*` errors are now passed through with their original JSON body —
  browser clients see the structured error and can surface it to the user.
- Operator diagnosis time on the next "form is broken" report drops from
  ~30 min (S253) to ~30 sec — the JSON error appears directly in DevTools.
- No new infrastructure, no new code, no new env vars, no Lambda@Edge.

### Negative

- `4xx`/`5xx` errors against `/quote` (the SSR-rendered HTML form, not
  the API) now also lose their friendly-page substitution. SvelteKit's
  built-in error page handles this acceptably (a small server-side-rendered
  error page), but it is less branded than `/index.html` would have been.
  If this becomes user-visible, ship a SvelteKit `+error.svelte` route as
  the proper fix.
- `S3 → 404` is the only remaining substitution. The next operator who
  thinks "I should add 403 here for the bucket-access-denied case" needs to
  know not to — the walkthrough's pushback section and a one-line warning in
  `docs/aws/cloudfront-behaviors.md` (follow-up doc PR) call this out.

### Neutral

- The CloudFront distribution remains Console-managed. No IaC introduced
  by this ADR.

## Validation

The change is verified by two `curl` smoke tests from the walkthrough:

```sh
# /api/* returns JSON 403 (not HTML homepage)
curl -sS -X POST https://abenerp.com/api/quote \
  -H 'Origin: https://evil.example' \
  -H 'Content-Type: application/json' \
  -d '{}' \
  -i
# expect: HTTP/2 403, content-type: application/json

# Non-API 404 still gets friendly homepage HTML
curl -sIo /dev/null -w '%{http_code} %{content_type}\n' \
  https://abenerp.com/this-page-does-not-exist
# expect: 404 text/html
```

Plus a browser-level re-run of the S253 failure: submit the quote form with
invalid input and confirm the server error renders in the form rather than
the generic "Network error."

## References

- S253 session transcript — original discovery.
- [`docs/walkthroughs/cloudfront-api-passthrough.md`](../walkthroughs/cloudfront-api-passthrough.md)
  — operator-facing recipe.
- [`docs/aws/cloudfront-behaviors.md`](../aws/cloudfront-behaviors.md) —
  authoritative behavior table.
- AWS CloudFront docs: _Generating custom error responses_ — confirms
  `CustomErrorResponses` is distribution-scoped only.
