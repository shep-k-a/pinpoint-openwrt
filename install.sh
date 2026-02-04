#!/bin/sh
#
# PinPoint - Selective VPN Routing for OpenWRT
# Installation Script
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh
#
# With mode specified:
#   curl -fsSL .../install.sh | sh -s -- lite
#   curl -fsSL .../install.sh | sh -s -- full
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

# Quiet opkg - filter out noise but keep errors
opkg_quiet() {
    opkg "$@" 2>&1 | grep -v "no valid architecture" | grep -v "^Package .* ignoring.$" || true
}

# Silent opkg - no output unless error
opkg_silent() {
    opkg "$@" 2>&1 | grep -iE "error|failed|cannot|No space" || true
}

# Download file - tries curl first, falls back to wget
download() {
    URL="$1"
    OUTPUT="$2"
    if command -v curl >/dev/null 2>&1; then
        if curl -fsSL --max-time 30 --connect-timeout 10 -o "$OUTPUT" "$URL" 2>/dev/null; then
            return 0
        else
            return 1
        fi
    elif command -v wget >/dev/null 2>&1; then
        if wget -q --timeout=30 --tries=2 -O "$OUTPUT" "$URL" 2>/dev/null; then
            return 0
        else
            return 1
        fi
    else
        error "Neither curl nor wget found. Install one: opkg install curl"
    fi
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
    
    # Simple disk check - just verify / has space
    # Use subshell to prevent set -e issues
    AVAILABLE_MB=$(df / 2>/dev/null | awk 'NR==2 {printf "%.0f", $4/1024}' || echo "0")
    
    # If parsing failed or returned empty, assume OK
    if [ -z "$AVAILABLE_MB" ] || [ "$AVAILABLE_MB" = "0" ]; then
        # Try alternative parsing
        AVAILABLE_MB=$(df -m / 2>/dev/null | awk 'NR==2 {print $4}' || echo "100")
    fi
    
    # Need at least 10MB
    if [ "$AVAILABLE_MB" -lt 10 ] 2>/dev/null; then
        error "Not enough disk space. Need at least 10MB, have ${AVAILABLE_MB}MB"
    fi
    
    info "Available space: ${AVAILABLE_MB}MB"
}

# ============================================
# Package Installation
# ============================================

# Track installed packages
INSTALLED_BY_PINPOINT=""

update_packages() {
    step "Updating package lists..."
    opkg_silent update
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
    
    # Install with filtered output
    OUTPUT=$(opkg install "$PKG" 2>&1 | grep -v "no valid architecture" | grep -v "ignoring.$")
    
    if opkg list-installed 2>/dev/null | grep -q "^$PKG "; then
        info "$DESC installed"
        INSTALLED_BY_PINPOINT="$INSTALLED_BY_PINPOINT $PKG"
        return 0
    else
        # Show error output if failed
        echo "$OUTPUT" | grep -iE "error|failed|cannot|No space" | head -2 || true
        warn "Failed to install $PKG"
        return 1
    fi
}

# ============================================
# ImmortalWRT Repository Setup
# ============================================
IMMORTALWRT_REPO_ADDED=0

setup_immortalwrt_repo() {
    step "Setting up ImmortalWRT repository..."
    
    # Detect architecture
    detect_package_arch
    
    # Get OpenWRT version
    OPENWRT_MAJOR=$(echo "$OPENWRT_VERSION" | cut -d. -f1,2)
    
    # Find working ImmortalWRT release (try more versions)
    # Try 22.03 branch as well for older devices
    for IMMORTAL_VER in "${OPENWRT_MAJOR}" "23.05.5" "23.05.4" "23.05.3" "23.05.2" "23.05.1" "23.05.0" "22.03.5" "22.03.4" "22.03.3"; do
        IMMORTAL_BASE="https://downloads.immortalwrt.org/releases/${IMMORTAL_VER}/packages/${IMMORTAL_ARCH}/packages"
        
        step "  Checking ImmortalWRT ${IMMORTAL_VER}..."
        
        # Test if repository is accessible (try both Packages.gz and Packages)
        if curl -fsSL --max-time 10 "${IMMORTAL_BASE}/Packages.gz" >/dev/null 2>&1 || \
           curl -fsSL --max-time 10 "${IMMORTAL_BASE}/Packages" >/dev/null 2>&1; then
            IMMORTAL_RELEASE="$IMMORTAL_VER"
            info "Found accessible ImmortalWRT repository: ${IMMORTAL_VER}"
            break
        else
            warn "    ImmortalWRT ${IMMORTAL_VER} not accessible"
        fi
    done
    
    if [ -z "$IMMORTAL_RELEASE" ]; then
        warn "Could not find accessible ImmortalWRT repository"
        warn "Architecture: ${IMMORTAL_ARCH}, OpenWRT: ${OPENWRT_VERSION}"
        return 1
    fi
    
    # Repository configuration file
    REPO_FILE="/etc/opkg/customfeeds.conf"
    REPO_NAME="immortalwrt_packages"
    REPO_URL="https://downloads.immortalwrt.org/releases/${IMMORTAL_RELEASE}/packages/${IMMORTAL_ARCH}/packages"
    
    # Check if already added
    if grep -q "immortalwrt" "$REPO_FILE" 2>/dev/null; then
        info "ImmortalWRT repository already configured"
        IMMORTALWRT_REPO_ADDED=1
        return 0
    fi
    
    # Create customfeeds.conf if not exists
    touch "$REPO_FILE"
    
    # Add ImmortalWRT repository
    echo "" >> "$REPO_FILE"
    echo "# ImmortalWRT packages repository (added by PinPoint)" >> "$REPO_FILE"
    echo "src/gz ${REPO_NAME} ${REPO_URL}" >> "$REPO_FILE"
    
    # Download and add ImmortalWRT signing key
    step "Adding ImmortalWRT signing key..."
    KEYS_DIR="/etc/opkg/keys"
    mkdir -p "$KEYS_DIR"
    
    # ImmortalWRT uses usign keys, try to fetch
    KEY_URL="https://downloads.immortalwrt.org/releases/${IMMORTAL_RELEASE}/packages/${IMMORTAL_ARCH}/packages/Packages.sig"
    if curl -fsSL "$KEY_URL" -o /tmp/immortalwrt.sig 2>/dev/null; then
        # Extract key ID from signature (first 16 chars of base64)
        KEY_ID=$(head -c 16 /tmp/immortalwrt.sig 2>/dev/null | base64 2>/dev/null | head -c 16)
        rm -f /tmp/immortalwrt.sig
    fi
    
    # Alternative: disable signature check for this repo (less secure but works)
    # This is common practice for third-party repos on OpenWRT
    sed -i 's/option check_signature/# option check_signature/' /etc/opkg.conf 2>/dev/null || true
    
    # Update package lists with new repo (suppress arch warnings)
    step "Updating package lists with ImmortalWRT..."
    opkg_silent update
    info "ImmortalWRT repository added (${IMMORTAL_RELEASE})"
    IMMORTALWRT_REPO_ADDED=1
    return 0
}

# ============================================
# sing-box Installation
# ============================================
# Minimum tested version for PinPoint features
SINGBOX_MIN_VERSION="1.10.0"
# Pinned version - set to specific version for stability
# Tested and verified to work with PinPoint
SINGBOX_PINNED_VERSION="1.11.7"
# Set to "1" to enforce pinned version, "0" to allow any >= MIN
SINGBOX_PIN_ENABLED="1"

# Detect architecture for package repositories
detect_package_arch() {
    case "$ARCH" in
        mips)
            IMMORTAL_ARCH="mips_24kc"
            # Try multiple MIPS variants (softfloat, hardfloat, generic)
            SAGERNET_ARCH_VARIANTS="linux-mips-softfloat linux-mips-hardfloat linux-mips"
            SAGERNET_ARCH="linux-mips-softfloat"  # Default
            ;;
        mipsel)
            IMMORTAL_ARCH="mipsel_24kc"
            # Try multiple MIPSLE variants
            SAGERNET_ARCH_VARIANTS="linux-mipsle-softfloat linux-mipsle-hardfloat linux-mipsle"
            SAGERNET_ARCH="linux-mipsle-softfloat"  # Default
            ;;
        aarch64)
            IMMORTAL_ARCH="aarch64_cortex-a53"
            SAGERNET_ARCH_VARIANTS="linux-arm64"
            SAGERNET_ARCH="linux-arm64"
            ;;
        armv7l|armv7)
            IMMORTAL_ARCH="arm_cortex-a7_neon-vfpv4"
            SAGERNET_ARCH_VARIANTS="linux-armv7"
            SAGERNET_ARCH="linux-armv7"
            ;;
        x86_64)
            IMMORTAL_ARCH="x86_64"
            SAGERNET_ARCH_VARIANTS="linux-amd64"
            SAGERNET_ARCH="linux-amd64"
            ;;
        *)
            IMMORTAL_ARCH="$ARCH"
            SAGERNET_ARCH_VARIANTS=""
            SAGERNET_ARCH=""
            ;;
    esac
}

