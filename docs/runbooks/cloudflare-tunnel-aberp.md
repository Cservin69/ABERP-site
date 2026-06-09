# Runbook — Cloudflare Tunnel bring-up for ABERP (ground-zero walkthrough)

**Audience:** anyone who can read and type. No prior knowledge of Cloudflare, DNS, AWS, SSH, or Lightsail is assumed. Every step says WHERE you do it, exactly what to type or click, and what you should see when it worked.

**Time budget:** ~60–90 minutes if nothing goes wrong, more if you hit something in §11.

**Reversibility:** every step is undoable. `sudo cloudflared service uninstall` removes the connector daemon from the Mac; the tunnel itself can then be deleted from the Zero Trust dashboard (**Networks → Tunnels → aberp → Delete**). The Route 53 CNAME can be deleted from the AWS Console. `/etc/aberp-site.env` is a plain text file you can hand-edit back. No customer data is touched.

**Important context:** this walkthrough assumes your DNS is on AWS Route 53 (the common case for AWS-hosted setups) and uses Cloudflare's Zero Trust token-based tunnel flow. The token-based flow is universal — it works whether your DNS is on Cloudflare or anywhere else. If your DNS IS on Cloudflare, the legacy `cloudflared tunnel login` + automatic CNAME flow also works (see Cloudflare's official quickstart); we use the token-based path here because it's the one path that always works regardless of where DNS lives.

---

## §1 — What this walkthrough does

This sets up a secure tunnel from your Mac's local ABERP to your public storefront (`abenerp.com` on Lightsail). After this is done, when a customer submits a quote on `abenerp.com`, your local ABERP picks it up automatically, prices it, and emails the customer back. Without this tunnel, the two halves can't talk to each other — the storefront is on the internet but ABERP is on `127.0.0.1` on your laptop, which the internet can't reach.

The tunnel works by running a small program called `cloudflared` on your Mac. `cloudflared` makes an outbound connection to Cloudflare's network and holds it open. When traffic arrives at the public hostname (`aberp.abenerp.com`), Cloudflare routes it down that held-open connection to your Mac, where `cloudflared` hands it to ABERP. No inbound port on your Mac is opened.

This runbook executes the decision in [ADR-0008](../adr/0008-aberp-storefront-network-topology.md) (Option B). Architecture is unchanged from S301; this rewrite makes the steps executable end-to-end.

---

## §2 — Preflight checks

Each check verifies one assumption. If a check fails, stop and fix that thing before moving on.

### P-1 — ABERP is running on your Mac

**WHERE:** Mac terminal.

```sh
lsof -nP -i4TCP -sTCP:LISTEN -c aberp | grep 127.0.0.1
```

Expected: at least one line printed (showing a process named `aberp` listening on `127.0.0.1:<some-port>`).

**Stuck?** ABERP isn't running. Launch ABERP and try again. The tunnel can't connect to something that isn't there.

### P-2 — Public storefront is up

**WHERE:** Browser tab. Visit <https://abenerp.com/quote>.

Expected: the "Get a quote" form loads.

**Stuck?** Lightsail might be down. Sign into <https://lightsail.aws.amazon.com> and check the instance status. Fix that before continuing.

### P-3 — Homebrew is installed

**WHERE:** Mac terminal.

```sh
which brew
```

Expected: a line like `/opt/homebrew/bin/brew`.

**Stuck?** Install Homebrew from <https://brew.sh> first, then re-run the check.

### P-4 — DNS for `abenerp.com` is on AWS Route 53

**WHERE:** Mac terminal.

```sh
dig NS abenerp.com +short
```

Expected: 4 lines ending in `awsdns-NN.org.`, `awsdns-NN.co.uk.`, `awsdns-NN.net.`, `awsdns-NN.com.` (the four AWS nameserver domains).

This walkthrough assumes Route 53. If you see a different DNS provider (Cloudflare, GoDaddy, Namecheap, etc.), the steps in §5 are different — stop and ask before going on.

### P-5 — You can sign into AWS Console for Route 53

**WHERE:** Browser tab. Visit <https://console.aws.amazon.com/route53>.

