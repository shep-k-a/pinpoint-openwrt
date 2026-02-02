#!/bin/sh
#
# PinPoint Complete Uninstaller for OpenWRT
# Removes all packages, dependencies, and configurations
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/uninstall.sh | sh
#   sh uninstall.sh
#   sh uninstall.sh --yes  # Skip confirmation
#

set -e

PINPOINT_DIR="/opt/pinpoint"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
step() { echo -e "${CYAN}[→]${NC} $1"; }

# Parse arguments
AUTO_YES=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) AUTO_YES=1 ;;
    esac
done

# Detect if running interactively
INTERACTIVE=0
[ -t 0 ] && INTERACTIVE=1

echo ""
echo -e "${RED}╔════════════════════════════════════════╗${NC}"
echo -e "${RED}║   PinPoint Complete Uninstaller         ║${NC}"
echo -e "${RED}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}This will remove:${NC}"
echo "  • All PinPoint files and data"
echo "  • All installed packages (sing-box, nftables, dnsmasq-full, etc.)"
echo "  • All Python packages (for Full mode)"
echo "  • All configurations and routing rules"
echo "  • LuCI integration"
echo ""

# Confirmation
if [ "$AUTO_YES" = "1" ] || [ "$INTERACTIVE" = "0" ]; then
    info "Starting complete uninstallation..."
else
    printf "Continue with complete removal? [y/N]: "
    read ans
    case "$ans" in
        [yY]*) ;;
        *) echo "Cancelled."; exit 0 ;;
    esac
fi

echo ""

# ============================================
# Stop all services
# ============================================
step "Stopping all services..."

# Stop PinPoint service (Full mode)
/etc/init.d/pinpoint stop 2>/dev/null || true
/etc/init.d/pinpoint disable 2>/dev/null || true
killall -9 python3 2>/dev/null || true

# Stop sing-box service
/etc/init.d/sing-box stop 2>/dev/null || true
/etc/init.d/sing-box disable 2>/dev/null || true
killall -9 sing-box 2>/dev/null || true

# Stop https-dns-proxy
/etc/init.d/https-dns-proxy stop 2>/dev/null || true
/etc/init.d/https-dns-proxy disable 2>/dev/null || true

info "All services stopped"

# ============================================
# Remove routing and firewall rules
# ============================================
step "Removing routing and firewall rules..."

# Remove policy routing
ip rule del fwmark 0x1 lookup 100 2>/dev/null || true
ip rule del fwmark 0x1 lookup pinpoint 2>/dev/null || true
ip route flush table 100 2>/dev/null || true
ip route flush table pinpoint 2>/dev/null || true
sed -i '/pinpoint/d' /etc/iproute2/rt_tables 2>/dev/null || true
sed -i '/^100[[:space:]]/d' /etc/iproute2/rt_tables 2>/dev/null || true

# Remove NFTables table
nft delete table inet pinpoint 2>/dev/null || true

# Remove firewall rules
RULE_IDX=$(uci show firewall 2>/dev/null | grep "name='Allow-PinPoint'" | cut -d'[' -f2 | cut -d']' -f1 | head -1)
if [ -n "$RULE_IDX" ]; then
    uci delete "firewall.@rule[$RULE_IDX]" 2>/dev/null || true
    uci commit firewall 2>/dev/null || true
fi

# Remove fw4 rules for tun1
if nft list table inet fw4 >/dev/null 2>&1; then
    # Remove masquerade rules
    nft list chain inet fw4 srcnat 2>/dev/null | grep -i tun1 | while read -r line; do
        HANDLE=$(echo "$line" | grep -o 'handle [0-9]*' | awk '{print $2}')
        [ -n "$HANDLE" ] && nft delete rule inet fw4 srcnat handle "$HANDLE" 2>/dev/null || true
    done
    
    # Remove forward rules
    nft list chain inet fw4 forward 2>/dev/null | grep -i tun1 | while read -r line; do
        HANDLE=$(echo "$line" | grep -o 'handle [0-9]*' | awk '{print $2}')
        [ -n "$HANDLE" ] && nft delete rule inet fw4 forward handle "$HANDLE" 2>/dev/null || true
    done
fi

info "Routing and firewall rules removed"

# ============================================
# Remove init scripts
# ============================================
step "Removing init scripts..."
rm -f /etc/init.d/pinpoint
rm -f /etc/init.d/sing-box
info "Init scripts removed"

