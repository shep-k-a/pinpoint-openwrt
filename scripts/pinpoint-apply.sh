#!/bin/sh
# Pinpoint - Apply routing rules
# This script applies IP lists to nftables sets

set -e

PINPOINT_DIR="/opt/pinpoint"
DATA_DIR="$PINPOINT_DIR/data"
LISTS_DIR="$DATA_DIR/lists"
CUSTOM_FILE="$DATA_DIR/custom_services.json"

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

# Load custom IPs from services.json (user-added IPs)
load_service_custom_ips() {
    local services_file="$DATA_DIR/services.json"
    
    if [ ! -f "$services_file" ]; then
        return 0
    fi
    
    if ! command -v jsonfilter >/dev/null 2>&1; then
        log "jsonfilter not found, skipping service custom IPs"
        return 0
    fi
    
    log "Loading custom IPs from services..."
    
    local count=0
    for service_id in $(jsonfilter -i "$services_file" -e '@.services[*].id'); do
        enabled=$(jsonfilter -i "$services_file" -e "@.services[@.id='$service_id'].enabled")
        if [ "$enabled" = "true" ]; then
            # Get custom_ips array for this service
            custom_ips=$(jsonfilter -i "$services_file" -e "@.services[@.id='$service_id'].custom_ips[*]" 2>/dev/null)
            for ip in $custom_ips; do
                case "$ip" in
                    \#*|""|null) continue ;;
                esac
                ip_clean=$(echo "$ip" | tr -d '\r' | xargs)
                
                # Basic validation and fixing for /24 CIDR
                if echo "$ip_clean" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/24$'; then
                    local base_ip=$(echo "$ip_clean" | cut -d'.' -f1-3)
                    local last_octet=$(echo "$ip_clean" | cut -d'.' -f4 | cut -d'/' -f1)
                    local cidr_suffix=$(echo "$ip_clean" | cut -d'/' -f2)
                    
                    if [ "$last_octet" != "0" ]; then
                        local fixed_ip="${base_ip}.0/${cidr_suffix}"
                        log "Fixed IP format: $ip_clean -> $fixed_ip"
                        ip_clean="$fixed_ip"
                    fi
                fi
                
                if [ -n "$ip_clean" ]; then
                    if nft add element inet pinpoint tunnel_nets { "$ip_clean" } 2>/dev/null; then
                        count=$((count + 1))
                    fi
                fi
            done
        fi
    done
    
    [ $count -gt 0 ] && log "Added $count custom IPs/ranges to tunnel_nets from services"
}

# Load IPs from enabled custom services directly into nft set
load_custom_service_ips() {
    if [ ! -f "$CUSTOM_FILE" ]; then
        return 0
    fi
    
    if ! command -v jsonfilter >/dev/null 2>&1; then
        log "jsonfilter not found, skipping custom service IPs"
        return 0
    fi
    
    log "Loading IPs from custom services..."
    
    local count=0
    # For each enabled custom service, add its IPs to tunnel_nets
    for ip in $(jsonfilter -i "$CUSTOM_FILE" -e '@.services[@.enabled=true].ips[*]' 2>/dev/null); do
        case "$ip" in
            \#*|"") continue ;;
        esac
        ip_clean=$(echo "$ip" | tr -d '\r' | xargs)
        
        if [ -z "$ip_clean" ]; then
            continue
        fi
        
        # Fix common IP format errors (e.g., 52.33.95.61/24 -> 52.33.95.0/24)
        # If IP has /24 but last octet is not 0, fix it
        if echo "$ip_clean" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/24$'; then
            base_ip=$(echo "$ip_clean" | cut -d'/' -f1)
            last_octet=$(echo "$base_ip" | cut -d'.' -f4)
            if [ "$last_octet" != "0" ]; then
                # Fix to proper /24 network
                first_three=$(echo "$base_ip" | cut -d'.' -f1-3)
                ip_clean="${first_three}.0/24"
                log "Fixed IP format: $ip -> $ip_clean"
            fi
        fi
        
        # Add to tunnel_nets
        if nft add element inet pinpoint tunnel_nets { "$ip_clean" } 2>/dev/null; then
            count=$((count + 1))
        else
            log "Warning: Failed to add IP $ip_clean to tunnel_nets"
        fi
    done
    
    [ $count -gt 0 ] && log "Added $count IPs/ranges to tunnel_nets from custom services"
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
    
    # Ensure directory exists
    mkdir -p "$(dirname "$output_file")"
    
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
                        if [ -n "$domain" ]; then
                            # Add the base domain
                            echo "nftset=/$domain/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                            # Add www. version if not already present
                            case "$domain" in
                                www.*) 
                                    # If domain starts with www., also add without www.
                                    base_domain="${domain#www.}"
                                    [ -n "$base_domain" ] && echo "nftset=/$base_domain/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                                    ;;
                                *)
                                    # If domain doesn't start with www., also add www. version
                                    echo "nftset=/www.$domain/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                                    ;;
                            esac
                        fi
                    done < "$domains_list"
                fi
            fi
        done
    fi
    
    # Add domains from enabled custom services
    if [ -f "$CUSTOM_FILE" ] && command -v jsonfilter >/dev/null 2>&1; then
        for domain in $(jsonfilter -i "$CUSTOM_FILE" -e '@.services[@.enabled=true].domains[*]' 2>/dev/null); do
            case "$domain" in
                \#*|"") continue ;;
            esac
            d_clean=$(echo "$domain" | tr -d '\r' | xargs)
            if [ -n "$d_clean" ]; then
                # Add the base domain
                echo "nftset=/$d_clean/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                # Add www. version if not already present
                case "$d_clean" in
                    www.*) 
                        # If domain starts with www., also add without www.
                        base_domain="${d_clean#www.}"
                        [ -n "$base_domain" ] && echo "nftset=/$base_domain/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                        ;;
                    *)
                        # If domain doesn't start with www., also add www. version
                        echo "nftset=/www.$d_clean/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                        ;;
                esac
            fi
        done
    fi
    
    # Add custom domains from services.json (user-added)
    if [ -f "$services_file" ] && command -v jsonfilter >/dev/null 2>&1; then
        for service_id in $(jsonfilter -i "$services_file" -e '@.services[*].id'); do
            enabled=$(jsonfilter -i "$services_file" -e "@.services[@.id='$service_id'].enabled")
            if [ "$enabled" = "true" ]; then
                # Get custom_domains array for this service
                custom_domains=$(jsonfilter -i "$services_file" -e "@.services[@.id='$service_id'].custom_domains[*]" 2>/dev/null)
                for domain in $custom_domains; do
                    case "$domain" in
                        \#*|""|null) continue ;;
                    esac
                    d_clean=$(echo "$domain" | tr -d '\r' | xargs)
                    if [ -n "$d_clean" ]; then
                        echo "nftset=/$d_clean/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                        # Add www. version
                        case "$d_clean" in
                            www.*) 
                                base_domain="${d_clean#www.}"
                                [ -n "$base_domain" ] && echo "nftset=/$base_domain/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                                ;;
                            *)
                                echo "nftset=/www.$d_clean/4#inet#pinpoint#tunnel_ips" >> "$output_file"
                                ;;
                        esac
                    fi
                done
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
    
    # Load custom IPs from services (user-added)
    load_service_custom_ips
    
    # Load IPs from custom services
    load_custom_service_ips
    
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