Expected: after sign-in, the Route 53 dashboard appears.

**Stuck?** You need AWS credentials with Route 53 read/write permission. Find them wherever you store account credentials. If you don't have any, you need an account holder to grant access before continuing.

### P-6 — You have (or can create) a Cloudflare account

**WHERE:** Browser tab. Visit <https://dash.cloudflare.com>.

Expected: either you can sign in, or you can sign up for free.

If you don't already have an account, click "Sign Up" and create one. The free tier is enough for this entire walkthrough. **Important:** you do NOT need to move `abenerp.com`'s DNS to Cloudflare. We use Cloudflare only for its tunnel program. DNS stays on Route 53.

**Stuck?** Account creation takes ~2 minutes — just an email and a password.

---

## §3 — Install `cloudflared` via the Zero Trust dashboard

This walkthrough uses Cloudflare's Zero Trust token-based tunnel flow. The token install command bundles the connector daemon with its credentials in one paste — no `cloudflared tunnel login` browser dance, no `cert.pem`, no zone-picking. This is the universal path that works whether your DNS is on Cloudflare or somewhere else (in our case, Route 53).

### S-1 — Install `cloudflared`

**WHERE:** Mac terminal.

```sh
brew install cloudflared
```

Expected: the install finishes after 1–2 minutes with a line starting `🍺 /opt/homebrew/Cellar/cloudflared/...`.

Confirm:

```sh
cloudflared --version
```

Expected: a line like `cloudflared version 2024.x.x ...` (or newer).

### S-2 — Sign into the Zero Trust dashboard

**WHERE:** Browser tab at <https://one.dash.cloudflare.com>.

Sign in with the Cloudflare account from preflight P-6. If you've never opened Zero Trust before, the dashboard walks you through a free signup (pick a team name, choose the **Free** plan, no payment method required).

Expected: the Zero Trust dashboard loads, with a left-nav listing **Networks**, **Access**, **Gateway**, etc.

### S-3 — Create the tunnel in the dashboard

**WHERE:** Zero Trust dashboard.

Click **Networks → Tunnels** in the left nav, then click **Create a tunnel** (top right).

- **Connector type:** pick **Cloudflared**. (Not WARP.)
- **Tunnel name:** type `aberp`.
- Click **Save tunnel**.

Expected: the page advances to "Install and run a connector" with a platform picker (macOS / Linux / Windows / Docker) and a one-line install command below it.

### S-4 — Copy the install command

**WHERE:** Zero Trust dashboard, "Install and run a connector" page.

Pick the **macOS** tab. The page shows a one-liner that looks like:

```
sudo cloudflared service install eyJhIjoi... (~200 characters of base64)
```

Click the copy icon next to the command (preferred — copying by hand can drop characters at either end). The token is long; make sure you got all of it.

### S-5 — Run the install command on the Mac

**WHERE:** Mac terminal.

Paste the command from S-4 and press Enter. You'll be prompted for your Mac password (this is `sudo`).

Expected: a line like `1 service was installed and started successfully`. The cloudflared daemon is now running as a launchd service in the background — you do not need to launch anything else by hand.

**Stuck?** If the install fails with a token parse error, the token got truncated when you copied it. Go back to S-4 and use the dashboard's copy icon. See also §11 T13.

### S-6 — Confirm the connector shows healthy in the dashboard

**WHERE:** Zero Trust dashboard. The page you copied the token from should still be open; if not, navigate back to **Networks → Tunnels** and click the `aberp` row.

Wait ~10 seconds, then refresh the page. Look at the **Connectors** section near the top of the tunnel detail page.

Expected: one row with status **HEALTHY** (green dot). The hostname column shows your Mac's hostname.

**Stuck?** If the connector stays **DOWN** for more than 30 seconds, see §11 T13.

---

## §4 — Capture the tunnel UUID

The dashboard already created the tunnel in §3 S-3. We just need its UUID for the Route 53 CNAME (§5) and the local config file (§6).

### T-1 — Copy the UUID from the dashboard

