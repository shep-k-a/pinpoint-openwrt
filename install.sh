#!/bin/sh
#
# PinPoint - Selective VPN Routing for OpenWRT
# Installation Script
#
# Usage:
#   wget -O - https://raw.githubusercontent.com/USER/pinpoint/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/USER/pinpoint/main/install.sh | sh
#
# Requirements: OpenWRT 23.05.0 or later
#

set -e

# ============================================
# Configuration
# ============================================
PINPOINT_VERSION="1.0.0"
MIN_OPENWRT_VERSION="23.05"
PINPOINT_DIR="/opt/pinpoint"
GITHUB_REPO="https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master"

# ============================================
# Colors
# ============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================
# Helper Functions
# ============================================
info() {
    echo -e "${GREEN}[✓]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

error() {
    echo -e "${RED}[✗]${NC} $1"
    exit 1
}

step() {
    echo -e "${CYAN}[→]${NC} $1"
}

# ============================================
# Version comparison
# ============================================
version_ge() {
    # Returns 0 if $1 >= $2
    [ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# ============================================
# System Checks
# ============================================
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        error "This script must be run as root"
    fi
}

check_openwrt() {
    step "Checking OpenWRT..."
    
    if [ ! -f /etc/openwrt_release ]; then
        error "This script is designed for OpenWRT only"
    fi
    
    # Get version
    OPENWRT_VERSION=$(grep 'DISTRIB_RELEASE' /etc/openwrt_release | cut -d"'" -f2 | cut -d'-' -f1)
    OPENWRT_NAME=$(grep 'DISTRIB_DESCRIPTION' /etc/openwrt_release | cut -d"'" -f2)
    
    info "Detected: $OPENWRT_NAME"
    
    # Check minimum version
    if ! version_ge "$OPENWRT_VERSION" "$MIN_OPENWRT_VERSION"; then
        error "OpenWRT $MIN_OPENWRT_VERSION or later required (found: $OPENWRT_VERSION)"
    fi
    
    info "Version $OPENWRT_VERSION is compatible"
}

check_architecture() {
    step "Checking architecture..."
    
    ARCH=$(uname -m)
    
    case "$ARCH" in
        x86_64)
            ARCH_NAME="x86_64"
            ;;
        aarch64)
            ARCH_NAME="ARM64"
            ;;
        armv7l|armv7)
            ARCH_NAME="ARMv7"
            ;;
        mips|mipsel)
            ARCH_NAME="MIPS"
            ;;
        *)
            ARCH_NAME="$ARCH"
            warn "Architecture $ARCH may have limited support"
            ;;
    esac
    
    info "Architecture: $ARCH_NAME ($ARCH)"
}

check_internet() {
    step "Checking internet connection..."
    
    if ! ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
        if ! ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then
            error "No internet connection. Please check your network."
        fi
    fi
    
    info "Internet connection OK"
}

check_disk_space() {
    step "Checking available disk space..."
    
    # Get available space in KB
    AVAILABLE=$(df /opt 2>/dev/null | tail -1 | awk '{print $4}')
    
    if [ -z "$AVAILABLE" ]; then
        AVAILABLE=$(df / | tail -1 | awk '{print $4}')
    fi
    
    # Need at least 10MB
    if [ "$AVAILABLE" -lt 10240 ]; then
        error "Not enough disk space. Need at least 10MB, have $(($AVAILABLE/1024))MB"
    fi
    
    info "Available space: $(($AVAILABLE/1024))MB"
}

# ============================================
# Package Installation
# ============================================

# Track installed packages
INSTALLED_BY_PINPOINT=""

update_packages() {
    step "Updating package lists..."
    opkg update >/dev/null 2>&1 || warn "Could not update package lists"
    info "Package lists updated"
}

install_package() {
    PKG=$1
    DESC=$2
    
    # Check if already installed
    if opkg list-installed 2>/dev/null | grep -q "^$PKG "; then
        info "$DESC ($PKG) - already installed"
        return 0
    fi
    
    step "Installing $DESC ($PKG)..."
    
    if opkg install "$PKG" >/dev/null 2>&1; then
        info "$DESC installed"
        # Track this package as installed by PinPoint
        INSTALLED_BY_PINPOINT="$INSTALLED_BY_PINPOINT $PKG"
        return 0
    else
        warn "Failed to install $PKG"
        return 1
    fi
}

