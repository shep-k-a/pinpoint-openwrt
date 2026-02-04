"""
PinPoint - Tunnel Management Module
Handles parsing, storage, and configuration of sing-box tunnels
"""

import json
import base64
import re
import uuid
import time
import urllib.parse
from pathlib import Path
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict
from enum import Enum


class TunnelType(str, Enum):
    VLESS = "vless"
    VMESS = "vmess"
    SHADOWSOCKS = "shadowsocks"
    TROJAN = "trojan"
    HYSTERIA2 = "hysteria2"


class TunnelSource(str, Enum):
    MANUAL = "manual"
    SUBSCRIPTION = "subscription"
    IMPORT = "import"


# Data directory
DATA_DIR = Path("/opt/pinpoint/data")
TUNNELS_FILE = DATA_DIR / "tunnels.json"
SUBSCRIPTIONS_FILE = DATA_DIR / "subscriptions.json"
GROUPS_FILE = DATA_DIR / "tunnel_groups.json"
ROUTING_RULES_FILE = DATA_DIR / "routing_rules.json"
SINGBOX_CONFIG = Path("/etc/sing-box/config.json")
SINGBOX_BACKUP = DATA_DIR / "singbox_config_backup.json"


# ============ Data Models ============

def generate_id() -> str:
    return str(uuid.uuid4())[:8]


def load_tunnels() -> List[Dict]:
    """Load tunnels from storage"""
    if TUNNELS_FILE.exists():
        try:
            with open(TUNNELS_FILE) as f:
                return json.load(f)
        except:
            pass
    return []


def save_tunnels(tunnels: List[Dict]):
    """Save tunnels to storage"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(TUNNELS_FILE, 'w') as f:
        json.dump(tunnels, f, indent=2, ensure_ascii=False)


def load_subscriptions() -> List[Dict]:
    """Load subscriptions from storage"""
    if SUBSCRIPTIONS_FILE.exists():
        try:
            with open(SUBSCRIPTIONS_FILE) as f:
                return json.load(f)
        except:
            pass
    return []


def save_subscriptions(subs: List[Dict]):
    """Save subscriptions to storage"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(SUBSCRIPTIONS_FILE, 'w') as f:
        json.dump(subs, f, indent=2, ensure_ascii=False)


def load_groups() -> List[Dict]:
    """Load tunnel groups from storage"""
    if GROUPS_FILE.exists():
        try:
            with open(GROUPS_FILE) as f:
                return json.load(f)
        except:
            pass
    return []


def save_groups(groups: List[Dict]):
    """Save tunnel groups to storage"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(GROUPS_FILE, 'w') as f:
        json.dump(groups, f, indent=2, ensure_ascii=False)


def load_routing_rules() -> Dict:
    """Load routing rules from storage"""
    if ROUTING_RULES_FILE.exists():
        try:
            with open(ROUTING_RULES_FILE) as f:
                return json.load(f)
        except:
            pass
    return {"default_outbound": None, "rules": []}


def save_routing_rules(rules: Dict):
    """Save routing rules to storage"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(ROUTING_RULES_FILE, 'w') as f:
        json.dump(rules, f, indent=2, ensure_ascii=False)


# ============ Link Parsers ============