**WHERE:** Zero Trust dashboard → **Networks → Tunnels** → click the `aberp` row.

Look at the top of the tunnel detail page. Under (or next to) the tunnel name `aberp` you'll see a long hex string with dashes:

```
abc12345-1234-1234-1234-abcdef123456
```

That's the UUID. Click it (or the copy icon next to it) to copy it to the clipboard. **Save it somewhere you can paste it back from twice** — once in §5 R-3, once in §6 C-2.

### T-2 — Confirm the connector daemon is running

**WHERE:** Mac terminal.

```sh
sudo launchctl list | grep cloudflared
```

Expected: at least one line showing `com.cloudflare.cloudflared` with a numeric PID (not `-`). This is the daemon installed by §3 S-5; if it isn't listed, see §11 T13.

Note: the legacy `cloudflared tunnel list` command needs a `cert.pem` from the old browser-login flow and will not work under the token-based path. The dashboard is the source of truth for tunnel inventory; the `launchctl list` check above is the local-side equivalent of "is it running."

---

## §5 — Route 53 CNAME (manual, in the AWS Console)

The critical fix versus S301: Cloudflare's normal `cloudflared tunnel route dns` shortcut can't manage your DNS because your DNS is on AWS Route 53, not on Cloudflare. So you create the CNAME by hand in the AWS Console.

### R-1 — Open the hosted zone

**WHERE:** Browser tab at <https://console.aws.amazon.com/route53/v2/hostedzones>.

Expected: a list of hosted zones. Find the row `abenerp.com.` and click on it.

### R-2 — Start a new record

**WHERE:** browser tab (Route 53 hosted zone detail page).

Click the orange **Create record** button (top right).

### R-3 — Fill in the record form

**WHERE:** the Create record form.

Fill the fields exactly as below.

- **Record name:** type `aberp` (just `aberp`; the box already shows `.abenerp.com` after it — do not type the full hostname).
- **Record type:** leave as `CNAME — Routes traffic to another domain name and to some AWS resources`.
- **Value:** type `<UUID>.cfargotunnel.com` — replace `<UUID>` with the UUID from T-1. Example: `abc12345-1234-1234-1234-abcdef123456.cfargotunnel.com`.
- **TTL (seconds):** change to `300` (5 minutes — short, so a typo here is cheap to fix).
- **Routing policy:** leave as `Simple routing`.

### R-4 — Save

**WHERE:** browser tab.

Click **Create records** at the bottom.

### R-5 — Confirm the success banner

**WHERE:** browser tab.

Expected: a green banner at the top: "1 record was created successfully".

### R-6 — Wait, then check DNS propagation

**WHERE:** Mac terminal. Wait at least 60 seconds first.

```sh
dig aberp.abenerp.com +short
```

Expected: one line ending in `.cfargotunnel.com.` — the same value you typed in R-3.

**Stuck?** Wait another minute and try again. DNS propagation usually finishes in 1–5 minutes. If `dig` still returns nothing after 5 minutes, go back to the Route 53 console and check the record's Value field — the most common error is a typo in the UUID.

### R-7 — Confirm the CNAME points where it should

**WHERE:** Mac terminal.

```sh
dig aberp.abenerp.com +short | grep cfargotunnel
```

Expected: exactly 1 line. This confirms the CNAME exists and points at Cloudflare's tunnel endpoint.

---

## §6 — Write the tunnel config file

### C-1 — Make sure the config directory exists and open it

**WHERE:** Mac terminal.

```sh
mkdir -p ~/.cloudflared && open ~/.cloudflared
```

