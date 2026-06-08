# Runbook — Cloudflare Tunnel bring-up for ABERP

**Goal:** stand up a Cloudflare Tunnel from Ervin's MacBook so the Lightsail storefront can call ABERP's loopback listener via a stable URL (`https://aberp.abenerp.com`). This closes the prod gap flagged by [ADR-0008](../adr/0008-aberp-storefront-network-topology.md) and unblocks the first real customer quote through the end-to-end pipeline.

**Audience:** Ervin (operator). Schoolboy-with-hands format per `[[walkthrough-format]]`. Every step is WHERE-tagged. One screen of action per step.

**Time budget:** ~45–90 minutes one-time, including the Cloudflare account check and the launchd persistence step.

**Reversibility:** every step is undoable. `cloudflared tunnel delete aberp` tears down the tunnel; deleting `~/.cloudflared/` removes local state; the DNS CNAME can be removed from the Cloudflare dashboard. Lightsail's `/etc/aberp-site.env` is hand-edited; revert by editing back. No data is mutated by following this runbook — only network plumbing is added.

**Prerequisites this runbook does NOT cover:**

- Ervin must already own (or be willing to manage) the `abenerp.com` DNS zone on Cloudflare. If today's zone is at AWS Route 53 or another registrar, see [Troubleshooting](#troubleshooting) → "DNS zone not at Cloudflare."
- ABERP must already be running locally with its HTTPS loopback listener up (per `[[local-dev-test-path-gaps]]`).
- The storefront's auto-quote pipeline must already be deployed on Lightsail (per [the S284 walkthrough](../walkthroughs/end-to-end-auto-quote-test.md)). This runbook only wires the storefront's `ABERP_INTERNAL_BASE_URL` to a stable URL — it does not deploy the storefront.

---

## Preflight

### Preflight 1 — Cloudflare account owns the abenerp.com zone

**[Cloudflare dashboard]** Sign in at <https://dash.cloudflare.com>. The left-hand "Websites" list should show `abenerp.com`.

**If `abenerp.com` is listed:** good. Note which Cloudflare account (the email at the top-right). If Ervin manages multiple Cloudflare accounts, write down which one — you'll keep using this one for every step below.

**If `abenerp.com` is NOT listed:** the zone lives elsewhere (AWS Route 53, GoDaddy, Namecheap, etc.). You have two choices:

1. **Recommended:** delegate the `abenerp.com` zone to Cloudflare ("Add a site" in the dashboard, then update the registrar's nameservers to Cloudflare's). Propagation takes 5 minutes to a few hours; do this on the morning of the bring-up. The storefront's existing public-edge (CloudFront) is independent of where DNS is hosted — moving DNS to Cloudflare does not change CloudFront behavior; CloudFront is a CDN, not a DNS provider.
2. **Alternative:** stand up a Cloudflare account just for the tunnel and use a different subdomain that you delegate one-off (e.g. `aberp.abenerp.dev` if the .dev is registered separately). This avoids touching the production storefront's DNS but costs a second domain and adds a second account to keep current. Not recommended unless there's an explicit reason to keep DNS off Cloudflare.

Pick one before continuing. The rest of this runbook assumes choice 1 (zone is at Cloudflare).

### Preflight 2 — Homebrew is installed on the MacBook

**[Mac terminal]**

```sh
which brew
```

Expect a path like `/opt/homebrew/bin/brew` (Apple Silicon) or `/usr/local/bin/brew` (Intel). If "brew not found", install from <https://brew.sh> and re-run the check.

### Preflight 3 — ABERP is running and binding a loopback port

**[Mac terminal]**

```sh
lsof -nP -i4TCP -sTCP:LISTEN -c aberp
```

Expect at least one line showing `127.0.0.1:<some-high-port>`. Note the port number — call it `<ABERP_PORT>` below. If nothing prints, start ABERP first (per `[[local-dev-test-path-gaps]]`).

**Known limitation:** ABERP currently picks a fresh port every restart. The runbook's `config.yml` (Step 5 below) names a specific port. Until S291's `./run/dev-test.sh` pins `ABERP_HTTPS_PORT=18443`, the operator must either (a) pin the port some other way before this runbook, or (b) edit `config.yml` and restart `cloudflared` on every ABERP restart. The latter is the discipline trap [ADR-0008](../adr/0008-aberp-storefront-network-topology.md) was meant to remove; treat it as a temporary cost paid until S291 lands.

