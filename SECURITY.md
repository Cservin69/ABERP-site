# Reporting a security issue

Please don't open a public GitHub issue for anything you believe is a security
vulnerability. Email the report instead:

- **hello@friboard.com** — primary

Include enough detail to reproduce: URL, request headers, body, the observed
response, and what you'd have expected. A proof-of-concept (curl command,
screenshot, brief write-up) speeds triage a lot.

## What we treat as in-scope

- Anything on **friboard.com** (the live site, including the `/quote` flow,
  the `/api/*` endpoints, the `/admin/*` operator UI).
- Source code in this repo.

## Out of scope

- Volumetric / network-layer denial of service.
- Findings whose only impact is on the reporter's own browser / device
  (e.g. WebGL resource exhaustion on the reporter's GPU).
- Reports generated solely by automated scanners with no manually-confirmed
  exploit.

## Response

Acknowledgement within a few business days. We're a small team — no formal
SLA — but we'll keep you in the loop on triage, fix, and disclosure.
Responsible disclosure timelines are negotiable; the default is "after the
fix is deployed."
