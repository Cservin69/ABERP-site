# ADR 0008 — Storefront ↔ ABERP network topology in prod

**Status:** **Superseded** by [ADR-0009](0009-storefront-as-queue-no-tunnel.md) (2026-06-09, S305). Originally Accepted — **Option B (Cloudflare Tunnel)** — 2026-06-08, Ervin's approval, recorded S301; proposed earlier the same day (S299).
**Superseded by:** [ADR-0009](0009-storefront-as-queue-no-tunnel.md) — Cloudflare Tunnel was the operator-time-cheapest path to close the storefront → ABERP connectivity gap, but it introduces a vendor in the customer-data + email path that Ervin's threat model rejected the morning after this ADR was Accepted ("I am paranoid about security but that means I do not trust cloudflare neither"). ADR-0009 picks the [Option D](#option-d--storefront-as-queue-aberp-polls-no-inbound-to-aberp-at-all) fallback documented in this ADR — storefront-as-queue, ABERP polls outbound only — as the actual implementation. **No `cloudflared` daemon was ever brought up against prod**; the runbook at `docs/runbooks/cloudflare-tunnel-aberp.md` will be removed in a follow-up session.
**Related:** [ADR-0004](0004-priced-quote-writeback.md) (priced-quote writeback path), [ADR-0007](0007-storefront-email-relay-via-aberp.md) (email relay path, also superseded by ADR-0009).
**Walkthrough flag:** [`docs/walkthroughs/end-to-end-auto-quote-test.md`](../walkthroughs/end-to-end-auto-quote-test.md) §"What's NOT in this walkthrough" OQ #3 — closed by [ADR-0009](0009-storefront-as-queue-no-tunnel.md) instead.
**Runbook:** [`docs/runbooks/cloudflare-tunnel-aberp.md`](../runbooks/cloudflare-tunnel-aberp.md) — superseded; do not execute. Pending deletion.

## Decision recorded