install_dependencies() {
    echo ""
    echo -e "${BLUE}Installing System Dependencies${NC}"
    echo "----------------------------------------"
    
    # Core Python
    install_package "python3" "Python 3"
    install_package "python3-pip" "Python pip"
    install_package "python3-sqlite3" "Python SQLite"
    install_package "python3-logging" "Python logging"
    install_package "python3-asyncio" "Python asyncio"
    
    # Network tools
    install_package "curl" "cURL"
    install_package "wget" "wget"
    install_package "ca-certificates" "CA certificates"
    install_package "ca-bundle" "CA bundle"
    
    # sing-box and dependencies
    install_package "sing-box" "sing-box proxy"
    install_package "kmod-tun" "TUN kernel module"
    
    # Firewall and routing
    install_package "nftables" "nftables firewall"
    install_package "ip-full" "iproute2 full"
    
    # DNS
    install_package "dnsmasq-full" "dnsmasq full" || install_package "dnsmasq" "dnsmasq"
    
    # Lua for LuCI integration
    install_package "lua" "Lua runtime"
    install_package "luci-compat" "LuCI compatibility"
    install_package "luci-lib-base" "LuCI base library"
    install_package "luci-lib-nixio" "LuCI nixio library"
    
    echo ""
    info "System dependencies installed"
}

save_installed_packages() {
    # Save list of packages installed by PinPoint for clean uninstall
    if [ -n "$INSTALLED_BY_PINPOINT" ]; then
        echo "$INSTALLED_BY_PINPOINT" | tr ' ' '\n' | grep -v '^$' > "$PINPOINT_DIR/data/installed_packages.txt"
        info "Package manifest saved"
    fi
}

install_python_packages() {
    echo ""
    echo -e "${BLUE}Installing Python Packages${NC}"
    echo "----------------------------------------"
    
    # First try to install from opkg (pre-compiled, faster, less RAM)
    step "Trying opkg packages first (faster)..."
    opkg install python3-yaml 2>/dev/null && info "python3-yaml from opkg" || true
    opkg install python3-multidict 2>/dev/null || true
    opkg install python3-aiohttp 2>/dev/null || true
    
    # Determine pip command
    if command -v pip3 >/dev/null 2>&1; then
        PIP="pip3"
    else
        PIP="python3 -m pip"
    fi
    
    # Python packages to install via pip
    # Using --only-binary to avoid compilation on low-RAM devices
    step "Installing Python packages via pip..."
    
    # Try binary-only first (no compilation needed)
    $PIP install --root-user-action=ignore --break-system-packages \
        --only-binary :all: --prefer-binary \
        uvicorn fastapi httpx 2>/dev/null || \
    # Fallback: allow source but with no isolation (less RAM)
    $PIP install --root-user-action=ignore --break-system-packages \
        --no-build-isolation --prefer-binary \
        uvicorn fastapi pyyaml httpx 2>/dev/null || \
    # Last resort: normal install
    $PIP install --root-user-action=ignore \
        uvicorn fastapi pyyaml httpx 2>/dev/null || \
    warn "Some Python packages may not have installed"
    
    # Save Python packages list
    echo "uvicorn fastapi pyyaml httpx" | tr ' ' '\n' > "$PINPOINT_DIR/data/python_packages.txt"
    
    info "Python packages installed"
}

# ============================================
# File Setup
# ============================================
create_directories() {
    echo ""
    echo -e "${BLUE}Creating Directory Structure${NC}"
    echo "----------------------------------------"
    
    step "Creating directories..."
    
    mkdir -p "$PINPOINT_DIR/backend"
    mkdir -p "$PINPOINT_DIR/frontend/css"
    mkdir -p "$PINPOINT_DIR/frontend/js"
    mkdir -p "$PINPOINT_DIR/frontend/assets"
    mkdir -p "$PINPOINT_DIR/data"
    mkdir -p "$PINPOINT_DIR/scripts"
    mkdir -p /var/log/pinpoint
    
    info "Directories created"
}

