# Personal hotspot HTTPS entry

On 2026-10-29, the personal entry was configured as
`https://car.littlepond.eu.org/`. Cloudflare has a DNS-only A record pointing to
`99.99.99.99`. Keep the browser URL as the domain: the issued certificate covers
`car.littlepond.eu.org`, not the numeric IP address.

The verified 1.5.0 / 1015 app already provides the local `/32` alias and HTTPS
443 / same-origin WSS relay. This package uses that existing implementation.
It does not include a system VPN. Reachability from an actual Tesla connected
to the iPhone hotspot still needs hardware verification.

A Let's Encrypt certificate was issued using DNS-01 and its complete chain was
verified against system trust. It expires at **2027-01-27 07:19:03 UTC**. Its
provided chain reaches ISRG Root X1 through a cross-signed Root YR certificate.
Certificate acceptance on the target iPhone and Tesla remains untested.

`tools/personalize_tls_deb.py` adds the identity and configuration to the verified
1.5.0 package without changing any original runtime bytes or app bundle files.
The install hook writes the P12 and domain/password JSON to
`/var/mobile/Library/Showcase/` with mode 0600 and mobile ownership. If prior
files exist, their first backup is retained with `.before-personal` appended.

The private personal package is under `.private/personal-package/`. It contains
the certificate private key and must never be published to the public repository,
GitHub Releases, or public Actions artifacts. No Cloudflare API token is included.
Checksums, certificate metadata, and original-payload equality were verified.

Install the personal package on the existing Dopamine rootless iPhone, reopen
Showcase+, and enable Browser Output and Browser Network Probe under Display.
Start CarPlay, connect the Tesla to the iPhone hotspot, and open the domain URL.
Check Network Status if HTTPS does not become ready. Do not bypass TLS warnings.

Certificate renewal is not automatic in this personal package. Renew via DNS-01,
then rebuild and reinstall the personal package before expiry. The separate
managed-access implementation remains work in progress and was not deployed for
this setup.
