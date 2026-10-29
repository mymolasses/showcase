# Automatic certificate updates

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
