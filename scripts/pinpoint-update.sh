#!/bin/sh
# Pinpoint - Download and update lists from external sources

# Don't exit on error - we handle errors manually
set +e

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
            # Also handles: route add IP mask NETMASK gateway
            grep -i "^route add" "$input" 2>/dev/null | while IFS= read -r line || [ -n "$line" ]; do
                # Extract IP (3rd field) and mask (5th field)
                ip=$(echo "$line" | awk '{print $3}')
                mask=$(echo "$line" | awk '{print $5}')
                if [ -n "$ip" ] && [ -n "$mask" ]; then
                    cidr=$(mask_to_cidr "$mask")
                    if [ -n "$cidr" ]; then
                        echo "$ip/$cidr"
                    elif [ -n "$ip" ]; then
                        # If mask conversion failed, use IP as /32
                        echo "$ip/32"
                    fi
                fi
            done | sort -u > "$temp_out" 2>/dev/null || true
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
    local parsed_file="$TEMP_DIR/${service_id}_parsed_$$"
    local output_file="$LISTS_DIR/${service_id}.txt"
    local domains_file="$LISTS_DIR/${service_id}_domains.txt"
    
    log "Downloading $service_id from $source_url..."
    
    if download_file "$source_url" "$temp_file"; then
        local count=$(parse_list "$temp_file" "$parsed_file" "$source_type")
        
        if [ "$count" -gt 0 ]; then
            # Determine if this is IP/CIDR or domains based on source type and content
            if [ "$source_type" = "domains" ] || grep -qE '^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}$' "$parsed_file" 2>/dev/null; then
                # This is domains - append to domains file
                cat "$parsed_file" >> "$domains_file" 2>/dev/null || true
                sort -u "$domains_file" -o "$domains_file" 2>/dev/null || true
                log "Downloaded $count domains for $service_id"
            else
                # This is IP/CIDR - append to main file
                cat "$parsed_file" >> "$output_file" 2>/dev/null || true
                sort -u "$output_file" -o "$output_file" 2>/dev/null || true
                log "Downloaded $count IPs/CIDRs for $service_id"
            fi
        else
            log "Downloaded 0 entries for $service_id (parsing may have failed)"
        fi
        
        rm -f "$temp_file" "$parsed_file"
        return 0
    else
        log "Failed to download $service_id"
        rm -f "$temp_file" "$parsed_file"
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