# ============================================
# Remove hotplug scripts
# ============================================
step "Removing hotplug scripts..."
rm -f /etc/hotplug.d/net/99-pinpoint-net
rm -f /etc/hotplug.d/iface/99-pinpoint-iface
rm -f /scripts/hotplug/99-pinpoint-net
rm -f /scripts/hotplug/99-pinpoint-iface
info "Hotplug scripts removed"

# ============================================
# Remove cron jobs
# ============================================
step "Removing cron jobs..."
rm -f /etc/cron.d/pinpoint
sed -i '/pinpoint/d' /etc/crontabs/root 2>/dev/null || true
/etc/init.d/cron restart >/dev/null 2>&1 || true
info "Cron jobs removed"

# ============================================
# Remove LuCI integration
# ============================================
step "Removing LuCI integration..."
rm -f /usr/share/luci/menu.d/luci-app-pinpoint.json
rm -f /usr/share/rpcd/acl.d/luci-app-pinpoint.json
rm -f /usr/share/rpcd/ucode/pinpoint.uc
rm -rf /usr/lib/lua/luci/view/pinpoint
rm -rf /usr/lib/lua/luci/controller/pinpoint
rm -rf /www/luci-static/resources/view/pinpoint
rm -f /www/pinpoint-redirect.html
rm -f /www/pinpoint.html
rm -rf /tmp/luci-*
rm -rf /tmp/ucode-*
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
info "LuCI integration removed"

# ============================================
# Remove UCI config
# ============================================
step "Removing UCI config..."
rm -f /etc/config/pinpoint
info "UCI config removed"

# ============================================
# Remove DNSmasq config
# ============================================
step "Removing DNSmasq config..."
rm -f /tmp/dnsmasq.d/pinpoint.conf
rm -f /tmp/dnsmasq.d/pinpoint-services.conf
rm -f /etc/dnsmasq.d/pinpoint.conf
rm -f /etc/dnsmasq.d/pinpoint-services.conf
/etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
info "DNSmasq config removed"

# ============================================
# Restore DNSmasq to original (if was replaced)
# ============================================
step "Checking DNSmasq configuration..."
# If dnsmasq-full was installed and original dnsmasq exists in repo, restore it
if opkg list-installed 2>/dev/null | grep -q "^dnsmasq-full "; then
    # Check if original dnsmasq is available
    if opkg list 2>/dev/null | grep -q "^dnsmasq "; then
        warn "dnsmasq-full was installed. Restoring original dnsmasq..."
        opkg remove dnsmasq-full --force-removal-of-dependent-packages >/dev/null 2>&1 || true
        opkg install dnsmasq >/dev/null 2>&1 || warn "Could not restore original dnsmasq"
    fi
fi

# Restore DNSmasq confdir if it was changed
if uci get dhcp.@dnsmasq[0].confdir 2>/dev/null | grep -q "/tmp/dnsmasq.d"; then
    uci delete dhcp.@dnsmasq[0].confdir 2>/dev/null || true
    uci commit dhcp 2>/dev/null || true
fi

# Restore DNS settings if they were changed
if uci get dhcp.@dnsmasq[0].noresolv 2>/dev/null | grep -q "1"; then
    uci set dhcp.@dnsmasq[0].noresolv='0' 2>/dev/null || true
    uci commit dhcp 2>/dev/null || true
fi

# Remove PinPoint DNS servers if present
if uci get dhcp.@dnsmasq[0].server 2>/dev/null | grep -q "127.0.0.1#5053"; then
    uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
    uci commit dhcp 2>/dev/null || true
fi

/etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
info "DNSmasq configuration restored"

# ============================================
# Remove all PinPoint files
# ============================================
step "Removing PinPoint files..."
rm -rf "$PINPOINT_DIR"
rm -rf /var/log/pinpoint
rm -f /etc/sing-box/config.json
rm -rf /etc/sing-box
info "All PinPoint files removed"

# ============================================
# Remove Python packages (Full mode)
# ============================================
step "Removing Python packages (if installed for Full mode)..."

if command -v pip3 >/dev/null 2>&1; then
    PIP="pip3"
elif command -v python3 >/dev/null 2>&1 && python3 -m pip --version >/dev/null 2>&1; then
    PIP="python3 -m pip"
else
    PIP=""
fi

if [ -n "$PIP" ]; then
    # Remove PinPoint Python packages
    for pkg in fastapi uvicorn starlette pydantic httpx pyyaml; do
        $PIP uninstall -y "$pkg" >/dev/null 2>&1 || true
    done
    info "Python packages removed"