download_files() {
    echo ""
    echo -e "${BLUE}Downloading PinPoint Files${NC}"
    echo "----------------------------------------"
    
    # Backend
    step "Downloading backend..."
    wget -q -O "$PINPOINT_DIR/backend/main.py" "$GITHUB_REPO/backend/main.py" || error "Failed to download main.py"
    wget -q -O "$PINPOINT_DIR/backend/tunnels.py" "$GITHUB_REPO/backend/tunnels.py" 2>/dev/null || true
    info "Backend downloaded"
    
    # Frontend
    step "Downloading frontend..."
    wget -q -O "$PINPOINT_DIR/frontend/index.html" "$GITHUB_REPO/frontend/index.html" || error "Failed to download index.html"
    wget -q -O "$PINPOINT_DIR/frontend/login.html" "$GITHUB_REPO/frontend/login.html" || error "Failed to download login.html"
    wget -q -O "$PINPOINT_DIR/frontend/css/style.css" "$GITHUB_REPO/frontend/css/style.css" || error "Failed to download style.css"
    wget -q -O "$PINPOINT_DIR/frontend/js/app.js" "$GITHUB_REPO/frontend/js/app.js" || error "Failed to download app.js"
    wget -q -O "$PINPOINT_DIR/frontend/assets/logo.svg" "$GITHUB_REPO/frontend/assets/logo.svg" 2>/dev/null || true
    info "Frontend downloaded"
    
    # Scripts
    step "Downloading scripts..."
    wget -q -O "$PINPOINT_DIR/scripts/update-subscriptions.sh" "$GITHUB_REPO/scripts/update-subscriptions.sh" 2>/dev/null || true
    chmod +x "$PINPOINT_DIR/scripts/"*.sh 2>/dev/null || true
    info "Scripts downloaded"
    
    # Set permissions
    chmod 755 "$PINPOINT_DIR/backend/"*.py
}