# Get source URL and type by index (simplified)
get_source_by_index() {
    local service_id="$1"
    local source_idx="$2"
    local field="$3"  # "url" or "type"
    
    # Try jsonfilter first (most reliable)
    if command -v jsonfilter >/dev/null 2>&1; then
        local service_idx=0
        while true; do
            local sid=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].id" 2>/dev/null)
            if [ -z "$sid" ]; then
                break
            fi
            if [ "$sid" = "$service_id" ]; then
                local result=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].sources[$source_idx].$field" 2>/dev/null)
                if [ -n "$result" ]; then
                    echo "$result"
                    return 0
                fi
                return 1
            fi
            service_idx=$((service_idx + 1))
        done
    fi
    
    # Fallback: awk-based extraction
    awk -v id="$service_id" -v idx="$source_idx" -v field="$field" '
    BEGIN { in_service=0; in_sources=0; source_count=-1; in_obj=0; brace=0; found=0 }
    /"id"[[:space:]]*:[[:space:]]*"/ {
        if ($0 ~ "\"" id "\"") { in_service=1; next }
        if (in_service && !in_sources) { in_service=0 }
    }
    in_service && /"sources"[[:space:]]*:[[:space:]]*\[/ { in_sources=1 }
    in_sources {
        if (/\{/) { 
            source_count++
            if (source_count == idx) { in_obj=1; brace=1 }
        }
        if (in_obj && /"[^"]*"[[:space:]]*:[[:space:]]*"/) {
            # Extract key
            key = $0
            gsub(/^[[:space:]]*"/, "", key)
            gsub(/"[[:space:]]*:.*$/, "", key)
            # Check if this is our field
            if (key == field) {
                # Extract value
                value = $0
                gsub(/^[^:]*:[[:space:]]*"/, "", value)
                gsub(/",?[[:space:]]*$/, "", value)
                print value
                found=1
                exit
            }
        }
        if (in_obj && /\}/) { 
            brace--
            if (brace == 0) { in_obj=0 }
        }
        if (/\]/ && in_sources && !in_obj) { exit }
    }
    in_service && !in_sources && /^[[:space:]]*\}/ { exit }
    END { if (!found) exit 1 }
    ' "$SERVICES_FILE" 2>/dev/null || return 1
}

# Count sources for a service (improved and simplified)
count_sources() {
    local service_id="$1"
    local count=0
    
    # Try jsonfilter first (most reliable)
    if command -v jsonfilter >/dev/null 2>&1; then
        local service_idx=0
        while true; do
            local sid=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].id" 2>/dev/null)
            if [ -z "$sid" ]; then
                break
            fi
            if [ "$sid" = "$service_id" ]; then
                # Try to get sources array and count URLs
                local sources_json=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_idx].sources" 2>/dev/null)
                if [ -n "$sources_json" ]; then
                    count=$(echo "$sources_json" | grep -o '"url"' | wc -l | xargs)
                    [ -z "$count" ] && count=0
                    echo "$count"
                    return 0
                fi
                echo "0"
                return 0
            fi
            service_idx=$((service_idx + 1))
        done
    fi
    
    # Fallback: simple grep/sed approach
    # Extract service block and count "url" in sources array
    awk -v id="$service_id" '
    BEGIN { in_service=0; in_sources=0; count=0; bracket=0 }
    /"id"[[:space:]]*:[[:space:]]*"/ {
        if ($0 ~ "\"" id "\"") { in_service=1; next }
        if (in_service && !in_sources) { in_service=0 }
    }
    in_service && /"sources"[[:space:]]*:[[:space:]]*\[/ { 
        in_sources=1; bracket=1
    }
    in_sources {
        if (/"url"/) count++
        if (/\]/) { bracket--; if (bracket == 0) { print count; exit } }
        if (/\{/) bracket++
        if (/\}/) bracket--
    }
    in_service && !in_sources && /^[[:space:]]*\}/ { exit }
    END { if (count == 0 && in_service) print "0" }
    ' "$SERVICES_FILE" 2>/dev/null || echo "0"
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
    # Count services by iterating until we get empty result
    service_count=0
    while true; do
        test_id=$(jsonfilter -i "$SERVICES_FILE" -e "@.services[$service_count].id" 2>/dev/null)
        if [ -z "$test_id" ]; then
            break
        fi
        service_count=$((service_count + 1))
    done
    
    log "Found $service_count services in total"
    
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
            log "  After extract_service_domains"
            
            # Extract static IP ranges
            extract_service_ips "$service_idx" "$service_id"
            log "  After extract_service_ips"
            
            # Download external sources (process all sources)
            # Use improved source extraction that works even when jsonfilter has issues
            source_count=$(count_sources "$service_id" 2>&1)
            source_count=$(echo "$source_count" | tail -1 | xargs)  # Get last line and trim
            
            # Debug output
            log "  Checking sources for $service_id: raw_count='$source_count'"
            
            # Validate count
            if [ -z "$source_count" ]; then
                source_count=0
            fi
            
            # Convert to number for comparison
            if ! echo "$source_count" | grep -qE '^[0-9]+$'; then
                log "  WARNING: Invalid source count '$source_count', treating as 0"
                source_count=0
            fi
            
            if [ "$source_count" -gt 0 ] 2>/dev/null; then
                log "  Found $source_count source(s) for $service_id"
                
                # Clear output files before processing sources (to avoid duplicates on re-run)
                > "$LISTS_DIR/${service_id}.txt" 2>/dev/null || true
                # Keep domains file as it may have static domains from config
                
                # Process all sources (loop through all)
                source_idx=0
                while [ "$source_idx" -lt "$source_count" ]; do
                    source_url=$(get_source_by_index "$service_id" "$source_idx" "url")
                    source_type=$(get_source_by_index "$service_id" "$source_idx" "type")
                    
                    if [ -z "$source_url" ]; then
                        source_idx=$((source_idx + 1))
                        continue
                    fi
                    
                    log "  Processing source $((source_idx + 1))/$source_count: $source_url (type: ${source_type:-auto})"
                    
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

# Only execute main logic if script is run directly (not sourced)
# When sourced, $0 will be the parent shell, not the script name
if [ "$(basename "$0" 2>/dev/null)" = "pinpoint-update.sh" ] || [ -n "${PINPOINT_UPDATE_DIRECT:-}" ]; then
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
fi
