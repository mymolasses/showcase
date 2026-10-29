#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/littlepond.eu.org ]; then
    /usr/bin/python3 /usr/local/sbin/showcase-install-root-certificate.py certbot
fi
