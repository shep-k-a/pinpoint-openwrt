#!/bin/sh
#
# PinPoint Uninstaller for OpenWRT
#
# Usage:
#   wget -O - https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/uninstall.sh | sh
#   Or locally: sh /opt/pinpoint/uninstall.sh
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PINPOINT_DIR="/opt/pinpoint"

info() {
    echo -e "${GREEN}[✓]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

step() {
    echo -e "${BLUE}[→]${NC} $1"
}

# ============================================
# Main
# ============================================

echo ""
echo -e "${RED}╔════════════════════════════════════════╗${NC}"
echo -e "${RED}║       PinPoint Uninstaller             ║${NC}"
echo -e "${RED}╚════════════════════════════════════════╝${NC}"
echo ""

# Check if PinPoint is installed
if [ ! -d "$PINPOINT_DIR" ]; then
    echo "PinPoint is not installed."
    exit 0
fi

printf "Are you sure you want to uninstall PinPoint? [y/N]: "
read CONFIRM

case "$CONFIRM" in
    [yY][eE][sS]|[yY])
        ;;
    *)
        echo "Cancelled."
        exit 0
        ;;
esac

echo ""

# ============================================
# Stop and disable service
# ============================================
step "Stopping PinPoint service..."
/etc/init.d/pinpoint stop 2>/dev/null || true
/etc/init.d/pinpoint disable 2>/dev/null || true
killall -9 python3 2>/dev/null || true
info "Service stopped"

# ============================================
# Remove init script
# ============================================
step "Removing init script..."
rm -f /etc/init.d/pinpoint
info "Init script removed"

# ============================================
# Remove LuCI integration
# ============================================
step "Removing LuCI integration..."
rm -f /usr/share/luci/menu.d/luci-app-pinpoint.json
rm -f /usr/share/rpcd/acl.d/luci-app-pinpoint.json
rm -f /www/cgi-bin/luci/admin/services/pinpoint
rm -f /www/pinpoint-redirect.html
rm -rf /tmp/luci-*
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
info "LuCI integration removed"

# ============================================
# Remove firewall rule
# ============================================
step "Removing firewall rule..."
# Find and delete PinPoint firewall rule
RULE_INDEX=$(uci show firewall 2>/dev/null | grep "name='Allow-PinPoint'" | cut -d'[' -f2 | cut -d']' -f1 | head -1)
if [ -n "$RULE_INDEX" ]; then
    uci delete "firewall.@rule[$RULE_INDEX]" 2>/dev/null || true
    uci commit firewall 2>/dev/null || true
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
    info "Firewall rule removed"
else
    info "Firewall rule not found (already removed)"
fi

# ============================================
# Ask about data
# ============================================
echo ""
printf "Remove all data (history, settings, tunnels)? [y/N]: "
read REMOVE_DATA

case "$REMOVE_DATA" in
    [yY][eE][sS]|[yY])
        KEEP_DATA=0
        ;;
    *)
        KEEP_DATA=1
        ;;
esac

# ============================================
# Ask about dependencies
# ============================================
echo ""
echo "Dependency removal options:"
echo "  1) Keep all dependencies (safe)"
echo "  2) Remove only packages installed by PinPoint"
echo "  3) Remove all PinPoint-related packages"
echo ""
printf "Choose [1]: "
read DEP_CHOICE

DEP_CHOICE="${DEP_CHOICE:-1}"

# ============================================
# Remove dependencies based on choice
# ============================================
case "$DEP_CHOICE" in
    2)
        # Remove only packages that PinPoint installed
        step "Removing packages installed by PinPoint..."
        
        if [ -f "$PINPOINT_DIR/data/installed_packages.txt" ]; then
            while read -r pkg; do
                if [ -n "$pkg" ]; then
                    step "Removing $pkg..."
                    opkg remove "$pkg" 2>/dev/null || true
                fi
            done < "$PINPOINT_DIR/data/installed_packages.txt"
            info "System packages removed"
        else
            warn "Package manifest not found, skipping system packages"
        fi
        
        # Remove Python packages
        if [ -f "$PINPOINT_DIR/data/python_packages.txt" ]; then
            step "Removing Python packages..."
            PY_PKGS=$(cat "$PINPOINT_DIR/data/python_packages.txt" | tr '\n' ' ')
            pip3 uninstall -y $PY_PKGS 2>/dev/null || true
            info "Python packages removed"
        fi
        ;;
    3)
        # Remove all PinPoint-related packages
        step "Removing all PinPoint-related packages..."
        
        # Python packages
        step "Removing Python packages..."
        pip3 uninstall -y uvicorn fastapi pyyaml httpx 2>/dev/null || true
        
        # sing-box (main dependency)
        printf "  Remove sing-box? [y/N]: "
        read REMOVE_SINGBOX
        case "$REMOVE_SINGBOX" in
            [yY][eE][sS]|[yY])
                opkg remove sing-box 2>/dev/null || true
                info "sing-box removed"
                ;;
            *)
                info "sing-box kept"
                ;;
        esac
        
        info "Packages removed"
        ;;
    *)
        info "Dependencies kept"
        ;;
esac

# ============================================
# Remove PinPoint files
# ============================================
step "Removing PinPoint files..."

if [ "$KEEP_DATA" -eq 1 ]; then
    # Keep data directory
    rm -rf "$PINPOINT_DIR/backend"
    rm -rf "$PINPOINT_DIR/frontend"
    rm -rf "$PINPOINT_DIR/scripts"
    info "Program files removed (data kept in $PINPOINT_DIR/data)"
else
    # Remove everything
    rm -rf "$PINPOINT_DIR"
    info "All PinPoint files removed"
fi

# ============================================
# Remove logs
# ============================================
rm -rf /var/log/pinpoint
info "Logs removed"

# ============================================
# Done
# ============================================
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║    PinPoint uninstalled successfully   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

if [ "$KEEP_DATA" -eq 1 ]; then
    echo "  Data preserved in: $PINPOINT_DIR/data"
    echo "  To fully remove: rm -rf $PINPOINT_DIR"
    echo ""
fi

echo "  To reinstall:"
echo "  wget -O - https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh"
echo ""
