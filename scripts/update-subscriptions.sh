#!/bin/sh
#
# PinPoint - Subscription Auto-Update Script
# This script is called by cron to update VPN subscriptions
#

PINPOINT_DIR="/opt/pinpoint"
API_URL="http://127.0.0.1:8080/api/subscriptions/refresh"
LOG_FILE="/var/log/pinpoint/subscription-update.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"
}

log "Starting subscription update..."

# Call API to refresh all subscriptions
RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json")

if echo "$RESPONSE" | grep -q '"status"'; then
    log "Subscription update completed: $RESPONSE"
else
    log "Subscription update failed: $RESPONSE"
fi
