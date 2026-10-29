#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/setup.littlepond.eu.org ]; then
    exec 9>/run/lock/showcase-root-certificate.lock
    flock -x 9
    /usr/sbin/nginx -t
    systemctl reload nginx
fi
