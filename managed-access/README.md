# Automatic certificate updates

## Existing VPS deployment

The original AssppWeb server is also suitable for hosting this service. In that
deployment, `node-server.mjs` runs the same authenticated API behind a dedicated
Nginx virtual host at `setup.littlepond.eu.org`. It uses a mode-0600 atomic file
store instead of a Cloudflare Durable Object. Transactions are serialized and
persist atomically; failed activation writes cannot leave a partial binding.
The service container uses the already-installed Node runtime image with its
own unprivileged user, state directory and loopback-only published port.

The setup hostname points to the VPS and uses its existing Certbot installation
with HTTP-01 webroot validation. Its deploy hook reloads Nginx after renewal.
The `car` hostname remains DNS-only at 99.99.99.99 and needs DNS-01 validation.
The VPS therefore needs one zone-scoped DNS edit token; no Workers deployment
token is required. DNS credentials stay on the VPS, not the phone or GitHub.
The daily systemd timer and `managed_certificate.py` handle the CarPlay identity.
Existing AssppWeb containers and the original domain's certificate files are
outside the service's deployment paths.

The files `vps-nginx.conf`, `vps-renew.service`, `vps-renew.timer`, and
`vps-nginx-renew-hook.sh` describe the separate virtual host and renewal units.

## Optional Cloudflare deployment

`car.littlepond.eu.org` stays DNS-only at 99.99.99.99. The iPhone's existing
local route handles HTTPS/WSS; this change does not add a system VPN or relay
video through the Internet.

`setup.littlepond.eu.org` is a dedicated Cloudflare Worker with a private SQLite
Durable Object. It holds the current P12 identity, hashed activation/client
credentials, and owned DNS challenge record IDs. The zone DNS token stays in
Worker secrets; it never enters the phone or GitHub Actions. Cloudflare scopes
DNS edit access to a whole zone, not an individual hostname. The service API
restricts the issuer to `_acme-challenge.car.littlepond.eu.org` and refuses to
delete challenge records changed by someone else.

Deploy `renewal-workflow.yml` and `tools/managed_certificate.py` to the private
`mymolasses/showcase-certificate-renewal` repository. Public GitHub repositories
can have scheduled workflows disabled after 60 days of inactivity, so the app's
public repository is not the production renewal scheduler. The private job runs
daily at 11:17 Hong Kong time and renews when fewer than 35 days remain. Its
issuer secret permits challenge creation/cleanup and certificate publication,
not client enrollment or DNS changes for other names. Private keys exist only
in the isolated runner temporary directory and the authenticated identity store;
no P12 artifact or log content is published.

The personal 1.6.0 package carries a one-use activation code valid for seven
days. First activation binds a random device nonce and returns a scoped refresh
token. The phone stores that token and its validated identity in mode-0600 files
under `/var/mobile/Library/Showcase/`. It checks on launch/foreground and at most
every six hours while running. No background operation while iOS suspends the
app is promised; it catches up on the next launch. A service or network failure
retains the previous usable identity. Redirects, oversized responses, invalid
hostnames, expired/untrusted certificates and bad P12 passwords cannot replace
the cache. HTTPS hot reload preserves existing WSS connections.

One app upgrade is necessary to add the updater to 1.5.0. Future certificate
renewals require no package reinstall. Public app packages contain no activation
code, DNS token or certificate private key. Do not publish personal installers.

Use `tools/deploy_managed_access.py` with a zone-scoped DNS edit token and a
separate short-lived Workers Scripts edit token for deployment. Keep credentials
in `.private/`; creating persistent credentials requires explicit action-time
approval when using the browser. The deployment helper refuses to replace an
occupied setup hostname or unrelated Worker and preserves the car A record.