def parse_vless_link(link: str) -> Optional[Dict]:
    """
    Parse VLESS share link
    Format: vless://uuid@server:port?params#name
    """
    if not link.startswith("vless://"):
        return None
    
    try:
        # Remove prefix
        content = link[8:]
        
        # Split name (fragment)
        if '#' in content:
            content, name = content.rsplit('#', 1)
            name = urllib.parse.unquote(name)
        else:
            name = "VLESS Server"
        
        # Split params
        params = {}
        if '?' in content:
            content, query = content.split('?', 1)
            params = dict(urllib.parse.parse_qsl(query))
        
        # Parse uuid@server:port
        if '@' not in content:
            return None
        
        user_uuid, server_port = content.split('@', 1)
        
        # Handle IPv6
        if server_port.startswith('['):
            match = re.match(r'\[([^\]]+)\]:(\d+)', server_port)
            if match:
                server, port = match.groups()
            else:
                return None
        else:
            if ':' in server_port:
                server, port = server_port.rsplit(':', 1)
            else:
                return None
        
        tunnel = {
            "id": generate_id(),
            "name": name,
            "type": TunnelType.VLESS,
            "enabled": True,
            "server": server,
            "port": int(port),
            "source": TunnelSource.IMPORT,
            "subscription_id": None,
            "latency": None,
            "last_check": None,
            "settings": {
                "uuid": user_uuid,
                "flow": params.get("flow", ""),
                "encryption": params.get("encryption", "none"),
            },
            "tls": {},
            "transport": {}
        }
        
        # TLS settings
        security = params.get("security", "none")
        if security == "reality":
            tunnel["tls"] = {
                "enabled": True,
                "type": "reality",
                "server_name": params.get("sni", ""),
                "fingerprint": params.get("fp", "chrome"),
                "public_key": params.get("pbk", ""),
                "short_id": params.get("sid", "")
            }
        elif security in ("tls", "xtls"):
            tunnel["tls"] = {
                "enabled": True,
                "type": security,
                "server_name": params.get("sni", server),
                "fingerprint": params.get("fp", ""),
                "alpn": params.get("alpn", "").split(",") if params.get("alpn") else []
            }
        
        # Transport settings
        transport_type = params.get("type", "tcp")
        if transport_type == "ws":
            tunnel["transport"] = {
                "type": "ws",
                "path": params.get("path", "/"),
                "host": params.get("host", server)
            }
        elif transport_type == "grpc":
            tunnel["transport"] = {
                "type": "grpc",
                "service_name": params.get("serviceName", "")
            }
        elif transport_type == "tcp":
            tunnel["transport"] = {"type": "tcp"}
        
        return tunnel
        
    except Exception as e:
        print(f"Error parsing VLESS link: {e}")
        return None


def parse_vmess_link(link: str) -> Optional[Dict]:
    """
    Parse VMess share link
    Format: vmess://base64(json)
    """
    if not link.startswith("vmess://"):
        return None
    
    try:
        # Decode base64 content
        content = link[8:]
        # Add padding if needed
        padding = 4 - len(content) % 4
        if padding != 4:
            content += '=' * padding
        
        decoded = base64.b64decode(content).decode('utf-8')
        data = json.loads(decoded)
        
        tunnel = {
            "id": generate_id(),
            "name": data.get("ps", "VMess Server"),
            "type": TunnelType.VMESS,
            "enabled": True,
            "server": data.get("add", ""),
            "port": int(data.get("port", 443)),
            "source": TunnelSource.IMPORT,
            "subscription_id": None,
            "latency": None,
            "last_check": None,
            "settings": {
                "uuid": data.get("id", ""),
                "alter_id": int(data.get("aid", 0)),
                "security": data.get("scy", "auto")
            },
            "tls": {},
            "transport": {}
        }
        
        # TLS
        if data.get("tls") == "tls":
            tunnel["tls"] = {
                "enabled": True,
                "type": "tls",
                "server_name": data.get("sni", data.get("host", tunnel["server"])),
                "alpn": data.get("alpn", "").split(",") if data.get("alpn") else []
            }
        
        # Transport
        net = data.get("net", "tcp")
        if net == "ws":
            tunnel["transport"] = {
                "type": "ws",
                "path": data.get("path", "/"),
                "host": data.get("host", tunnel["server"])
            }
        elif net == "grpc":
            tunnel["transport"] = {
                "type": "grpc",
                "service_name": data.get("path", "")
            }
        elif net == "h2":
            tunnel["transport"] = {
                "type": "http",
                "path": data.get("path", "/"),
                "host": [data.get("host", tunnel["server"])]
            }
        else:
            tunnel["transport"] = {"type": "tcp"}
        
        return tunnel
        
    except Exception as e:
        print(f"Error parsing VMess link: {e}")
        return None


