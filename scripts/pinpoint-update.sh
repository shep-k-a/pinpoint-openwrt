#!/bin/sh
# Pinpoint - Download and update lists from external sources

set -e

PINPOINT_DIR="/opt/pinpoint"
DATA_DIR="$PINPOINT_DIR/data"
LISTS_DIR="$DATA_DIR/lists"
SERVICES_FILE="$DATA_DIR/services.json"
TEMP_DIR="/tmp/pinpoint"

log() {
    logger -t pinpoint "$1"
    echo "[pinpoint] $1"
}

# Create directories
mkdir -p "$LISTS_DIR" "$TEMP_DIR"

# Download a file with retry (using curl for HTTPS support)
download_file() {
    local url="$1"
    local output="$2"
    local retries=3
    local wait=5
    
    for i in $(seq 1 $retries); do
        if curl -sL --connect-timeout 30 --max-time 120 -o "$output" "$url" 2>/dev/null; then
            # Check if file is not empty
            if [ -s "$output" ]; then
                return 0
            fi
        fi
        log "Download failed (attempt $i/$retries): $url"
        sleep $wait
    done
    
    log "ERROR: Failed to download after $retries attempts: $url"
    return 1
}

# Convert netmask to CIDR prefix
mask_to_cidr() {
    local mask="$1"
    case "$mask" in
        255.255.255.255) echo "32" ;;
        255.255.255.254) echo "31" ;;
        255.255.255.252) echo "30" ;;
        255.255.255.248) echo "29" ;;
        255.255.255.240) echo "28" ;;
        255.255.255.224) echo "27" ;;
        255.255.255.192) echo "26" ;;
        255.255.255.128) echo "25" ;;
        255.255.255.0) echo "24" ;;
        255.255.254.0) echo "23" ;;
        255.255.252.0) echo "22" ;;
        255.255.248.0) echo "21" ;;
        255.255.240.0) echo "20" ;;
        255.255.224.0) echo "19" ;;
        255.255.192.0) echo "18" ;;
        255.255.128.0) echo "17" ;;
        255.255.0.0) echo "16" ;;
        255.254.0.0) echo "15" ;;
        255.252.0.0) echo "14" ;;
        255.248.0.0) echo "13" ;;
        255.240.0.0) echo "12" ;;
        255.224.0.0) echo "11" ;;
        255.192.0.0) echo "10" ;;
        255.128.0.0) echo "9" ;;
        255.0.0.0) echo "8" ;;
        *) echo "32" ;;
    esac
}

# Parse different list formats and extract IPs/CIDRs
parse_list() {
    local input="$1"
    local output="$2"
    local format="${3:-auto}"
    
    # Create temp output
    local temp_out="$TEMP_DIR/parsed_$$"
    
    # Auto-detect format
    if [ "$format" = "auto" ]; then
        if grep -q "^route add" "$input" 2>/dev/null; then
            format="keenetic"
        elif grep -q "^||" "$input" 2>/dev/null; then
            format="adblock"
        elif grep -q "^127\." "$input" 2>/dev/null || grep -q "^0\.0\.0\.0" "$input" 2>/dev/null; then
            format="hosts"
        else
            format="ip"
        fi
    fi
    
    case "$format" in
        keenetic)
            # Keenetic format: route add IP mask NETMASK 0.0.0.0 (case-insensitive)
            while IFS= read -r line || [ -n "$line" ]; do
                # Case-insensitive check for "route add"
                line_lower=$(echo "$line" | tr '[:upper:]' '[:lower:]')
                case "$line_lower" in
                    route\ add*)
                        ip=$(echo "$line" | awk '{print $3}')
                        mask=$(echo "$line" | awk '{print $5}')
                        if [ -n "$ip" ] && [ -n "$mask" ]; then
                            cidr=$(mask_to_cidr "$mask")
                            [ -n "$cidr" ] && echo "$ip/$cidr"
                        fi
                        ;;
                esac
            done < "$input" | sort -u > "$temp_out" || true
            ;;
        ip|cidr)
            # Plain IP/CIDR list - just clean it up
            grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$' "$input" 2>/dev/null | \
                sort -u > "$temp_out" || true
            ;;
        hosts)
            # Hosts format: 127.0.0.1 domain.com
            awk '{print $2}' "$input" 2>/dev/null | \
                grep -v '^$' | sort -u > "$temp_out" || true
            ;;
        adblock)
            # AdBlock format: ||domain.com^
            sed -n 's/^||\([^/^]*\).*/\1/p' "$input" 2>/dev/null | \
                sort -u > "$temp_out" || true
            ;;
        domains)
            # Plain domain list
            grep -E '^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}$' "$input" 2>/dev/null | \
                sort -u > "$temp_out" || true
            ;;
    esac
    
    # Move to output
    mv "$temp_out" "$output"
    
    # Return count
    wc -l < "$output" | xargs
}