---

## Bring-up

### Step 1 — [Mac terminal] Install `cloudflared`

```sh
brew install cloudflared
```

Verify:

```sh
cloudflared --version
```

Expect a version string. Cloudflare ships frequent updates; `brew upgrade cloudflared` is the maintenance path.

### Step 2 — [Mac terminal] Authenticate `cloudflared` against the Cloudflare account

```sh
cloudflared tunnel login
```

This opens a browser tab pointing at Cloudflare's OAuth flow. Sign into the account identified in Preflight 1. Cloudflare will ask which zone to authorize — pick `abenerp.com`. On success, `cloudflared` writes a cert to `~/.cloudflared/cert.pem`.

**If the browser does not open**, the terminal prints a URL. Copy it into a browser manually.

### Step 3 — [Mac terminal] Create the tunnel

```sh
cloudflared tunnel create aberp
```

Cloudflare assigns the tunnel a UUID and writes credentials to `~/.cloudflared/<UUID>.json`. The terminal prints both. Note the UUID — call it `<TUNNEL_ID>` below.

### Step 4 — [Mac terminal] Capture the tunnel ID for later steps

```sh
cloudflared tunnel list
```

Expect one row with NAME `aberp` and the UUID from Step 3. Copy the UUID into a scratchpad — you'll paste it into `config.yml` in Step 5 and reference it in the launchd step.

### Step 5 — [Mac text editor] Write `~/.cloudflared/config.yml`

Open `~/.cloudflared/config.yml` in any text editor (`code ~/.cloudflared/config.yml`, `nano`, etc.). Paste the following template, then substitute `<TUNNEL_ID>` and `<ABERP_PORT>`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /Users/aben/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: aberp.abenerp.com
    service: https://localhost:<ABERP_PORT>
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

Save the file. Notes:

- The `noTLSVerify: true` is required because ABERP's loopback listener uses a self-signed cert. This is acceptable here because the link between `cloudflared` and ABERP is over the loopback interface (`localhost`) and never leaves the MacBook — there is no network attacker on a loopback. The TLS terminus that matters (the one the storefront talks to) is Cloudflare's edge, which uses a real cert provisioned by Cloudflare in Step 6.
- The catch-all `http_status:404` block at the bottom is mandatory — `cloudflared` rejects a config without one.
- If you later host more services through the same tunnel, add more `hostname:`/`service:` blocks above the catch-all.

### Step 6 — [Mac terminal] Route DNS for the public hostname

```sh
cloudflared tunnel route dns aberp aberp.abenerp.com
```

This creates a CNAME record `aberp.abenerp.com → <TUNNEL_ID>.cfargotunnel.com` in the Cloudflare zone. Verify in the dashboard:

**[Cloudflare dashboard]** → `abenerp.com` → DNS → records. Expect a CNAME row for `aberp` pointing at `<TUNNEL_ID>.cfargotunnel.com`, proxied (orange cloud on).

### Step 7 — [Mac terminal] Run the tunnel in the foreground for testing

```sh
cloudflared tunnel run aberp
```

Expect lines indicating registered connections to Cloudflare PoPs ("Registered tunnel connection"). Leave this running in one terminal tab; open a second terminal for the next step. Stop with `Ctrl+C` when done testing — you'll re-launch via launchd in Step 9.

### Step 8 — [Second Mac terminal] Smoke-test the tunnel end-to-end

```sh
curl -i https://aberp.abenerp.com/
```

Expect HTTP 200 (or whatever ABERP returns for `/`). Try a known ABERP endpoint:

```sh
curl -i https://aberp.abenerp.com/api/internal/send-email
```

Expect HTTP 401 with `WWW-Authenticate: Bearer` or similar — that confirms the tunnel reached ABERP and ABERP's bearer-token gate is firing. If you get a 502 or connection-reset, see [Troubleshooting](#troubleshooting).

### Step 9 — [Mac terminal] Install `cloudflared` as a launchd service

Stop the foreground `cloudflared` from Step 7 (`Ctrl+C` in the first terminal). Then:

```sh
sudo cloudflared service install
```

This writes `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` and starts the service. It reads `~/.cloudflared/config.yml` automatically. The tunnel now survives reboots and lid-close.

Verify:

```sh
sudo launchctl list | grep cloudflare
```

