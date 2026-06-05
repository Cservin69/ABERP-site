# Walkthrough — CloudFront `/api/*` error pass-through

**Goal:** stop CloudFront from replacing 4xx/5xx responses from `/api/*` with
the prerendered homepage HTML. Browser clients calling `await res.json()` on a
`/api/*` failure currently choke on HTML and surface a generic "Network error"
instead of the structured server error.

**Discovered:** S253 — a 403 from `/api/quote` was masked as a homepage HTML
response. Diagnosis took ~30 min because the failure mode looked like a
client-side bug, not an origin error.

**Time on the day:** ~10 min hands-on in AWS Console + 5–15 min CloudFront
propagation + 2 min smoke tests.

**Reversibility:** trivial — every removed entry can be re-added from the same
Error Pages tab.

---

## Important pushback before you start

The brief that scoped this work proposed creating (or editing) a path-pattern
behavior for `/api/*` with **"Custom Error Pages disabled for that behavior"**.
This is **not expressible** in CloudFront's data model:

- `CustomErrorResponses` lives on the **distribution**, not on the cache
  behavior. There is no per-behavior toggle in either the Console or the API.
- Once a code is configured (e.g. `403 → /index.html`), the substitution fires
  for **every** origin that returns that code — including Lightsail's
  `/api/*` JSON responses.

The correct, simplest fix is therefore at the **distribution level**: remove
the custom error response entries for HTTP codes that the API legitimately
returns (400, 401, 403, 500, 502, 503, 504). Keep `404 → /index.html` only if
S3 misses (typo'd marketing URLs) are still a concern.

A Lambda@Edge origin-response interceptor _could_ keep the global substitution
and skip it for `/api/*`, but it adds a Lambda invocation to every CloudFront
response and is overkill here. Rejected.

If the deployed distribution turns out to have **only** `404 → /index.html`
configured (matching what `docs/deploy.md` says), then the S253 substitution
came from somewhere else and this walkthrough's diagnosis is wrong — stop and
re-investigate before changing anything.

---

## Step 1 — [Mac terminal] Find the distribution ID

You almost certainly have it in `~/.aws-aberp-env` or as
`ABERP_SITE_CF_DIST` in your GitHub repo Variables (see
`docs/aws/operator-checklist.md` Step 4). If not, list it:

```sh
aws cloudfront list-distributions \
  --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, 'abenerp.com')].{Id:Id,Aliases:Aliases.Items,Domain:DomainName}" \
  --output table
```

Note the `Id` (looks like `E1A2B3C4D5E6F7`). You will not need the CLI again
unless Step 4's Console UI gives you trouble.

---

## Step 2 — [AWS Console] Open the distribution

1. AWS Console → **CloudFront** (region selector irrelevant; CloudFront is
   global).
2. Left nav: **Distributions**.
3. Click the row whose **Alternate domain names** column contains
   `abenerp.com`. (Or paste the ID from Step 1 into the search box.)

You should land on the distribution overview page with tabs:
**General | Origins | Behaviors | Error pages | Geographic restrictions |
Invalidations | Tags**.

---

## Step 3 — [AWS Console] Open the Error pages tab and inventory

1. Click the **Error pages** tab.
2. Note **every row** in the table. Each row is one
   `(HTTP error code, Error caching minimum TTL, Customize error response,
Response page path, HTTP response code)` tuple.
3. Copy them into a scratch note or screenshot — you will need this to confirm
   what changed, and so you can put any back if needed.

**Expected state (per `docs/deploy.md`):** one row only —
`404 → /index.html` with response code `404` and TTL `0`.

**Likely actual state (what S253 implies):** more rows than that — probably
`400`, `403`, `500`, `502`, `503`, `504` also pointing at `/index.html`.

If the table contains **only** the `404` entry, **stop**: the homepage
substitution on `/api/quote` 403 came from somewhere else, and this
walkthrough's premise is wrong. Most likely culprit in that case: the
`/api/*` behavior's **origin** is misconfigured and the request is hitting S3
(which serves `/index.html` for unmatched paths). Re-check Step 4 below
without removing anything.

---

## Step 4 — [AWS Console] Sanity-check that `/api/*` actually points at Lightsail

1. Click the **Behaviors** tab.
2. Find the row whose **Path pattern** is `/api/*`.
3. Confirm **Origin** is the Lightsail origin (the one whose origin domain is
   your Lightsail static IP), **not** the S3 origin.
4. Confirm **Cache policy** is `CachingDisabled` and **Origin request policy**
   is `AllViewer`.

If the row is missing, or the origin is S3, that is the actual bug — fix that
first per `docs/aws/cloudfront-behaviors.md` and then re-test before touching
Error pages. The error-page substitution work below is unnecessary in that
case.

---

## Step 5 — [AWS Console] Remove the 4xx/5xx entries that mask API errors

For **each** row in the Error pages table whose **HTTP error code** is one
of `400`, `401`, `403`, `500`, `502`, `503`, `504`:

1. Select the row's checkbox.
2. Click **Delete** (top right of the table).
3. Confirm in the modal.

Do this one code at a time so the audit trail in your scratch note from Step 3
matches what you removed.

**Keep the `404 → /index.html` row.** A typo'd marketing URL (e.g. someone
links `abenerp.com/imprintt`) still benefits from being routed back to the
homepage instead of returning S3's raw XML error. The `404` substitution
applies to `/api/*` too, but the Node server explicitly returns `404` only
for genuine resource-not-found (e.g. `GET /api/quotes/<unknown-id>`); those
should be rare enough that customer-facing impact is nil, and the Node side
can be tightened in a follow-up if needed.