else
    info "No pip found, skipping Python packages"
fi

# ============================================
# Remove system packages
# ============================================
step "Removing system packages..."

# Remove sing-box
if opkg list-installed 2>/dev/null | grep -q "^sing-box "; then
    opkg remove sing-box --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove sing-box"
fi

# Remove nftables (only if installed by PinPoint)
# Check if it was installed before PinPoint by checking if it's in a saved list
if opkg list-installed 2>/dev/null | grep -q "^nftables"; then
    # Only remove if it's nftables-json (likely installed by PinPoint)
    if opkg list-installed 2>/dev/null | grep -q "^nftables-json "; then
        opkg remove nftables-json --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove nftables-json"
    fi
fi

# Remove dnsmasq-full (if installed)
if opkg list-installed 2>/dev/null | grep -q "^dnsmasq-full "; then
    opkg remove dnsmasq-full --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove dnsmasq-full"
fi

# Remove https-dns-proxy (if installed)
if opkg list-installed 2>/dev/null | grep -q "^https-dns-proxy "; then
    opkg remove https-dns-proxy --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove https-dns-proxy"
fi

# Remove Python packages (Full mode only - be careful, might be used by other apps)
# Only remove if we're sure they were installed for PinPoint
if [ -f "$PINPOINT_DIR/data/requirements.txt" ] 2>/dev/null; then
    # PinPoint was installed, safe to remove Python
    if opkg list-installed 2>/dev/null | grep -q "^python3-pip "; then
        opkg remove python3-pip --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove python3-pip"
    fi
    if opkg list-installed 2>/dev/null | grep -q "^python3 "; then
        # Check if Python is used by other packages
        PYTHON_DEPS=$(opkg list-installed 2>/dev/null | grep -E "^python3-" | grep -v "python3-pip" | wc -l)
        if [ "$PYTHON_DEPS" -eq 0 ]; then
            opkg remove python3 --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove python3"
        else
            warn "Python3 is used by other packages, keeping it"
        fi
    fi
fi

# Remove kmod-tun (only if no other packages need it)
if opkg list-installed 2>/dev/null | grep -q "^kmod-tun "; then
    # Check if other packages depend on it
    TUN_DEPS=$(opkg depends kmod-tun 2>/dev/null | grep -v "^kmod-tun" | wc -l)
    if [ "$TUN_DEPS" -eq 0 ]; then
        opkg remove kmod-tun --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove kmod-tun"
    else
        warn "kmod-tun is used by other packages, keeping it"
    fi
fi

# Remove ip-full (only if no other packages need it)
if opkg list-installed 2>/dev/null | grep -q "^ip-full "; then
    IP_DEPS=$(opkg depends ip-full 2>/dev/null | grep -v "^ip-full" | wc -l)
    if [ "$IP_DEPS" -eq 0 ]; then
        opkg remove ip-full --force-removal-of-dependent-packages >/dev/null 2>&1 || warn "Could not remove ip-full"
    else
        warn "ip-full is used by other packages, keeping it"
    fi
fi

# Note: curl and ca-certificates are usually system packages, don't remove them
info "System packages removed (where safe)"

# ============================================
# Cleanup
# ============================================
step "Final cleanup..."

# Remove any remaining PinPoint processes
killall -9 pinpoint 2>/dev/null || true
killall -9 python3 2>/dev/null || true

# Remove any remaining config files
rm -rf /opt/pinpoint
rm -rf /var/log/pinpoint
rm -f /etc/sing-box/config.json

# Clear caches
rm -rf /tmp/luci-*
rm -rf /tmp/ucode-*
rm -rf /tmp/opkg-*

info "Cleanup complete"

# ============================================
# Summary
# ============================================
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   PinPoint completely uninstalled     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}Removed:${NC}"
echo "  ✓ All PinPoint files and data"
echo "  ✓ All routing and firewall rules"
echo "  ✓ All init scripts and services"
echo "  ✓ LuCI integration"
echo "  ✓ DNSmasq configuration"
echo "  ✓ System packages (sing-box, nftables, etc.)"
echo "  ✓ Python packages (if Full mode was installed)"
echo ""
echo -e "${YELLOW}Note:${NC} Some packages may remain if used by other applications:"
echo "  • curl, ca-certificates (system packages)"
echo "  • python3 (if used by other apps)"
echo "  • kmod-tun, ip-full (if used by other apps)"
echo ""
echo -e "${CYAN}To reinstall:${NC}"
echo "  curl -fsSL https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh"
echo ""