Expect one row with PID != `-` (the service is running) and exit-code `0`.

Re-smoke-test (you can omit `-i` now):

```sh
curl https://aberp.abenerp.com/ -o /dev/null -w "%{http_code}\n"
```

Expect `200`.

### Step 10 — [Lightsail SSH] Wire the storefront to the tunnel

SSH into the Lightsail storefront host and edit `/etc/aberp-site.env`:

```sh
sudo nano /etc/aberp-site.env
```

Set:

```
ABERP_INTERNAL_BASE_URL=https://aberp.abenerp.com
```

(Leave `ABERP_EMAIL_RELAY_TOKEN` and other vars unchanged — only the base URL changes.) Save, then restart the storefront service:

```sh
sudo systemctl restart aberp-site
```

Verify the env applied by checking the service env:

```sh
sudo systemctl show aberp-site -p Environment
```

The `ABERP_INTERNAL_BASE_URL` line should show the new value. Tail the journal for at least one quote-pricing cycle (~60s) and watch for a successful priced-writeback `POST 200` to `aberp.abenerp.com`:

```sh
sudo journalctl -fu aberp-site
```

---

## Troubleshooting

### Browser doesn't open during `cloudflared tunnel login` (Step 2)

The terminal prints a fallback URL. Copy it into any browser and complete the flow there. The cert lands at `~/.cloudflared/cert.pem` regardless of how the OAuth completes.

### Tunnel runs but ingress isn't routing (Step 7 returns nothing)

Stop `cloudflared`. Check `~/.cloudflared/config.yml`:

- The `tunnel:` UUID matches what `cloudflared tunnel list` shows.
- The `credentials-file:` path is absolute and points at an existing JSON file (`ls -la ~/.cloudflared/<TUNNEL_ID>.json`).
- YAML indentation is exactly two spaces. `originRequest:` is indented one level deeper than `service:`.
- The catch-all `service: http_status:404` block exists.

Restart `cloudflared tunnel run aberp`. If still broken, run `cloudflared tunnel ingress validate` — it parses the config and reports the first error.

### 502 from `aberp.abenerp.com` (Step 8)

Means the tunnel reached Cloudflare's edge and Cloudflare reached the MacBook, but `cloudflared` could not reach the configured `service:` URL. Check:

- ABERP is still running (`lsof -nP -i4TCP -sTCP:LISTEN -c aberp`).
- The port in `config.yml` matches ABERP's current port. If ABERP has restarted since Preflight 3, the port has likely changed.
- `curl -k https://localhost:<ABERP_PORT>/` from the same MacBook terminal returns 200. If it doesn't, the problem is ABERP-side, not tunnel-side.

### TLS cert error / "x509: cannot validate" in `cloudflared` logs

`cloudflared` is trying to validate ABERP's self-signed loopback cert. Confirm `noTLSVerify: true` is set under `originRequest:` in `config.yml`. (Indentation matters — `originRequest:` must be a child of the `- hostname:` ingress rule, two spaces under it; `noTLSVerify:` is two spaces under `originRequest:`.)

### `sudo cloudflared service install` fails or service doesn't start at boot (Step 9)

On macOS Sequoia and Sonoma, `cloudflared service install` may need to be re-approved in **System Settings → Privacy & Security → Login Items & Extensions → Allow in Background** for `com.cloudflare.cloudflared`. Check there if the service shows up in `launchctl list` but its PID stays `-`.

If the install command itself fails with a permission error, run with sudo (it needs to write to `/Library/LaunchDaemons/`). If it still fails, fall back to `cloudflared tunnel run aberp &` in a `nohup`-protected terminal as a stopgap — not lid-close-safe, but unblocks the first real test.

### DNS zone not at Cloudflare

If Preflight 1 found that `abenerp.com` is hosted at AWS Route 53 or another DNS provider, the recommended path is to delegate the zone to Cloudflare (free; propagation typically completes in under an hour). If that's not desirable, the alternative is to create a CNAME at the current DNS host pointing `aberp.abenerp.com` at `<TUNNEL_ID>.cfargotunnel.com` — Cloudflare's tunnel will accept the traffic, but Cloudflare's automatic edge cert provisioning won't work for a hostname Cloudflare doesn't own. You'll either need to use Cloudflare for SaaS (additional setup, paid feature on some tiers) or pick a different subdomain at a zone Cloudflare does own. The simple answer is "move the zone to Cloudflare."