Ervin approved the S299 recommendation on the night of 2026-06-08: "I always take your recommendation so Option B, no ask you can continue." The remaining four open questions collapse to operator-time configuration choices (Cloudflare account ownership) and one backlog item (`transit_path` audit field) — see [Open questions](#open-questions-resolved-and-residual) below. The bring-up procedure lives in [`docs/runbooks/cloudflare-tunnel-aberp.md`](../runbooks/cloudflare-tunnel-aberp.md). Until that runbook is executed and Lightsail's `ABERP_INTERNAL_BASE_URL` is set, the auto-quote pipeline remains architecturally LIVE but prod-blocked exactly as documented in the S284 walkthrough.

## Context

The auto-quote pipeline shipped in S276–S284 has three cross-stack call legs:

1. **Storefront → ABERP, priced-quote writeback** ([ADR-0004](0004-priced-quote-writeback.md)) — POST from storefront to ABERP.
2. **Storefront → ABERP, customer email relay** ([ADR-0007](0007-storefront-email-relay-via-aberp.md)) — POST from storefront to ABERP.
3. **ABERP → storefront, pending-quote pull** — GET from ABERP to storefront (already works; storefront is public via CloudFront).

Today's deployment:

- **Storefront** runs on AWS Lightsail (Ubuntu), public via CloudFront at `abenerp.com`. Outbound HTTPS works; inbound HTTPS works; outbound SMTP works (the bit ADR-0007 is consolidating away from).
- **ABERP** runs on Ervin's MacBook as a Tauri-hosted service, binds to `127.0.0.1:<dynamic-port>`. Reachable only via loopback. No public IP, no DNS name, no inbound TLS terminus.

The forward leg — storefront → ABERP — is the gap. Both writebacks (priced and email-relay) need a stable URL the Lightsail process can resolve and reach. Today's `ABERP_INTERNAL_BASE_URL` is unspecified in prod; in local-dev it's `http://127.0.0.1:8080` and that obviously doesn't work from Lightsail.

The [S284 walkthrough](../walkthroughs/end-to-end-auto-quote-test.md) explicitly flagged this as out of scope for the doc and named it OQ #3: "Before the first real customer's quote, this topology needs a decision: public TLS terminus on ABERP (with proper bearer hardening), Cloudflare Tunnel, Tailscale, or the queue-and-let-ABERP-poll fallback ADR-0007 §Reconciliation with ADR-0006 sketched."

This ADR is the decision document for that flag. The pipeline is **architecturally LIVE** today (S287 / 514d0c9) — every code path is wired and tested in local-dev — but cannot run end-to-end in prod until one of the four options below is picked and stood up.

### Constraints worth naming

- **Single-operator, single-MacBook today.** Not a fleet. Not multi-tenant. Eventual SaaS migration is documented as `[[aberp-saas-migration]]` (Phase A–G, multi-PR effort, not scheduled). The topology pick should not preclude that migration but does not need to anticipate it either.
- **Sender reputation already consolidated through ABERP** (ADR-0007). Splitting it back across two endpoints is a regression.
- **Polling cadence on the ABERP-side pull is currently ~60 s.** That's the implicit latency floor of anything resembling option D below.
- **No human-in-the-loop on quote pricing.** The priced writeback is auto-triggered as soon as ABERP finishes pricing. Latency on the writeback delays the customer's "your quote is ready" email by the same amount.
- **Ervin trusts code, not operator** (`[[trust-code-not-operator]]`). A topology that requires Ervin to remember to keep his MacBook awake / on the right Wi-Fi / port-forward enabled is the wrong shape.

## Decision

**Picked: Option B (Cloudflare Tunnel).** Justification under [Recommendation](#recommendation-and-pushback). Approved by Ervin 2026-06-08 (see [Decision recorded](#decision-recorded) above). The other three options remain documented below in [Options considered](#options-considered) so the trade space is on the record and the fallback shapes (especially D) are referenceable if a future audit reopens this.

Whatever option lands, the wire surface from the storefront's perspective is unchanged: the storefront calls `${ABERP_INTERNAL_BASE_URL}/api/...` and the existing bearer-token auth (per ADR-0004 / ADR-0007) gates the call. The four options differ only in **how `ABERP_INTERNAL_BASE_URL` resolves to ABERP's listener** and **what (if anything) terminates TLS in between**.

## Options considered

### Option A — Public TLS endpoint on ABERP

**Shape.** Open Ervin's home router to inbound HTTPS via DDNS + port-forward. ABERP terminates TLS itself (Let's Encrypt via `acme.sh` or similar, manually rotated). `ABERP_INTERNAL_BASE_URL=https://aberp-mac.<ddns-provider>.tld`.

**Pros.**

- No third-party dependency.
- Simplest mental model: "ABERP has a URL, storefront calls it."
- TLS terminus is on the same machine that holds the data — no third party can see plaintext relay traffic.

**Cons.**

- **Residential IP exposure.** The MacBook becomes a target. Any unauthenticated request hits the listener directly; bearer auth is the only defense.
- **IP rotation risk.** DDNS handles most ISP IP changes but mid-flight requests fail during the window.
- **TLS cert lifecycle on a desktop.** Let's Encrypt's 90-day rotation must run on a machine that may be asleep / closed lid / on the wrong network. Operator-discipline territory — violates `[[trust-code-not-operator]]`.
- **MacBook sleep = pipeline outage.** When the lid closes, the listener stops. Customer quote emails stop. No "queued" semantics because the writeback POST itself fails at TCP layer.
- **Home-router blast radius.** Port-forward rules on a consumer router are a security-audit nightmare; misconfiguration can expose more than intended (UPnP, NAT loopback quirks, etc.).

**Security posture: weak.** Residential IP + desktop endpoint + operator-managed TLS = three independent failure modes. Acceptable only as a stopgap if Cloudflare and Tailscale are both somehow rejected.

### Option B — Cloudflare Tunnel (`cloudflared`)

**Shape.** Install `cloudflared` daemon on Ervin's MacBook. The daemon opens a long-lived **outbound** TLS connection to Cloudflare's edge. Cloudflare proxies inbound requests for `aberp.abenerp.com` (or chosen subdomain) through the tunnel to ABERP's loopback listener. `ABERP_INTERNAL_BASE_URL=https://aberp.abenerp.com`.

**Pros.**

- **No inbound port-forward.** The MacBook never accepts a public socket. Outbound-only is a strictly weaker exposure than inbound-listening.
- **Stable URL.** `aberp.abenerp.com` resolves the same forever; storefront env doesn't change if Ervin's ISP rotates IPs or he moves laptops.
- **Solves the dynamic-port pain.** The local-dev brittleness documented in `[[local-dev-test-path-gaps]]` (where ABERP picks a fresh port on every boot) doesn't propagate to prod — the tunnel always points at whichever loopback port `cloudflared` is configured for, and Cloudflare's edge URL is stable above it.
- **Cloudflare-side DDoS shield.** Any abuse traffic burns Cloudflare bandwidth, not Ervin's home connection.
- **Zero Trust policy hooks.** Cloudflare Access can layer mTLS / service-token auth on top of the bearer token if a future audit demands it (defense in depth).
- **Free tier sufficient.** Cloudflare Tunnel is free for personal / small-business use; no billing tripwire.
- **TLS cert managed by Cloudflare.** No `acme.sh` cron on a desktop. Cert rotation is invisible.
- **Aligns with eventual SaaS migration** (`[[aberp-saas-migration]]`). When ABERP moves to a real long-lived host, repoint the tunnel target; storefront env is unchanged.

**Cons.**

- **Cloudflare uptime dependency.** Cloudflare outages take the relay down. Historical SLA is high; not zero. Mitigated by ADR-0007's "queue on storefront, retry" semantics — a Cloudflare 502 to the storefront looks like a 503 and queues.
- **`cloudflared` daemon on the MacBook.** One more process to keep alive. On macOS it can run as a `launchd` service, so it survives reboots / lid open.
- **Third party in the relay path.** Email and quote-pricing traffic transits Cloudflare's edge before reaching ABERP. For GDPR purposes this is fine if Cloudflare's EU PoPs handle the request and a DPA is in place. Both are achievable on the free tier; needs an explicit configuration choice (CF dashboard → enable EU geo restriction).
- **New vendor dependency.** Áben Consulting Kft. currently has zero direct Cloudflare relationship (the storefront's public-edge is CloudFront, which is AWS, not Cloudflare). This adds one account.

**Security posture: strong.** No inbound port. Cert managed by a vendor whose only business is doing this correctly. The MacBook's only network surface remains loopback + the outbound tunnel daemon. Authentication is bearer-token (unchanged) plus optionally Cloudflare Access.

### Option C — Tailscale (or self-hosted WireGuard mesh)

**Shape.** Both the Lightsail storefront EC2 instance and Ervin's MacBook join the same Tailscale tailnet. Storefront calls ABERP via the tailnet's MagicDNS name (`aberp-mac.<tailnet>.ts.net`). `ABERP_INTERNAL_BASE_URL=http://aberp-mac.<tailnet>.ts.net:8080` (HTTP is acceptable inside the WireGuard tunnel; the tunnel is the encryption layer).

**Pros.**

- **End-to-end encrypted by WireGuard.** No third party sees plaintext relay traffic (Tailscale's coordination server only sees connection metadata, not payload).
- **MacBook never exposed publicly.** Tailnet membership requires mutual key exchange; no internet-facing socket.
- **Works across NATs.** Same as B, no port-forward.
- **MagicDNS gives a stable name.** Similar to Option B's `aberp.abenerp.com` stability.
- **Free tier sufficient.** Tailscale Free covers up to 100 devices, more than enough for one MacBook + one EC2.
- **Aligns with eventual SaaS migration** as a tailnet member; on the cutover day, the SaaS host joins the tailnet and the storefront URL is updated.

**Cons.**

- **Tailscale Inc. dependency.** Commercial entity; free tier is at their discretion. Lower brand recognition than Cloudflare for "this is critical infrastructure I bet a business on."
- **Daemon on both sides.** Tailscale client on the MacBook AND on the Lightsail EC2. EC2-side install is fine but is one more thing to keep current.
- **MagicDNS resolution timing.** When the MacBook reconnects to the tailnet (lid open, network change), the storefront's DNS cache may briefly resolve to stale state. Bounded by short TTLs; rare in practice.
- **No public-facing identity.** Unlike B, there's no `aberp.abenerp.com` URL that can also be used for, e.g., a debug ping from Ervin's phone outside the tailnet. Tailscale's Funnel feature can expose a tailnet service publicly, but at that point it's a more complicated Option B.

**Security posture: strong.** Zero-trust mesh; mutually authenticated; payload encrypted end-to-end. Comparable to B and arguably better on the "no third party sees plaintext" axis.

### Option D — Storefront-as-queue, ABERP polls (no inbound to ABERP at all)

**Shape.** Drop the push model. The storefront writes priced-quote-writeback intents and email-relay intents to local JSON queues on its own disk. ABERP's existing poller (which already pulls pending quotes) grows two more endpoints: `GET /api/storefront/pending-writebacks` and `GET /api/storefront/pending-emails`, plus matching `POST .../<id>/done` endpoints for ABERP to mark a queue entry consumed. ABERP makes only outbound HTTPS calls to the storefront's public URL. `ABERP_INTERNAL_BASE_URL` is never set on the storefront — the call shape disappears.

**Pros.**

- **Zero new infrastructure.** No tunnel, no VPN, no port-forward, no new vendor account.
- **Best security posture of any option.** ABERP has zero inbound surface — same posture it has today.
- **Survives every kind of network failure on the ABERP side gracefully.** Storefront accumulates queue entries; ABERP catches up when it comes back online. No "the writeback POST failed, retry policy on storefront" code path needed because there is no POST.
- **Single-call-direction simplifies threat model.** Auth gates live entirely on the storefront's public surface.

**Cons.**

- **Latency floor = polling cadence.** Today's pull is ~60s. A 60s wait between "ABERP finishes pricing" and "customer email goes out" is operationally fine for v1 but is a real regression vs. the push model.
- **Real engineering work to land.** Two new queue endpoints on storefront + two new poller responsibilities on ABERP + idempotency + dedup + retry. The push model's code is already shipped and working; this rewires three working surfaces.
- **More moving parts on the storefront.** Persisted queue state on the Lightsail disk needs its own lifecycle (vacuum, dead-letter, retention). The current writeback-and-forget model is simpler.
- **Same shape for both legs.** Both the priced-writeback POST AND the email-relay POST need their own queue endpoints. The shape of the work doubles.
- **ABERP becomes pollier.** The polling daemon now polls three endpoints on a fixed cadence. Cost is small but the system's "background hum" gets louder.

**Security posture: best.** No inbound to ABERP at all. The bearer-token auth surface shrinks; the network surface shrinks; the threat model shrinks. If a future security audit demands "ABERP must have no public inbound," D is the only option that survives unmodified.

## Recommendation and pushback

**Pick B (Cloudflare Tunnel) for v1.** Reasoning:

- **Honest about today's setup.** Single-operator, MacBook-as-server, Lightsail-as-public-face. Not a fleet, not multi-tenant. A tunnel is the right shape for "this dev box needs to act like a service" without pretending it's something it isn't.
- **Solves the right problem cleanly.** Tunnel daemon is one binary, runs under `launchd`, survives lid-open/lid-close. No router config. No port forwarding. No `acme.sh` cron on a desktop. No operator-discipline failure mode (`[[trust-code-not-operator]]`).
- **Stable URL future-proofs the storefront env.** `ABERP_INTERNAL_BASE_URL=https://aberp.abenerp.com` is fixed forever. Repoints follow the tunnel target. Also incidentally fixes the dynamic-port pain in `[[local-dev-test-path-gaps]]` because the tunnel pins ABERP's loopback port for everyone who calls through the edge.
- **Free tier sufficient; no vendor lock.** If Cloudflare decides to start charging or the policy changes, the migration to Option C is a one-day swap.
- **Aligns with `[[aberp-saas-migration]]`.** When ABERP moves to `invoicing.abenerp.com`, repoint the tunnel target; storefront env unchanged. Or remove the tunnel and call the SaaS host directly via the same URL semantics.

**Pushback worth flagging** (per `[[pushback-as-method]]`):

- **Cloudflare introduces a third party in the email-relay path.** Not a problem per se (and Cloudflare publishes a GDPR DPA; EU PoPs are configurable), but worth recording in the audit trail. ADR-0007's `email.relayed_storefront` audit event should probably grow a `transit_path` field naming "cloudflare-tunnel" so a future audit can see at a glance that mail flows through CF.
- **Tailscale (C) is genuinely close.** The choice between B and C comes down to whether Ervin prefers a vendor whose product is "public-facing edge" (Cloudflare) or one whose product is "private mesh" (Tailscale). B is closer to the architecture in the eventual SaaS world (public name, edge terminus); C is closer to the architecture in the today-world (private call between two boxes I own). Both are defensible. Pick B because the public-name shape is what the storefront's writeback URL becomes regardless; if we'll eventually expose `aberp.abenerp.com` anyway, build that habit now.
- **Option D (storefront-as-queue) is cleanest security-wise** and is the option a strict auditor would prefer. It's not picked for v1 because (a) the push code is already shipped and working, (b) the polling latency is a real product regression, (c) the engineering cost is days not hours, and (d) Ervin's mandate today is "ship the pipeline, not gold-plate it." D is the right pick if a future audit or compliance ask makes "zero inbound to ABERP" load-bearing — keep it documented as the fallback.
- **Option A (public TLS endpoint on ABERP) is not seriously recommended.** It's documented because it's the obvious naive option and someone will ask "why not just open port 443?" — the answer is in the cons list under A. Don't pick A.

## Consequences (assuming Option B lands)

### Positive

- **End-to-end auto-quote pipeline goes from "architecturally LIVE, prod topology TBD" to "LIVE in prod."** First real customer quote can run through it as soon as `cloudflared` is configured and `ABERP_INTERNAL_BASE_URL` is set on Lightsail.
- **Storefront env becomes stable across ABERP reboots.** No more "ABERP picked port 8081 today, port 8092 yesterday" rewiring.
- **Audit trail gets a new field** (`transit_path` on email-relay audit events) — small but meaningful change for future compliance.
- **Closes OQ #3 from the S284 walkthrough**, unblocking the "ready for first real run" stamp on the auto-quote pipeline.

### Negative

- **New vendor relationship to provision.** Cloudflare account creation, DNS delegation for `aberp.abenerp.com` (either via NS records pointing the subdomain at Cloudflare, or by managing the whole zone at Cloudflare), `cloudflared` install + tunnel creation. ~1–2h one-time work; not zero.
  - Mitigation: ship the tunnel config as documented runbook in `docs/runbooks/` with the exact CLI commands; do not rely on dashboard click-through.
- **`cloudflared` daemon must be kept current.** Security updates ship periodically. Auto-update via `brew` or `cloudflared update` cron.
  - Mitigation: `cloudflared` has its own self-update path; enable it.
- **Cloudflare outage → relay outage.** Storefront's existing 503-then-queue semantics (per ADR-0007) cover this transparently for email; priced-writeback retry behavior needs an explicit check.
  - Mitigation: confirm the priced-writeback path retries with exponential backoff on a 5xx from `ABERP_INTERNAL_BASE_URL` (not just on a network error). If it doesn't, that's a small follow-up PR.

### Neutral

- **Latency budget unchanged.** Cloudflare's edge adds tens of ms; not perceptible in the pipeline.
- **`ABERP_INTERNAL_BASE_URL` naming becomes slightly misleading** — it's not really "internal" anymore, it's "via a tunnel that pretends to be internal." Worth a rename to `ABERP_RELAY_BASE_URL` in a future cleanup, but not load-bearing.

## Reconciliation with ADR-0007

ADR-0007 introduced the storefront-side `ABERP_EMAIL_RELAY_TOKEN` and bearer-gated `/api/internal/send-email` on ABERP. It assumed the call could reach ABERP somehow but did not pick the mechanism. This ADR is the mechanism. ADR-0007's call shape (HTTPS, bearer, JSON) is preserved unchanged under every option above; the only thing that changes is what `ABERP_EMAIL_RELAY_BASE_URL` (or the unified `ABERP_INTERNAL_BASE_URL`) resolves to.

ADR-0007's §"Reconciliation with ADR-0006" explicitly named Option D ("staged-pending-mail variant") as the fallback if a future audit hardens "no inbound at all." That fallback is preserved here under [Option D](#option-d--storefront-as-queue-aberp-polls-no-inbound-to-aberp-at-all).

## Validation

Per `[[trust-code-not-operator]]`, the validation surface is **a real customer-style end-to-end run through the prod pipeline**, not log lines or unit tests:

1. With the chosen topology stood up, the [S284 walkthrough](../walkthroughs/end-to-end-auto-quote-test.md) runs cleanly from CAD upload through priced email arrival in a real mailbox.
2. ABERP's audit ledger shows the `email.relayed_storefront` event with the matching `audit_id` returned in the storefront's logs.
3. The priced-writeback POST from storefront returns 200 with the priced metadata persisted on ABERP.
4. (Option B specifically) Cloudflare's tunnel dashboard shows steady-state outbound from the MacBook with the request count matching the storefront's log of attempted writebacks.

If any of (1)–(3) fail under the chosen topology, the topology pick is wrong-shaped and this ADR should be reopened.

## Open questions (resolved and residual)

1. **Pick A / B / C / D.** **RESOLVED — B (Cloudflare Tunnel)** (Ervin, 2026-06-08; see [Decision recorded](#decision-recorded)).
2. **If B: Cloudflare account ownership.** **Residual — operator-time decision during runbook execution.** Recommendation stands: configure the tunnel under the Cloudflare account that owns (or will own) `abenerp.com` DNS so the subdomain `aberp.abenerp.com` delegates cleanly via CNAME flattening or NS delegation under the same zone. The runbook's Preflight step prompts the operator to confirm or split. Captured as configuration-choice, not as an open architectural question.
3. **If C: existing Tailscale footprint.** **N/A** — C was not picked.
4. **If D: latency tolerance.** **N/A** — D was not picked.
5. **Audit field `transit_path`.** **Residual — backlog item.** Adding a `transit_path` enum (`direct` | `cloudflare-tunnel` | `tailscale` | `queue-pull`) to ADR-0007's `email.relayed_storefront` audit event is still recommended for compliance auditability. Now that B is picked, the field would always emit `cloudflare-tunnel` for the email-relay leg; the engineering work is small (ADR-0007 ledger schema + emit-site) and lives in a separate session, not this ADR. Tracked in memory as a backlog item alongside this ADR.

## References

- [ADR-0004](0004-priced-quote-writeback.md) — priced-quote writeback shape (storefront → ABERP POST).
- [ADR-0007](0007-storefront-email-relay-via-aberp.md) — customer email relay shape (storefront → ABERP POST); §"Reconciliation with ADR-0006" sketched the Option D fallback.
- [`docs/walkthroughs/end-to-end-auto-quote-test.md`](../walkthroughs/end-to-end-auto-quote-test.md) §"What's NOT in this walkthrough" — flagged this topology as OQ #3.
- [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) — full pipeline design that this topology closes the prod-gap on.
- `[[aberp-saas-migration]]` — eventual move to `invoicing.abenerp.com`; topology pick should not preclude it.
- `[[trust-code-not-operator]]` — rules out Option A's TLS-cert-on-desktop and lid-must-stay-open failure modes.
- `[[pushback-as-method]]` — explicit recommendation + pushback structure used in this ADR rather than soft-peddled agreement with the brief.
- `[[origin-clean-topology]]` — unrelated topology but same word; doesn't apply here.
- `[[local-dev-test-path-gaps]]` — the dynamic-port pain Option B incidentally solves.