Expected: a Finder window opens, showing whatever is in `~/.cloudflared/` (likely empty or close to it under the token-based flow — the daemon's credentials live with the launchd service, not in this directory).

### C-2 — Write `config.yml`

We need a text file at `~/.cloudflared/config.yml`. The easiest way is to paste the whole thing in one go.

**WHERE:** Mac terminal. Copy this entire block, paste it into the terminal, press Enter.

```sh
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: REPLACE-WITH-UUID

ingress:
  - hostname: aberp.abenerp.com
    service: https://localhost:18443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF
```

Then substitute your real UUID into the placeholder. Replace `<your-actual-UUID>` with the UUID from T-1.

```sh
sed -i '' "s/REPLACE-WITH-UUID/<your-actual-UUID>/g" ~/.cloudflared/config.yml
```

Confirm it worked:

```sh
cat ~/.cloudflared/config.yml
```

Expected: the file contents, with your UUID substituted onto the `tunnel:` line. No `REPLACE-WITH-UUID` literal text should remain.

**Note on token-based connector + local YAML.** If you used the token-based install in §3 (the recommended path for Route 53 DNS users), `config.yml` routing still works — the token authenticates the connector daemon, the YAML configures what it forwards. There is no `credentials-file:` line because the token (stored in the launchd service definition by §3 S-5) does that job. The Zero Trust dashboard's "Public Hostnames" tab is an alternative way to express the same routing, but that tab requires picking a Cloudflare-managed zone from a dropdown — empty when DNS is on Route 53. So we use local YAML instead. The local YAML takes precedence over the dashboard's Public Hostnames config when both are present.

**About the port `18443`.** That's the port ABERP listens on when launched via `./run/dev-test.sh` from the ABERP repo. If you launch ABERP some other way (the Cowork install path, `./run/upgrade_prod.sh`, etc.), ABERP picks a different port every restart and this config will not match it. To get a predictable port that matches this config, launch ABERP via:

```sh
cd /Users/aben/Documents/Claude/Projects/ABERP && ./run/dev-test.sh
```

From now on, the assumption is you launch ABERP that way. If you need a different port for some reason, edit the `service:` line in `config.yml` to match.

### C-3 — Validate the config syntax

**WHERE:** Mac terminal.

```sh
cloudflared tunnel ingress validate
```

Expected: `OK`.

**Stuck?** YAML cares about indentation. Every nested line must be exactly 2 spaces, no tabs. Re-paste the C-2 block fresh if you're not sure.

---

## §7 — Reload the daemon and verify

### V-1 — Reload the daemon to pick up `config.yml`

**WHERE:** Mac terminal.

The launchd service installed in §3 S-5 has been running since then, but it started before you wrote `config.yml` in §6, so kick it to reload:

```sh
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

Then confirm it's still running:

```sh
sudo launchctl list | grep cloudflared
```

Expected: one line showing `com.cloudflare.cloudflared` with a numeric PID (not `-`). The daemon now serves the ingress rules from §6. (If you already ran the same `launchctl list` check in §3 S-6 or §4 T-2 and you don't need to reload, this whole step is a no-op.)

If you want to watch live connector logs in another window:

```sh
sudo log stream --predicate 'process == "cloudflared"' --level info
```

You should see several `Registered tunnel connection` lines — one per Cloudflare edge data center the tunnel connected to. Cmd+C the tail when you've seen those; the daemon keeps running.

### V-2 — Check that the tunnel reaches ABERP

**WHERE:** open a SECOND Mac terminal tab (Cmd+T in Terminal).

```sh
curl -i https://aberp.abenerp.com/health 2>&1 | head -20
```

Expected: either an HTTP `200 OK` with a JSON body, or an HTTP `401 Unauthorized` (depending on whether `/health` requires auth in your ABERP build). What you must NOT see: a TLS error, an HTTP `502 Bad Gateway`, or "connection refused / timed out."

**Stuck?** Tail the connector logs in a separate window with `sudo log stream --predicate 'process == "cloudflared"' --level info` and re-run the curl. The most common failure here is that ABERP isn't actually running on port 18443 — the log will show a connection-refused line. Confirm with `lsof -nP -i4TCP -sTCP:LISTEN -c aberp` — you should see `127.0.0.1:18443` in the output.

### V-3 — Check that the email relay endpoint is reachable through the tunnel

**WHERE:** second Mac terminal.

```sh
curl -i -X POST https://aberp.abenerp.com/api/internal/send-email \
  -H "Content-Type: application/json" \
  -d '{}' 2>&1 | head -5
```

Expected: HTTP `401 Unauthorized` with a JSON body like `{"error":"unauthorized"}` (or similar). This proves the tunnel routes correctly to ABERP's relay endpoint AND that ABERP is enforcing auth (it should — it's a 401 without a bearer token).

### V-4 — Fetch (or create) the email relay token

**WHERE:** second Mac terminal.

```sh
security find-generic-password -a "$USER" -s "aberp.email_relay.prod.email_relay_token" -w 2>&1
```

Expected: a 64-character hex string (your relay token).

**Stuck?** If the command says "The specified item could not be found in the keychain", the token doesn't exist yet. Create one:

```sh
TOKEN=$(openssl rand -hex 32) && \
  security add-generic-password -a "$USER" -s "aberp.email_relay.prod.email_relay_token" -w "$TOKEN" -U && \
  echo "$TOKEN"
```

Save the printed token somewhere safe — you'll paste it into the Lightsail env file in §9.

### V-5 — Send a real test email through the tunnel

**WHERE:** second Mac terminal.

```sh
TOKEN=$(security find-generic-password -a "$USER" -s "aberp.email_relay.prod.email_relay_token" -w)
curl -i -X POST https://aberp.abenerp.com/api/internal/send-email \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":["ervin@aben.ch"],"subject":"prod-prod tunnel test","body_text":"If you see this email, the tunnel + ABERP relay + SMTP all work end to end."}'
```

Expected: HTTP `200 OK` with a JSON body containing `"audit_id":"..."`. Then check your email inbox — the test message should arrive within ~30 seconds.

**Stuck?** If the curl returned 200 but no email arrived, the tunnel is fine and the failure is downstream in ABERP's SMTP send. Check ABERP's main log window for SMTP errors. If the curl returned 401, the token is wrong — re-fetch with V-4 and try again.

---

## §8 — Service management reference

The launchd service was installed in §3 S-5 by the token-based one-liner. It runs in the background, survives reboots and lid-close, and starts at boot. This section is a reference for managing it later — you don't need to do anything here for the initial bring-up.

### L-1 — Confirm the service is loaded

**WHERE:** Mac terminal.

```sh
sudo launchctl list | grep cloudflared
```

Expected: one line showing `com.cloudflare.cloudflared` with a numeric PID (not `-`). Same check as §3 S-6 and §7 V-1.

### L-2 — Restart the service after editing `config.yml`

**WHERE:** Mac terminal.

```sh
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

Use this whenever you change `~/.cloudflared/config.yml` (e.g., to point at a different ABERP port). The daemon does not hot-reload the YAML.

### L-3 — Stop or uninstall the service

**WHERE:** Mac terminal.

To stop and remove the service entirely:

```sh
sudo cloudflared service uninstall
```

To reinstall, copy a fresh one-liner from the Zero Trust dashboard (§3 S-4) and re-run it.

---

## §9 — Wire the storefront to the tunnel (Lightsail SSH)

The storefront on Lightsail needs to know the public tunnel URL (`https://aberp.abenerp.com`) and the email relay token from V-4 / V-5.

### D-1 — Open an SSH session to Lightsail

**WHERE:** Browser tab at <https://lightsail.aws.amazon.com>.

Click on your storefront instance row. On the instance page, click the orange **Connect using SSH** button. A new browser tab opens with a terminal inside it (this is your SSH session).

### D-2 — Pull the latest storefront code

**WHERE:** Lightsail SSH session.

```sh
cd /path/to/ABERP-site && git pull origin main
```

Replace `/path/to/ABERP-site` with the actual directory the storefront is checked out in.

**Stuck?** If you don't know the path, find it:

```sh
sudo find / -name aberp-site -type d 2>/dev/null
```

Expected: the path is printed. Use that path.

Expected after `git pull`: `Already up to date.` or a clean fast-forward to a recent commit.

### D-3 — Open the storefront env file

**WHERE:** Lightsail SSH session.

```sh
sudo nano /etc/aberp-site.env
```

Expected: nano opens, showing the existing env vars.

### D-4 — Add or update the tunnel URL, relay token, and prod-mode flag

**WHERE:** nano editor inside the SSH session.

Scroll to the bottom of the file. Paste these three lines, replacing the token placeholder with the 64-character hex string from V-4 or V-5.

```
ABERP_INTERNAL_BASE_URL=https://aberp.abenerp.com
ABERP_EMAIL_RELAY_TOKEN=<paste-the-64-char-hex-token-here>
ABERP_DEV_MODE=0
```

If any of those three keys already appear earlier in the file with different values, delete the older lines so only the new values remain. Otherwise the older one might win.

Save and exit nano:

- `Ctrl+O`, then press Enter to confirm the filename.
- `Ctrl+X` to exit.

### D-5 — Restart the storefront service

**WHERE:** Lightsail SSH session.

```sh
sudo systemctl restart aberp-site
```

Expected: no output (silent success).

**Stuck?** If you see an error, check the service status:

```sh
sudo systemctl status aberp-site
```

The most common cause is a typo in the env file (a stray space, a missing `=`, etc.). Re-edit `/etc/aberp-site.env` and fix.

### D-6 — Confirm the env file is being loaded

**WHERE:** Lightsail SSH session.

```sh
sudo systemctl show aberp-site | grep -E "Environment(File)?"
```

Expected: at least one line referencing `/etc/aberp-site.env`.

### D-7 — Watch the startup log for ~10 seconds

**WHERE:** Lightsail SSH session.

```sh
sudo journalctl -u aberp-site -f -n 50
```

Expected: clean startup lines. No errors about missing env vars, no panics. Press `Ctrl+C` after ~10 seconds to stop tailing.

---

## §10 — Pilot end-to-end test

This is the real prod-to-prod customer pilot. Have your email inbox open in a separate browser tab so you can watch emails arrive in real time.

### E-1 — Open the quote form

**WHERE:** Browser tab at <https://abenerp.com/quote>.

Expected: the storefront submission form. The **Material** dropdown should show real grades like "Stainless Steel 304", "Aluminum 6061-T6", etc. — those are coming from ABERP's catalogue push through the new tunnel. Seeing them confirms the catalogue push is working.

**Stuck?** If the dropdown is empty or shows placeholders only, ABERP's catalogue push hasn't reached the storefront. Check ABERP's main log for catalogue push errors.

### E-2 — Fill the form

**WHERE:** storefront form.

- **Name:** anything (e.g., "Pilot Test").
- **Email:** `ervin@aben.ch`.
- **Material:** pick `304` or `6061-T6` from the dropdown (must be a real ABERP grade — do not pick "unknown" or leave blank).
- **Quantity:** `1`.
- **Needed by:** a date 7 days from today.
- **File:** upload a small STL file. Anything simple — a cube, a sphere, a small bracket. Avoid huge files for the pilot.
- **Privacy consent:** tick the box.

### E-3 — Submit

**WHERE:** storefront form. Click **Submit**.

Expected: a success page "Get a quote — Thanks, we have your request" with a quote reference UUID. Copy the reference somewhere — you'll match it against ABERP's row in E-5.

### E-4 — Watch for the "Submission received" email

**WHERE:** email inbox.

Expected: within ~10 seconds, an email from Áben Consulting titled "Submission received" (bilingual HU + EN body).

**Stuck?** If the email doesn't arrive, the storefront's `/api/quote` handler failed to relay through ABERP. Check ABERP's main log and Lightsail journalctl (the `sudo journalctl -u aberp-site -f` tail from D-7).

### E-5 — Watch the row appear in ABERP

**WHERE:** ABERP desktop app, **Auto-árazás** (Pricing) tab.

Expected: within ~60 seconds, a new row appears with the quote reference from E-3. Watch the State column cycle through:

```
Beérkezett (Received) → Extracting → Pricing → Rendering → PostingBack → Posted
```

Total time for a simple STL: ~30–60 seconds.

### E-6 — Watch for the "Quote ready" email

**WHERE:** email inbox.

Expected: within ~10 seconds of the row reaching `Posted`, an email titled "Quote ready" arrives with:

- A PDF attachment showing the indicative quote (price breakdown, valid-until date).
- A "Click to accept" button that links to a `/q/{id}/accept?ts=...&sig=...` URL on `abenerp.com`.

### E-7 — Open the accept link

**WHERE:** click the "Click to accept" button in the email.

Expected: a quote status page opens, showing:

- The quote summary.
- A big input field labeled "Type ACCEPT to confirm".
- A DEAL / Confirm button (initially disabled).

### E-8 — Type ACCEPT and confirm

**WHERE:** the accept page in the browser.

Type the literal word `ACCEPT` — case-sensitive, all capitals — into the input field. The input border should change from red to green and the Confirm button should become enabled.

Click **Confirm**.

Expected: a "Quote approved" thank-you page.

### E-9 — Final confirmations

**WHERE:** email inbox.

Expected: within ~10 seconds, a "Thank you for accepting" email arrives.

**WHERE:** ABERP desktop app, **Ajánlatok** (Quotes) tab.

Expected: the quote appears in the Quotes tab with state `approved`, ready for the operator-side DEAL flow.

If you got here without falling out at any step, **the prod-prod pipeline is live.** Document the result wherever you track that.

(The DEAL flow itself is operator-side and lives in the existing walkthrough — out of scope for this pilot.)

---

## §11 — Troubleshooting

### T1 — Connector daemon is healthy in the dashboard but `https://aberp.abenerp.com` returns HTTP 530 / "no route to backend"

The daemon is running but it isn't picking up the local `~/.cloudflared/config.yml`. Most common causes, in order:

1. The config file is missing. Confirm:

   ```sh
   ls ~/.cloudflared/config.yml
   ```

   If missing, re-run §6 step C-2.

2. The config file exists but the daemon was started before you wrote it. Reload:

   ```sh
   sudo launchctl kickstart -k system/com.cloudflare.cloudflared
   ```

3. The YAML is malformed. Validate:

   ```sh
   cloudflared tunnel ingress validate
   ```

   Fix any error it prints, then kickstart again.

### T2 — `dig aberp.abenerp.com +short` returns empty

DNS hasn't propagated yet. Wait 5 more minutes and re-check. If still empty after 10 minutes, the most likely cause is a typo in the Route 53 record's Value field. Go back to the Route 53 console (R-1), open the record, and check the Value matches `<UUID>.cfargotunnel.com` exactly.

### T3 — Pilot submission email never arrives, but ABERP shows the new row

Relay token mismatch between Mac and Lightsail.

**On Lightsail SSH:**

```sh
grep RELAY_TOKEN /etc/aberp-site.env
```

**On Mac terminal:**

```sh
security find-generic-password -a "$USER" -s "aberp.email_relay.prod.email_relay_token" -w
```

The two values must be identical. If they aren't, re-edit `/etc/aberp-site.env` (D-3, D-4) and restart the service (D-5).

### T4 — Pilot submission shows "Sikertelen / Failed" with "material grade `unknown` is not in the catalogue snapshot"

You either selected "unknown" or the catalogue dropdown wasn't populated when you submitted. Refresh <https://abenerp.com/quote> in the browser and pick a real grade from the dropdown.

### T5 — ABERP's Auto-árazás tab shows no new row 90+ seconds after submission

ABERP's quote-intake daemon isn't polling the storefront. For prod-prod with the tunnel running, ABERP polls `https://abenerp.com` directly (over the public internet — the tunnel handles the reverse direction). Check **Maintenance → Quote Intake** in ABERP; the Base URL field should be `https://abenerp.com`, NOT `http://localhost:5173`.

### T6 — `cloudflared` logs show "no connections" repeatedly

`cloudflared` is up and connected to Cloudflare but cannot reach `localhost:18443`. Either ABERP isn't running, or it's listening on a different port.

```sh
lsof -nP -i4TCP -sTCP:LISTEN -c aberp
```

Confirm the port is `18443`. If it isn't, you launched ABERP via something other than `./run/dev-test.sh`. Either re-launch it via `./run/dev-test.sh` or edit `~/.cloudflared/config.yml` to match the actual port and restart the launchd service (`sudo launchctl kickstart -k system/com.cloudflare.cloudflared`).

### T7 — Curl from V-3 returns HTTP `502 Bad Gateway`

Same root cause as T6 — tunnel up, but ABERP not reachable on the expected port.

### T8 — AWS Console says "You do not have permission to view this hosted zone"

Your AWS credentials don't include Route 53 read/write. You need a different IAM user or role with `route53:ChangeResourceRecordSets` and `route53:ListHostedZones`. Ask the account holder.

### T9 — You signed into the wrong Cloudflare account in the Zero Trust dashboard

The token you copied in §3 S-4 is bound to the account where you created the tunnel. If that was the wrong account, the connector will appear in the wrong place (and may consume free-tier quota you didn't intend). Uninstall the service (`sudo cloudflared service uninstall`), sign out at <https://one.dash.cloudflare.com>, sign back in with the right account, and redo §3 S-2 through S-6.

### T10 — Pilot price PDF arrives but the email body is English only (not bilingual)

The bilingualization fix is on storefront commit `81afac2` (S293) and later. On Lightsail SSH:

```sh
cd /path/to/aberp-site && git log -1 --oneline
```

If you see a commit older than `81afac2`, run `git pull origin main` (re-do D-2) and restart the service (D-5).

### T11 — `cloudflared tunnel login` hangs at "Waiting for login..." indefinitely

You followed the legacy cert-based login flow (the one not used by this runbook). That flow requires authorizing at least one Cloudflare-managed DNS zone in the browser tab Cloudflare opens; if your DNS lives outside Cloudflare (e.g., Route 53), no zone appears, the "Authorize" button never shows up, and the terminal loops forever. Stop the legacy command (Ctrl+C) and use the Zero Trust token-based flow in §3 instead — that flow does not need a Cloudflare-managed zone.

### T12 — Zero Trust dashboard says "Domain not found" when adding a public hostname

The dashboard's **Public Hostnames** tab can only attach hostnames to Cloudflare-managed DNS zones. Your DNS is on Route 53, so the dropdown is empty (or doesn't list `abenerp.com`). Skip the dashboard tab entirely; route via local `~/.cloudflared/config.yml` per §6. After editing the YAML, kickstart the daemon (§7 V-1 or §8 L-2).

### T13 — After running the token install command, `launchctl list | grep cloudflared` returns nothing

The install command failed silently — almost always because the token got truncated when you copied it from the dashboard. The token is ~200 characters of base64; if you grabbed only part of it, `cloudflared service install` parses successfully but no service ends up registered.

Re-copy the FULL one-liner from the Zero Trust dashboard (§3 S-4) — use the copy icon next to the command rather than selecting it by hand, since manual selection routinely drops characters at either end. Paste and re-run.

If `launchctl list` still shows nothing, run the install command WITHOUT `sudo` to see the error message that the launchd registration is suppressing:

```sh
cloudflared service install <paste-token-here>
```

The error tells you whether it's a malformed token, an account-permissions problem, or something else.

---

## §12 — Open questions

- **Q1.** If a step gets stuck on a failure mode not covered in §11, capture the literal error and append a new T-row in the next pass of this runbook.
- **Q2.** Once this works prod-to-prod, can we replace the "ABERP must be launched via `./run/dev-test.sh` for a stable port" assumption with a tunnel-aware launcher that picks the port and rewrites `~/.cloudflared/config.yml` on every launch? Backlog item.

---

## References

- [ADR-0008](../adr/0008-aberp-storefront-network-topology.md) — the decision this runbook executes (Option B Cloudflare Tunnel).
- [ADR-0007](../adr/0007-storefront-email-relay-via-aberp.md) — the email relay contract the tunnel carries.
- [ADR-0004](../adr/0004-priced-quote-writeback.md) — the priced writeback contract the tunnel carries.
- [`docs/walkthroughs/end-to-end-auto-quote-test.md`](../walkthroughs/end-to-end-auto-quote-test.md) — the local-dev end-to-end test that this runbook makes obsolete for the prod-prod path.
- Cloudflare Tunnel docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