### Storefront still calls the old URL after `/etc/aberp-site.env` edit (Step 10)

Confirm the service was restarted, not just reloaded. `sudo systemctl restart aberp-site` re-reads the env file; `reload` may not. Check `sudo systemctl show aberp-site -p Environment` after restart.

---

## Post-install verification

Per [ADR-0008](../adr/0008-aberp-storefront-network-topology.md) §Validation and `[[trust-code-not-operator]]`, success is measured by a real end-to-end run, not log lines:

1. **[Lightsail SSH]** A curl against the relay endpoint over the tunnel returns 401 from ABERP (proves the tunnel is reachable and ABERP's auth gate fires):

   ```sh
   curl -i https://aberp.abenerp.com/api/internal/send-email
   ```

2. **[Browser]** Run the [S284 walkthrough](../walkthroughs/end-to-end-auto-quote-test.md) Preflight 1–5 cleanly. Preflight 3 (the `/etc/aberp-site.env` checks) now passes with the new `ABERP_INTERNAL_BASE_URL` value.

3. **[Browser]** Submit one real customer-style CAD upload at <https://abenerp.com/quote>. Within the daemon's poll cadence (~60s) the priced-quote email arrives at the customer mailbox. ABERP's audit ledger shows an `email.relayed_storefront` event with a matching `audit_id` in the storefront's logs. The storefront's logs show a successful `POST 200` to `aberp.abenerp.com/api/internal/send-email`.

4. **[Cloudflare dashboard]** → Zero Trust → Networks → Tunnels → `aberp` → shows steady-state inbound request count matching the storefront's relay attempts.

If any of (1)–(3) fail, the runbook is incomplete or [ADR-0008](../adr/0008-aberp-storefront-network-topology.md)'s decision needs revisiting. Log the failure and stop — do not paper over by reverting `ABERP_INTERNAL_BASE_URL` to a local-dev value on Lightsail. Local-dev URLs on Lightsail are silently broken (the storefront thinks it's working; nothing reaches ABERP).

---

## Open follow-ups (backlog)

These are not blockers for the bring-up but should be tracked separately so they don't get lost:

1. **ABERP dynamic-port pin.** S291's `./run/dev-test.sh` (in flight) is expected to set `ABERP_HTTPS_PORT=18443` on launch, eliminating the "edit config.yml every restart" discipline trap noted in Preflight 3 and Step 5. Once S291 lands, update this runbook's Step 5 template to hardcode `18443` (or whatever S291 picks) and delete the `<ABERP_PORT>` placeholder.

2. **`transit_path` audit field.** ADR-0008 Open Question #5 (residual). Add a `transit_path` enum (`direct` | `cloudflare-tunnel` | `tailscale` | `queue-pull`) to ADR-0007's `email.relayed_storefront` event so the audit ledger records the network path. Schema change on ABERP's ledger plus an emit-site change on the storefront. Separate session.

3. **launchd quirks on macOS Sequoia/Sonoma.** If Step 9's "Allow in Background" approval is required in practice, document the exact System Settings click path with a screenshot for the next operator. Append to the [Troubleshooting](#troubleshooting) section after the first real bring-up.

4. **Periodic `cloudflared` upgrades.** `brew upgrade cloudflared` should run at least quarterly. Track in maintenance backlog rather than relying on operator memory.

5. **Cloudflare Access overlay (defense in depth).** Once the tunnel is up and working, ADR-0008 §"Option B Pros" mentions Cloudflare Access can layer mTLS / service-token auth on top of the bearer token. Optional hardening; revisit only if a future audit calls for it.

---

## References

- [ADR-0008](../adr/0008-aberp-storefront-network-topology.md) — the decision document this runbook executes.
- [ADR-0004](../adr/0004-priced-quote-writeback.md), [ADR-0007](../adr/0007-storefront-email-relay-via-aberp.md) — the two call legs the tunnel enables.
- [`docs/walkthroughs/end-to-end-auto-quote-test.md`](../walkthroughs/end-to-end-auto-quote-test.md) — the operator-facing end-to-end test; Preflight 3 now passes once Step 10 of this runbook is done.
- Cloudflare Tunnel docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
- `cloudflared` GitHub releases (for upgrade tracking): <https://github.com/cloudflare/cloudflared/releases>
