# Walkthrough — flip the CloudFront `404 → /index.html` response code back to 404

**Goal:** stop CloudFront from rewriting a genuine `404` from `/api/*` into a
`200 text/html` SPA-shell response. The `404 → /index.html` CustomErrorResponse
row is fine to keep (it gives typo'd marketing URLs a friendly homepage), but
its **Response code must be `404`, not `200`**. A row set to "Response code 200"
masks every real `/api/*` 404 as a success, which downstream consumers then
misread.

**Why this matters (S356):** when the storefront 404'd a priced-quote lookup
(`GET /api/quotes/{id}/priced`, e.g. the quote dir was wiped on redeploy — see
`docs/walkthroughs/deploy-storefront.md`), CloudFront returned `200` + the SPA
shell HTML. ABERP's writeback/poll classifier saw `200 text/html`, could not
parse it as JSON, and labelled it `RoutingMisconfigured` ("CloudFront route
missing") — sending the operator to the wrong panel. The real fault was a
storefront 404 the CDN had hidden.

**Relationship to the other CloudFront docs:**

- `docs/walkthroughs/cloudfront-api-passthrough.md` removes the `4xx/5xx →
/index.html` rows that mask API errors, and **keeps** `404 → /index.html`.
  That walkthrough assumes the kept `404` row has Response code `404`. **This
  doc covers the case where that row was set to Response code `200`** — flip it
  back.
- ADR: `docs/adr/0001-cloudfront-api-passthrough.md`.

**Reversibility:** trivial — the Response code is a single dropdown; re-edit to
revert. No data is touched.

**Time:** ~2 min hands-on + ~5 min CloudFront propagation.

> Doc-only: this walkthrough makes **no** AWS API call from any automated
> session. An operator performs the steps in the AWS Console.

---

## Step 1 — [AWS Console] Open the distribution's Error pages tab

1. AWS Console → **CloudFront** (global; region selector irrelevant).
2. Left nav → **Distributions** → click the row whose **Alternate domain names**
   contains `abenerp.com` (or paste `ABERP_SITE_CF_DIST` into the search box;
   see `docs/aws/operator-checklist.md` Step 4).
3. Click the **Error pages** tab.

## Step 2 — [AWS Console] Locate the masking row

Find the row with:

- **HTTP Error Code** = `404`
- **Response Page Path** = `/index.html`
- **HTTP Response Code** = `200` ← **this is the bug**

If the **HTTP Response Code** already reads `404`, **stop** — this distribution
is not masking 404s and S356's symptom came from elsewhere (re-check the
`/api/*` behavior origin per `cloudfront-api-passthrough.md` Step 4).

## Step 3 — [AWS Console] Edit the row → Response code 404

1. Select the row → **Edit**.
2. Ensure **Customize error response** = **Yes**.
3. **Response page path:** `/index.html` (unchanged).
4. **HTTP Response code:** change `200` → **`404`**.
5. **Save changes**.

## Step 4 — [AWS Console] Wait for Deployed

The distribution status (General tab) reads **Deploying** for ~5 min. Wait for
**Deployed** before smoke-testing.

## Step 5 — [Mac terminal] Smoke-test that `/api/*` 404s surface as 404

```sh
curl -sIo /dev/null -w '%{http_code} %{content_type}\n' \
  https://abenerp.com/api/quotes/definitely-not-a-real-id/priced \
  -H 'Authorization: Bearer <admin-token>'
```

**Expected:** `404 application/json` (the storefront's structured Not-found),
**not** `200 text/html`.

Sanity-check a typo'd marketing URL still gets the friendly homepage — now with
a true 404 status:

```sh
curl -sIo /dev/null -w '%{http_code} %{content_type}\n' \
  https://abenerp.com/this-page-does-not-exist
```

**Expected:** `404 text/html; charset=utf-8` (homepage HTML body, 404 status).

---

## After the flip

Once the masking is gone, ABERP's classifier sees the real `404` and routes it
through the non-routing branches (`AppRejected` / `NonJsonResponse`) instead of
`RoutingMisconfigured`. The S368 rewording of the `RoutingMisconfigured`
operator hint (it now names _both_ the CDN-route-missing and the
404-masked-as-200 causes) stays in place as a safety net for any distribution
that regresses this setting.
