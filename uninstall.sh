#!/bin/sh
#
# PinPoint Uninstaller for OpenWRT
#
# Usage:
#   curl -fsSL .../uninstall.sh | sh     # auto (keeps data)
#   sh /opt/pinpoint/uninstall.sh        # interactive
#   sh /opt/pinpoint/uninstall.sh -y     # auto (keeps data)
#   sh /opt/pinpoint/uninstall.sh --all  # auto (removes everything)
#

set -e

PINPOINT_DIR="/opt/pinpoint"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
step() { echo -e "${BLUE}[→]${NC} $1"; }

# Parse arguments
REMOVE_ALL=0
AUTO_YES=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) AUTO_YES=1 ;;
        --all) REMOVE_ALL=1; AUTO_YES=1 ;;
    esac
done

# Detect if running interactively
INTERACTIVE=0
[ -t 0 ] && INTERACTIVE=1

echo ""
echo -e "${RED}╔════════════════════════════════════════╗${NC}"
echo -e "${RED}║       PinPoint Uninstaller             ║${NC}"
echo -e "${RED}╚════════════════════════════════════════╝${NC}"
echo ""

# Check if installed
if [ ! -d "$PINPOINT_DIR" ]; then
    echo "PinPoint is not installed."
    exit 0
fi

# Confirmation
if [ "$AUTO_YES" = "1" ] || [ "$INTERACTIVE" = "0" ]; then
    info "Uninstalling PinPoint..."
else
    printf "Uninstall PinPoint? [y/N]: "
    read ans
    case "$ans" in
        [yY]*) ;;
        *) echo "Cancelled."; exit 0 ;;
    esac
fi

echo ""

# Stop service
step "Stopping service..."
/etc/init.d/pinpoint stop 2>/dev/null || true
/etc/init.d/pinpoint disable 2>/dev/null || true
killall -9 python3 2>/dev/null || true
info "Service stopped"

# Remove init script
step "Removing init script..."
rm -f /etc/init.d/pinpoint
info "Done"

# Remove hotplug scripts
step "Removing hotplug scripts..."
rm -f /etc/hotplug.d/net/99-pinpoint
rm -f /etc/hotplug.d/iface/99-pinpoint
info "Done"

# Remove LuCI integration
step "Removing LuCI integration..."
rm -f /usr/share/luci/menu.d/luci-app-pinpoint.json
rm -f /usr/share/rpcd/acl.d/luci-app-pinpoint.json
rm -rf /usr/lib/lua/luci/view/pinpoint
rm -rf /usr/lib/lua/luci/controller/pinpoint
rm -f /www/pinpoint-redirect.html
rm -f /www/pinpoint.html
rm -rf /tmp/luci-*
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
info "Done"

# Remove firewall rule
step "Removing firewall rule..."
RULE_IDX=$(uci show firewall 2>/dev/null | grep "name='Allow-PinPoint'" | cut -d'[' -f2 | cut -d']' -f1 | head -1)
if [ -n "$RULE_IDX" ]; then
    uci delete "firewall.@rule[$RULE_IDX]" 2>/dev/null || true
    uci commit firewall 2>/dev/null || true
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
fi
info "Done"

# Remove routing
step "Removing routing config..."
ip rule del fwmark 0x1 table pinpoint 2>/dev/null || true
ip route flush table pinpoint 2>/dev/null || true
sed -i '/pinpoint/d' /etc/iproute2/rt_tables 2>/dev/null || true
nft delete table inet pinpoint 2>/dev/null || true
info "Done"

# Remove files
step "Removing PinPoint files..."
if [ "$REMOVE_ALL" = "1" ]; then
    rm -rf "$PINPOINT_DIR"
    info "All files removed"
else
    rm -rf "$PINPOINT_DIR/backend"
    rm -rf "$PINPOINT_DIR/frontend"
    rm -rf "$PINPOINT_DIR/scripts"
    rm -f "$PINPOINT_DIR"/*.sh 2>/dev/null || true
    info "Program files removed (data kept)"
fi

# Remove logs
rm -rf /var/log/pinpoint
info "Logs removed"

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║    PinPoint uninstalled successfully   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

if [ "$REMOVE_ALL" != "1" ]; then
    echo "  Data preserved in: $PINPOINT_DIR/data"
    echo "  To fully remove: rm -rf $PINPOINT_DIR"
    echo ""
fi

echo "  To reinstall:"
echo "  curl -fsSL https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh"
echo ""