# Download and process a single source
process_source() {
    local service_id="$1"
    local source_url="$2"
    local source_type="$3"
    
    local temp_file="$TEMP_DIR/${service_id}_raw_$$"
    local output_file="$LISTS_DIR/${service_id}.txt"
    
    log "Downloading $service_id from $source_url..."
    
    if download_file "$source_url" "$temp_file"; then
        local count=$(parse_list "$temp_file" "$output_file" "$source_type")
        log "Downloaded $count entries for $service_id"
        rm -f "$temp_file"
        return 0
    else
        log "Failed to download $service_id"
        rm -f "$temp_file"
        return 1
    fi
}

# Extract domains from service config and save to file
extract_service_domains() {
    local service_idx="$1"
    local service_id="$2"
    local output_file="$LISTS_DIR/${service_id}_domains.txt"
    
    if command -v jsonfilter >/dev/null 2>&1; then
        jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].domains[*]" 2>/dev/null | \
            sort -u > "$output_file"
        
        local count=$(wc -l < "$output_file" | xargs)
        [ "$count" -gt 0 ] && log "Extracted $count domains for $service_id"
    fi
}

# Extract static IP ranges from service config
extract_service_ips() {
    local service_idx="$1"
    local service_id="$2"
    local output_file="$LISTS_DIR/${service_id}_static.txt"
    
    if command -v jsonfilter >/dev/null 2>&1; then
        jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].ip_ranges[*]" 2>/dev/null | \
            sort -u > "$output_file" 2>/dev/null || true
        
        local count=$(wc -l < "$output_file" 2>/dev/null | xargs)
        [ "$count" -gt 0 ] && log "Extracted $count static IPs for $service_id"
    fi
}

# Update all enabled services
update_all_services() {
    log "=== Starting list update ==="
    
    local success=0
    local failed=0
    
    if ! command -v jsonfilter >/dev/null 2>&1; then
        log "WARNING: jsonfilter not found, using fallback method"
        # Fallback: just download known sources
        download_file "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/Global/youtube.txt" "$LISTS_DIR/youtube.txt"
        download_file "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/Global/Instagram.txt" "$LISTS_DIR/instagram.txt"
        return 0
    fi
    
    # Process each service (use index-based access to avoid jsonfilter filtering issues)
    service_count=$(jsonfilter -i "$SERVICES_FILE" -e '@.services' 2>/dev/null | grep -c '"id"' || echo 0)
    
    service_idx=0
    while [ "$service_idx" -lt "$service_count" ]; do
        service_id=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].id" 2>/dev/null)
        enabled=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].enabled" 2>/dev/null)
        
        if [ -z "$service_id" ]; then
            service_idx=$((service_idx + 1))
            continue
        fi
        
        if [ "$enabled" = "true" ]; then
            log "Processing service: $service_id"
            
            # Extract domains to file
            extract_service_domains "$service_idx" "$service_id"
            
            # Extract static IP ranges
            extract_service_ips "$service_idx" "$service_id"
            
            # Download external sources (process all sources)
            source_count=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].sources" 2>/dev/null | grep -c 'url' || echo 0)
            
            if [ "$source_count" -gt 0 ]; then
                # Process all sources (loop through all)
                source_idx=0
                while true; do
                    source_url=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].sources[$source_idx].url" 2>/dev/null)
                    source_type=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].sources[$source_idx].type" 2>/dev/null)
                    
                    if [ -z "$source_url" ]; then
                        break  # No more sources
                    fi
                    
                    log "  Processing source $((source_idx + 1)): $source_url (type: ${source_type:-auto})"
                    
                    if process_source "$service_id" "$source_url" "${source_type:-auto}"; then
                        success=$((success + 1))
                    else
                        failed=$((failed + 1))
                    fi
                    
                    source_idx=$((source_idx + 1))
                done
            fi
        else
            log "Skipping disabled service: $service_id"
        fi
        
        service_idx=$((service_idx + 1))
    done
    
    log "=== Update complete: $success succeeded, $failed failed ==="
    
    # Cleanup
    rm -rf "$TEMP_DIR"
    
    return 0
}

# Show what's currently downloaded
show_lists() {
    echo "=== Downloaded Lists ==="
    for f in "$LISTS_DIR"/*.txt; do
        [ -f "$f" ] || continue
        name=$(basename "$f")
        count=$(wc -l < "$f" | xargs)
        size=$(ls -lh "$f" | awk '{print $5}')
        echo "  $name: $count entries ($size)"
    done
}

case "${1:-update}" in
    update)
        update_all_services
        # Apply the new rules (через sh на случай проблем с исполняемым битом/CRLF)
        sh /opt/pinpoint/scripts/pinpoint-apply.sh reload
        ;;
    show|list)
        show_lists
        ;;
    *)
        echo "Usage: $0 {update|show}"
        exit 1
        ;;
esac
