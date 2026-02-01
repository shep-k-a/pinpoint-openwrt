#!/bin/sh
# PinPoint - List Updater (Shell version for low-memory devices)
# SPDX-License-Identifier: GPL-2.0-only

PINPOINT_DIR="/opt/pinpoint"
DATA_DIR="$PINPOINT_DIR/data"
LISTS_DIR="$DATA_DIR/lists"
SERVICES_FILE="$DATA_DIR/services.json"
DEVICES_FILE="$DATA_DIR/devices.json"
DNSMASQ_CONF="/tmp/dnsmasq.d/pinpoint.conf"

log() {
    echo "[pinpoint] $1"
    logger -t pinpoint "$1"
}

# Extract value from JSON (simple grep-based parser)
json_get() {
    local file="$1"
    local key="$2"
    grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/'
}

# Check if service is enabled
service_enabled() {
    local service_id="$1"
    grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$service_id\"" "$SERVICES_FILE" && \
    awk -v id="$service_id" '
        BEGIN { found=0; enabled=0 }
        /"id"[[:space:]]*:[[:space:]]*"'"$service_id"'"/ { found=1 }
        found && /"enabled"[[:space:]]*:[[:space:]]*true/ { enabled=1; exit }
        found && /\}/ { exit }
        END { exit !enabled }
    ' "$SERVICES_FILE"
}

# Download file with curl
download() {
    local url="$1"
    local output="$2"
    curl -sf --connect-timeout 10 -o "$output" "$url" 2>/dev/null
}

# Parse Keenetic route format
parse_keenetic() {
    grep -i "^route add" | while read -r line; do
        ip=$(echo "$line" | awk '{print $3}')
        mask=$(echo "$line" | awk '{print $5}')
        case "$mask" in
            255.255.255.255) echo "$ip/32" ;;
            255.255.255.0)   echo "$ip/24" ;;
            255.255.0.0)     echo "$ip/16" ;;
            255.0.0.0)       echo "$ip/8" ;;
            *) echo "$ip/32" ;;
        esac
    done | sort -u
}

# Generate dnsmasq config
generate_dnsmasq() {
    log "Generating dnsmasq config..."
    
    mkdir -p "$(dirname "$DNSMASQ_CONF")"
    
    cat > "$DNSMASQ_CONF" << 'HEADER'
# PinPoint - Domain routing via nftset
# Auto-generated - do not edit manually
HEADER
    
    # Extract domains from services.json
    if [ -f "$SERVICES_FILE" ]; then
        grep -o '"domains"[[:space:]]*:[[:space:]]*\[[^]]*\]' "$SERVICES_FILE" | \
        grep -o '"[a-zA-Z0-9.-]*\.[a-zA-Z]*"' | \
        tr -d '"' | sort -u | while read -r domain; do
            [ -n "$domain" ] && echo "nftset=/$domain/4#inet#pinpoint#tunnel_ips"
        done >> "$DNSMASQ_CONF"
    fi
    
    # Add domain files from lists
    for f in "$LISTS_DIR"/*_domains.txt; do
        [ -f "$f" ] || continue
        while read -r domain; do
            [ -n "$domain" ] && echo "nftset=/$domain/4#inet#pinpoint#tunnel_ips"
        done < "$f" >> "$DNSMASQ_CONF"
    done
    
    log "dnsmasq config generated"
}

# Load nftables sets
load_nftables() {
    log "Loading nftables sets..."
    
    # Flush existing set
    nft flush set inet pinpoint tunnel_nets 2>/dev/null
    
    local loaded=0
    
    # Load CIDR files
    for f in "$LISTS_DIR"/*.txt; do
        [ -f "$f" ] || continue
        
        # Skip domain files
        case "$f" in
            *_domains.txt|*_static.txt) continue ;;
        esac
        
        # Check if service is enabled
        service_id=$(basename "$f" .txt)
        service_enabled "$service_id" || continue
        
        while read -r cidr; do
            [ -z "$cidr" ] && continue
            case "$cidr" in
                */*) ;;
                *) cidr="$cidr/32" ;;
            esac
            nft add element inet pinpoint tunnel_nets "{ $cidr }" 2>/dev/null && loaded=$((loaded + 1))
        done < "$f"
    done
    
    # Add essential Meta/Instagram IP ranges ONLY if instagram/meta/facebook is enabled
    # These are critical because ISP DNS hijacking may return CDN IPs
    if service_enabled "instagram" || service_enabled "meta" || service_enabled "facebook"; then
        for cidr in \
            "31.13.24.0/21" \
            "31.13.64.0/18" \
            "157.240.0.0/16" \
            "179.60.192.0/22" \
            "185.60.216.0/22" \
            "66.220.144.0/20" \
            "69.63.176.0/20" \
            "69.171.224.0/19" \
            "129.134.0.0/16" \
            "147.75.208.0/20"; do
            nft add element inet pinpoint tunnel_nets "{ $cidr }" 2>/dev/null && loaded=$((loaded + 1))
        done
    fi
    
    log "Loaded $loaded CIDRs to nftables"
}

