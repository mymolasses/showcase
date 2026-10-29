# Personal hotspot HTTPS and automatic renewal

The personal CarPlay entry is `https://car.littlepond.eu.org/`. Its DNS-only A record points to 99.99.99.99. Use the domain URL: the certificate covers that hostname, not the numeric IP. The existing local /32 route and HTTPS/WSS relay remain in use; this change does not add a system VPN.

## Personal 1.6.0 / 1016 installer

The private installer under `.private/personal-package/` contains a one-use, device-bound activation profile. It includes no DNS credential or certificate private key. Install this update once, then first open it within seven days to activate. Future certificate renewals require no package reinstall.

The phone downloads and validates its trusted P12 identity through authenticated HTTPS. It saves the identity in `/var/mobile/Library/Showcase/browser-managed-identity.json` and device authorization in `browser-managed-client.json`, both mode 0600. It checks on launch/foreground and every six hours while running, retaining a usable cached identity on network failures. iOS suspension is not background polling: the next launch catches up. New HTTPS handshakes use the new identity while existing WSS sessions continue. Invalid identities cannot replace the active certificate.

The earlier manual 1.5.0 installer wrote `browser-server.p12` and `browser-web.json` in the same directory. Those remain a manual fallback; a validated managed identity takes precedence in 1.6.0.

## Server deployment

The original VPS hosts an independent `showcase-access` container behind Nginx at `https://setup.littlepond.eu.org`. State lives privately in `/var/lib/showcase-access/`; the zone DNS credential is in root-only `/etc/showcase-access/service.env`, not on the phone or GitHub. Public app builds contain no activation credential, private P12 or DNS token.

`showcase-certificate-renew.timer` checks daily at 11:17 Hong Kong time and renews when fewer than 35 days remain. DNS-01 modifies only its owned `_acme-challenge.car` TXT records. A real issuance/publication succeeded; a client enrolled before renewal downloaded a different identity with the same authorization afterward. The timer is enabled and its service check succeeded. The unused private GitHub scheduler is disabled.

The setup hostname uses existing Certbot HTTP webroot validation. Its deploy hook validates and reloads Nginx after renewal.

## Original site's certificate directory

The original site keeps its own certificate. Certbot deployment and successful manual `acme.sh --renew -d littlepond.eu.org --ecc` invoke a shared validated installer. ACME writes to private staging first. The installer verifies public trust, hostname, lifetime and key pairing, preserves a newer active certificate, backs up prior files, and deploys the matching full chain and key to `/etc/v2ray-agent/tls/littlepond.eu.org.crt` and `.key`. It validates Nginx and reloads it, or starts it if stopped. Failed application rolls back.

The original site's Certbot staging renewal and deployment hook succeeded. Its externally served certificate fingerprint was verified against the newly installed certificate and the site returned HTTP 200. Private keys remained on the VPS.

Native updater, TLS hot reload, retained WSS, source provenance and package checks passed. Target iPhone and Tesla operation still require hardware testing; desktop/server checks do not establish D-gear behavior.