setup_luci() {
    echo ""
    echo -e "${BLUE}Setting up LuCI Integration${NC}"
    echo "----------------------------------------"
    
    # Check if LuCI is installed
    if [ ! -d "/usr/share/luci" ]; then
        warn "LuCI not found, skipping integration"
        return 0
    fi
    
    step "Installing LuCI menu entry..."
    
    # Create directories
    mkdir -p /usr/share/luci/menu.d
    mkdir -p /usr/share/rpcd/acl.d
    mkdir -p /usr/lib/lua/luci/view/pinpoint
    mkdir -p /usr/lib/lua/luci/controller/pinpoint
    
    # Create Lua template for LuCI page
    cat > /usr/lib/lua/luci/view/pinpoint/main.htm << 'LUAEOF'
<%+header%>
<style>
.pinpoint-container{text-align:center;padding:40px;max-width:600px;margin:0 auto}
.pinpoint-logo{width:80px;height:80px;margin:0 auto 20px;background:linear-gradient(135deg,#4a5568 0%,#6b5b7a 100%);border-radius:18px;display:flex;align-items:center;justify-content:center}
.pinpoint-logo-dot{width:30px;height:30px;background:rgba(255,255,255,0.95);border-radius:50%}
.pinpoint-title{font-size:28px;font-weight:bold;margin-bottom:10px;color:#4a5568}
.pinpoint-desc{color:#666;margin-bottom:30px;font-size:16px}
.pinpoint-btn{display:inline-block;background:linear-gradient(135deg,#4a5568 0%,#6b5b7a 100%);color:white !important;padding:15px 40px;border-radius:8px;text-decoration:none;font-size:18px;font-weight:500}
.pinpoint-btn:hover{opacity:0.9}
.pinpoint-info{margin-top:30px;padding:15px 25px;background:#f5f5f5;border-radius:8px;display:inline-block}
.pinpoint-info p{margin:5px 0;color:#555}
</style>
<div class="pinpoint-container">
<div class="pinpoint-logo"><div class="pinpoint-logo-dot"></div></div>
<div class="pinpoint-title">PinPoint</div>
<div class="pinpoint-desc">Selective VPN Routing for OpenWRT</div>
<br>
<a href="/pinpoint/" target="_blank" class="pinpoint-btn" onclick="this.href='http://'+location.hostname+':8080/';return true;">Open PinPoint Dashboard</a>
<div class="pinpoint-info">
<p><strong>Port:</strong> 8080</p>
</div>
</div>
<%+footer%>
LUAEOF
    
    # Fix line endings
    sed -i 's/\r$//' /usr/lib/lua/luci/view/pinpoint/main.htm 2>/dev/null || true
    
    # Create Lua controller
    cat > /usr/lib/lua/luci/controller/pinpoint/pinpoint.lua << 'CTRLEOF'
module("luci.controller.pinpoint.pinpoint", package.seeall)

function index()
    entry({"admin", "services", "pinpoint"}, template("pinpoint/main"), _("PinPoint"), 90)
end
CTRLEOF
    
    # Create menu JSON (for newer LuCI)
    cat > /usr/share/luci/menu.d/luci-app-pinpoint.json << 'MENUEOF'
{
    "admin/services/pinpoint": {
        "title": "PinPoint",
        "order": 90,
        "action": {
            "type": "template",
            "path": "pinpoint/main"
        }
    }
}
MENUEOF
    
    # Create ACL file for permissions
    cat > /usr/share/rpcd/acl.d/luci-app-pinpoint.json << 'ACLEOF'
{
    "luci-app-pinpoint": {
        "description": "Grant access to PinPoint",
        "read": {
            "ubus": {
                "luci": ["getInitList", "getLocaltime"],
                "service": ["list"]
            },
            "file": {
                "/opt/pinpoint/*": ["read"]
            }
        },
        "write": {}
    }
}
ACLEOF

    # Restart rpcd to apply ACL
    /etc/init.d/rpcd restart >/dev/null 2>&1 || true
    
    # Clear LuCI cache
    rm -rf /tmp/luci-* 2>/dev/null || true
    
    info "LuCI integration installed"
    echo "    Menu: Services → PinPoint"
}

setup_default_config() {
    step "Creating default configuration..."
    
    # Main config
    cat > "$PINPOINT_DIR/data/config.json" << 'CONFIGEOF'
{
    "version": "1.0.0",
    "api": {
        "host": "0.0.0.0",
        "port": 8080
    },
    "singbox": {
        "config_path": "/etc/sing-box/config.json"
    },
    "auto_refresh": {
        "enabled": true,
        "interval": 5
    },
    "adblock": {
        "enabled": false
    }
}
CONFIGEOF

    # Empty services
    cat > "$PINPOINT_DIR/data/services.json" << 'SERVICESEOF'
{
    "services": [],
    "categories": {}
}
SERVICESEOF

    # Custom services
    cat > "$PINPOINT_DIR/data/custom_services.json" << 'CUSTOMEOF'
{
    "services": []
}
CUSTOMEOF

    info "Default configuration created"
}

# ============================================
# Authentication Setup
# ============================================
setup_authentication() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║       PinPoint Initial Setup           ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""
    
    # Username
    DEFAULT_USER="admin"
    printf "  Username [${GREEN}$DEFAULT_USER${NC}]: "
    read INPUT_USER
    USERNAME="${INPUT_USER:-$DEFAULT_USER}"
    
    # Password
    while true; do
        printf "  Password: "
        stty -echo 2>/dev/null || true
        read PASSWORD
        stty echo 2>/dev/null || true
        echo ""
        
        if [ -z "$PASSWORD" ]; then
            warn "  Password cannot be empty"
            continue
        fi
        
        if [ ${#PASSWORD} -lt 4 ]; then
            warn "  Password must be at least 4 characters"
            continue
        fi
        
        printf "  Confirm password: "
        stty -echo 2>/dev/null || true
        read PASSWORD2
        stty echo 2>/dev/null || true
        echo ""
        
        if [ "$PASSWORD" != "$PASSWORD2" ]; then
            warn "  Passwords do not match"
            continue
        fi
        
        break
    done
    
    # Create auth in SQLite
    step "Setting up authentication..."
    
    python3 << AUTHEOF
import sqlite3
import hashlib
import os

db_path = "$PINPOINT_DIR/data/stats.db"
os.makedirs(os.path.dirname(db_path), exist_ok=True)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Create auth table
cursor.execute('''
    CREATE TABLE IF NOT EXISTS auth (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL DEFAULT 'admin',
        password_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        session_hours INTEGER NOT NULL DEFAULT 24,
        last_login TEXT,
        first_login INTEGER NOT NULL DEFAULT 1
    )
''')

# Hash password
password_hash = hashlib.sha256('$PASSWORD'.encode()).hexdigest()

# Insert user
cursor.execute('''
    INSERT OR REPLACE INTO auth (id, username, password_hash, enabled, session_hours, first_login)
    VALUES (1, '$USERNAME', ?, 1, 24, 1)
''', (password_hash,))

conn.commit()
conn.close()
AUTHEOF

    info "User '$USERNAME' created"
}

# ============================================
# Service Setup
# ============================================
create_init_script() {
    echo ""
    echo -e "${BLUE}Creating System Service${NC}"
    echo "----------------------------------------"
    
    step "Creating PinPoint init.d service..."
    
    cat > /etc/init.d/pinpoint << 'INITEOF'
#!/bin/sh /etc/rc.common

START=99
STOP=10

start() {
    echo "Starting PinPoint..."
    cd /opt/pinpoint/backend
    /usr/bin/python3 -u main.py > /var/log/pinpoint.log 2>&1 &
    echo $! > /var/run/pinpoint.pid
}

stop() {
    echo "Stopping PinPoint..."
    if [ -f /var/run/pinpoint.pid ]; then
        kill $(cat /var/run/pinpoint.pid) 2>/dev/null
        rm -f /var/run/pinpoint.pid
    fi
    killall python3 2>/dev/null || true
}

restart() {
    stop
    sleep 1
    start
}
INITEOF

    chmod +x /etc/init.d/pinpoint
    
    # Enable service
    /etc/init.d/pinpoint enable 2>/dev/null || true
    
    info "PinPoint service created"
    
    # Create sing-box init script (simple version)
    step "Creating sing-box init.d service..."
    
    cat > /etc/init.d/sing-box << 'SBINIT'
#!/bin/sh /etc/rc.common

START=95
STOP=15

start() {
    echo "Starting sing-box..."
    /usr/bin/sing-box run -c /etc/sing-box/config.json > /var/log/sing-box.log 2>&1 &
    echo $! > /var/run/sing-box.pid
    # Initialize pinpoint routing after sing-box starts
    sleep 3
    [ -x /opt/pinpoint/scripts/pinpoint-init.sh ] && /opt/pinpoint/scripts/pinpoint-init.sh start
}

stop() {
    echo "Stopping sing-box..."
    [ -x /opt/pinpoint/scripts/pinpoint-init.sh ] && /opt/pinpoint/scripts/pinpoint-init.sh stop
    if [ -f /var/run/sing-box.pid ]; then
        kill $(cat /var/run/sing-box.pid) 2>/dev/null
        rm -f /var/run/sing-box.pid
    fi
    killall sing-box 2>/dev/null || true
}

restart() {
    stop
    sleep 1
    start
}
SBINIT

    chmod +x /etc/init.d/sing-box
    /etc/init.d/sing-box enable 2>/dev/null || true
    
    info "sing-box service created"
}

# ============================================
# Routing Setup
# ============================================
create_routing_scripts() {
    echo ""
    echo -e "${BLUE}Creating Routing Scripts${NC}"
    echo "----------------------------------------"
    
    step "Creating pinpoint-init.sh..."
    
    cat > "$PINPOINT_DIR/scripts/pinpoint-init.sh" << 'ROUTESCRIPT'
#!/bin/sh
# PinPoint - Policy Routing Initialization Script

MARK=0x100
TABLE_ID=100
TUN_IFACE="tun1"

log() { echo "[pinpoint] $1"; }

case "${1:-start}" in
    start)
        log "Initializing routing..."
        
        # Check tun interface
        if ! ip link show "$TUN_IFACE" > /dev/null 2>&1; then
            log "ERROR: $TUN_IFACE not found"
            exit 1
        fi
        
        # Setup policy routing
        ip rule del fwmark $MARK lookup $TABLE_ID 2>/dev/null || true
        ip route flush table $TABLE_ID 2>/dev/null || true
        
        grep -q "^$TABLE_ID" /etc/iproute2/rt_tables 2>/dev/null || \
            echo "$TABLE_ID pinpoint" >> /etc/iproute2/rt_tables
        
        ip rule add fwmark $MARK lookup $TABLE_ID priority 100
        ip route add default dev $TUN_IFACE table $TABLE_ID
        
        # Setup nftables
        nft delete table inet pinpoint 2>/dev/null || true
        nft -f - << 'NFT'
table inet pinpoint {
    set tunnel_ips { type ipv4_addr; flags timeout; timeout 1h; }
    set tunnel_nets { type ipv4_addr; flags interval; }
    
    chain prerouting {
        type filter hook prerouting priority mangle - 1; policy accept;
        ip daddr @tunnel_ips meta mark set 0x100 counter
        ip daddr @tunnel_nets meta mark set 0x100 counter
    }
    chain output {
        type route hook output priority mangle - 1; policy accept;
        ip daddr @tunnel_ips meta mark set 0x100 counter
        ip daddr @tunnel_nets meta mark set 0x100 counter
    }
}
NFT
        log "Routing initialized"
        ;;
    stop)
        log "Stopping routing..."
        ip rule del fwmark $MARK lookup $TABLE_ID 2>/dev/null || true
        ip route flush table $TABLE_ID 2>/dev/null || true
        nft delete table inet pinpoint 2>/dev/null || true
        log "Routing stopped"
        ;;
    status)
        echo "=== Policy Routing ==="
        ip rule show | grep -E "pinpoint|$TABLE_ID" || echo "No rules"
        echo ""
        echo "=== NFTables ==="
        nft list table inet pinpoint 2>/dev/null || echo "Table not found"
        ;;
    *)
        echo "Usage: $0 {start|stop|status}"
        ;;
esac
ROUTESCRIPT

    chmod +x "$PINPOINT_DIR/scripts/pinpoint-init.sh"
    
    info "Routing scripts created"
}

# ============================================
# sing-box Configuration
# ============================================
create_singbox_config() {
    echo ""
    echo -e "${BLUE}Creating sing-box Configuration${NC}"
    echo "----------------------------------------"
    
    step "Creating default sing-box config..."
    
    mkdir -p /etc/sing-box
    
    # Create minimal config (will be updated by PinPoint when tunnels are added)
    cat > /etc/sing-box/config.json << 'SBCONFIG'
{
  "log": {"level": "info"},
  "dns": {
    "servers": [
      {"tag": "google", "address": "8.8.8.8"},
      {"tag": "local", "address": "127.0.0.1", "detour": "direct-out"}
    ]
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "tun1",
      "address": ["10.0.0.1/30"],
      "mtu": 9000,
      "auto_route": false,
      "sniff": true
    }
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct-out"},
    {"type": "dns", "tag": "dns-out"}
  ],
  "route": {
    "rules": [
      {"protocol": "dns", "outbound": "dns-out"}
    ],
    "auto_detect_interface": true
  }
}
SBCONFIG

    info "sing-box config created (add tunnels via PinPoint UI)"
}

# ============================================
# Firewall Setup
# ============================================
setup_firewall() {
    step "Configuring firewall..."
    
    # Allow port 8080 for web interface
    if ! uci show firewall 2>/dev/null | grep -q "pinpoint"; then
        uci add firewall rule >/dev/null
        uci set firewall.@rule[-1].name='Allow-PinPoint'
        uci set firewall.@rule[-1].src='lan'
        uci set firewall.@rule[-1].dest_port='8080'
        uci set firewall.@rule[-1].proto='tcp'
        uci set firewall.@rule[-1].target='ACCEPT'
        uci commit firewall
        /etc/init.d/firewall reload >/dev/null 2>&1 || true
    fi
    
    info "Firewall configured"
}

# ============================================
# Start Service
# ============================================
start_service() {
    echo ""
    echo -e "${BLUE}Starting PinPoint${NC}"
    echo "----------------------------------------"
    
    step "Starting service..."
    
    /etc/init.d/pinpoint start
    
    # Wait and check
    sleep 3
    
    if pgrep -f "python3.*main.py" >/dev/null 2>&1; then
        info "PinPoint is running"
    else
        warn "Service may not have started. Check: logread | grep pinpoint"
    fi
}

# ============================================
# Print Success
# ============================================
get_lan_ip() {
    # Try to get LAN IP
    IP=$(uci get network.lan.ipaddr 2>/dev/null)
    if [ -z "$IP" ]; then
        IP=$(ip addr show br-lan 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
    fi
    if [ -z "$IP" ]; then
        IP="<router-ip>"
    fi
    echo "$IP"
}

# ============================================
# Cleanup
# ============================================
cleanup_install() {
    step "Cleaning up installation..."
    
    # Kill any lingering pip processes
    killall pip3 2>/dev/null || true
    
    # Clear package cache
    rm -rf /tmp/opkg-* 2>/dev/null || true
    
    # Sync and drop caches to free memory
    sync
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    
    info "Cleanup complete"
}

print_success() {
    IP=$(get_lan_ip)
    
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                                                    ║${NC}"
    echo -e "${GREEN}║    PinPoint installed successfully! 🎉            ║${NC}"
    echo -e "${GREEN}║                                                    ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${CYAN}Web Interface:${NC}"
    echo -e "    http://${GREEN}$IP:8080${NC}"
    echo ""
    echo -e "  ${CYAN}Login:${NC}"
    echo -e "    Username: ${GREEN}$USERNAME${NC}"
    echo -e "    Password: (the one you set)"
    echo ""
    echo -e "  ${CYAN}Service Commands:${NC}"
    echo "    /etc/init.d/pinpoint start"
    echo "    /etc/init.d/pinpoint stop"
    echo "    /etc/init.d/pinpoint restart"
    echo "    /etc/init.d/pinpoint status"
    echo ""
    echo -e "  ${CYAN}Logs:${NC}"
    echo "    logread | grep pinpoint"
    echo ""
    echo -e "  ${YELLOW}Note:${NC} On first login you will be redirected to"
    echo "        the Help section to get started."
    echo ""
}

# ============================================
# Uninstall Function
# ============================================
uninstall() {
    echo -e "${RED}Uninstalling PinPoint...${NC}"
    
    # Stop service
    /etc/init.d/pinpoint stop 2>/dev/null || true
    /etc/init.d/pinpoint disable 2>/dev/null || true
    
    # Remove files
    rm -rf "$PINPOINT_DIR"
    rm -f /etc/init.d/pinpoint
    rm -rf /var/log/pinpoint
    
    # Remove firewall rule
    # (keeping for safety - manual removal recommended)
    
    info "PinPoint uninstalled"
    echo "Note: Python packages and sing-box were not removed."
    echo "To remove them: opkg remove sing-box python3-pip ..."
}

# ============================================
# Main
# ============================================
main() {
    clear
    
    echo -e "${CYAN}"
    echo "  ╔═══════════════════════════════════════════════════╗"
    echo "  ║                                                   ║"
    echo "  ║   ██████╗ ██╗███╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗  ║"
    echo "  ║   ██╔══██╗██║████╗  ██║██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝  ║"
    echo "  ║   ██████╔╝██║██╔██╗ ██║██████╔╝██║   ██║██║██╔██╗ ██║   ██║     ║"
    echo "  ║   ██╔═══╝ ██║██║╚██╗██║██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║     ║"
    echo "  ║   ██║     ██║██║ ╚████║██║     ╚██████╔╝██║██║ ╚████║   ██║     ║"
    echo "  ║   ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝     ║"
    echo "  ║                                                   ║"
    echo "  ║      Selective VPN Routing for OpenWRT           ║"
    echo "  ║                  v$PINPOINT_VERSION                          ║"
    echo "  ║                                                   ║"
    echo "  ╚═══════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    
    # Check for uninstall flag
    if [ "$1" = "--uninstall" ] || [ "$1" = "-u" ]; then
        uninstall
        exit 0
    fi
    
    # Pre-flight checks
    echo -e "${BLUE}Pre-flight Checks${NC}"
    echo "----------------------------------------"
    check_root
    check_openwrt
    check_architecture
    check_internet
    check_disk_space
    echo ""
    
    # Install
    update_packages
    create_directories
    install_dependencies
    save_installed_packages
    install_python_packages
    download_files
    setup_luci
    setup_default_config
    setup_authentication
    create_init_script
    create_routing_scripts
    create_singbox_config
    setup_firewall
    start_service
    cleanup_install
    print_success
}

# Run
main "$@"
