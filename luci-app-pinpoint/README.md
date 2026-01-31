# luci-app-pinpoint

LuCI application for PinPoint - Selective VPN routing for OpenWRT.

## Overview

PinPoint allows you to route traffic for specific services (YouTube, Instagram, etc.) 
or devices through a VPN tunnel while keeping other traffic direct.

## Features

- **Service-based routing**: Enable VPN for specific services
- **Device-based routing**: Per-device VPN policies (all VPN, all direct, custom)
- **Low memory footprint**: Designed for devices with 256MB+ RAM
- **LuCI integration**: Native OpenWRT admin interface

## Requirements

- OpenWRT 23.05 or later
- sing-box (for VPN tunnel)
- nftables
- ~60MB RAM (with sing-box)

## Installation

### From OpenWRT package feed:
```bash
opkg update
opkg install luci-app-pinpoint
```

### Manual installation:
```bash
# Copy files to router
scp -r root/* root@router:/

# Restart services
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

## Directory Structure

```
/opt/pinpoint/
├── data/
│   ├── services.json    # Service definitions
│   ├── devices.json     # Device configurations
│   ├── lists/           # Downloaded IP lists
│   └── status.json      # Last update status
└── scripts/
    └── pinpoint-update.sh
```

## License

GPL-2.0-only
