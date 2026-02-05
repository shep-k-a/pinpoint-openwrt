#!/bin/sh
# Migrate sing-box TUN: deprecated inet4_address -> "address" array (1.10+)
# Idempotent. Run from /etc/init.d/sing-box start.

CONF="/etc/sing-box/config.json"
[ ! -f "$CONF" ] && exit 0
sed -i 's/"inet4_address": "10\.0\.0\.1\/30",/"address": ["10.0.0.1\/30"],/' "$CONF" 2>/dev/null
sed -i 's/"inet4_address": "10\.0\.0\.1\/30"/"address": ["10.0.0.1\/30"]/' "$CONF" 2>/dev/null
exit 0