def parse_ss_link(link: str) -> Optional[Dict]:
    """
    Parse Shadowsocks share link
    Format: ss://base64(method:password)@server:port#name
    or: ss://base64(method:password@server:port)#name
    """
    if not link.startswith("ss://"):
        return None
    
    try:
        content = link[5:]
        
        # Extract name
        name = "Shadowsocks Server"
        if '#' in content:
            content, name = content.rsplit('#', 1)
            name = urllib.parse.unquote(name)
        
        # Try SIP002 format first: base64(method:password)@server:port
        if '@' in content:
            user_info, server_port = content.rsplit('@', 1)
            
            # Decode user info
            try:
                padding = 4 - len(user_info) % 4
                if padding != 4:
                    user_info += '=' * padding
                decoded = base64.urlsafe_b64decode(user_info).decode('utf-8')
                method, password = decoded.split(':', 1)
            except:
                # Already decoded
                method, password = user_info.split(':', 1)
            
            # Parse server:port
            if server_port.startswith('['):
                match = re.match(r'\[([^\]]+)\]:(\d+)', server_port)
                if match:
                    server, port = match.groups()
                else:
                    return None
            else:
                server, port = server_port.rsplit(':', 1)
        else:
            # Legacy format: base64(method:password@server:port)
            padding = 4 - len(content) % 4
            if padding != 4:
                content += '=' * padding
            decoded = base64.urlsafe_b64decode(content).decode('utf-8')
            
            method_pass, server_port = decoded.rsplit('@', 1)
            method, password = method_pass.split(':', 1)
            server, port = server_port.rsplit(':', 1)
        
        tunnel = {
            "id": generate_id(),
            "name": name,
            "type": TunnelType.SHADOWSOCKS,
            "enabled": True,
            "server": server,
            "port": int(port),
            "source": TunnelSource.IMPORT,
            "subscription_id": None,
            "latency": None,
            "last_check": None,
            "settings": {
                "method": method,
                "password": password
            },
            "tls": {},
            "transport": {}
        }
        
        return tunnel
        
    except Exception as e:
        print(f"Error parsing Shadowsocks link: {e}")
        return None


def parse_trojan_link(link: str) -> Optional[Dict]:
    """
    Parse Trojan share link
    Format: trojan://password@server:port?params#name
    """
    if not link.startswith("trojan://"):
        return None
    
    try:
        content = link[9:]
        
        # Extract name
        name = "Trojan Server"
        if '#' in content:
            content, name = content.rsplit('#', 1)
            name = urllib.parse.unquote(name)
        
        # Extract params
        params = {}
        if '?' in content:
            content, query = content.split('?', 1)
            params = dict(urllib.parse.parse_qsl(query))
        
        # Parse password@server:port
        password, server_port = content.rsplit('@', 1)
        
        # Handle IPv6
        if server_port.startswith('['):
            match = re.match(r'\[([^\]]+)\]:(\d+)', server_port)
            if match:
                server, port = match.groups()
            else:
                return None
        else:
            server, port = server_port.rsplit(':', 1)
        
        tunnel = {
            "id": generate_id(),
            "name": name,
            "type": TunnelType.TROJAN,
            "enabled": True,
            "server": server,
            "port": int(port),
            "source": TunnelSource.IMPORT,
            "subscription_id": None,
            "latency": None,
            "last_check": None,
            "settings": {
                "password": password
            },
            "tls": {
                "enabled": True,
                "type": "tls",
                "server_name": params.get("sni", server),
                "alpn": params.get("alpn", "").split(",") if params.get("alpn") else []
            },
            "transport": {}
        }
        
        # Transport
        transport_type = params.get("type", "tcp")
        if transport_type == "ws":
            tunnel["transport"] = {
                "type": "ws",
                "path": params.get("path", "/"),
                "host": params.get("host", server)
            }
        elif transport_type == "grpc":
            tunnel["transport"] = {
                "type": "grpc",
                "service_name": params.get("serviceName", "")
            }
        else:
            tunnel["transport"] = {"type": "tcp"}
        
        return tunnel
        
    except Exception as e:
        print(f"Error parsing Trojan link: {e}")
        return None


