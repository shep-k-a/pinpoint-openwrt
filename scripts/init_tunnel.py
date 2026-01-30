#!/usr/bin/env python3
"""Initialize tunnels.json from existing sing-box config"""
import json

tunnel = {
    "id": "vless-lux",
    "name": "LuxWifi VLESS",
    "type": "vless",
    "enabled": True,
    "server": "s1.luxwifi.ru",
    "port": 443,
    "source": "manual",
    "subscription_id": None,
    "latency": None,
    "last_check": None,
    "settings": {
        "uuid": "e813ebca-6880-412a-a2d2-310a19877fb8",
        "flow": "xtls-rprx-vision",
        "encryption": "none"
    },
    "tls": {
        "enabled": True,
        "type": "reality",
        "server_name": "google.com",
        "fingerprint": "chrome",
        "public_key": "xkUZ3DWBZA7aMedxmRNZUpJ67OcxBuKS79A5dUKb-EQ",
        "short_id": "f4"
    },
    "transport": {"type": "tcp"}
}

with open("/opt/pinpoint/data/tunnels.json", "w") as f:
    json.dump([tunnel], f, indent=2)

# Set active outbound
settings = {"active_outbound": "vless-vless-lux"}
with open("/opt/pinpoint/data/settings.json", "w") as f:
    json.dump(settings, f, indent=2)

print("Tunnel imported and set as active!")