# Clean device rules
clean_device_rules() {
    log "Cleaning old device rules..."
    
    # Get handles of device rules
    nft -a list chain inet pinpoint prerouting 2>/dev/null | \
    grep 'pinpoint: device' | \
    sed 's/.*# handle \([0-9]*\)/\1/' | \
    while read -r handle; do
        nft delete rule inet pinpoint prerouting handle "$handle" 2>/dev/null
    done
}

# Generate device rules
generate_device_rules() {
    log "Generating device rules..."
    
    clean_device_rules
    
    [ -f "$DEVICES_FILE" ] || return
    
    # Simple JSON parsing for devices
    # Format: extract id, ip, mode, enabled for each device
    awk '
        BEGIN { in_device=0 }
        /"devices"/ { in_devices=1 }
        in_devices && /\{/ { in_device=1; id=""; ip=""; mode="default"; enabled=0 }
        in_device && /"id"/ { gsub(/.*"id"[[:space:]]*:[[:space:]]*"|".*/, ""); id=$0 }
        in_device && /"ip"/ { gsub(/.*"ip"[[:space:]]*:[[:space:]]*"|".*/, ""); ip=$0 }
        in_device && /"mode"/ { gsub(/.*"mode"[[:space:]]*:[[:space:]]*"|".*/, ""); mode=$0 }
        in_device && /"enabled"[[:space:]]*:[[:space:]]*true/ { enabled=1 }
        in_device && /\}/ {
            if (enabled && ip != "") {
                print id, ip, mode
            }
            in_device=0
        }
    ' "$DEVICES_FILE" | while read -r id ip mode; do
        case "$mode" in
            vpn_all)
                log "  Device $id: all traffic via VPN"
                nft add rule inet pinpoint prerouting ip saddr "$ip" meta mark set 0x100 counter comment "\"pinpoint: device $id vpn_all\""
                ;;
            direct_all)
                log "  Device $id: all traffic direct"
                nft add rule inet pinpoint prerouting ip saddr "$ip" return comment "\"pinpoint: device $id direct_all\""
                ;;
            custom)
                log "  Device $id: custom mode (not implemented in lite)"
                ;;
        esac
    done
}

# Restart dnsmasq
restart_dnsmasq() {
    log "Restarting dnsmasq..."
    /etc/init.d/dnsmasq restart
}

# Save status
save_status() {
    local now=$(date "+%Y-%m-%d %H:%M:%S")
    local ts=$(date +%s)
    
    cat > "$DATA_DIR/status.json" << EOF
{
  "last_update": "$now",
  "last_update_timestamp": $ts
}
EOF
}

# Main update
update_all() {
    log "=== Starting list update ==="
    
    mkdir -p "$LISTS_DIR"
    
    generate_dnsmasq
    load_nftables
    generate_device_rules
    restart_dnsmasq
    save_status
    
    log "=== Update complete ==="
}

# Entry point
case "${1:-update}" in
    update)
        update_all
        ;;
    status)
        echo "PinPoint Status:"
        echo "  Services file: $([ -f "$SERVICES_FILE" ] && echo "OK" || echo "MISSING")"
        echo "  Devices file: $([ -f "$DEVICES_FILE" ] && echo "OK" || echo "MISSING")"
        echo "  Lists: $(ls -1 "$LISTS_DIR"/*.txt 2>/dev/null | wc -l) files"
        ;;
    *)
        echo "Usage: $0 {update|status}"
        exit 1
        ;;
esac
