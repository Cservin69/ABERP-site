# Privacy policy — friboard.com (Phase 1)

**Last reviewed:** 2026-05-31

## Summary

**This site sets no cookies. No personal data is collected by the website itself.**

The only contact path on friboard.com is a `mailto:` link. Clicking it opens your email client — the email is sent from your provider to ours, without traversing friboard.com infrastructure.

## What data is processed

- **Page views.** Standard HTTP request metadata (IP address, user-agent, referrer, requested URL, timestamp) is briefly visible to our CDN (Amazon CloudFront) to deliver the page. If CloudFront access logs are enabled, this metadata is retained for up to 30 days for security and debugging purposes. It is not used for analytics, profiling, or marketing.
- **Email contact.** When you email `hello@friboard.com`, the contents and your email address are processed by Ervin's email provider under that provider's privacy policy. We use this data only to respond to your inquiry. Retention is determined by Ervin and the email provider; assume up to 24 months unless you request earlier deletion.

## Quote requests (Phase 2)

If you submit a quote request via the `/quote` form, the following data is processed:

- **Form fields you provide.** Your name, email address, optional company name, optional material preference, optional quantity, optional needed-by date, and optional notes.
- **CAD files you upload.** The files themselves and their original filenames, sizes, and the timestamp of submission. CAD files are treated as customer intellectual property and are not shared outside of Friboard's quoting workflow.
- **Consent timestamp.** The time at which you confirmed the consent checkbox.

**Purpose.** This data is used solely to respond to your quote request — reviewing the CAD, estimating cost and lead time, and replying to the email address you provided.

**Where it lives.** During Phase 2 the data is stored on the Friboard operator's instance (the host serving `friboard.com`). It is not yet ingested into the ABERP order-management system. The 2.0 cutover (planned) will move processed quote data into ABERP under a separate processing record.

**Retention.** Retention is determined by the operator. Submitted quote data is kept at least until a quote is delivered and a reasonable response window has elapsed; specific retention rules are pending and will be documented here when finalised.

**Lawful basis (GDPR Art. 6).** Performance of pre-contractual steps at the data subject's request (Art. 6(1)(b)).

**Your rights.** All GDPR rights listed below apply. To exercise any of them in respect of a quote request, email `hello@friboard.com` and quote your quote reference ID (shown on screen after submission and included in any reply we send).

**Security caveats (Phase 2).** CAD files are stored on the operator instance without at-rest encryption beyond the underlying disk encryption of the host. No third-party processors receive your quote data during Phase 2. This will be tightened in Phase 3 and again at the 2.0 cutover.

## What data is NOT processed

- No cookies, local storage, or session storage are set.
- No third-party analytics, advertising, or tag-management scripts are loaded.
- No fingerprinting, cross-site tracking, or behavioural profiling.
- No newsletter, account system, or persistent identifier of any kind.

## Lawful basis (GDPR Art. 6)

- **Server logs:** legitimate interest (security, debugging, fraud prevention) per Art. 6(1)(f).
- **Email correspondence:** performance of pre-contractual steps or legitimate interest per Art. 6(1)(b)/(f), depending on the nature of your inquiry.

## Your rights under GDPR

You have the following rights regarding any personal data we process. To exercise any of them, email `hello@friboard.com` and we will respond within 30 days.

- **Right of access (Art. 15).** You may request a copy of the personal data we hold about you, the purposes for which it is processed, and the categories of recipients (Subject Access Request — SAR).
- **Right to rectification (Art. 16).** You may ask us to correct inaccurate or incomplete data.
- **Right to erasure (Art. 17, "right to be forgotten").** You may ask us to delete your personal data, subject to legal retention requirements (e.g. tax law) where applicable.
- **Right to restriction of processing (Art. 18).** You may ask us to stop processing your data while a dispute is resolved.
- **Right to data portability (Art. 20).** Where processing is automated and based on consent or contract, you may receive your data in a machine-readable format.
- **Right to object (Art. 21).** You may object to processing based on legitimate interests, including any future direct-marketing use.

You also have the right to lodge a complaint with a supervisory authority — in Hungary, the Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH).

## Data Controller

Áben Consulting Kft.
Tax ID: HU24904362-2-41
1037 Budapest, Visszatérő köz 6, Hungary
Email: `hello@friboard.com`

_Placeholder pending Ervin's confirmation that Áben Consulting Kft. is the correct controlling entity for Friboard, vs. a separate Friboard-named entity._

## Changes to this policy

We will update the "Last reviewed" date above and re-publish the page when the policy changes. For material changes affecting your rights, we will note the substance of the change at the top of the page for at least 30 days.
