# Analytics — Phase 1 decision

**Decision:** No analytics on friboard.com in Phase 1.

## Rationale

- **GDPR-by-design.** With no cookies, no fingerprinting, and no third-party scripts, the site has no `consent banner` requirement under ePrivacy/GDPR. This is the lowest legal-surface-area posture available.
- **Phase 1 is a single landing page.** There is no conversion funnel to instrument — the only outbound action is a `mailto:` click. Even if we measured CTR, the n is too small to be actionable.
- **Engineering cost.** Adding analytics later is cheap (one `<script>` tag plus a `vercel-ignore`-style block in `robots.txt`); removing it later (especially GA4) is messier. Default to less.

## Re-evaluation triggers

Revisit this decision when **any** of the following becomes true:

- **(a)** Phase 2 quote-form ships and we need conversion-funnel data (CAD upload → quote view → quote accepted).
- **(b)** Ervin requests traffic numbers to make business decisions (pricing, geographic targeting, etc.).
- **(c)** Paid ad/marketing spend justifies attribution tracking (UTM parameters, conversion pixels).

## If/when we add analytics

Preferred order, EU-first:

1. **Plausible (self-hosted, EU region)** — no cookies, GDPR-compliant by default, lightweight (~1KB script). First choice.
2. **Umami (self-hosted)** — similar properties to Plausible, lower-touch UI.
3. **GA4** — only if a marketing partner requires it. Requires Google Consent Mode v2 setup and likely a cookie banner — costs disproportionate to value for a single landing page.

Avoid: Mixpanel, Amplitude, Hotjar, Segment — heavyweight, cookie-based, EU-hostile defaults.

## What is NOT analytics

**CloudFront access logs** are server-side request logs, not analytics. They record `(timestamp, IP, URL, status, user-agent)` per request. If Ervin enables them on the CloudFront distribution, they:

- Land in S3, not a third-party platform.
- Count as a legitimate-interest log retention under GDPR (not consent-required), provided retention is bounded (suggest 30 days).
- Do not require disclosure beyond the privacy policy line "we retain server logs for security and debugging."

If Ervin needs basic traffic counts without committing to an analytics platform, CloudFront logs + a one-off `awk` over them is sufficient.
