#!/bin/sh
# Pinpoint - Policy Routing Initialization Script
# This script sets up nftables and policy routing for selective tunneling

set -e

MARK=0x1
TABLE_ID=100
TUN_IFACE="tun1"

log() {
    logger -t pinpoint "$1"
    echo "[pinpoint] $1"
}

# Check if tun interface exists
check_tun() {
    if ! ip link show "$TUN_IFACE" > /dev/null 2>&1; then
        log "ERROR: Interface $TUN_IFACE not found. Is sing-box running?"
        return 1
    fi
    log "TUN interface $TUN_IFACE is up"
    return 0
}

# Setup policy routing rules
setup_policy_routing() {
    log "Setting up policy routing..."
    
    # Remove existing rules if any
    ip rule del fwmark $MARK lookup $TABLE_ID 2>/dev/null || true
    ip route flush table $TABLE_ID 2>/dev/null || true
    
    # Add routing table entry to /etc/iproute2/rt_tables if not exists
    if ! grep -q "^$TABLE_ID" /etc/iproute2/rt_tables 2>/dev/null; then
        echo "$TABLE_ID pinpoint" >> /etc/iproute2/rt_tables
    fi
    
    # Add policy rule: packets with mark go to table 100
    ip rule add fwmark $MARK lookup $TABLE_ID priority 100
    
    # Add default route via tun1 in table 100
    ip route add default dev $TUN_IFACE table $TABLE_ID
    
    log "Policy routing configured: fwmark $MARK -> table $TABLE_ID -> $TUN_IFACE"
}

# Load nftables rules
setup_nftables() {
    log "Setting up nftables..."
    
    # Check if pinpoint table exists and flush it
    nft list table inet pinpoint >/dev/null 2>&1 && nft flush table inet pinpoint
    
    # Load pinpoint nftables config
    if [ -f /opt/pinpoint/data/pinpoint.nft ]; then
        nft -f /opt/pinpoint/data/pinpoint.nft
        log "Loaded /opt/pinpoint/data/pinpoint.nft"
    else
        log "Creating default nftables config..."
        cat > /opt/pinpoint/data/pinpoint.nft << 'EOF'
#!/usr/sbin/nft -f

table inet pinpoint {
    # IPs resolved from domains via dnsmasq nftset
    set tunnel_ips {
        type ipv4_addr
        flags timeout
        timeout 1h
    }
    
    # Static IP ranges/CIDRs from lists
    set tunnel_nets {
        type ipv4_addr
        flags interval
    }
    
    chain prerouting {
        type filter hook prerouting priority raw - 1; policy accept;
        
        # Skip local/private networks
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        
        # Mark connection for tunnel IPs (so response packets are also marked)
        ip daddr @tunnel_ips ct mark set 0x1 counter
        ip daddr @tunnel_nets ct mark set 0x1 counter
        
        # Mark packets based on connection mark (for response packets)
        ct mark 0x1 meta mark set 0x1 counter
        
        # Mark packets destined to tunnel IPs (for new connections)
        ip daddr @tunnel_ips meta mark set 0x1 counter
        ip daddr @tunnel_nets meta mark set 0x1 counter
    }
    
    chain output {
        type route hook output priority mangle - 1; policy accept;
        
        # Skip local/private networks
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        
        # Also mark local traffic (from router itself)
        ip daddr @tunnel_ips meta mark set 0x1 counter
        ip daddr @tunnel_nets meta mark set 0x1 counter
    }
    
    chain forward {
        type route hook forward priority mangle - 1; policy accept;
        
        # Skip local/private networks
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        
        # Mark forwarded packets (LAN -> WAN)
        # Using 'route' hook marks BEFORE routing decision
        ip daddr @tunnel_ips meta mark set 0x1 counter
        ip daddr @tunnel_nets meta mark set 0x1 counter
    }
}
EOF
        nft -f /opt/pinpoint/data/pinpoint.nft
        log "Created and loaded default nftables config"
    fi
}

# Restart dnsmasq to apply nftset config
restart_dnsmasq() {
    log "Restarting dnsmasq..."
    /etc/init.d/dnsmasq restart
    log "dnsmasq restarted"
}

# Main
main() {
    log "=== Pinpoint initialization starting ==="
    
    check_tun || exit 1
    setup_nftables
    setup_policy_routing
    
    # Only restart dnsmasq if pinpoint.conf exists
    if [ -f /etc/dnsmasq.d/pinpoint.conf ]; then
        restart_dnsmasq
    fi
    
    log "=== Pinpoint initialization complete ==="
}

# Handle commands
case "${1:-start}" in
    start)
        main
        ;;
    stop)
        log "Stopping pinpoint..."
        ip rule del fwmark $MARK lookup $TABLE_ID 2>/dev/null || true
        ip route flush table $TABLE_ID 2>/dev/null || true
        nft delete table inet pinpoint 2>/dev/null || true
        log "Pinpoint stopped"
        ;;
    restart)
        $0 stop
        sleep 1
        $0 start
        ;;
    status)
        echo "=== Policy Routing ==="
        ip rule show | grep -E "pinpoint|$TABLE_ID" || echo "No pinpoint rules"
        echo ""
        echo "=== Route Table $TABLE_ID ==="
        ip route show table $TABLE_ID 2>/dev/null || echo "Table empty"
        echo ""
        echo "=== NFTables Sets ==="
        nft list set inet pinpoint tunnel_ips 2>/dev/null || echo "Set not found"
        nft list set inet pinpoint tunnel_nets 2>/dev/null || echo "Set not found"
        echo ""
        echo "=== Counters ==="
        nft list chain inet pinpoint prerouting 2>/dev/null | grep counter || echo "No counters"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
