# PinPoint

**Selective VPN Routing for OpenWRT**

PinPoint is a web-based management interface for routing specific services and domains through VPN tunnels on OpenWRT routers. Built on top of sing-box, it provides an intuitive way to manage selective routing without editing configuration files manually.

![PinPoint Dashboard](docs/images/dashboard.png)

## Features

- **Selective Routing**: Route specific services (YouTube, Netflix, Telegram, etc.) through VPN while keeping other traffic direct
- **Multi-Tunnel Support**: Manage multiple VPN tunnels with different providers
- **Subscription Management**: Import and auto-update VPN configurations from subscription URLs
- **Custom Domains**: Add your own domains and services for routing
- **Real-time Dashboard**: Monitor traffic, connections, and system resources
- **Ad Blocking**: Built-in DNS-based ad blocking
- **Dark/Light Theme**: Modern, responsive web interface
- **Authentication**: Secure login with session management

## Requirements

- **OpenWRT 23.05.0** or later
- **10MB** free disk space
- **Internet connection** for installation

## Quick Install

Run this one-line command on your OpenWRT router:

```bash
wget -O - https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh
```

Or with curl:

```bash
curl -fsSL https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh
```

**Lite mode** (LuCI only, no Python backend) for low-memory routers:

```bash
curl -fsSL https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh -s -- lite
```

**Note:** Installation optimized for low-RAM devices (256MB+). Python packages are installed from pre-compiled binaries when possible.

The installer will:
1. Check system compatibility
2. Install all required dependencies (sing-box, dnsmasq-full, nftables)
3. Download PinPoint files
4. Ask you to set a username and password (Full) or use LuCI login (Lite)
5. Create and start the system service

**After adding a VPN subscription (Lite):** Pre-installed services (e.g. Instagram, YouTube) apply automatically. If something doesn't work, open **Services** in LuCI and click **Apply**, or run on the router: `/etc/init.d/pinpoint restart`

## Access

After installation, access the web interface at:

```
http://<router-ip>:8080
```

Default is usually `http://192.168.1.1:8080`

## Uninstall

```bash
wget -O - https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/uninstall.sh | sh
```

Or use the install script with `--uninstall` flag:

```bash
/opt/pinpoint/install.sh --uninstall
```

## Service Management

```bash
# Start
/etc/init.d/pinpoint start

# Stop
/etc/init.d/pinpoint stop

# Restart
/etc/init.d/pinpoint restart

# Check status
/etc/init.d/pinpoint status

# View logs
logread | grep pinpoint
```

## Dependencies

Automatically installed:
- `python3`, `python3-pip`, `python3-sqlite3`
- `sing-box` (proxy client)
- `nftables` (firewall)
- `kmod-tun` (tunnel interface)
- `curl`, `wget`, `ca-certificates`
- Python packages (pinned versions):
  - `fastapi==0.115.6`
  - `uvicorn==0.34.0`
  - `pydantic==2.10.4`
  - `httpx==0.28.1`
  - `pyyaml==6.0.2`

## Architecture Support

| Architecture | Status | sing-box source |
|--------------|--------|-----------------|
| x86_64 | ✅ Full support | OpenWRT repo |
| aarch64 (ARM64) | ✅ Full support | OpenWRT repo |
| armv7 | ✅ Full support | OpenWRT repo |
| mips/mipsel (MT7621) | ✅ Full support | ImmortalWRT / SagerNet |

**Note:** The installer automatically:
1. **Adds ImmortalWRT repository** to `/etc/opkg/customfeeds.conf`
2. Installs sing-box via `opkg` from ImmortalWRT (allows future updates via `opkg upgrade`)
3. Falls back to direct download or SagerNet binaries if needed

This ensures sing-box can be updated with `opkg upgrade sing-box`.

Tested on: SIMAX 1800T, Xiaomi Mi Router 3G, Netgear R7800, x86_64 and others.

## Directory Structure

```
/opt/pinpoint/
├── backend/
│   └── main.py           # FastAPI backend
├── frontend/
│   ├── index.html        # Main interface
│   ├── login.html        # Login page
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   └── app.js
│   └── assets/
│       └── logo.svg
├── data/
│   ├── config.json       # Main configuration
│   ├── stats.db          # SQLite database
│   ├── services.json     # Service definitions
│   └── custom_services.json
└── scripts/
```

## Configuration

Main configuration is stored in `/opt/pinpoint/data/config.json`:

```json
{
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
    }
}
```

## Security Notes

- Change the default password immediately after installation
- The web interface is accessible from LAN only by default
- Consider using HTTPS proxy (nginx) for production use
- Authentication tokens expire after 24 hours (configurable)

## Troubleshooting

### Service won't start

```bash
# Check logs
logread | grep pinpoint

# Check Python
python3 --version

# Try running manually
cd /opt/pinpoint/backend && python3 main.py
```

### Port 8080 not accessible

```bash
# Check if service is running
pgrep -f "python3.*main.py"

# Check firewall
uci show firewall | grep -i pinpoint

# Add firewall rule manually
uci add firewall rule
uci set firewall.@rule[-1].name='Allow-PinPoint'
uci set firewall.@rule[-1].src='lan'
uci set firewall.@rule[-1].dest_port='8080'
uci set firewall.@rule[-1].proto='tcp'
uci set firewall.@rule[-1].target='ACCEPT'
uci commit firewall
/etc/init.d/firewall reload
```

### sing-box not working

```bash
# Check status
sing-box check -c /etc/sing-box/config.json

# View logs
logread | grep sing-box
```

### Lite: services/Instagram not working after adding subscription

Ensure routing is applied and sing-box is up:

```bash
/etc/init.d/sing-box start
sleep 2
/opt/pinpoint/scripts/pinpoint-init.sh start
/opt/pinpoint/scripts/pinpoint-apply.sh reload
```

Or restart the whole PinPoint service:

```bash
/etc/init.d/pinpoint restart
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) first.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [sing-box](https://github.com/SagerNet/sing-box) - The universal proxy platform
- [OpenWRT](https://openwrt.org/) - Linux distribution for embedded devices
- [FastAPI](https://fastapi.tiangolo.com/) - Modern Python web framework