def parse_hysteria2_link(link: str) -> Optional[Dict]:
    """
    Parse Hysteria2 share link
    Format: hy2://password@server:port?params#name
    or: hysteria2://password@server:port?params#name
    """
    if link.startswith("hysteria2://"):
        content = link[12:]
    elif link.startswith("hy2://"):
        content = link[6:]
    else:
        return None
    
    try:
        # Extract name
        name = "Hysteria2 Server"
        if '#' in content:
            content, name = content.rsplit('#', 1)
            name = urllib.parse.unquote(name)
        
        # Extract params
        params = {}
        if '?' in content:
            content, query = content.split('?', 1)
            params = dict(urllib.parse.parse_qsl(query))
        
        # Parse password@server:port
        if '@' in content:
            password, server_port = content.rsplit('@', 1)
        else:
            password = ""
            server_port = content
        
        # Handle IPv6
        if server_port.startswith('['):
            match = re.match(r'\[([^\]]+)\]:(\d+)', server_port)
            if match:
                server, port = match.groups()
            else:
                return None
        else:
            server, port = server_port.rsplit(':', 1)
        
        tunnel = {
            "id": generate_id(),
            "name": name,
            "type": TunnelType.HYSTERIA2,
            "enabled": True,
            "server": server,
            "port": int(port),
            "source": TunnelSource.IMPORT,
            "subscription_id": None,
            "latency": None,
            "last_check": None,
            "settings": {
                "password": password,
                "obfs_type": params.get("obfs", ""),
                "obfs_password": params.get("obfs-password", ""),
                "up_mbps": int(params.get("up", 0)) if params.get("up") else None,
                "down_mbps": int(params.get("down", 0)) if params.get("down") else None
            },
            "tls": {
                "enabled": True,
                "type": "tls",
                "server_name": params.get("sni", server),
                "insecure": params.get("insecure", "0") == "1"
            },
            "transport": {}
        }
        
        return tunnel
        
    except Exception as e:
        print(f"Error parsing Hysteria2 link: {e}")
        return None


def parse_share_link(link: str) -> Optional[Dict]:
    """Parse any supported share link"""
    link = link.strip()
    
    if link.startswith("vless://"):
        return parse_vless_link(link)
    elif link.startswith("vmess://"):
        return parse_vmess_link(link)
    elif link.startswith("ss://"):
        return parse_ss_link(link)
    elif link.startswith("trojan://"):
        return parse_trojan_link(link)
    elif link.startswith("hy2://") or link.startswith("hysteria2://"):
        return parse_hysteria2_link(link)
    
    return None


# ============ Subscription Parsers ============

def parse_base64_subscription(content: str) -> List[Dict]:
    """Parse Base64 encoded subscription (list of share links)"""
    tunnels = []
    
    try:
        # Decode base64
        padding = 4 - len(content) % 4
        if padding != 4:
            content += '=' * padding
        decoded = base64.b64decode(content).decode('utf-8')
        
        # Parse each line as a share link
        for line in decoded.strip().split('\n'):
            line = line.strip()
            if line:
                tunnel = parse_share_link(line)
                if tunnel:
                    tunnels.append(tunnel)
    except Exception as e:
        print(f"Error parsing Base64 subscription: {e}")
    
    return tunnels