install_singbox() {
    step "Installing sing-box..."
    
    # Detect architecture first
    detect_package_arch
    if [ -n "$SAGERNET_ARCH_VARIANTS" ]; then
        info "Architecture: ${ARCH} → ImmortalWRT: ${IMMORTAL_ARCH}, SagerNet variants: ${SAGERNET_ARCH_VARIANTS}"
    else
        info "Architecture: ${ARCH} → ImmortalWRT: ${IMMORTAL_ARCH}, SagerNet: ${SAGERNET_ARCH:-none}"
    fi
    
    # Check if already installed with sufficient version
    if command -v sing-box >/dev/null 2>&1; then
        CURRENT_VERSION=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        if [ -n "$CURRENT_VERSION" ]; then
            # If pinning enabled, check exact version
            if [ "$SINGBOX_PIN_ENABLED" = "1" ]; then
                if [ "$CURRENT_VERSION" = "$SINGBOX_PINNED_VERSION" ]; then
                    info "sing-box $CURRENT_VERSION already installed (pinned version)"
                    return 0
                else
                    warn "sing-box $CURRENT_VERSION installed, but pinned version is $SINGBOX_PINNED_VERSION"
                    step "Reinstalling with pinned version..."
                fi
            elif version_ge "$CURRENT_VERSION" "$SINGBOX_MIN_VERSION"; then
                info "sing-box $CURRENT_VERSION already installed"
                return 0
            else
                warn "sing-box $CURRENT_VERSION is outdated (need >= $SINGBOX_MIN_VERSION)"
            fi
        fi
    fi
    
    # =============================================
    # Method 1: OpenWRT official repository (PREFERRED - opkg)
    # =============================================
    step "Trying OpenWRT official repository (opkg)..."
    
    # If pinning enabled, try to install specific version first
    if [ "$SINGBOX_PIN_ENABLED" = "1" ]; then
        step "  Checking for pinned version ${SINGBOX_PINNED_VERSION}..."
        # Check if pinned version is available
        AVAILABLE_VERSIONS=$(opkg list sing-box 2>/dev/null | grep -oE "sing-box - [0-9]+\.[0-9]+\.[0-9]+" | awk '{print $3}')
        if echo "$AVAILABLE_VERSIONS" | grep -q "^${SINGBOX_PINNED_VERSION}$"; then
            step "  Installing pinned version ${SINGBOX_PINNED_VERSION}..."
            opkg_silent install "sing-box=${SINGBOX_PINNED_VERSION}"
            if command -v sing-box >/dev/null 2>&1; then
                INSTALLED_VER=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
                if [ "$INSTALLED_VER" = "$SINGBOX_PINNED_VERSION" ]; then
                    info "sing-box ${INSTALLED_VER} installed from OpenWRT repo (pinned version)"
                    return 0
                fi
            fi
        else
            info "  Pinned version ${SINGBOX_PINNED_VERSION} not available in OpenWRT repo"
            if [ -n "$AVAILABLE_VERSIONS" ]; then
                info "  Available versions: $(echo "$AVAILABLE_VERSIONS" | tr '\n' ' ')"
            fi
        fi
    fi
    
    # Try any available version
    step "  Installing any available version..."
    opkg_silent install sing-box
    if command -v sing-box >/dev/null 2>&1; then
        INSTALLED_VER=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        if [ "$SINGBOX_PIN_ENABLED" = "1" ] && [ "$INSTALLED_VER" != "$SINGBOX_PINNED_VERSION" ]; then
            warn "Installed version ${INSTALLED_VER} differs from pinned ${SINGBOX_PINNED_VERSION}"
        fi
        info "sing-box ${INSTALLED_VER:-unknown} installed from OpenWRT repo"
        return 0
    fi
    
    # =============================================
    # Method 2: ImmortalWRT repo via opkg
    # =============================================
    if [ "$IMMORTALWRT_REPO_ADDED" = "1" ] || setup_immortalwrt_repo; then
        step "Installing sing-box from ImmortalWRT via opkg..."
        
        # If pinning enabled, try to install specific version first
        if [ "$SINGBOX_PIN_ENABLED" = "1" ]; then
            step "  Checking for pinned version ${SINGBOX_PINNED_VERSION}..."
            # Update package lists first
            opkg_silent update
            AVAILABLE_VERSIONS=$(opkg list sing-box 2>/dev/null | grep -oE "sing-box - [0-9]+\.[0-9]+\.[0-9]+" | awk '{print $3}')
            if echo "$AVAILABLE_VERSIONS" | grep -q "^${SINGBOX_PINNED_VERSION}$"; then
                step "  Installing pinned version ${SINGBOX_PINNED_VERSION}..."
                opkg_silent install "sing-box=${SINGBOX_PINNED_VERSION}"
                if command -v sing-box >/dev/null 2>&1; then
                    INSTALLED_VER=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
                    if [ "$INSTALLED_VER" = "$SINGBOX_PINNED_VERSION" ]; then
                        info "sing-box ${INSTALLED_VER} installed from ImmortalWRT (pinned version)"
                        return 0
                    fi
                fi
            else
                info "  Pinned version ${SINGBOX_PINNED_VERSION} not available in ImmortalWRT repo"
                if [ -n "$AVAILABLE_VERSIONS" ]; then
                    info "  Available versions: $(echo "$AVAILABLE_VERSIONS" | tr '\n' ' ')"
                fi
            fi
        fi
        
        # Try any available version
        step "  Installing any available version..."
        opkg_silent install sing-box
        if command -v sing-box >/dev/null 2>&1; then
            INSTALLED_VER=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
            if [ "$SINGBOX_PIN_ENABLED" = "1" ] && [ "$INSTALLED_VER" != "$SINGBOX_PINNED_VERSION" ]; then
                warn "Installed version ${INSTALLED_VER} differs from pinned ${SINGBOX_PINNED_VERSION}"
            fi
            info "sing-box ${INSTALLED_VER:-unknown} installed from ImmortalWRT"
            return 0
        fi
    fi
    
    # =============================================
    # Method 3: Direct download from ImmortalWRT
    # =============================================
    step "Trying direct download from ImmortalWRT..."
    
    OPENWRT_MAJOR=$(echo "$OPENWRT_VERSION" | cut -d. -f1,2)
    
    # Try more ImmortalWRT versions
    for IMMORTAL_VER in "${OPENWRT_MAJOR}" "23.05.5" "23.05.4" "23.05.3" "23.05.2" "23.05.1" "23.05.0"; do
        IMMORTAL_BASE="https://downloads.immortalwrt.org/releases/${IMMORTAL_VER}/packages/${IMMORTAL_ARCH}/packages"
        
        # Try Packages.gz first, then Packages
        PACKAGES_CONTENT=""
        if curl -fsSL --max-time 10 "${IMMORTAL_BASE}/Packages.gz" 2>/dev/null | gunzip 2>/dev/null | head -1000 >/tmp/packages.txt 2>/dev/null; then
            PACKAGES_CONTENT="/tmp/packages.txt"
        elif curl -fsSL --max-time 10 "${IMMORTAL_BASE}/Packages" 2>/dev/null | head -1000 >/tmp/packages.txt 2>/dev/null; then
            PACKAGES_CONTENT="/tmp/packages.txt"
        fi
        
        if [ -n "$PACKAGES_CONTENT" ] && [ -f "$PACKAGES_CONTENT" ]; then
            # Get package list and find sing-box
            SINGBOX_PKG=$(grep -A1 "^Package: sing-box$" "$PACKAGES_CONTENT" 2>/dev/null | grep "Filename:" | awk '{print $2}')
            
            if [ -n "$SINGBOX_PKG" ]; then
                SINGBOX_URL="${IMMORTAL_BASE}/${SINGBOX_PKG}"
                TMP_PKG="/tmp/sing-box.ipk"
                
                step "  Downloading from ImmortalWRT ${IMMORTAL_VER}..."
                if download "$SINGBOX_URL" "$TMP_PKG"; then
                    if [ -f "$TMP_PKG" ] && [ -s "$TMP_PKG" ]; then
                        opkg_silent install "$TMP_PKG"
                        rm -f "$TMP_PKG" "/tmp/packages.txt"
                        if command -v sing-box >/dev/null 2>&1; then
                            INSTALLED_VER=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
                            info "sing-box ${INSTALLED_VER:-unknown} installed (ImmortalWRT direct)"
                            return 0
                        fi
                    else
                        warn "  Downloaded file is empty or invalid"
                    fi
                else
                    warn "  Failed to download package from ${IMMORTAL_VER}"
                fi
            else
                [ "$DEBUG" = "1" ] && warn "  sing-box not found in ${IMMORTAL_VER} repository" || true
            fi
            rm -f "/tmp/packages.txt"
        else
            [ "$DEBUG" = "1" ] && warn "  Cannot access Packages file for ${IMMORTAL_VER}" || true
        fi
    done
    
    # =============================================
    # Method 4: SagerNet pinned version (fallback - direct download)
    # =============================================
    if [ "$SINGBOX_PIN_ENABLED" = "1" ] && [ -n "$SAGERNET_ARCH_VARIANTS" ]; then
        step "Trying pinned sing-box v${SINGBOX_PINNED_VERSION} from GitHub..."
        info "Will try variants: ${SAGERNET_ARCH_VARIANTS}"
        
        TMP_DIR="/tmp/singbox_install"
        mkdir -p "$TMP_DIR"
        
        # Try all architecture variants for MIPS
        TRIED_ARCHS=""
        for ARCH_VARIANT in $SAGERNET_ARCH_VARIANTS; do
            BINARY_URL="https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_PINNED_VERSION}/sing-box-${SINGBOX_PINNED_VERSION}-${ARCH_VARIANT}.tar.gz"
            TRIED_ARCHS="$TRIED_ARCHS $ARCH_VARIANT"
            
            step "  Trying ${ARCH_VARIANT}..."
            
            # Check if URL is accessible first
            if curl -fsSL --max-time 15 --head "$BINARY_URL" >/dev/null 2>&1; then
                if download "$BINARY_URL" "$TMP_DIR/sing-box.tar.gz"; then
                    cd "$TMP_DIR"
                    if tar -xzf sing-box.tar.gz 2>/dev/null; then
                        BINARY_PATH=$(find . -name "sing-box" -type f 2>/dev/null | head -1)
                        if [ -n "$BINARY_PATH" ] && [ -f "$BINARY_PATH" ]; then
                            # Remove old version if exists
                            rm -f /usr/bin/sing-box 2>/dev/null
                            chmod +x "$BINARY_PATH"
                            mv "$BINARY_PATH" /usr/bin/sing-box
                            cd /
                            rm -rf "$TMP_DIR"
                            info "sing-box ${SINGBOX_PINNED_VERSION} installed (pinned version, ${ARCH_VARIANT})"
                            return 0
                        else
                            warn "    Binary not found in archive"
                        fi
                    else
                        warn "    Failed to extract archive"
                    fi
                    cd /
                    rm -rf "$TMP_DIR"
                else
                    warn "    Failed to download"
                fi
            else
                warn "    URL not accessible for ${ARCH_VARIANT}"
            fi
        done
        
        if [ -n "$TRIED_ARCHS" ]; then
            warn "Failed to download pinned version (tried:$TRIED_ARCHS), trying alternatives..."
        else
            warn "No architecture variants to try, skipping pinned version..."
        fi
    fi
    
    # =============================================
    # Method 5: SagerNet latest release (fallback)
    # =============================================
    if [ -n "$SAGERNET_ARCH_VARIANTS" ]; then
        step "Trying SagerNet latest release..."
        
        LATEST_RELEASE=$(curl -fsSL --max-time 10 "https://api.github.com/repos/SagerNet/sing-box/releases/latest" 2>/dev/null | grep '"tag_name"' | cut -d'"' -f4)
        
        if [ -n "$LATEST_RELEASE" ]; then
            VERSION_NUM=$(echo "$LATEST_RELEASE" | sed 's/^v//')
            
            TMP_DIR="/tmp/singbox_install"
            mkdir -p "$TMP_DIR"
            
            # Try all architecture variants
            for ARCH_VARIANT in $SAGERNET_ARCH_VARIANTS; do
                BINARY_URL="https://github.com/SagerNet/sing-box/releases/download/${LATEST_RELEASE}/sing-box-${VERSION_NUM}-${ARCH_VARIANT}.tar.gz"
                
                step "  Trying latest (${VERSION_NUM}) with ${ARCH_VARIANT}..."
                
                if curl -fsSL --max-time 15 --head "$BINARY_URL" >/dev/null 2>&1; then
                    if download "$BINARY_URL" "$TMP_DIR/sing-box.tar.gz"; then
                        cd "$TMP_DIR"
                        if tar -xzf sing-box.tar.gz 2>/dev/null; then
                            BINARY_PATH=$(find . -name "sing-box" -type f 2>/dev/null | head -1)
                            if [ -n "$BINARY_PATH" ] && [ -f "$BINARY_PATH" ]; then
                                rm -f /usr/bin/sing-box 2>/dev/null
                                chmod +x "$BINARY_PATH"
                                mv "$BINARY_PATH" /usr/bin/sing-box
                                cd /
                                rm -rf "$TMP_DIR"
                                info "sing-box $VERSION_NUM installed from SagerNet (${ARCH_VARIANT})"
                                return 0
                            else
                                warn "    Binary not found in archive"
                            fi
                        else
                            warn "    Failed to extract archive"
                        fi
                        cd /
                        rm -rf "$TMP_DIR"
                    else
                        warn "    Failed to download"
                    fi
                else
                    [ "$DEBUG" = "1" ] && warn "    URL not accessible" || true
                fi
            done
            warn "Latest release not available for any MIPS variant"
        else
            warn "Could not fetch latest release info from GitHub"
        fi
    fi
    
    # =============================================
    # Method 6: Try older sing-box versions (for MIPS compatibility)
    # =============================================
    if [ -n "$SAGERNET_ARCH_VARIANTS" ] && ([ "$ARCH" = "mips" ] || [ "$ARCH" = "mipsel" ]); then
        step "Trying older sing-box versions (MIPS compatibility)..."
        
        # Try a few recent versions that might have MIPS builds
        for OLD_VERSION in "1.10.0" "1.9.4" "1.9.0" "1.8.4" "1.8.0"; do
            step "  Checking v${OLD_VERSION}..."
            for ARCH_VARIANT in $SAGERNET_ARCH_VARIANTS; do
                BINARY_URL="https://github.com/SagerNet/sing-box/releases/download/v${OLD_VERSION}/sing-box-${OLD_VERSION}-${ARCH_VARIANT}.tar.gz"
                
                step "    Trying v${OLD_VERSION} with ${ARCH_VARIANT}..."
                
                if curl -fsSL --max-time 10 --head "$BINARY_URL" >/dev/null 2>&1; then
                    step "    Found v${OLD_VERSION} with ${ARCH_VARIANT}, downloading..."
                    TMP_DIR="/tmp/singbox_install"
                    mkdir -p "$TMP_DIR"
                    
                    if download "$BINARY_URL" "$TMP_DIR/sing-box.tar.gz"; then
                        cd "$TMP_DIR"
                        if tar -xzf sing-box.tar.gz 2>/dev/null; then
                            BINARY_PATH=$(find . -name "sing-box" -type f 2>/dev/null | head -1)
                            if [ -n "$BINARY_PATH" ] && [ -f "$BINARY_PATH" ]; then
                                rm -f /usr/bin/sing-box 2>/dev/null
                                chmod +x "$BINARY_PATH"
                                mv "$BINARY_PATH" /usr/bin/sing-box
                                cd /
                                rm -rf "$TMP_DIR"
                                
                                # Verify version meets minimum
                                INSTALLED_VER=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
                                if [ -n "$INSTALLED_VER" ] && version_ge "$INSTALLED_VER" "$SINGBOX_MIN_VERSION"; then
                                    info "sing-box ${INSTALLED_VER} installed (older version, ${ARCH_VARIANT})"
                                    warn "Note: Using older version ${INSTALLED_VER} instead of pinned ${SINGBOX_PINNED_VERSION}"
                                    return 0
                                elif [ -n "$INSTALLED_VER" ]; then
                                    warn "Version ${INSTALLED_VER} is below minimum ${SINGBOX_MIN_VERSION}, trying next..."
                                    rm -f /usr/bin/sing-box
                                else
                                    warn "Could not verify version, trying next..."
                                    rm -f /usr/bin/sing-box
                                fi
                            else
                                warn "    Binary not found in archive"
                            fi
                        else
                            warn "    Failed to extract archive"
                        fi
                        cd /
                        rm -rf "$TMP_DIR"
                    else
                        warn "    Failed to download"
                    fi
                    break  # Found working URL, stop trying other arch variants for this version
                else
                    [ "$DEBUG" = "1" ] && warn "    URL not accessible" || true
                fi
            done
        done
        warn "No older versions found with MIPS builds"
    fi
    
    # Final diagnostic info
    echo ""
    warn "Could not install sing-box automatically"
    echo "  Architecture detected: ${ARCH} (${IMMORTAL_ARCH:-unknown})"
    if [ -n "$SAGERNET_ARCH_VARIANTS" ]; then
        echo "  SagerNet variants tried: ${SAGERNET_ARCH_VARIANTS}"
    fi
    echo "  OpenWRT version: ${OPENWRT_VERSION}"
    echo ""
    echo "  Troubleshooting:"
    echo "  1. Check internet connection: ping -c 1 8.8.8.8"
    echo "  2. Check if architecture is supported: uname -m"
    echo "  3. Try manual installation: https://sing-box.sagernet.org/installation/from-source/"
    echo "  4. For MIPS devices, try: opkg install sing-box (if repo available)"
    echo "  5. Consider using HomeProxy (luci-app-homeproxy) which includes sing-box"
    return 1
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
    install_package "ca-certificates" "CA certificates"
    install_package "ca-bundle" "CA bundle"
    
    # sing-box with multiple fallback sources
    install_singbox
    install_package "kmod-tun" "TUN kernel module"
    
    # Firewall and routing
    if command -v nft >/dev/null 2>&1; then
        info "nftables - already installed"
    else
        install_package "nftables-json" "nftables firewall" || install_package "nftables" "nftables"
    fi
    install_package "ip-full" "iproute2 full"
    
    # DNS - need dnsmasq-full for nftset support
    # Must remove standard dnsmasq first as they conflict
    step "Installing dnsmasq-full (with nftset support)..."
    if opkg list-installed 2>/dev/null | grep -q "^dnsmasq-full "; then
        info "dnsmasq-full already installed"
    else
        # Remove standard dnsmasq if present (they conflict)
        if opkg list-installed 2>/dev/null | grep -q "^dnsmasq "; then
            opkg remove dnsmasq --force-removal-of-dependent-packages >/dev/null 2>&1 || true
        fi
        opkg_quiet install dnsmasq-full
        if opkg list-installed 2>/dev/null | grep -q "^dnsmasq-full "; then
            info "dnsmasq-full installed"
        else
            warn "Failed to install dnsmasq-full, trying standard dnsmasq"
            install_package "dnsmasq" "dnsmasq"
        fi
    fi
    
    # Configure dnsmasq confdir (used for nftset-based routing)
    uci set dhcp.@dnsmasq[0].confdir='/etc/dnsmasq.d' 2>/dev/null || true
    mkdir -p /etc/dnsmasq.d
    
    # Install https-dns-proxy to bypass ISP DNS hijacking (DPI)
    step "Installing https-dns-proxy (DNS over HTTPS)..."
    install_package "https-dns-proxy" "https-dns-proxy"
    
    # Configure dnsmasq to use DoH proxy (bypasses ISP DNS interception)
    # Only if https-dns-proxy is installed and working
    if [ -x /etc/init.d/https-dns-proxy ]; then
        /etc/init.d/https-dns-proxy enable 2>/dev/null || true
        /etc/init.d/https-dns-proxy start 2>/dev/null || true
        sleep 2
        
        # Check if https-dns-proxy is actually running and responding
        if netstat -ln 2>/dev/null | grep -q ":5053" || ss -ln 2>/dev/null | grep -q ":5053"; then
            # Use local DoH proxy (127.0.0.1:5053)
            uci set dhcp.@dnsmasq[0].noresolv='1' 2>/dev/null || true
            uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
            uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#5053' 2>/dev/null || true
            uci commit dhcp 2>/dev/null || true
            /etc/init.d/dnsmasq restart 2>/dev/null || true
            info "DNS over HTTPS enabled (bypasses ISP DNS hijacking)"
        else
            warn "https-dns-proxy not responding, using fallback DNS"
            # Fallback to public DNS
            uci set dhcp.@dnsmasq[0].noresolv='0' 2>/dev/null || true
            uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
            uci add_list dhcp.@dnsmasq[0].server='8.8.8.8' 2>/dev/null || true
            uci add_list dhcp.@dnsmasq[0].server='1.1.1.1' 2>/dev/null || true
            uci commit dhcp 2>/dev/null || true
            /etc/init.d/dnsmasq restart 2>/dev/null || true
        fi
    else
        # Fallback to public DNS (may be intercepted by ISP)
        warn "https-dns-proxy not available, using plain DNS"
        uci set dhcp.@dnsmasq[0].noresolv='0' 2>/dev/null || true
        uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
        uci add_list dhcp.@dnsmasq[0].server='8.8.8.8' 2>/dev/null || true
        uci add_list dhcp.@dnsmasq[0].server='1.1.1.1' 2>/dev/null || true
        uci commit dhcp 2>/dev/null || true
        /etc/init.d/dnsmasq restart 2>/dev/null || true
    fi
    
    # Force clients to use router DNS (critical for nftset to work!)
    step "Configuring DHCP to force router DNS..."
    uci -q delete dhcp.lan.dhcp_option 2>/dev/null || true
    uci add_list dhcp.lan.dhcp_option='6,192.168.5.1' 2>/dev/null || true
    uci commit dhcp 2>/dev/null || true
    info "DHCP configured to force clients to use router DNS (192.168.5.1)"
    
    # Enable DNS query logging for debugging
    step "Enabling DNS query logging..."
    uci set dhcp.@dnsmasq[0].logqueries='1' 2>/dev/null || true
    uci commit dhcp 2>/dev/null || true
    /etc/init.d/dnsmasq restart 2>/dev/null || true
    info "DNS query logging enabled (use: logread | grep query)"
    
    # Increase LuCI/RPC timeouts for slow operations (GitHub updates, IP loading, etc.)
    step "Configuring LuCI/RPC timeouts..."
    uci set rpcd.@rpcd[0].socket_timeout='180' 2>/dev/null || true
    uci commit rpcd 2>/dev/null || true
    uci set uhttpd.main.script_timeout='180' 2>/dev/null || true
    uci set uhttpd.main.network_timeout='180' 2>/dev/null || true
    uci commit uhttpd 2>/dev/null || true
    /etc/init.d/rpcd restart 2>/dev/null || true
    /etc/init.d/uhttpd restart 2>/dev/null || true
    info "LuCI/RPC timeouts set to 180 seconds (prevents XHR timeout errors)"
    
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

# ============================================
# Python Package Versions (MIPS compatible)
# ============================================
# IMPORTANT: Using pydantic v1 (pure Python) for MIPS compatibility
# pydantic v2 requires pydantic-core (Rust) which can't compile on MIPS
#
# These versions are tested on:
#   - MIPS (mipsel_24kc) - SIMAX 1800T, etc.
#   - ARM (aarch64, armv7)
#   - x86_64
#
# fastapi < 0.100.0 supports pydantic v1
# Updated: January 2026

PYTHON_PACKAGES="
fastapi==0.99.1
uvicorn==0.22.0
starlette==0.27.0
pydantic==1.10.13
pyyaml==6.0.1
httpx==0.24.1
"

install_python_packages() {
    echo ""
    echo -e "${BLUE}Installing Python Packages${NC}"
    echo "----------------------------------------"
    info "Using pydantic v1 (pure Python, MIPS compatible)"
    
    # Try opkg first (pre-compiled, faster)
    step "Installing from opkg (if available)..."
    opkg_silent install python3-yaml
    python3 -c "import yaml" 2>/dev/null && info "  python3-yaml OK" || true
    
    # Determine pip command
    if command -v pip3 >/dev/null 2>&1; then
        PIP="pip3"
    else
        PIP="python3 -m pip"
    fi
    
    # Create requirements file
    REQUIREMENTS_FILE="$PINPOINT_DIR/data/requirements.txt"
    echo "$PYTHON_PACKAGES" | grep -v '^$' | grep -v '^#' > "$REQUIREMENTS_FILE"
    
    # Install via pip (quiet mode, show only errors)
    step "Installing Python packages via pip..."
    PIP_OPTS="--root-user-action=ignore --break-system-packages --prefer-binary -q"
    
    FAILED=""
    for pkg in fastapi uvicorn starlette pydantic httpx; do
        PKG_VER=$(grep "^${pkg}==" "$REQUIREMENTS_FILE" | head -1)
        if [ -n "$PKG_VER" ]; then
            if $PIP install $PIP_OPTS "$PKG_VER" 2>&1 | grep -iE "error|failed" | head -1; then
                # Retry without version
                $PIP install $PIP_OPTS "$pkg" 2>/dev/null || FAILED="$FAILED $pkg"
            fi
        fi
    done
    
    # Install pyyaml if not from opkg
    python3 -c "import yaml" 2>/dev/null || $PIP install $PIP_OPTS pyyaml 2>/dev/null || true
    
    # Verify and show results
    echo ""
    step "Installed packages:"
    INSTALLED=$($PIP list 2>/dev/null | grep -iE "uvicorn|fastapi|pydantic|httpx|starlette|pyyaml")
    if [ -n "$INSTALLED" ]; then
        echo "$INSTALLED" | while read line; do echo "  $line"; done
        info "Python packages installed"
    else
        warn "Some packages may not have installed"
    fi
    
    [ -n "$FAILED" ] && warn "Failed packages:$FAILED" || true
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
    download "$GITHUB_REPO/backend/main.py" "$PINPOINT_DIR/backend/main.py" || error "Failed to download main.py"
    download "$GITHUB_REPO/backend/tunnels.py" "$PINPOINT_DIR/backend/tunnels.py" || true
    info "Backend downloaded"
    
    # Frontend
    step "Downloading frontend..."
    download "$GITHUB_REPO/frontend/index.html" "$PINPOINT_DIR/frontend/index.html" || error "Failed to download index.html"
    download "$GITHUB_REPO/frontend/login.html" "$PINPOINT_DIR/frontend/login.html" || error "Failed to download login.html"
    download "$GITHUB_REPO/frontend/css/style.css" "$PINPOINT_DIR/frontend/css/style.css" || error "Failed to download style.css"
    download "$GITHUB_REPO/frontend/js/app.js" "$PINPOINT_DIR/frontend/js/app.js" || error "Failed to download app.js"
    download "$GITHUB_REPO/frontend/assets/logo.svg" "$PINPOINT_DIR/frontend/assets/logo.svg" || true
    info "Frontend downloaded"
    
    # Scripts
    step "Downloading scripts..."
    download "$GITHUB_REPO/scripts/update-subscriptions.sh" "$PINPOINT_DIR/scripts/update-subscriptions.sh" || true
    download "$GITHUB_REPO/scripts/pinpoint-update.py" "$PINPOINT_DIR/scripts/pinpoint-update.py" || error "Failed to download pinpoint-update.py"
    chmod +x "$PINPOINT_DIR/scripts/"*.sh 2>/dev/null || true
    chmod +x "$PINPOINT_DIR/scripts/"*.py 2>/dev/null || true
    info "Scripts downloaded"
    
    # Download default services database
    step "Downloading services database..."
    download "$GITHUB_REPO/data/services.json" "$PINPOINT_DIR/data/services.json" || warn "Failed to download services.json"
    info "Services database downloaded"
    
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
    read INPUT_USER </dev/tty
    USERNAME="${INPUT_USER:-$DEFAULT_USER}"
    
    # Password
    while true; do
        printf "  Password: "
        stty -echo </dev/tty 2>/dev/null || true
        read PASSWORD </dev/tty
        stty echo </dev/tty 2>/dev/null || true
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
        stty -echo </dev/tty 2>/dev/null || true
        read PASSWORD2 </dev/tty
        stty echo </dev/tty 2>/dev/null || true
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
    
    if [ "$INSTALL_MODE" = "lite" ]; then
        # Lite mode: VPN + shell scripts (no Python backend)
        cat > /etc/init.d/pinpoint << 'INITEOF'
#!/bin/sh /etc/rc.common
# Pinpoint - VPN + Policy Routing (Lite Mode - shell scripts)

START=99
STOP=10
USE_PROCD=1

PINPOINT_DIR="/opt/pinpoint"

start_service() {
    logger -t pinpoint "Starting pinpoint service..."
    
    # Initialize nftables and policy routing
    /opt/pinpoint/scripts/pinpoint-init.sh start
    
    # Apply current rules (creates dnsmasq config and loads IPs)
    /opt/pinpoint/scripts/pinpoint-apply.sh reload
    
    # Start sing-box if tunnels exist
    if [ -f /opt/pinpoint/data/tunnels.json ]; then
        /etc/init.d/sing-box enable >/dev/null 2>&1 || true
        /etc/init.d/sing-box start >/dev/null 2>&1 || true
        sleep 1
    fi
    
    # Restart dnsmasq to load new config
    if [ -f /etc/dnsmasq.d/pinpoint.conf ]; then
        /etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
    fi
    
    logger -t pinpoint "Pinpoint service started"
}

stop_service() {
    logger -t pinpoint "Stopping pinpoint service..."
    /opt/pinpoint/scripts/pinpoint-init.sh stop
    logger -t pinpoint "Pinpoint service stopped"
}

reload_service() {
    logger -t pinpoint "Reloading pinpoint rules..."
    /opt/pinpoint/scripts/pinpoint-apply.sh reload
}

status_service() {
    /opt/pinpoint/scripts/pinpoint-init.sh status
}
INITEOF
    else
        # Full mode: Python backend
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
    fi

    chmod +x /etc/init.d/pinpoint
    
    # Enable service
    /etc/init.d/pinpoint enable 2>/dev/null || true
    
    info "PinPoint service created"
    
    # Create sing-box wrapper script (for deprecated features in 1.12+)
    step "Creating sing-box init.d service..."
    
    cat > /usr/bin/sing-box-wrapper << 'SBWRAP'
#!/bin/sh
export ENABLE_DEPRECATED_TUN_ADDRESS_X=true
export ENABLE_DEPRECATED_SPECIAL_OUTBOUNDS=true
exec /usr/bin/sing-box "$@"
SBWRAP
    chmod +x /usr/bin/sing-box-wrapper
    
    # Create sing-box init script
    cat > /etc/init.d/sing-box << 'SBINIT'
#!/bin/sh /etc/rc.common

START=95
STOP=15
USE_PROCD=1

setup_routing() {
    # Wait for tun1 to come up
    for i in 1 2 3 4 5; do
        ip link show tun1 >/dev/null 2>&1 && break
        sleep 1
    done
    
    # Setup policy routing
    ip rule del fwmark 0x1 lookup 100 2>/dev/null
    ip rule add fwmark 0x1 lookup 100 priority 50
    ip route flush table 100 2>/dev/null
    ip route add default dev tun1 table 100
    
    # Add fw4 masquerade for tun1
    nft insert rule inet fw4 srcnat oifname "tun1" masquerade 2>/dev/null
    nft insert rule inet fw4 forward iifname "br-lan" oifname "tun1" accept 2>/dev/null
    nft insert rule inet fw4 forward iifname "tun1" accept 2>/dev/null
    nft insert rule inet fw4 forward oifname "tun1" accept 2>/dev/null
    
    # Run pinpoint-init if exists
    [ -x /opt/pinpoint/scripts/pinpoint-init.sh ] && /opt/pinpoint/scripts/pinpoint-init.sh start
    
    logger -t sing-box "Policy routing configured"
}

start_service() {
    procd_open_instance
    procd_set_param command /usr/bin/sing-box run -c /etc/sing-box/config.json
    procd_set_param env ENABLE_DEPRECATED_TUN_ADDRESS_X=true ENABLE_DEPRECATED_SPECIAL_OUTBOUNDS=true
    procd_set_param respawn
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
    
    # Setup routing after short delay
    ( sleep 3 && setup_routing ) &
}

stop_service() {
    [ -x /opt/pinpoint/scripts/pinpoint-init.sh ] && /opt/pinpoint/scripts/pinpoint-init.sh stop
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

MARK=0x1
TABLE_ID=100
TUN_IFACE="tun1"

# Note: MARK 0x1 is used for policy routing
# nftables will mark packets with 0x1, and ip rule will route them via table 100

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
        
        ip rule add fwmark $MARK lookup $TABLE_ID priority 50
        ip route add default dev $TUN_IFACE table $TABLE_ID
        
        # Setup nftables
        nft delete table inet pinpoint 2>/dev/null || true
        nft -f - << 'NFT'
table inet pinpoint {
    set tunnel_ips { type ipv4_addr; flags timeout; timeout 1h; }
    set tunnel_nets { type ipv4_addr; flags interval; }
    
    chain prerouting {
        type filter hook prerouting priority raw - 1; policy accept;
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        ip daddr @tunnel_ips ct mark set 0x1 counter
        ip daddr @tunnel_nets ct mark set 0x1 counter
        ct mark 0x1 meta mark set 0x1 counter
        ip daddr @tunnel_ips meta mark set 0x1 counter
        ip daddr @tunnel_nets meta mark set 0x1 counter
    }
    chain output {
        type route hook output priority mangle - 1; policy accept;
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        ip daddr @tunnel_ips meta mark set 0x1 counter
        ip daddr @tunnel_nets meta mark set 0x1 counter
    }
    chain forward {
        type filter hook forward priority mangle - 1; policy accept;
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        ip daddr @tunnel_ips meta mark set 0x1 counter
        ip daddr @tunnel_nets meta mark set 0x1 counter
    }
}
NFT
        
        # Add masquerade for tun1 traffic (NAT for VPN)
        if nft list tables 2>/dev/null | grep -q "inet fw4"; then
            nft add chain inet fw4 srcnat_tun1 2>/dev/null || true
            nft add rule inet fw4 srcnat_tun1 meta nfproto ipv4 masquerade 2>/dev/null || true
            nft list chain inet fw4 srcnat 2>/dev/null | grep -q "tun1" || \
                nft insert rule inet fw4 srcnat oifname tun1 jump srcnat_tun1 2>/dev/null || true
            # Add forward accept rules for tun1 traffic
            nft list chain inet fw4 forward 2>/dev/null | grep -q "iifname.*tun1" || \
                nft insert rule inet fw4 forward iifname tun1 accept 2>/dev/null || true
            nft list chain inet fw4 forward 2>/dev/null | grep -q "oifname.*tun1" || \
                nft insert rule inet fw4 forward oifname tun1 accept 2>/dev/null || true
        fi
        
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
# Hotplug Scripts (auto-restore routing)
# ============================================
install_hotplug_scripts() {
    echo ""
    echo -e "${BLUE}Installing Hotplug Scripts${NC}"
    echo "----------------------------------------"
    
    step "Installing network hotplug script..."
    
    # Hotplug for tun1 interface creation
    cat > /etc/hotplug.d/net/99-pinpoint << 'HOTPLUGNET'
#!/bin/sh
# Reinitialize pinpoint routing when tun1 comes up

[ "$ACTION" = "add" ] && [ "$INTERFACE" = "tun1" ] && {
    logger -t pinpoint "tun1 interface added, initializing routing..."
    sleep 1
    /opt/pinpoint/scripts/pinpoint-init.sh start
}
HOTPLUGNET

    chmod +x /etc/hotplug.d/net/99-pinpoint
    
    step "Installing iface hotplug script..."
    
    # Hotplug for interface changes
    cat > /etc/hotplug.d/iface/99-pinpoint << 'HOTPLUGIFACE'
#!/bin/sh
# Reinitialize pinpoint routing on interface changes

[ "$ACTION" = "ifup" ] || exit 0

# Restore routing when wan or any interface comes up
case "$INTERFACE" in
    wan|wan6|sing_box)
        logger -t pinpoint "$INTERFACE up, checking routing..."
        sleep 2
        
        # Ensure ip rule exists
        ip rule show 2>/dev/null | grep -q "fwmark 0x1 lookup 100" || {
            ip rule add fwmark 0x1 lookup 100 priority 50 2>/dev/null
            logger -t pinpoint "Added fwmark rule"
        }
        
        # Ensure table 100 has default route to tun1
        if ip link show tun1 >/dev/null 2>&1; then
            ip route show table 100 2>/dev/null | grep -q "default" || {
                ip route add default dev tun1 table 100 2>/dev/null
                logger -t pinpoint "Added default route to table 100"
            }
        fi
        ;;
esac
HOTPLUGIFACE

    chmod +x /etc/hotplug.d/iface/99-pinpoint
    
    info "Hotplug scripts installed (auto-restore routing)"
}

# ============================================
# Cron Jobs (periodic updates)
# ============================================
install_cron_jobs() {
    step "Installing periodic update cron jobs..."
    
    mkdir -p /etc/cron.d
    
    # Check if Python is available (for Full mode)
    # In Lite mode, Python is not installed, so we use shell script only
    if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
        PYTHON_CMD="python3"
        command -v python3 >/dev/null 2>&1 || PYTHON_CMD="python"
        USE_PYTHON=1
        
        # Get update time from settings (default: 03:00)
        UPDATE_TIME="03:00"
        if [ -f "$PINPOINT_DIR/data/settings.json" ]; then
            UPDATE_TIME=$(grep -o '"update_time"[[:space:]]*:[[:space:]]*"[^"]*"' "$PINPOINT_DIR/data/settings.json" 2>/dev/null | cut -d'"' -f4 || echo "03:00")
        fi
        
        # Parse time (HH:MM)
        UPDATE_HOUR=$(echo "$UPDATE_TIME" | cut -d: -f1)
        UPDATE_MINUTE=$(echo "$UPDATE_TIME" | cut -d: -f2)
        [ -z "$UPDATE_HOUR" ] && UPDATE_HOUR=3
        [ -z "$UPDATE_MINUTE" ] && UPDATE_MINUTE=0
        
        # Full mode: Daily update at specified time
        cat > /etc/cron.d/pinpoint << CRONEOF
# Pinpoint - Daily list update at $UPDATE_TIME (Full mode)
# Auto-updates from GitHub if services.json is older than 24 hours
$UPDATE_MINUTE $UPDATE_HOUR * * * root $PYTHON_CMD /opt/pinpoint/scripts/pinpoint-update.py update >/dev/null 2>&1 || /opt/pinpoint/scripts/pinpoint-update.sh update >/dev/null 2>&1

# Pinpoint - Force update from GitHub (once per day at 3 AM)
# This ensures services.json is always fresh with latest services from GitHub
0 3 * * * root $PYTHON_CMD /opt/pinpoint/scripts/pinpoint-update.py update-github >/dev/null 2>&1 || true
CRONEOF
        
        # Also add to crontab if cron.d not supported
        if [ -f /etc/crontabs/root ]; then
            if ! grep -q "pinpoint-update" /etc/crontabs/root 2>/dev/null; then
                echo "$UPDATE_MINUTE $UPDATE_HOUR * * * $PYTHON_CMD /opt/pinpoint/scripts/pinpoint-update.py update >/dev/null 2>&1 || /opt/pinpoint/scripts/pinpoint-update.sh update >/dev/null 2>&1" >> /etc/crontabs/root
                echo "0 3 * * * $PYTHON_CMD /opt/pinpoint/scripts/pinpoint-update.py update-github >/dev/null 2>&1 || true" >> /etc/crontabs/root
            fi
        fi
        
        info "Cron jobs installed (Full mode with Python):"
        info "  - List updates: daily at $UPDATE_TIME (auto-updates from GitHub if needed)"
        info "  - GitHub update: daily at 3:00 AM (force update services.json)"
        info "  - You can change update time in Settings page"
    else
        USE_PYTHON=0
        # Lite mode: NO automatic cron updates, only manual updates via UI
        # Remove any existing cron jobs
        rm -f /etc/cron.d/pinpoint
        
        # Remove from crontabs if exists
        if [ -f /etc/crontabs/root ]; then
            sed -i '/pinpoint-update/d' /etc/crontabs/root 2>/dev/null || true
        fi
        
        info "Cron jobs NOT installed (Lite mode):"
        info "  - Automatic updates: disabled (use 'Update Lists Now' button in Settings)"
        info "  - Manual updates: available via LuCI Settings page"
        info "  - Note: Lists are updated once during installation"
    fi
    
    # Add sing-box daily restart as safety measure (DNS leak fixed, but keep restart for safety)
    step "Installing sing-box auto-restart (safety measure)..."
    cat > /etc/cron.d/singbox-restart << 'CRONEOF'
# Restart sing-box daily at 4 AM as safety measure
# DNS memory leak has been fixed, but daily restart ensures stability
# Using init.d script ensures proper cleanup and routing restart
0 4 * * * root /etc/init.d/sing-box restart >/dev/null 2>&1
CRONEOF
    info "sing-box will auto-restart daily at 4:00 AM (safety measure)"
    
    # Restart cron if running
    /etc/init.d/cron restart 2>/dev/null || true
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
    
    # Detect sing-box version to adapt config format
    TUN_ADDRESS_FIELD="inet4_address"
    if command -v sing-box >/dev/null 2>&1; then
        SB_VERSION=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        if [ -n "$SB_VERSION" ]; then
            # Check if version is < 1.11.0 (uses "address" instead of "inet4_address")
            VERSION_MAJOR=$(echo "$SB_VERSION" | cut -d. -f1)
            VERSION_MINOR=$(echo "$SB_VERSION" | cut -d. -f2)
            if [ "$VERSION_MAJOR" -lt 1 ] || ([ "$VERSION_MAJOR" -eq 1 ] && [ "$VERSION_MINOR" -lt 11 ]); then
                TUN_ADDRESS_FIELD="address"
                info "Detected sing-box $SB_VERSION - using legacy 'address' field format"
            else
                info "Detected sing-box $SB_VERSION - using modern 'inet4_address' field format"
            fi
        fi
    fi
    
    # Create minimal config (will be updated by PinPoint when tunnels are added)
    if [ "$TUN_ADDRESS_FIELD" = "address" ]; then
        cat > /etc/sing-box/config.json << 'SBCONFIG'
{
  "log": {"level": "info"},
  "dns": {
    "servers": [
      {"tag": "google", "address": "8.8.8.8", "detour": "direct-out"},
      {"tag": "local", "address": "127.0.0.1", "detour": "direct-out"}
    ]
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "tun1",
      "address": ["10.0.0.1/30"],
      "mtu": 1400,
      "auto_route": false,
      "sniff": true,
      "stack": "gvisor"
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
    "final": "direct-out",
    "auto_detect_interface": true
  }
}
SBCONFIG
    else
        cat > /etc/sing-box/config.json << 'SBCONFIG'
{
  "log": {"level": "info"},
  "dns": {
    "servers": [
      {"tag": "google", "address": "8.8.8.8", "detour": "direct-out"},
      {"tag": "local", "address": "127.0.0.1", "detour": "direct-out"}
    ]
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "tun1",
      "inet4_address": "10.0.0.1/30",
      "mtu": 1400,
      "auto_route": false,
      "sniff": true,
      "stack": "gvisor"
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
    "final": "direct-out",
    "auto_detect_interface": true
  }
}
SBCONFIG
    fi

    info "sing-box config created (version-aware format, add tunnels via PinPoint UI)"
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
    
    # Add masquerade for tun1 (VPN interface) in nftables
    # This ensures client traffic going through VPN is properly NAT'd
    if nft list tables 2>/dev/null | grep -q "inet fw4"; then
        # Create srcnat chain for tun1 if not exists
        nft add chain inet fw4 srcnat_tun1 2>/dev/null || true
        nft add rule inet fw4 srcnat_tun1 meta nfproto ipv4 masquerade 2>/dev/null || true
        # Add rule to jump to srcnat_tun1 for tun1 traffic
        if ! nft list chain inet fw4 srcnat 2>/dev/null | grep -q "tun1"; then
            nft insert rule inet fw4 srcnat oifname tun1 jump srcnat_tun1 2>/dev/null || \
                nft add rule inet fw4 srcnat oifname tun1 masquerade 2>/dev/null || true
        fi
        # Add forward accept rules for tun1 traffic
        if ! nft list chain inet fw4 forward 2>/dev/null | grep -q "iifname.*tun1"; then
            nft insert rule inet fw4 forward iifname tun1 accept 2>/dev/null || true
        fi
        if ! nft list chain inet fw4 forward 2>/dev/null | grep -q "oifname.*tun1"; then
            nft insert rule inet fw4 forward oifname tun1 accept 2>/dev/null || true
        fi
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
    
    # Initialize routing and load services
    step "Initializing routing..."
    
    # Install Python if not available (needed for pinpoint-update.py)
    if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
        step "Installing Python..."
        install_package "python3" "Python 3" || install_package "python" "Python" || warn "Python not available, services update may fail"
    fi
    
    # Copy nftables config file
    if [ -f "$PINPOINT_DIR/scripts/pinpoint-init.sh" ]; then
        # Create nftables config file for pinpoint-init.sh
        mkdir -p "$PINPOINT_DIR/data"
        if [ -f "/etc/nftables.d/pinpoint.nft" ]; then
            cp /etc/nftables.d/pinpoint.nft "$PINPOINT_DIR/data/pinpoint.nft"
        else
            # Create from etc/nftables.d/pinpoint.nft if available
            download "$GITHUB_REPO/etc/nftables.d/pinpoint.nft" "$PINPOINT_DIR/data/pinpoint.nft" || true
        fi
    fi
    
    # Run pinpoint-init.sh to setup nftables and routing
    if [ -f "$PINPOINT_DIR/scripts/pinpoint-init.sh" ]; then
        chmod +x "$PINPOINT_DIR/scripts/pinpoint-init.sh"
        "$PINPOINT_DIR/scripts/pinpoint-init.sh" start >/dev/null 2>&1 || true
    fi
    
    # Update services to load IPs into nftables sets
    if [ -f "$PINPOINT_DIR/scripts/pinpoint-update.py" ]; then
        PYTHON_CMD="python3"
        command -v python3 >/dev/null 2>&1 || PYTHON_CMD="python"
        if command -v "$PYTHON_CMD" >/dev/null 2>&1; then
            step "Updating service lists (this may take a minute)..."
            "$PYTHON_CMD" "$PINPOINT_DIR/scripts/pinpoint-update.py" update || true
            info "Services and routing initialized"
        else
            warn "Python not found, services update skipped (run manually: $PINPOINT_DIR/scripts/pinpoint-update.py update)"
        fi
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
    echo -e "  ${YELLOW}⚠ Рекомендуется перезагрузить роутер для применения всех изменений:${NC}"
    echo -e "    ${CYAN}reboot${NC}"
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
    echo -e "  ${RED}⚠ ВАЖНО: Рекомендуется перезагрузить роутер для применения всех изменений!${NC}"
    echo -e "    ${CYAN}reboot${NC}"
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
# LuCI-Only (Lite) Installation
# ============================================
install_luci_app() {
    echo ""
    echo -e "${BLUE}Installing LuCI App (Lite Mode)${NC}"
    echo "----------------------------------------"
    
    # Required packages for lite mode (VPN without Python backend)
    step "Installing dependencies for Lite mode..."
    install_package "curl" "cURL"
    install_package "ca-certificates" "CA certificates"
    install_package "ca-bundle" "CA bundle"
    
    # sing-box is needed for VPN tunnels (Lite mode ALSO bypasses blocks)
    install_singbox
    install_package "kmod-tun" "TUN kernel module"
    
    # Firewall and routing
    if command -v nft >/dev/null 2>&1; then
        info "nftables - already installed"
    else
        install_package "nftables-json" "nftables firewall" || install_package "nftables" "nftables"
    fi
    install_package "ip-full" "iproute2 full"
    
    # DNS - install dnsmasq-full for nftset support (domain-based routing)
    step "Installing dnsmasq-full (with nftset support)..."
    if opkg list-installed 2>/dev/null | grep -q "^dnsmasq-full "; then
        info "dnsmasq-full already installed"
    else
        # Remove standard dnsmasq if present (they conflict)
        if opkg list-installed 2>/dev/null | grep -q "^dnsmasq "; then
            opkg remove dnsmasq --force-removal-of-dependent-packages >/dev/null 2>&1 || true
        fi
        opkg_quiet install dnsmasq-full
        if opkg list-installed 2>/dev/null | grep -q "^dnsmasq-full "; then
            info "dnsmasq-full installed"
        else
            warn "Failed to install dnsmasq-full - domain routing will use CIDR blocks only"
            install_package "dnsmasq" "dnsmasq"
        fi
    fi
    
    # Configure dnsmasq confdir (used for nftset-based routing)
    uci set dhcp.@dnsmasq[0].confdir='/etc/dnsmasq.d' 2>/dev/null || true
    mkdir -p /etc/dnsmasq.d
    
    # Install https-dns-proxy to bypass ISP DNS hijacking (DPI)
    step "Installing https-dns-proxy (DNS over HTTPS)..."
    install_package "https-dns-proxy" "https-dns-proxy"
    
    # Configure dnsmasq to use DoH proxy (bypasses ISP DNS interception)
    # Only if https-dns-proxy is installed and working
    if [ -x /etc/init.d/https-dns-proxy ]; then
        /etc/init.d/https-dns-proxy enable 2>/dev/null || true
        /etc/init.d/https-dns-proxy start 2>/dev/null || true
        sleep 2
        
        # Check if https-dns-proxy is actually running and responding
        if netstat -ln 2>/dev/null | grep -q ":5053" || ss -ln 2>/dev/null | grep -q ":5053"; then
            # Use local DoH proxy (127.0.0.1:5053)
            uci set dhcp.@dnsmasq[0].noresolv='1' 2>/dev/null || true
            uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
            uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#5053' 2>/dev/null || true
            uci commit dhcp 2>/dev/null || true
            /etc/init.d/dnsmasq restart 2>/dev/null || true
            info "DNS over HTTPS enabled (bypasses ISP DNS hijacking)"
        else
            warn "https-dns-proxy not responding, using fallback DNS"
            # Fallback to public DNS
            uci set dhcp.@dnsmasq[0].noresolv='0' 2>/dev/null || true
            uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
            uci add_list dhcp.@dnsmasq[0].server='8.8.8.8' 2>/dev/null || true
            uci add_list dhcp.@dnsmasq[0].server='1.1.1.1' 2>/dev/null || true
            uci commit dhcp 2>/dev/null || true
            /etc/init.d/dnsmasq restart 2>/dev/null || true
        fi
    else
        # Fallback to public DNS (may be intercepted by ISP)
        warn "https-dns-proxy not available, using plain DNS"
        uci set dhcp.@dnsmasq[0].noresolv='0' 2>/dev/null || true
        uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
        uci add_list dhcp.@dnsmasq[0].server='8.8.8.8' 2>/dev/null || true
        uci add_list dhcp.@dnsmasq[0].server='1.1.1.1' 2>/dev/null || true
        uci commit dhcp 2>/dev/null || true
        /etc/init.d/dnsmasq restart 2>/dev/null || true
    fi
    
    # Force clients to use router DNS (critical for nftset to work!)
    step "Configuring DHCP to force router DNS..."
    uci -q delete dhcp.lan.dhcp_option 2>/dev/null || true
    uci add_list dhcp.lan.dhcp_option='6,192.168.5.1' 2>/dev/null || true
    uci commit dhcp 2>/dev/null || true
    info "DHCP configured to force clients to use router DNS (192.168.5.1)"
    
    # Enable DNS query logging for debugging
    step "Enabling DNS query logging..."
    uci set dhcp.@dnsmasq[0].logqueries='1' 2>/dev/null || true
    uci commit dhcp 2>/dev/null || true
    /etc/init.d/dnsmasq restart 2>/dev/null || true
    info "DNS query logging enabled (use: logread | grep query)"
    
    # Increase LuCI/RPC timeouts for slow operations (GitHub updates, IP loading, etc.)
    step "Configuring LuCI/RPC timeouts..."
    uci set rpcd.@rpcd[0].socket_timeout='180' 2>/dev/null || true
    uci commit rpcd 2>/dev/null || true
    uci set uhttpd.main.script_timeout='180' 2>/dev/null || true
    uci set uhttpd.main.network_timeout='180' 2>/dev/null || true
    uci commit uhttpd 2>/dev/null || true
    /etc/init.d/rpcd restart 2>/dev/null || true
    /etc/init.d/uhttpd restart 2>/dev/null || true
    info "LuCI/RPC timeouts set to 180 seconds (prevents XHR timeout errors)"
    
    # Create directories
    step "Creating directories..."
    mkdir -p /www/luci-static/resources/view/pinpoint
    mkdir -p /usr/share/rpcd/ucode
    mkdir -p /usr/share/luci/menu.d
    mkdir -p /usr/share/rpcd/acl.d
    mkdir -p /opt/pinpoint/data
    mkdir -p /opt/pinpoint/scripts
    mkdir -p /etc/sing-box
    
    # Download LuCI app files
    step "Downloading LuCI views..."
    for view in status tunnels services devices custom logs settings; do
        download "$GITHUB_REPO/luci-app-pinpoint/htdocs/luci-static/resources/view/pinpoint/${view}.js" \
            "/www/luci-static/resources/view/pinpoint/${view}.js" || warn "Failed to download ${view}.js"
    done
    info "LuCI views downloaded"
    
    step "Downloading backend..."
    download "$GITHUB_REPO/luci-app-pinpoint/root/usr/share/rpcd/ucode/pinpoint.uc" \
        "/usr/share/rpcd/ucode/pinpoint.uc" || error "Failed to download pinpoint.uc"
    info "Backend downloaded"
    
    step "Downloading menu and ACL..."
    download "$GITHUB_REPO/luci-app-pinpoint/root/usr/share/luci/menu.d/luci-app-pinpoint.json" \
        "/usr/share/luci/menu.d/luci-app-pinpoint.json" || error "Failed to download menu"
    download "$GITHUB_REPO/luci-app-pinpoint/root/usr/share/rpcd/acl.d/luci-app-pinpoint.json" \
        "/usr/share/rpcd/acl.d/luci-app-pinpoint.json" || error "Failed to download ACL"
    info "Menu and ACL downloaded"
    
    step "Downloading routing & update scripts (Lite mode)..."
    download "$GITHUB_REPO/scripts/pinpoint-init.sh" \
        "/opt/pinpoint/scripts/pinpoint-init.sh" || warn "Failed to download pinpoint-init.sh"
    download "$GITHUB_REPO/scripts/pinpoint-apply.sh" \
        "/opt/pinpoint/scripts/pinpoint-apply.sh" || warn "Failed to download pinpoint-apply.sh"
    download "$GITHUB_REPO/scripts/pinpoint-update.sh" \
        "/opt/pinpoint/scripts/pinpoint-update.sh" || error "Failed to download pinpoint-update.sh"
    chmod +x /opt/pinpoint/scripts/*.sh 2>/dev/null || true
    # Normalize line endings just in case
    sed -i 's/\r$//' /opt/pinpoint/scripts/*.sh 2>/dev/null || true
    info "Scripts downloaded"
    
    step "Downloading services database..."
    download "$GITHUB_REPO/data/services.json" "/opt/pinpoint/data/services.json" || true
    info "Services database downloaded"
    
    # Initialize data files
    step "Initializing data files..."
    mkdir -p /opt/pinpoint/data
    [ -f /opt/pinpoint/data/custom_services.json ] || echo '{"services":[]}' > /opt/pinpoint/data/custom_services.json
    [ -f /opt/pinpoint/data/subscriptions.json ] || echo '{"subscriptions":[]}' > /opt/pinpoint/data/subscriptions.json
    [ -f /opt/pinpoint/data/settings.json ] || echo '{"auto_update":true,"update_interval":21600}' > /opt/pinpoint/data/settings.json
    [ -f /opt/pinpoint/data/devices.json ] || echo '{"devices":[]}' > /opt/pinpoint/data/devices.json
    [ -f /opt/pinpoint/data/services.json ] || download "$GITHUB_REPO/data/services.json" "/opt/pinpoint/data/services.json" || echo '{"services":[]}' > /opt/pinpoint/data/services.json
    
    # Copy nftables config file
    step "Setting up nftables config..."
    download "$GITHUB_REPO/etc/nftables.d/pinpoint.nft" "/opt/pinpoint/data/pinpoint.nft" || warn "Failed to download pinpoint.nft"
    if [ -f /opt/pinpoint/data/pinpoint.nft ]; then
        info "nftables config file ready"
    else
        warn "nftables config file not found, will be created by pinpoint-init.sh"
    fi
    
    # Create UCI config if not exists (required for menu)
    if [ ! -f /etc/config/pinpoint ]; then
        touch /etc/config/pinpoint
        uci set pinpoint.@pinpoint[0]=pinpoint 2>/dev/null || uci add pinpoint pinpoint 2>/dev/null || true
        uci set pinpoint.@pinpoint[0].enabled='1' 2>/dev/null || true
        uci commit pinpoint 2>/dev/null || true
    fi
    info "Data files initialized"
    
    # Create sing-box config if not exists
    if [ ! -f /etc/sing-box/config.json ]; then
        step "Creating default sing-box config..."
        
        # Detect sing-box version to adapt config format
        TUN_ADDRESS_FIELD="inet4_address"
        if command -v sing-box >/dev/null 2>&1; then
            SB_VERSION=$(sing-box version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
            if [ -n "$SB_VERSION" ]; then
                # Check if version is < 1.11.0 (uses "address" instead of "inet4_address")
                VERSION_MAJOR=$(echo "$SB_VERSION" | cut -d. -f1)
                VERSION_MINOR=$(echo "$SB_VERSION" | cut -d. -f2)
                if [ "$VERSION_MAJOR" -lt 1 ] || ([ "$VERSION_MAJOR" -eq 1 ] && [ "$VERSION_MINOR" -lt 11 ]); then
                    TUN_ADDRESS_FIELD="address"
                    info "Detected sing-box $SB_VERSION - using legacy 'address' field format"
                else
                    info "Detected sing-box $SB_VERSION - using modern 'inet4_address' field format"
                fi
            fi
        fi
        
        # Generate config based on version
        if [ "$TUN_ADDRESS_FIELD" = "address" ]; then
            cat > /etc/sing-box/config.json << 'SBCFG'
{
  "log": {"level": "info"},
  "dns": {
    "servers": [
      {"tag": "google", "address": "8.8.8.8", "detour": "direct-out"},
      {"tag": "local", "address": "127.0.0.1", "detour": "direct-out"}
    ]
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "tun1",
      "address": ["10.0.0.1/30"],
      "mtu": 1400,
      "auto_route": false,
      "sniff": true,
      "stack": "gvisor"
    }
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct-out"},
    {"type": "dns", "tag": "dns-out"}
  ],
  "route": {
    "rules": [{"protocol": "dns", "outbound": "dns-out"}],
    "final": "direct-out",
    "auto_detect_interface": true
  }
}
SBCFG
        else
            cat > /etc/sing-box/config.json << 'SBCFG'
{
  "log": {"level": "info"},
  "dns": {
    "servers": [
      {"tag": "google", "address": "8.8.8.8", "detour": "direct-out"},
      {"tag": "local", "address": "127.0.0.1", "detour": "direct-out"}
    ]
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "tun1",
      "inet4_address": "10.0.0.1/30",
      "mtu": 1400,
      "auto_route": false,
      "sniff": true,
      "stack": "gvisor"
    }
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct-out"},
    {"type": "dns", "tag": "dns-out"}
  ],
  "route": {
    "rules": [{"protocol": "dns", "outbound": "dns-out"}],
    "final": "direct-out",
    "auto_detect_interface": true
  }
}
SBCFG
        fi
        info "sing-box config created (version-aware format)"
    fi
    
    # Create sing-box init script
    step "Creating sing-box service..."
    cat > /etc/init.d/sing-box << 'SBINIT'
#!/bin/sh /etc/rc.common

START=95
STOP=15
USE_PROCD=1

setup_routing() {
    # Wait for tun1 to come up
    for i in 1 2 3 4 5; do
        ip link show tun1 >/dev/null 2>&1 && break
        sleep 1
    done
    
    # Setup policy routing
    ip rule del fwmark 0x1 lookup 100 2>/dev/null
    ip rule add fwmark 0x1 lookup 100 priority 50
    ip route flush table 100 2>/dev/null
    ip route add default dev tun1 table 100
    
    # Add fw4 masquerade for tun1
    nft insert rule inet fw4 srcnat oifname "tun1" masquerade 2>/dev/null
    nft insert rule inet fw4 forward iifname "br-lan" oifname "tun1" accept 2>/dev/null
    nft insert rule inet fw4 forward iifname "tun1" accept 2>/dev/null
    nft insert rule inet fw4 forward oifname "tun1" accept 2>/dev/null
    
    # Run pinpoint-init if exists
    [ -x /opt/pinpoint/scripts/pinpoint-init.sh ] && /opt/pinpoint/scripts/pinpoint-init.sh start
    
    logger -t sing-box "Policy routing configured"
}

start_service() {
    procd_open_instance
    procd_set_param command /usr/bin/sing-box run -c /etc/sing-box/config.json
    procd_set_param env ENABLE_DEPRECATED_TUN_ADDRESS_X=true ENABLE_DEPRECATED_SPECIAL_OUTBOUNDS=true
    procd_set_param respawn
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
    
    # Setup routing after short delay
    ( sleep 3 && setup_routing ) &
}

stop_service() {
    [ -x /opt/pinpoint/scripts/pinpoint-init.sh ] && /opt/pinpoint/scripts/pinpoint-init.sh stop
}
SBINIT
    chmod +x /etc/init.d/sing-box
    /etc/init.d/sing-box enable 2>/dev/null || true
    
    # Note: pinpoint-init.sh will be created by create_routing_scripts() later
    # We'll initialize routing after all scripts are created
    
    # Restart rpcd to apply changes
    step "Restarting rpcd..."
    /etc/init.d/rpcd restart >/dev/null 2>&1
    
    # Clear LuCI cache to force menu reload
    step "Clearing LuCI cache..."
    rm -rf /tmp/luci-* 2>/dev/null || true
    rm -rf /tmp/ucode-* 2>/dev/null || true
    
    # Verify installation
    sleep 2
    step "Verifying installation..."
    if ubus list 2>/dev/null | grep -q "luci.pinpoint"; then
        info "luci.pinpoint registered successfully!"
    else
        warn "luci.pinpoint not found in ubus. Check: logread | grep rpcd"
    fi
    
    # Verify UCI config exists
    if [ -f /etc/config/pinpoint ]; then
        info "UCI config created successfully"
    else
        warn "UCI config not found, creating now..."
        touch /etc/config/pinpoint
        uci set pinpoint.@pinpoint[0]=pinpoint 2>/dev/null || uci add pinpoint pinpoint 2>/dev/null || true
        uci set pinpoint.@pinpoint[0].enabled='1' 2>/dev/null || true
        uci commit pinpoint 2>/dev/null || true
    fi
    
    info "LuCI App installed"
}

print_success_lite() {
    IP=$(get_lan_ip)
    
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                                                    ║${NC}"
    echo -e "${GREEN}║    PinPoint Lite installed successfully! 🎉       ║${NC}"
    echo -e "${GREEN}║                                                    ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${CYAN}Access via LuCI:${NC}"
    echo -e "    http://${GREEN}$IP${NC}/cgi-bin/luci/admin/services/pinpoint"
    echo ""
    echo -e "  ${YELLOW}⚠ Рекомендуется перезагрузить роутер для применения всех изменений:${NC}"
    echo -e "    ${CYAN}reboot${NC}"
    echo ""
    echo -e "  ${CYAN}Menu Location:${NC}"
    echo "    Services → PinPoint"
    echo ""
    echo -e "  ${CYAN}Features:${NC}"
    echo "    • Import VPN links (vless/vmess/ss/trojan/hysteria2)"
    echo "    • Manage subscriptions"
    echo "    • Service-based routing"
    echo "    • Device management with network discovery"
    echo "    • Custom services"
    echo "    • Logs & domain testing"
    echo ""
    echo -e "  ${CYAN}sing-box Commands:${NC}"
    echo "    /etc/init.d/sing-box start"
    echo "    /etc/init.d/sing-box stop"
    echo "    /etc/init.d/sing-box restart"
    echo ""
    echo -e "  ${RED}⚠ ВАЖНО: Рекомендуется перезагрузить роутер для применения всех изменений!${NC}"
    echo -e "    ${CYAN}reboot${NC}"
    echo ""
}

# ============================================
# Installation Mode Selection
# ============================================
select_install_mode() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║       Select Installation Mode         ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}1)${NC} ${CYAN}Full${NC} - Standalone web interface (port 8080)"
    echo "     • Python backend with REST API"
    echo "     • Full-featured dashboard"
    echo "     • Traffic statistics & charts"
    echo "     • Requires ~50MB RAM"
    echo ""
    echo -e "  ${GREEN}2)${NC} ${CYAN}Lite${NC} - LuCI integration only"
    echo "     • Native OpenWRT UI integration"
    echo "     • Minimal resource usage (~5MB RAM)"
    echo "     • All core features included"
    echo "     • Recommended for low-memory devices"
    echo ""
    
    while true; do
        printf "  Select mode [1/2]: "
        read MODE_CHOICE </dev/tty
        case "$MODE_CHOICE" in
            1|full|Full|FULL)
                INSTALL_MODE="full"
                break
                ;;
            2|lite|Lite|LITE)
                INSTALL_MODE="lite"
                break
                ;;
            "")
                # Default to lite for low-memory devices
                MEM_TOTAL=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
                if [ -n "$MEM_TOTAL" ] && [ "$MEM_TOTAL" -lt 131072 ]; then
                    info "Low memory detected, defaulting to Lite mode"
                    INSTALL_MODE="lite"
                else
                    INSTALL_MODE="full"
                fi
                break
                ;;
            *)
                warn "Please enter 1 or 2"
                ;;
        esac
    done
    
    echo ""
    info "Selected: $INSTALL_MODE mode"
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
    
    # Check for mode flags
    if [ "$1" = "--lite" ] || [ "$1" = "-l" ]; then
        INSTALL_MODE="lite"
    elif [ "$1" = "--full" ] || [ "$1" = "-f" ]; then
        INSTALL_MODE="full"
    else
        INSTALL_MODE=""
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
    
    # Select mode if not specified
    if [ -z "$INSTALL_MODE" ]; then
        select_install_mode
    fi
    
    # Update packages
    update_packages
    
    # Branch based on mode
    if [ "$INSTALL_MODE" = "lite" ]; then
        # Lite installation (VPN without Python backend - shell scripts only)
        
        install_luci_app
        create_init_script
        create_routing_scripts
        install_hotplug_scripts
        install_cron_jobs
        setup_firewall
        
        # Initialize routing and services after all scripts are created
        step "Initializing routing and services..."
        
        # Run pinpoint-init.sh to setup nftables and routing
        if [ -f /opt/pinpoint/scripts/pinpoint-init.sh ]; then
            /opt/pinpoint/scripts/pinpoint-init.sh start >/dev/null 2>&1 || true
        fi
        
        # Run pinpoint-update.sh to update services (shell version, no Python needed)
        if [ -f /opt/pinpoint/scripts/pinpoint-update.sh ]; then
            step "Updating service lists (this may take a minute)..."
            /opt/pinpoint/scripts/pinpoint-update.sh update || true
            info "Services and routing initialized"
        else
            warn "pinpoint-update.sh not found, services update skipped"
        fi
        
        # Apply routing rules (creates dnsmasq config and loads IPs)
        if [ -f /opt/pinpoint/scripts/pinpoint-apply.sh ]; then
            step "Applying routing rules..."
            /opt/pinpoint/scripts/pinpoint-apply.sh reload >/dev/null 2>&1 || true
            info "Routing rules applied"
        else
            warn "pinpoint-apply.sh not found, routing rules not applied"
        fi
        
        # Start sing-box if tunnels exist
        if [ -f /opt/pinpoint/data/tunnels.json ]; then
            step "Starting sing-box..."
            /etc/init.d/sing-box enable >/dev/null 2>&1 || true
            /etc/init.d/sing-box start >/dev/null 2>&1 || true
            sleep 2
            if pgrep -x sing-box >/dev/null 2>&1; then
                info "sing-box started"
            else
                warn "sing-box failed to start (check logs: logread | grep sing-box)"
            fi
        else
            info "No tunnels configured yet - sing-box will start when subscription is added"
        fi
        
        # Restart dnsmasq to load new config
        if [ -f /etc/dnsmasq.d/pinpoint.conf ]; then
            step "Restarting dnsmasq..."
            /etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
            sleep 1
            if /etc/init.d/dnsmasq running >/dev/null 2>&1; then
                info "dnsmasq restarted with new configuration"
            else
                warn "dnsmasq failed to restart (check logs: logread | grep dnsmasq)"
            fi
        fi
        
        cleanup_install
        print_success_lite
    else
        # Full installation
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
        install_hotplug_scripts
        install_cron_jobs
        create_singbox_config
        setup_firewall
        start_service
        cleanup_install
        print_success
    fi
}

# Run
main "$@"
