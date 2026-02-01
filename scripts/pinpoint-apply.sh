#!/bin/sh
# Pinpoint - Apply routing rules
# This script applies IP lists to nftables sets

set -e

PINPOINT_DIR="/opt/pinpoint"
DATA_DIR="$PINPOINT_DIR/data"
LISTS_DIR="$DATA_DIR/lists"

log() {
    logger -t pinpoint "$1"
    echo "[pinpoint] $1"
}

# Add IPs to nftables set
add_ips_to_set() {
    local file="$1"
    local set_name="$2"
    local count=0
    
    if [ ! -f "$file" ]; then
        log "File not found: $file"
        return 1
    fi
    
    log "Loading IPs from $file to set $set_name..."
    
    # Process file line by line
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip comments and empty lines
        case "$line" in
            \#*|"") continue ;;
        esac
        
        # Clean up the line (remove whitespace, carriage returns)
        ip=$(echo "$line" | tr -d '\r' | xargs)
        
        # Validate IP/CIDR format (basic check)
        case "$ip" in
            *.*.*.*) 
                nft add element inet pinpoint "$set_name" { "$ip" } 2>/dev/null && count=$((count + 1))
                ;;
        esac
    done < "$file"
    
    log "Added $count IPs to $set_name from $file"
}

# Load all enabled service lists
load_service_lists() {
    local services_file="$DATA_DIR/services.json"
    
    if [ ! -f "$services_file" ]; then
        log "Services file not found: $services_file"
        return 0
    fi
    
    log "Loading enabled service lists..."
    
    # Parse JSON and load enabled services (requires jsonfilter from OpenWrt)
    if command -v jsonfilter >/dev/null 2>&1; then
        # Get list of enabled services
        for service_id in $(jsonfilter -i "$services_file" -e '@.services[*].id'); do
            enabled=$(jsonfilter -i "$services_file" -e "@.services[@.id='$service_id'].enabled")
            if [ "$enabled" = "true" ]; then
                list_file="$LISTS_DIR/${service_id}.txt"
                if [ -f "$list_file" ]; then
                    add_ips_to_set "$list_file" "tunnel_nets"
                fi
            fi
        done
    else
        # Fallback: load all .txt files in lists directory
        for list_file in "$LISTS_DIR"/*.txt; do
            [ -f "$list_file" ] && add_ips_to_set "$list_file" "tunnel_nets"
        done
    fi
}

# Check if dnsmasq supports nftset
check_nftset_support() {
    dnsmasq --help 2>&1 | grep -q nftset
}

# Generate dnsmasq config from domain lists
generate_dnsmasq_config() {
    local domains_file="$DATA_DIR/domains.json"
    local output_file="/etc/dnsmasq.d/pinpoint.conf"
    
    # Check if dnsmasq supports nftset
    if ! check_nftset_support; then
        log "dnsmasq does not support nftset - skipping config (using CIDR blocks only)"
        rm -f "$output_file" /tmp/dnsmasq.d/pinpoint.conf 2>/dev/null
        return
    fi
    
    log "Generating dnsmasq config..."
    
    # Start fresh
    cat > "$output_file" << 'EOF'
# Pinpoint - Domain routing via nftset
# Auto-generated - do not edit manually
# Domains resolved here will have their IPs added to nftables set

EOF
    
    # Add domains from JSON file
    if [ -f "$domains_file" ] && command -v jsonfilter >/dev/null 2>&1; then
        for domain in $(jsonfilter -i "$domains_file" -e '@.domains[*].domain'); do
            echo "nftset=/$domain/4#inet#pinpoint#tunnel_ips" >> "$output_file"
        done
    fi
    
    # Add domains from services
    local services_file="$DATA_DIR/services.json"
    if [ -f "$services_file" ] && command -v jsonfilter >/dev/null 2>&1; then
        for service_id in $(jsonfilter -i "$services_file" -e '@.services[*].id'); do
            enabled=$(jsonfilter -i "$services_file" -e "@.services[@.id='$service_id'].enabled")
            if [ "$enabled" = "true" ]; then
                # Load domains for this service
                domains_list="$LISTS_DIR/${service_id}_domains.txt"
                if [ -f "$domains_list" ]; then
                    while IFS= read -r domain || [ -n "$domain" ]; do
                        case "$domain" in
                            \#*|"") continue ;;
                        esac
                        domain=$(echo "$domain" | tr -d '\r' | xargs)
                        [ -n "$domain" ] && echo "nftset=/$domain/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                    done < "$domains_list"
                fi
            fi
        done
    fi
    
    log "dnsmasq config generated: $output_file"
}

# Flush and reload all rules
reload_all() {
    log "Reloading all pinpoint rules..."
    
    # Flush existing sets
    nft flush set inet pinpoint tunnel_ips 2>/dev/null || true
    nft flush set inet pinpoint tunnel_nets 2>/dev/null || true
    
    # Load service IP lists
    load_service_lists
    
    # Generate and apply dnsmasq config
    generate_dnsmasq_config
    
    # Restart dnsmasq
    /etc/init.d/dnsmasq restart
    
    log "Reload complete"
}

# Show current status
show_status() {
    echo "=== Tunnel IPs (from DNS) ==="
    nft list set inet pinpoint tunnel_ips 2>/dev/null | grep -E "elements|timeout" | head -20
    echo ""
    echo "=== Tunnel Networks (from lists) ==="
    nft list set inet pinpoint tunnel_nets 2>/dev/null | grep -E "elements" | head -20
    echo ""
    echo "=== Traffic Counters ==="
    nft list chain inet pinpoint prerouting 2>/dev/null | grep counter
}

case "${1:-reload}" in
    reload)
        reload_all
        ;;
    status)
        show_status
        ;;
    add-ip)
        [ -z "$2" ] && echo "Usage: $0 add-ip <ip/cidr>" && exit 1
        nft add element inet pinpoint tunnel_nets { "$2" }
        log "Added $2 to tunnel_nets"
        ;;
    add-domain)
        [ -z "$2" ] && echo "Usage: $0 add-domain <domain>" && exit 1
        if ! check_nftset_support; then
            echo "Error: dnsmasq does not support nftset. Install dnsmasq-full."
            exit 1
        fi
        echo "nftset=/$2/4#inet#pinpoint#tunnel_ips" >> /etc/dnsmasq.d/pinpoint.conf
        /etc/init.d/dnsmasq restart
        log "Added domain $2"
        ;;
    *)
        echo "Usage: $0 {reload|status|add-ip <ip>|add-domain <domain>}"
        exit 1
        ;;
esac