def parse_clash_subscription(content: str) -> List[Dict]:
    """Parse Clash YAML subscription"""
    tunnels = []
    
    try:
        import yaml
        data = yaml.safe_load(content)
        proxies = data.get("proxies", [])
        
        for proxy in proxies:
            proxy_type = proxy.get("type", "").lower()
            
            tunnel = {
                "id": generate_id(),
                "name": proxy.get("name", "Proxy"),
                "enabled": True,
                "server": proxy.get("server", ""),
                "port": int(proxy.get("port", 443)),
                "source": TunnelSource.SUBSCRIPTION,
                "subscription_id": None,
                "latency": None,
                "last_check": None,
                "settings": {},
                "tls": {},
                "transport": {}
            }
            
            if proxy_type == "vless":
                tunnel["type"] = TunnelType.VLESS
                tunnel["settings"] = {
                    "uuid": proxy.get("uuid", ""),
                    "flow": proxy.get("flow", ""),
                    "encryption": "none"
                }
            elif proxy_type == "vmess":
                tunnel["type"] = TunnelType.VMESS
                tunnel["settings"] = {
                    "uuid": proxy.get("uuid", ""),
                    "alter_id": int(proxy.get("alterId", 0)),
                    "security": proxy.get("cipher", "auto")
                }
            elif proxy_type in ("ss", "shadowsocks"):
                tunnel["type"] = TunnelType.SHADOWSOCKS
                tunnel["settings"] = {
                    "method": proxy.get("cipher", ""),
                    "password": proxy.get("password", "")
                }
            elif proxy_type == "trojan":
                tunnel["type"] = TunnelType.TROJAN
                tunnel["settings"] = {
                    "password": proxy.get("password", "")
                }
            elif proxy_type == "hysteria2":
                tunnel["type"] = TunnelType.HYSTERIA2
                tunnel["settings"] = {
                    "password": proxy.get("password", ""),
                    "obfs_type": proxy.get("obfs", ""),
                    "obfs_password": proxy.get("obfs-password", "")
                }
            else:
                continue
            
            # TLS
            if proxy.get("tls"):
                tunnel["tls"] = {
                    "enabled": True,
                    "type": "tls",
                    "server_name": proxy.get("sni", proxy.get("servername", tunnel["server"])),
                    "skip_verify": proxy.get("skip-cert-verify", False)
                }
            
            # Reality
            if proxy.get("reality-opts"):
                reality = proxy["reality-opts"]
                tunnel["tls"] = {
                    "enabled": True,
                    "type": "reality",
                    "server_name": proxy.get("sni", proxy.get("servername", "")),
                    "fingerprint": proxy.get("client-fingerprint", "chrome"),
                    "public_key": reality.get("public-key", ""),
                    "short_id": reality.get("short-id", "")
                }
            
            # Transport
            network = proxy.get("network", "tcp")
            if network == "ws":
                ws_opts = proxy.get("ws-opts", {})
                tunnel["transport"] = {
                    "type": "ws",
                    "path": ws_opts.get("path", "/"),
                    "host": ws_opts.get("headers", {}).get("Host", tunnel["server"])
                }
            elif network == "grpc":
                grpc_opts = proxy.get("grpc-opts", {})
                tunnel["transport"] = {
                    "type": "grpc",
                    "service_name": grpc_opts.get("grpc-service-name", "")
                }
            else:
                tunnel["transport"] = {"type": "tcp"}
            
            tunnels.append(tunnel)
            
    except ImportError:
        print("PyYAML not installed, cannot parse Clash config")
    except Exception as e:
        print(f"Error parsing Clash subscription: {e}")
    
    return tunnels


