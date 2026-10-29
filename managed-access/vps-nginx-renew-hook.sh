#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/setup.littlepond.eu.org ]; then
    /usr/sbin/nginx -t
    systemctl reload nginx
fi
