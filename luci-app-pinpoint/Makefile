# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2024-2026 PinPoint Project

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for PinPoint VPN routing
LUCI_DESCRIPTION:=Selective VPN routing for specific services and devices
LUCI_DEPENDS:=+sing-box +curl +nftables
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-pinpoint
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=PinPoint Project

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildance magic, do not touch
$(eval $(call BuildPackage,$(PKG_NAME)))