def parse_singbox_subscription(content: str) -> List[Dict]:
    """Parse sing-box JSON subscription/config"""
    tunnels = []
    
    try:
        data = json.loads(content)
        outbounds = data.get("outbounds", [])
        
        for ob in outbounds:
            ob_type = ob.get("type", "")
            
            # Skip non-proxy types
            if ob_type in ("direct", "block", "dns", "selector", "urltest"):
                continue
            
            tunnel = {
                "id": generate_id(),
                "name": ob.get("tag", ob_type),
                "enabled": True,
                "server": ob.get("server", ""),
                "port": int(ob.get("server_port", 443)),
                "source": TunnelSource.SUBSCRIPTION,
                "subscription_id": None,
                "latency": None,
                "last_check": None,
                "settings": {},
                "tls": {},
                "transport": {}
            }
            
            if ob_type == "vless":
                tunnel["type"] = TunnelType.VLESS
                tunnel["settings"] = {
                    "uuid": ob.get("uuid", ""),
                    "flow": ob.get("flow", ""),
                    "encryption": "none"
                }
            elif ob_type == "vmess":
                tunnel["type"] = TunnelType.VMESS
                tunnel["settings"] = {
                    "uuid": ob.get("uuid", ""),
                    "alter_id": int(ob.get("alter_id", 0)),
                    "security": ob.get("security", "auto")
                }
            elif ob_type == "shadowsocks":
                tunnel["type"] = TunnelType.SHADOWSOCKS
                tunnel["settings"] = {
                    "method": ob.get("method", ""),
                    "password": ob.get("password", "")
                }
            elif ob_type == "trojan":
                tunnel["type"] = TunnelType.TROJAN
                tunnel["settings"] = {
                    "password": ob.get("password", "")
                }
            elif ob_type == "hysteria2":
                tunnel["type"] = TunnelType.HYSTERIA2
                tunnel["settings"] = {
                    "password": ob.get("password", ""),
                    "obfs_type": ob.get("obfs", {}).get("type", "") if ob.get("obfs") else "",
                    "obfs_password": ob.get("obfs", {}).get("password", "") if ob.get("obfs") else "",
                    "up_mbps": ob.get("up_mbps"),
                    "down_mbps": ob.get("down_mbps")
                }
            else:
                continue
            
            # TLS
            tls = ob.get("tls", {})
            if tls:
                if tls.get("reality", {}).get("enabled"):
                    reality = tls["reality"]
                    tunnel["tls"] = {
                        "enabled": True,
                        "type": "reality",
                        "server_name": tls.get("server_name", ""),
                        "fingerprint": tls.get("utls", {}).get("fingerprint", "chrome"),
                        "public_key": reality.get("public_key", ""),
                        "short_id": reality.get("short_id", "")
                    }
                else:
                    tunnel["tls"] = {
                        "enabled": tls.get("enabled", False),
                        "type": "tls",
                        "server_name": tls.get("server_name", tunnel["server"]),
                        "insecure": tls.get("insecure", False),
                        "alpn": tls.get("alpn", [])
                    }
            
            # Transport
            transport = ob.get("transport", {})
            if transport:
                t_type = transport.get("type", "tcp")
                if t_type == "ws":
                    tunnel["transport"] = {
                        "type": "ws",
                        "path": transport.get("path", "/"),
                        "host": transport.get("headers", {}).get("Host", tunnel["server"])
                    }
                elif t_type == "grpc":
                    tunnel["transport"] = {
                        "type": "grpc",
                        "service_name": transport.get("service_name", "")
                    }
                else:
                    tunnel["transport"] = {"type": t_type}
            else:
                tunnel["transport"] = {"type": "tcp"}
            
            tunnels.append(tunnel)
            
    except Exception as e:
        print(f"Error parsing sing-box subscription: {e}")
    
    return tunnels


def parse_subscription_content(content: str, format_hint: str = "auto") -> List[Dict]:
    """Parse subscription content, auto-detecting format if needed"""
    content = content.strip()
    
    if format_hint == "singbox" or (format_hint == "auto" and content.startswith("{")):
        return parse_singbox_subscription(content)
    
    if format_hint == "clash" or (format_hint == "auto" and content.startswith("proxies:")):
        return parse_clash_subscription(content)
    
    # Try base64 (most common)
    tunnels = parse_base64_subscription(content)
    if tunnels:
        return tunnels
    
    # Try as raw share links
    tunnels = []
    for line in content.split('\n'):
        line = line.strip()
        if line:
            tunnel = parse_share_link(line)
            if tunnel:
                tunnels.append(tunnel)
    
    return tunnels


# ============ Sing-box Config Generator ============