---

## Step 6 — [AWS Console] Save and wait for propagation

CloudFront writes the change immediately when you delete each row — there is
no separate "Save" button on the Error pages tab. The distribution's
**Last modified** timestamp on the General tab updates per delete.

Propagation to all edges takes **5–15 minutes**. The distribution status will
read **Deploying** during this window (top of the General tab); wait for
**Deployed** before smoke-testing.

---

## Step 7 — [Mac terminal] Smoke test: `/api/*` returns structured JSON

Once status is **Deployed**, run a request that the Origin allowlist will
reject (the easiest reproducible 403):

```sh
curl -sS -X POST https://abenerp.com/api/quote \
  -H 'Origin: https://evil.example' \
  -H 'Content-Type: application/json' \
  -d '{}' \
  -i
```

**Expected** — HTTP `403` headers + a small JSON body:

```
HTTP/2 403
content-type: application/json; charset=utf-8
…

{"error":"forbidden"}
```

**Failure mode if Step 5 was incomplete** — HTTP `403` with
`content-type: text/html` and a multi-KB body starting with `<!doctype html>`.
If you see that, return to Step 3 and re-check the Error pages table; you
probably missed a `403` row.

---

## Step 8 — [Mac terminal] Sanity-check non-API still gets the friendly 404

```sh
curl -sIo /dev/null -w '%{http_code} %{content_type}\n' \
  https://abenerp.com/this-page-does-not-exist
```

**Expected** — `404 text/html; charset=utf-8`. The body is the homepage HTML
(per the kept `404 → /index.html` rule), which is the desired UX for
typo'd marketing URLs.

If you instead see `403 application/xml`, the S3 bucket policy or the
distribution's default behavior is misconfigured — that is a separate problem
and not introduced by this walkthrough.

---

## Step 9 — [Mac terminal] Verify the original S253 reproducer is gone

The S253 path was a real form submission failing. To confirm end-to-end:

1. Open `https://abenerp.com/quote` in a browser.
2. Open DevTools → Network.
3. Fill the form and submit with deliberately bad data (e.g. invalid email
   format that the server rejects).
4. The failing `/api/quote` request in the Network tab should show
   `Response → JSON` (not HTML), and the form should render the server's
   specific error message rather than the generic "Network error."

---

## Update the docs after the change

Mark `docs/deploy.md` step 3 ("Custom error responses") and
`docs/aws/cloudfront-behaviors.md` to reflect the new minimal config. A
follow-up PR (not part of this session) should:

- Reword the "Custom error responses" block in `docs/deploy.md` to explicitly
  call out that **4xx codes from `/api/*` must pass through**.
- Add a one-line warning in `docs/aws/cloudfront-behaviors.md` to never
  re-introduce `400/401/403/500/502/503/504 → /index.html` distribution-wide.

ADR: `docs/adr/0001-cloudfront-api-passthrough.md`.