def generate_tunnel_outbound(tunnel: Dict) -> Dict:
    """Generate sing-box outbound config from tunnel data"""
    t_type = tunnel["type"]
    tag = f"{t_type}-{tunnel['id']}"
    
    outbound = {
        "type": t_type,
        "tag": tag,
        "server": tunnel["server"],
        "server_port": tunnel["port"]
    }
    
    settings = tunnel.get("settings", {})
    tls_config = tunnel.get("tls", {})
    transport = tunnel.get("transport", {})
    
    # Protocol-specific settings
    if t_type == "vless":
        outbound["uuid"] = settings.get("uuid", "")
        if settings.get("flow"):
            outbound["flow"] = settings["flow"]
    
    elif t_type == "vmess":
        outbound["uuid"] = settings.get("uuid", "")
        outbound["alter_id"] = settings.get("alter_id", 0)
        outbound["security"] = settings.get("security", "auto")
    
    elif t_type == "shadowsocks":
        outbound["method"] = settings.get("method", "")
        outbound["password"] = settings.get("password", "")
    
    elif t_type == "trojan":
        outbound["password"] = settings.get("password", "")
    
    elif t_type == "hysteria2":
        outbound["password"] = settings.get("password", "")
        if settings.get("obfs_type"):
            outbound["obfs"] = {
                "type": settings["obfs_type"],
                "password": settings.get("obfs_password", "")
            }
        if settings.get("up_mbps"):
            outbound["up_mbps"] = settings["up_mbps"]
        if settings.get("down_mbps"):
            outbound["down_mbps"] = settings["down_mbps"]
    
    # TLS
    if tls_config.get("enabled"):
        tls = {"enabled": True}
        
        if tls_config.get("type") == "reality":
            tls["server_name"] = tls_config.get("server_name", "")
            tls["utls"] = {"enabled": True, "fingerprint": tls_config.get("fingerprint", "chrome")}
            tls["reality"] = {
                "enabled": True,
                "public_key": tls_config.get("public_key", ""),
                "short_id": tls_config.get("short_id", "")
            }
        else:
            tls["server_name"] = tls_config.get("server_name", tunnel["server"])
            if tls_config.get("insecure"):
                tls["insecure"] = True
            if tls_config.get("alpn"):
                tls["alpn"] = tls_config["alpn"]
            if tls_config.get("fingerprint"):
                tls["utls"] = {"enabled": True, "fingerprint": tls_config["fingerprint"]}
        
        outbound["tls"] = tls
    
    # Transport
    if transport.get("type") and transport["type"] != "tcp":
        t = {"type": transport["type"]}
        
        if transport["type"] == "ws":
            t["path"] = transport.get("path", "/")
            if transport.get("host"):
                t["headers"] = {"Host": transport["host"]}
        elif transport["type"] == "grpc":
            t["service_name"] = transport.get("service_name", "")
        
        outbound["transport"] = t
    
    return outbound


def generate_group_outbound(group: Dict, tunnels: List[Dict]) -> Dict:
    """Generate sing-box selector/urltest outbound from group"""
    tunnel_tags = []
    for t_id in group.get("tunnels", []):
        for t in tunnels:
            if t["id"] == t_id and t.get("enabled"):
                tunnel_tags.append(f"{t['type']}-{t['id']}")
                break
    
    if group["type"] == "urltest":
        return {
            "type": "urltest",
            "tag": group.get("tag", f"group-{group['id']}"),
            "outbounds": tunnel_tags,
            "url": "https://www.gstatic.com/generate_204",
            "interval": group.get("interval", "5m"),
            "tolerance": group.get("tolerance", 50)
        }
    elif group["type"] == "fallback":
        return {
            "type": "urltest",
            "tag": group.get("tag", f"group-{group['id']}"),
            "outbounds": tunnel_tags,
            "url": "https://www.gstatic.com/generate_204",
            "interval": group.get("interval", "1m")
        }
    else:
        return {
            "type": "selector",
            "tag": group.get("tag", f"group-{group['id']}"),
            "outbounds": tunnel_tags,
            "default": tunnel_tags[0] if tunnel_tags else "direct-out"
        }


def generate_singbox_config(tunnels: List[Dict], groups: List[Dict], active_outbound: str = None, routing_rules: Dict = None) -> Dict:
    """Generate complete sing-box config from tunnels, groups, and routing rules"""
    
    # Start with base config
    # NOTE: DNS removed from sing-box to prevent memory leaks from hanging DNS connections
    # DNS is handled by dnsmasq + https-dns-proxy instead
    config = {
        "log": {"level": "info"},
        "inbounds": [
            {
                "type": "tun",
                "tag": "tun-in",
                "interface_name": "tun1",
                "inet4_address": "10.0.0.1/30",
                "mtu": 1400,
                "auto_route": False,
                "sniff": True,
                "stack": "gvisor"
            }
        ],
        "outbounds": [
            {"type": "direct", "tag": "direct-out"}
        ],
        "route": {
            "auto_detect_interface": True
        }
    }
    
    # Add tunnel outbounds
    enabled_tunnels = [t for t in tunnels if t.get("enabled")]
    for tunnel in enabled_tunnels:
        outbound = generate_tunnel_outbound(tunnel)
        config["outbounds"].append(outbound)
    
    # Add group outbounds
    for group in groups:
        group_outbound = generate_group_outbound(group, tunnels)
        if group_outbound.get("outbounds"):
            config["outbounds"].append(group_outbound)
    
    # Build set of valid outbound tags
    valid_tags = {ob.get("tag") for ob in config["outbounds"]}
    
    # Add routing rules (service -> tunnel mapping)
    if routing_rules and routing_rules.get("rules"):
        for rule in routing_rules["rules"]:
            if not rule.get("enabled", True):
                continue
            
            outbound_tag = rule.get("outbound")
            if not outbound_tag or outbound_tag not in valid_tags:
                continue
            
            # Collect domains from rule
            domains = []
            domain_suffixes = []
            
            # Add explicit domains
            if rule.get("domains"):
                for d in rule["domains"]:
                    d = d.strip().lower()
                    if d.startswith("*."):
                        domain_suffixes.append(d[2:])
                    elif d.startswith("."):
                        domain_suffixes.append(d[1:])
                    else:
                        domains.append(d)
            
            # Add domain keywords (partial match)
            domain_keywords = rule.get("domain_keywords", [])
            
            # Build the sing-box rule
            singbox_rule = {"outbound": outbound_tag}
            
            if domains:
                singbox_rule["domain"] = domains
            if domain_suffixes:
                singbox_rule["domain_suffix"] = domain_suffixes
            if domain_keywords:
                singbox_rule["domain_keyword"] = domain_keywords
            
            # Only add rule if it has domain matchers
            if len(singbox_rule) > 1:
                config["route"]["rules"].append(singbox_rule)
    
    # Set default outbound for all tun traffic
    default_outbound = None
    if routing_rules and routing_rules.get("default_outbound"):
        default_outbound = routing_rules["default_outbound"]
    elif active_outbound:
        default_outbound = active_outbound
    
    if default_outbound and default_outbound in valid_tags:
        config["route"]["rules"].append({
            "inbound": ["tun-in"],
            "outbound": default_outbound
        })
    elif enabled_tunnels:
        # Use first enabled tunnel
        first_tag = f"{enabled_tunnels[0]['type']}-{enabled_tunnels[0]['id']}"
        config["route"]["rules"].append({
            "inbound": ["tun-in"],
            "outbound": first_tag
        })
    
    return config


def apply_singbox_config(config: Dict) -> bool:
    """Save config and restart sing-box"""
    import subprocess
    
    try:
        # Backup current config
        if SINGBOX_CONFIG.exists():
            import shutil
            shutil.copy(SINGBOX_CONFIG, SINGBOX_BACKUP)
        
        # Write new config
        SINGBOX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        with open(SINGBOX_CONFIG, 'w') as f:
            json.dump(config, f, indent=2)
        
        # Restart sing-box
        result = subprocess.run(
            ["/etc/init.d/sing-box", "restart"],
            capture_output=True,
            timeout=30
        )
        
        return result.returncode == 0
        
    except Exception as e:
        print(f"Error applying sing-box config: {e}")
        # Restore backup
        if SINGBOX_BACKUP.exists():
            import shutil
            shutil.copy(SINGBOX_BACKUP, SINGBOX_CONFIG)
        return False
