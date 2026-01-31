#!/usr/bin/env python3
"""
PinPoint - FastAPI Backend
Web API for managing selective routing on OpenWRT
"""

import json
import os
import subprocess
import socket
import time
import re
import asyncio
import sqlite3
import hashlib
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, Response, Request, Depends, Cookie
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel

# Import tunnel management
import tunnels as tunnel_mgr

# Configuration
PINPOINT_DIR = Path("/opt/pinpoint")
DATA_DIR = PINPOINT_DIR / "data"
LISTS_DIR = DATA_DIR / "lists"
FRONTEND_DIR = PINPOINT_DIR / "frontend"
SERVICES_FILE = DATA_DIR / "services.json"
DOMAINS_FILE = DATA_DIR / "domains.json"
CUSTOM_SERVICES_FILE = DATA_DIR / "custom_services.json"
CONFIG_FILE = DATA_DIR / "config.json"
DEVICES_FILE = DATA_DIR / "devices.json"
STATS_FILE = DATA_DIR / "traffic_stats.json"  # Legacy, will be removed
SYSTEM_STATS_FILE = DATA_DIR / "system_stats.json"  # Legacy, will be removed
STATS_DB_FILE = DATA_DIR / "stats.db"
HISTORY_FILE = DATA_DIR / "connection_history.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
# ============ Authentication System (SQLite) ============

# Active sessions storage (token -> {username, expires})
active_sessions: Dict[str, Dict[str, Any]] = {}

def hash_password(password: str) -> str:
    """Hash password using SHA-256"""
    return hashlib.sha256(password.encode()).hexdigest()

def init_auth_db():
    """Initialize auth table in SQLite database"""
    conn = sqlite3.connect(STATS_DB_FILE)
    cursor = conn.cursor()
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
    # Check if first_login column exists, add if not
    cursor.execute("PRAGMA table_info(auth)")
    columns = [col[1] for col in cursor.fetchall()]
    if 'first_login' not in columns:
        cursor.execute('ALTER TABLE auth ADD COLUMN first_login INTEGER NOT NULL DEFAULT 1')
    
    # Insert default user if not exists
    cursor.execute('SELECT COUNT(*) FROM auth')
    if cursor.fetchone()[0] == 0:
        cursor.execute('''
            INSERT INTO auth (id, username, password_hash, enabled, session_hours, first_login)
            VALUES (1, 'admin', ?, 1, 24, 1)
        ''', (hash_password('admin'),))
    conn.commit()
    conn.close()

def load_auth_config() -> dict:
    """Load authentication configuration from SQLite"""
    init_auth_db()
    conn = sqlite3.connect(STATS_DB_FILE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM auth WHERE id = 1')
    row = cursor.fetchone()
    conn.close()
    
    if row:
        return {
            "enabled": bool(row["enabled"]),
            "username": row["username"],
            "password_hash": row["password_hash"],
            "session_hours": row["session_hours"],
            "last_login": row["last_login"],
            "first_login": bool(row["first_login"]) if "first_login" in row.keys() else False
        }
    return {"enabled": True, "username": "admin", "password_hash": hash_password("admin"), "session_hours": 24, "first_login": True}

def save_auth_config(config: dict):
    """Save authentication configuration to SQLite"""
    init_auth_db()
    conn = sqlite3.connect(STATS_DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        UPDATE auth SET 
            username = ?,
            password_hash = ?,
            enabled = ?,
            session_hours = ?,
            last_login = ?
        WHERE id = 1
    ''', (
        config.get("username", "admin"),
        config.get("password_hash"),
        1 if config.get("enabled", True) else 0,
        config.get("session_hours", 24),
        config.get("last_login")
    ))
    conn.commit()
    conn.close()

def update_last_login():
    """Update last login timestamp"""
    conn = sqlite3.connect(STATS_DB_FILE)
    cursor = conn.cursor()
    cursor.execute('UPDATE auth SET last_login = ? WHERE id = 1', (datetime.now().isoformat(),))
    conn.commit()
    conn.close()

def mark_first_login_complete():
    """Mark first login as completed"""
    conn = sqlite3.connect(STATS_DB_FILE)
    cursor = conn.cursor()
    cursor.execute('UPDATE auth SET first_login = 0 WHERE id = 1')
    conn.commit()
    conn.close()

def verify_password(password: str, stored_hash: str) -> bool:
    """Verify password against stored hash"""
    return hash_password(password) == stored_hash

def create_session(username: str) -> str:
    """Create a new session and return token"""
    auth_config = load_auth_config()
    token = secrets.token_urlsafe(32)
    expires = datetime.now() + timedelta(hours=auth_config.get("session_hours", 24))
    active_sessions[token] = {
        "username": username,
        "expires": expires.isoformat()
    }
    update_last_login()
    return token

def validate_session(token: str) -> Optional[str]:
    """Validate session token, return username if valid"""
    if not token or token not in active_sessions:
        return None
    
    session = active_sessions[token]
    expires = datetime.fromisoformat(session["expires"])
    
    if datetime.now() > expires:
        del active_sessions[token]
        return None
    
    return session["username"]

def clear_expired_sessions():
    """Remove expired sessions"""
    now = datetime.now()
    expired = [
        token for token, session in active_sessions.items()
        if datetime.fromisoformat(session["expires"]) < now
    ]
    for token in expired:
        del active_sessions[token]

async def get_current_user(request: Request) -> Optional[str]:
    """Dependency to get current authenticated user"""
    auth_config = load_auth_config()
    
    # If auth is disabled, return a default user
    if not auth_config.get("enabled", True):
        return "admin"
    
    # Check for token in cookie
    token = request.cookies.get("pinpoint_token")
    
    # Also check Authorization header
    if not token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
    
    if token:
        username = validate_session(token)
        if username:
            return username
    
    return None

async def require_auth(request: Request):
    """Dependency that requires authentication"""
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user

# Pydantic Models for Auth
class LoginRequest(BaseModel):
    username: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class AuthSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    session_hours: Optional[int] = None

# Pydantic Models
class ServiceToggle(BaseModel):
    enabled: bool

class DomainCreate(BaseModel):
    domain: str
    description: Optional[str] = ""

class DomainTest(BaseModel):
    domain: str

class SourceCreate(BaseModel):
    service_id: str
    url: str
    type: str = "auto"

class ServiceDomainAdd(BaseModel):
    domain: str

class ServiceIpAdd(BaseModel):
    ip: str

class CustomServiceCreate(BaseModel):
    name: str
    description: Optional[str] = ""
    domains: Optional[list] = []
    ips: Optional[list] = []

class CustomServiceUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    domains: Optional[list] = None
    ips: Optional[list] = None
    enabled: Optional[bool] = None

class ServiceSourceAdd(BaseModel):
    url: str
    type: str = "keenetic"

class DeviceCreate(BaseModel):
    name: str
    ip: str
    mac: Optional[str] = ""
    mode: str = "default"
    services: list = []
    custom_domains: list = []
    custom_ips: list = []

class DeviceUpdate(BaseModel):
    name: Optional[str] = None
    ip: Optional[str] = None
    mac: Optional[str] = None
    mode: Optional[str] = None
    services: Optional[list] = None
    custom_domains: Optional[list] = None
    custom_ips: Optional[list] = None
    enabled: Optional[bool] = None

# Tunnel Management Models
class TunnelCreate(BaseModel):
    name: str
    type: str  # vless, vmess, shadowsocks, trojan, hysteria2
    server: str
    port: int
    settings: dict = {}
    tls: dict = {}
    transport: dict = {}

class TunnelUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    server: Optional[str] = None
    port: Optional[int] = None
    settings: Optional[dict] = None
    tls: Optional[dict] = None
    transport: Optional[dict] = None

class TunnelImport(BaseModel):
    link: str  # Share link (vless://, vmess://, ss://, etc.)

class SubscriptionCreate(BaseModel):
    name: str
    url: str
    format: str = "auto"  # auto, base64, clash, singbox
    auto_update: bool = True
    update_interval: int = 24  # hours

class SubscriptionUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    auto_update: Optional[bool] = None
    update_interval: Optional[int] = None

class TunnelGroupCreate(BaseModel):
    name: str
    type: str = "urltest"  # urltest, fallback, selector
    tunnels: List[str] = []
    interval: str = "5m"
    tolerance: int = 50

class TunnelGroupUpdate(BaseModel):
    name: Optional[str] = None
    tunnels: Optional[List[str]] = None
    interval: Optional[str] = None
    tolerance: Optional[int] = None

class ActiveOutboundSet(BaseModel):
    outbound_tag: str

class RoutingRuleCreate(BaseModel):
    name: str
    outbound: str  # Tunnel or group tag
    domains: List[str] = []
    domain_keywords: List[str] = []
    enabled: bool = True

class RoutingRuleUpdate(BaseModel):
    name: Optional[str] = None
    outbound: Optional[str] = None
    domains: Optional[List[str]] = None
    domain_keywords: Optional[List[str]] = None
    enabled: Optional[bool] = None

class RoutingDefaultSet(BaseModel):
    default_outbound: str

# Helper functions
def load_json(path: Path) -> dict:
    """Load JSON file"""
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return {}

def save_json(path: Path, data: dict):
    """Save JSON file"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def run_command(cmd: list, timeout: int = 30) -> tuple:
    """Run shell command and return (success, output)"""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.returncode == 0, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return False, "Command timed out"
    except Exception as e:
        return False, str(e)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler"""
    # Startup
    print("[pinpoint] API server starting...", flush=True)
    asyncio.create_task(background_health_check())
    print("[pinpoint] Background task created", flush=True)
    yield
    # Shutdown
    print("[pinpoint] API server stopping...", flush=True)

# Create FastAPI app
app = FastAPI(
    title="PinPoint",
    description="Selective routing management for OpenWRT",
    version="1.0.0",
    lifespan=lifespan
)

# Public paths that don't require authentication
PUBLIC_PATHS = {
    "/api/auth/login",
    "/api/auth/status",
    "/api/auth/logout",
    "/login.html",
    "/css/style.css",
    "/js/app.js",
    "/docs",
    "/openapi.json",
    "/redoc",
}

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Middleware to check authentication for API routes"""
    path = request.url.path
    
    # Allow static files and public paths
    if (path.startswith("/css/") or 
        path.startswith("/js/") or 
        path.startswith("/assets/") or
        path in PUBLIC_PATHS or
        path == "/" or
        path == "/login.html" or
        path == "/favicon.ico"):
        return await call_next(request)
    
    # Check if auth is enabled
    auth_config = load_auth_config()
    if not auth_config.get("enabled", True):
        return await call_next(request)
    
    # For API routes, check authentication
    if path.startswith("/api/"):
        user = await get_current_user(request)
        if not user:
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized"}
            )
    
    return await call_next(request)

# ============ Auth API Routes ============

@app.post("/api/auth/login")
async def login(data: LoginRequest, response: Response):
    """Login and get session token"""
    auth_config = load_auth_config()
    
    # Check credentials
    if data.username != auth_config.get("username"):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    if not verify_password(data.password, auth_config.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    # Create session
    token = create_session(data.username)
    
    # Check if first login
    is_first_login = auth_config.get("first_login", False)
    
    # Mark first login as completed
    if is_first_login:
        mark_first_login_complete()
    
    # Set cookie
    response.set_cookie(
        key="pinpoint_token",
        value=token,
        httponly=True,
        max_age=auth_config.get("session_hours", 24) * 3600,
        samesite="lax"
    )
    
    return {
        "status": "ok",
        "token": token,
        "username": data.username,
        "expires_hours": auth_config.get("session_hours", 24),
        "first_login": is_first_login
    }

@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    """Logout and invalidate session"""
    token = request.cookies.get("pinpoint_token")
    if token and token in active_sessions:
        del active_sessions[token]
    
    response.delete_cookie("pinpoint_token")
    return {"status": "ok"}

@app.get("/api/auth/status")
async def auth_status(request: Request):
    """Check if user is authenticated"""
    auth_config = load_auth_config()
    user = await get_current_user(request)
    
    return {
        "authenticated": user is not None,
        "username": user,
        "auth_enabled": auth_config.get("enabled", True)
    }

@app.post("/api/auth/change-password")
async def change_password(data: ChangePasswordRequest, request: Request):
    """Change user password"""
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    auth_config = load_auth_config()
    
    # Verify current password
    if not verify_password(data.current_password, auth_config.get("password_hash", "")):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    
    # Update password
    auth_config["password_hash"] = hash_password(data.new_password)
    save_auth_config(auth_config)
    
    # Invalidate all sessions except current
    current_token = request.cookies.get("pinpoint_token")
    tokens_to_remove = [t for t in active_sessions.keys() if t != current_token]
    for token in tokens_to_remove:
        del active_sessions[token]
    
    return {"status": "ok", "message": "Password changed successfully"}

@app.get("/api/auth/settings")
async def get_auth_settings(request: Request):
    """Get authentication settings (admin only)"""
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    auth_config = load_auth_config()
    return {
        "enabled": auth_config.get("enabled", True),
        "username": auth_config.get("username", "admin"),
        "session_hours": auth_config.get("session_hours", 24),
        "last_login": auth_config.get("last_login")
    }

@app.put("/api/auth/settings")
async def update_auth_settings(data: AuthSettingsUpdate, request: Request):
    """Update authentication settings"""
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    auth_config = load_auth_config()
    
    if data.enabled is not None:
        auth_config["enabled"] = data.enabled
    if data.session_hours is not None:
        auth_config["session_hours"] = max(1, min(720, data.session_hours))  # 1h - 30days
    
    save_auth_config(auth_config)
    return {"status": "ok", "settings": auth_config}

# API Routes

@app.get("/api/status")
async def get_status():
    """Get system status"""
    # Check if tun1 is up
    tun_up = Path("/sys/class/net/tun1").exists()
    
    # Check if VPN is actually configured (not just direct outbound)
    vpn_configured = False
    try:
        config_path = Path("/etc/sing-box/config.json")
        if config_path.exists():
            config = json.loads(config_path.read_text())
            outbounds = config.get("outbounds", [])
            vpn_types = ["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "hysteria"]
            vpn_configured = any(ob.get("type") in vpn_types for ob in outbounds)
    except Exception:
        pass
    
    # Get nftables counters
    success, output = run_command(["nft", "list", "chain", "inet", "pinpoint", "prerouting"])
    
    packets = 0
    bytes_count = 0
    if success:
        import re
        # Parse counter from output
        match = re.search(r'counter packets (\d+) bytes (\d+)', output)
        if match:
            packets = int(match.group(1))
            bytes_count = int(match.group(2))
    
    # Count sets
    success, output = run_command(["nft", "list", "set", "inet", "pinpoint", "tunnel_nets"])
    nets_count = output.count(',') + 1 if 'elements' in output else 0
    
    success, output = run_command(["nft", "list", "set", "inet", "pinpoint", "tunnel_ips"])
    ips_count = output.count(',') + 1 if 'elements' in output else 0
    
    # Get last update info
    status_file = DATA_DIR / "status.json"
    update_info = load_json(status_file)
    
    # VPN is truly active only if tun1 is up AND VPN outbound is configured
    vpn_active = tun_up and vpn_configured
    
    return {
        "status": "running" if vpn_active else ("vpn_disabled" if tun_up and not vpn_configured else "tunnel_down"),
        "tunnel_interface": "tun1",
        "tunnel_up": tun_up,
        "vpn_configured": vpn_configured,
        "vpn_active": vpn_active,
        "stats": {
            "packets_tunneled": packets,
            "bytes_tunneled": bytes_count,
            "static_networks": nets_count,
            "dynamic_ips": ips_count
        },
        "last_update": update_info.get("last_update"),
        "last_update_timestamp": update_info.get("last_update_timestamp"),
        "enabled_services": update_info.get("enabled_services", 0),
        "total_cidrs": update_info.get("total_cidrs", 0),
        "total_domains": update_info.get("total_domains", 0)
    }

@app.get("/api/services")
async def get_services():
    """Get all services with categories"""
    data = load_json(SERVICES_FILE)
    return {
        "services": data.get("services", []),
        "categories": data.get("categories", {})
    }

@app.get("/api/services/{service_id}")
async def get_service(service_id: str):
    """Get single service"""
    data = load_json(SERVICES_FILE)
    for service in data.get("services", []):
        if service["id"] == service_id:
            return service
    raise HTTPException(status_code=404, detail="Service not found")

@app.post("/api/services/{service_id}/toggle")
async def toggle_service(service_id: str, toggle: ServiceToggle):
    """Enable/disable a service"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            service["enabled"] = toggle.enabled
            save_json(SERVICES_FILE, data)
            
            # Apply changes
            run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "service_id": service_id, "enabled": toggle.enabled}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.post("/api/services/{service_id}/domain")
async def add_service_domain(service_id: str, item: ServiceDomainAdd):
    """Add custom domain to a service"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            if "custom_domains" not in service:
                service["custom_domains"] = []
            
            if item.domain not in service["custom_domains"]:
                service["custom_domains"].append(item.domain)
                save_json(SERVICES_FILE, data)
                
                # Apply changes if service is enabled
                if service.get("enabled"):
                    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "domain": item.domain}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.delete("/api/services/{service_id}/domain/{domain}")
async def delete_service_domain(service_id: str, domain: str):
    """Remove custom domain from a service"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            custom = service.get("custom_domains", [])
            if domain in custom:
                custom.remove(domain)
                save_json(SERVICES_FILE, data)
                
                if service.get("enabled"):
                    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "removed": domain}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.post("/api/services/{service_id}/ip")
async def add_service_ip(service_id: str, item: ServiceIpAdd):
    """Add custom IP/CIDR to a service"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            if "custom_ips" not in service:
                service["custom_ips"] = []
            
            if item.ip not in service["custom_ips"]:
                service["custom_ips"].append(item.ip)
                save_json(SERVICES_FILE, data)
                
                if service.get("enabled"):
                    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "ip": item.ip}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.delete("/api/services/{service_id}/ip/{ip}")
async def delete_service_ip(service_id: str, ip: str):
    """Remove custom IP/CIDR from a service"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            custom = service.get("custom_ips", [])
            # Handle CIDR notation in URL (replace _ with /)
            ip_clean = ip.replace("_", "/")
            if ip_clean in custom:
                custom.remove(ip_clean)
                save_json(SERVICES_FILE, data)
                
                if service.get("enabled"):
                    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "removed": ip_clean}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.post("/api/services/{service_id}/source")
async def add_service_source(service_id: str, item: ServiceSourceAdd):
    """Add source URL to a service"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            if "sources" not in service:
                service["sources"] = []
            
            # Check if URL already exists
            for src in service["sources"]:
                if src.get("url") == item.url:
                    return {"status": "exists", "url": item.url}
            
            service["sources"].append({"type": item.type, "url": item.url})
            save_json(SERVICES_FILE, data)
            
            if service.get("enabled"):
                run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "url": item.url}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.delete("/api/services/{service_id}/source")
async def delete_service_source(service_id: str, url: str):
    """Remove source URL from a service"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            sources = service.get("sources", [])
            service["sources"] = [s for s in sources if s.get("url") != url]
            save_json(SERVICES_FILE, data)
            
            if service.get("enabled"):
                run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "removed": url}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.post("/api/services/{service_id}/refresh")
async def refresh_service(service_id: str):
    """Refresh service lists from sources"""
    data = load_json(SERVICES_FILE)
    
    for service in data.get("services", []):
        if service["id"] == service_id:
            if not service.get("enabled"):
                raise HTTPException(status_code=400, detail="Service is disabled")
            
            # Run update
            success, output = run_command(
                ["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"],
                timeout=120
            )
            
            return {"status": "ok" if success else "error", "output": output}
    
    raise HTTPException(status_code=404, detail="Service not found")

@app.get("/api/domains")
async def get_domains():
    """Get custom domains"""
    data = load_json(DOMAINS_FILE)
    return data.get("domains", [])

@app.post("/api/domains")
async def add_domain(domain: DomainCreate):
    """Add custom domain"""
    data = load_json(DOMAINS_FILE)
    if "domains" not in data:
        data["domains"] = []
    
    # Check if domain already exists
    for d in data["domains"]:
        if isinstance(d, dict) and d.get("domain") == domain.domain:
            raise HTTPException(status_code=400, detail="Domain already exists")
        elif d == domain.domain:
            raise HTTPException(status_code=400, detail="Domain already exists")
    
    # Add new domain
    new_domain = {
        "id": len(data["domains"]) + 1,
        "domain": domain.domain,
        "description": domain.description,
        "enabled": True
    }
    data["domains"].append(new_domain)
    save_json(DOMAINS_FILE, data)
    
    # Apply changes
    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
    
    return new_domain

@app.delete("/api/domains/{domain_id}")
async def delete_domain(domain_id: int):
    """Delete custom domain"""
    data = load_json(DOMAINS_FILE)
    
    domains = data.get("domains", [])
    for i, d in enumerate(domains):
        if isinstance(d, dict) and d.get("id") == domain_id:
            del domains[i]
            save_json(DOMAINS_FILE, data)
            
            # Apply changes
            run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "deleted": domain_id}
    
    raise HTTPException(status_code=404, detail="Domain not found")

# Custom IPs API
@app.get("/api/custom-ips")
async def get_custom_ips():
    """Get custom IPs"""
    data = load_json(DOMAINS_FILE)
    return data.get("custom_ips", [])

@app.post("/api/custom-ips")
async def add_custom_ip(ip_data: dict):
    """Add custom IP"""
    data = load_json(DOMAINS_FILE)
    if "custom_ips" not in data:
        data["custom_ips"] = []
    
    ip = ip_data.get("ip", "").strip()
    description = ip_data.get("description", "").strip()
    
    if not ip:
        raise HTTPException(status_code=400, detail="IP is required")
    
    # Check if IP already exists
    for item in data["custom_ips"]:
        if isinstance(item, dict) and item.get("ip") == ip:
            raise HTTPException(status_code=400, detail="IP already exists")
    
    new_ip = {
        "id": len(data["custom_ips"]) + 1,
        "ip": ip,
        "description": description,
        "enabled": True
    }
    data["custom_ips"].append(new_ip)
    save_json(DOMAINS_FILE, data)
    
    # Apply changes
    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
    
    return new_ip

@app.delete("/api/custom-ips/{ip_id}")
async def delete_custom_ip(ip_id: int):
    """Delete custom IP"""
    data = load_json(DOMAINS_FILE)
    
    custom_ips = data.get("custom_ips", [])
    for i, item in enumerate(custom_ips):
        if isinstance(item, dict) and item.get("id") == ip_id:
            del custom_ips[i]
            save_json(DOMAINS_FILE, data)
            
            # Apply changes
            run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "deleted": ip_id}
    
    raise HTTPException(status_code=404, detail="IP not found")


# ============ Custom Services API ============

@app.get("/api/custom-services")
async def get_custom_services():
    """Get all custom services"""
    data = load_json(CUSTOM_SERVICES_FILE)
    return data.get("services", [])


@app.post("/api/custom-services")
async def create_custom_service(service: CustomServiceCreate):
    """Create a new custom service"""
    import uuid
    
    data = load_json(CUSTOM_SERVICES_FILE)
    if "services" not in data:
        data["services"] = []
    
    # Generate unique ID
    service_id = f"custom_{uuid.uuid4().hex[:8]}"
    
    new_service = {
        "id": service_id,
        "name": service.name,
        "description": service.description or "",
        "domains": service.domains or [],
        "ips": service.ips or [],
        "enabled": True,
        "is_custom": True
    }
    
    data["services"].append(new_service)
    save_json(CUSTOM_SERVICES_FILE, data)
    
    # Apply changes
    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
    
    return new_service


@app.get("/api/custom-services/{service_id}")
async def get_custom_service(service_id: str):
    """Get a specific custom service"""
    data = load_json(CUSTOM_SERVICES_FILE)
    
    for service in data.get("services", []):
        if service.get("id") == service_id:
            return service
    
    raise HTTPException(status_code=404, detail="Custom service not found")


@app.put("/api/custom-services/{service_id}")
async def update_custom_service(service_id: str, update: CustomServiceUpdate):
    """Update a custom service"""
    data = load_json(CUSTOM_SERVICES_FILE)
    
    for i, service in enumerate(data.get("services", [])):
        if service.get("id") == service_id:
            if update.name is not None:
                service["name"] = update.name
            if update.description is not None:
                service["description"] = update.description
            if update.domains is not None:
                service["domains"] = update.domains
            if update.ips is not None:
                service["ips"] = update.ips
            if update.enabled is not None:
                service["enabled"] = update.enabled
            
            data["services"][i] = service
            save_json(CUSTOM_SERVICES_FILE, data)
            
            # Apply changes
            run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return service
    
    raise HTTPException(status_code=404, detail="Custom service not found")


@app.delete("/api/custom-services/{service_id}")
async def delete_custom_service(service_id: str):
    """Delete a custom service"""
    data = load_json(CUSTOM_SERVICES_FILE)
    
    services = data.get("services", [])
    for i, service in enumerate(services):
        if service.get("id") == service_id:
            del services[i]
            save_json(CUSTOM_SERVICES_FILE, data)
            
            # Apply changes
            run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "deleted": service_id}
    
    raise HTTPException(status_code=404, detail="Custom service not found")


@app.post("/api/custom-services/{service_id}/toggle")
async def toggle_custom_service(service_id: str):
    """Toggle custom service enabled state"""
    data = load_json(CUSTOM_SERVICES_FILE)
    
    for i, service in enumerate(data.get("services", [])):
        if service.get("id") == service_id:
            service["enabled"] = not service.get("enabled", True)
            data["services"][i] = service
            save_json(CUSTOM_SERVICES_FILE, data)
            
            # Apply changes
            run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
            
            return {"status": "ok", "enabled": service["enabled"]}
    
    raise HTTPException(status_code=404, detail="Custom service not found")


@app.post("/api/update")
async def update_lists():
    """Update all lists from sources"""
    success, output = run_command(
        ["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"],
        timeout=120
    )
    
    return {
        "status": "ok" if success else "error",
        "output": output
    }

@app.get("/api/settings/auto-update")
async def get_auto_update_time():
    """Get auto-update time from cron"""
    import re
    try:
        with open("/etc/crontabs/root", "r") as f:
            content = f.read()
        
        # Find pinpoint cron line
        match = re.search(r'^(\d+)\s+(\d+)\s+\*\s+\*\s+\*\s+.*pinpoint-update\.py', content, re.MULTILINE)
        if match:
            minute = int(match.group(1))
            hour = int(match.group(2))
            return {"time": f"{hour:02d}:{minute:02d}", "enabled": True}
        
        return {"time": "05:00", "enabled": False}
    except:
        return {"time": "05:00", "enabled": False}

@app.post("/api/settings/auto-update")
async def set_auto_update_time(data: dict):
    """Set auto-update time in cron"""
    import re
    time_str = data.get("time", "05:00")
    
    try:
        hour, minute = map(int, time_str.split(":"))
        
        with open("/etc/crontabs/root", "r") as f:
            content = f.read()
        
        # Replace existing pinpoint cron line
        new_line = f"{minute} {hour} * * * /usr/bin/python3 /opt/pinpoint/scripts/pinpoint-update.py update >/dev/null 2>&1"
        
        if "pinpoint-update.py" in content:
            content = re.sub(
                r'^\d+\s+\d+\s+\*\s+\*\s+\*\s+.*pinpoint-update\.py.*$',
                new_line,
                content,
                flags=re.MULTILINE
            )
        else:
            content += f"\n{new_line}\n"
        
        with open("/etc/crontabs/root", "w") as f:
            f.write(content)
        
        # Restart cron
        run_command(["/etc/init.d/cron", "restart"])
        
        return {"status": "ok", "time": f"{hour:02d}:{minute:02d}"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/test")
async def test_domain(test: DomainTest):
    """Test if domain would be routed through tunnel"""
    domain = test.domain
    
    # Resolve domain
    try:
        ips = socket.gethostbyname_ex(domain)[2]
    except socket.gaierror:
        return {
            "domain": domain,
            "resolved": False,
            "error": "Could not resolve domain"
        }
    
    # Check if any IP is in the tunnel sets
    in_tunnel = False
    matched_ip = None
    
    for ip in ips:
        # Check nftables set
        success, output = run_command([
            "nft", "get", "element", "inet", "pinpoint", "tunnel_ips", 
            "{", ip, "}"
        ])
        if success:
            in_tunnel = True
            matched_ip = ip
            break
        
        # Also check tunnel_nets (harder to check for CIDR match)
        # For now, we'll use a simple approach
    
    return {
        "domain": domain,
        "resolved": True,
        "ips": ips,
        "routed_through_tunnel": in_tunnel,
        "matched_ip": matched_ip
    }

@app.get("/api/stats")
async def get_stats():
    """Get traffic statistics"""
    # Get nftables counters
    success, output = run_command(["nft", "list", "chain", "inet", "pinpoint", "prerouting"])
    
    stats = {
        "dns_resolved": {"packets": 0, "bytes": 0},
        "static_lists": {"packets": 0, "bytes": 0}
    }
    
    if success:
        import re
        # Parse counters - tunnel_ips = DNS resolved, tunnel_nets = static lists
        for line in output.split('\n'):
            if '@tunnel_ips' in line or 'tunnel_ips' in line:
                match = re.search(r'counter packets (\d+) bytes (\d+)', line)
                if match:
                    stats["dns_resolved"]["packets"] = int(match.group(1))
                    stats["dns_resolved"]["bytes"] = int(match.group(2))
            elif '@tunnel_nets' in line or 'tunnel_nets' in line:
                match = re.search(r'counter packets (\d+) bytes (\d+)', line)
                if match:
                    stats["static_lists"]["packets"] = int(match.group(1))
                    stats["static_lists"]["bytes"] = int(match.group(2))
    
    stats["total"] = {
        "packets": stats["dns_resolved"]["packets"] + stats["static_lists"]["packets"],
        "bytes": stats["dns_resolved"]["bytes"] + stats["static_lists"]["bytes"]
    }
    
    return stats

# ============ Service Control ============
@app.get("/api/service/status")
async def get_service_status():
    """Get status of PinPoint and sing-box services"""
    result = {
        "pinpoint": {"running": False, "pid": None},
        "singbox": {"running": False, "pid": None}
    }
    
    # Check PinPoint (Python/uvicorn process)
    success, output = run_command(["pgrep", "-f", "uvicorn.*main:app"])
    if success and output.strip():
        result["pinpoint"]["running"] = True
        result["pinpoint"]["pid"] = int(output.strip().split()[0])
    
    # Check sing-box
    success, output = run_command(["pgrep", "-f", "sing-box"])
    if success and output.strip():
        result["singbox"]["running"] = True
        result["singbox"]["pid"] = int(output.strip().split()[0])
    
    return result

@app.post("/api/service/start")
async def start_services():
    """Start PinPoint and sing-box services"""
    results = {"pinpoint": False, "singbox": False}
    
    # Start sing-box first
    success, _ = run_command(["/etc/init.d/sing-box", "start"])
    results["singbox"] = success
    
    # PinPoint should already be running (we're responding to this request)
    results["pinpoint"] = True
    
    return {"status": "ok", "results": results}

@app.post("/api/service/stop")
async def stop_services():
    """Stop sing-box service (PinPoint will keep running)"""
    results = {"singbox": False}
    
    # Stop sing-box
    success, _ = run_command(["/etc/init.d/sing-box", "stop"])
    results["singbox"] = success
    
    return {"status": "ok", "results": results, "note": "PinPoint keeps running to serve UI"}

@app.post("/api/service/restart")
async def restart_services():
    """Restart sing-box and routing"""
    results = {"singbox": False, "routing": False}
    
    # Restart sing-box
    success, _ = run_command(["/etc/init.d/sing-box", "restart"])
    results["singbox"] = success
    
    # Re-apply routing
    import time
    time.sleep(2)
    success, _ = run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
    results["routing"] = success
    
    return {"status": "ok", "results": results}

@app.get("/api/service/logs")
async def get_service_logs(type: str = "pinpoint", lines: int = 100):
    """Get service logs"""
    logs = ""
    
    if type == "pinpoint":
        # PinPoint logs
        log_file = Path("/var/log/pinpoint.log")
        if log_file.exists():
            try:
                with open(log_file, 'r') as f:
                    all_lines = f.readlines()
                    logs = ''.join(all_lines[-lines:])
            except:
                logs = "Ошибка чтения логов"
        else:
            # Try logread
            success, output = run_command(["logread", "-e", "pinpoint"])
            if success:
                lines_list = output.strip().split('\n')
                logs = '\n'.join(lines_list[-lines:])
    
    elif type == "singbox":
        # sing-box logs
        log_file = Path("/var/log/sing-box.log")
        if log_file.exists():
            try:
                with open(log_file, 'r') as f:
                    all_lines = f.readlines()
                    logs = ''.join(all_lines[-lines:])
            except:
                logs = "Ошибка чтения логов"
        else:
            success, output = run_command(["logread", "-e", "sing-box"])
            if success:
                lines_list = output.strip().split('\n')
                logs = '\n'.join(lines_list[-lines:])
    
    elif type == "system":
        # General system logs
        success, output = run_command(["logread"])
        if success:
            lines_list = output.strip().split('\n')
            logs = '\n'.join(lines_list[-lines:])
    
    # Strip ANSI color codes
    import re
    logs = re.sub(r'\x1b\[[0-9;]*m', '', logs)
    
    return {"logs": logs, "type": type}

@app.get("/api/logs")
async def get_logs(limit: int = 100):
    """Get recent DNS query logs"""
    # Read dnsmasq log (if query logging is enabled)
    log_file = Path("/tmp/dnsmasq.log")
    
    if not log_file.exists():
        # Try system log
        success, output = run_command(["logread", "-l", str(limit)])
        if success:
            # Filter for dnsmasq entries
            lines = [l for l in output.split('\n') if 'dnsmasq' in l.lower()]
            return {"source": "syslog", "logs": lines[-limit:]}
    else:
        with open(log_file) as f:
            lines = f.readlines()[-limit:]
            return {"source": "dnsmasq.log", "logs": [l.strip() for l in lines]}
    
    return {"source": "none", "logs": []}

@app.get("/api/lists")
async def get_lists():
    """Get downloaded list files"""
    lists = []
    
    if LISTS_DIR.exists():
        for f in sorted(LISTS_DIR.glob("*.txt")):
            with open(f) as file:
                count = sum(1 for _ in file)
            lists.append({
                "name": f.name,
                "entries": count,
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime
            })
    
    return lists

# ============ Device Management API ============

@app.get("/api/devices")
async def get_devices():
    """Get all devices with routing rules"""
    data = load_json(DEVICES_FILE)
    return {
        "devices": data.get("devices", []),
        "modes": data.get("modes", {})
    }

@app.get("/api/devices/{device_id}")
async def get_device(device_id: str):
    """Get single device"""
    data = load_json(DEVICES_FILE)
    for device in data.get("devices", []):
        if device["id"] == device_id:
            return device
    raise HTTPException(status_code=404, detail="Device not found")

@app.post("/api/devices")
async def create_device(device: DeviceCreate):
    """Create new device"""
    data = load_json(DEVICES_FILE)
    if "devices" not in data:
        data["devices"] = []
    
    # Generate unique ID
    import re
    device_id = re.sub(r'[^a-z0-9]', '_', device.name.lower())
    base_id = device_id
    counter = 1
    existing_ids = [d["id"] for d in data["devices"]]
    while device_id in existing_ids:
        device_id = f"{base_id}_{counter}"
        counter += 1
    
    new_device = {
        "id": device_id,
        "name": device.name,
        "ip": device.ip,
        "mac": device.mac,
        "mode": device.mode,
        "services": device.services,
        "custom_domains": device.custom_domains,
        "custom_ips": device.custom_ips,
        "enabled": True
    }
    
    data["devices"].append(new_device)
    save_json(DEVICES_FILE, data)
    
    # Apply routing rules
    apply_device_routing()
    
    return new_device

@app.put("/api/devices/{device_id}")
async def update_device(device_id: str, update: DeviceUpdate):
    """Update device settings"""
    data = load_json(DEVICES_FILE)
    
    for device in data.get("devices", []):
        if device["id"] == device_id:
            if update.name is not None:
                device["name"] = update.name
            if update.ip is not None:
                device["ip"] = update.ip
            if update.mac is not None:
                device["mac"] = update.mac
            if update.mode is not None:
                device["mode"] = update.mode
            if update.services is not None:
                device["services"] = update.services
            if update.custom_domains is not None:
                device["custom_domains"] = update.custom_domains
            if update.custom_ips is not None:
                device["custom_ips"] = update.custom_ips
            if update.enabled is not None:
                device["enabled"] = update.enabled
            
            save_json(DEVICES_FILE, data)
            apply_device_routing()
            
            return device
    
    raise HTTPException(status_code=404, detail="Device not found")

@app.delete("/api/devices/{device_id}")
async def delete_device(device_id: str):
    """Delete device"""
    data = load_json(DEVICES_FILE)
    
    devices = data.get("devices", [])
    for i, device in enumerate(devices):
        if device["id"] == device_id:
            del devices[i]
            save_json(DEVICES_FILE, data)
            apply_device_routing()
            return {"status": "ok", "deleted": device_id}
    
    raise HTTPException(status_code=404, detail="Device not found")

@app.post("/api/devices/{device_id}/services/{service_id}")
async def add_device_service(device_id: str, service_id: str):
    """Add service to device custom list"""
    data = load_json(DEVICES_FILE)
    
    for device in data.get("devices", []):
        if device["id"] == device_id:
            if "services" not in device:
                device["services"] = []
            if service_id not in device["services"]:
                device["services"].append(service_id)
                save_json(DEVICES_FILE, data)
                apply_device_routing()
            return {"status": "ok", "services": device["services"]}
    
    raise HTTPException(status_code=404, detail="Device not found")

@app.delete("/api/devices/{device_id}/services/{service_id}")
async def remove_device_service(device_id: str, service_id: str):
    """Remove service from device custom list"""
    data = load_json(DEVICES_FILE)
    
    for device in data.get("devices", []):
        if device["id"] == device_id:
            if service_id in device.get("services", []):
                device["services"].remove(service_id)
                save_json(DEVICES_FILE, data)
                apply_device_routing()
            return {"status": "ok", "services": device.get("services", [])}
    
    raise HTTPException(status_code=404, detail="Device not found")

def apply_device_routing():
    """Apply device-specific routing rules via nftables"""
    run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])

@app.get("/api/network/hosts")
async def get_network_hosts():
    """Get list of devices from OpenWRT (DHCP leases + ARP)"""
    hosts = {}
    
    # Parse DHCP leases file
    dhcp_file = Path("/tmp/dhcp.leases")
    if dhcp_file.exists():
        with open(dhcp_file) as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 4:
                    # Format: timestamp mac ip hostname clientid
                    mac = parts[1].upper()
                    ip = parts[2]
                    hostname = parts[3] if parts[3] != '*' else ''
                    
                    hosts[ip] = {
                        "ip": ip,
                        "mac": mac,
                        "hostname": hostname,
                        "source": "dhcp"
                    }
    
    # Parse ARP table for additional devices
    arp_file = Path("/proc/net/arp")
    if arp_file.exists():
        with open(arp_file) as f:
            for line in f:
                if line.startswith("IP"):
                    continue  # Skip header
                parts = line.split()
                if len(parts) >= 4:
                    ip = parts[0]
                    mac = parts[3].upper()
                    
                    # Skip incomplete entries and localhost
                    if mac == "00:00:00:00:00:00" or ip.startswith("127."):
                        continue
                    
                    if ip not in hosts:
                        hosts[ip] = {
                            "ip": ip,
                            "mac": mac,
                            "hostname": "",
                            "source": "arp"
                        }
                    elif not hosts[ip].get("mac"):
                        hosts[ip]["mac"] = mac
    
    # Try to get hostnames from /etc/ethers or /etc/hosts
    ethers_file = Path("/etc/ethers")
    if ethers_file.exists():
        with open(ethers_file) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 2:
                    mac = parts[0].upper()
                    name = parts[1]
                    # Find host by MAC and add name
                    for ip, host in hosts.items():
                        if host.get("mac") == mac and not host.get("hostname"):
                            host["hostname"] = name
    
    # Check which hosts are already configured as devices
    devices_data = load_json(DEVICES_FILE)
    configured_ips = {d["ip"] for d in devices_data.get("devices", [])}
    
    result = []
    for ip, host in sorted(hosts.items(), key=lambda x: [int(p) for p in x[0].split('.')]):
        host["configured"] = ip in configured_ips
        result.append(host)
    
    return {"hosts": result, "count": len(result)}

@app.post("/api/devices/import/{ip}")
async def import_device(ip: str):
    """Import device from network hosts"""
    # Get host info
    hosts_data = await get_network_hosts()
    host = None
    for h in hosts_data["hosts"]:
        if h["ip"] == ip:
            host = h
            break
    
    if not host:
        raise HTTPException(status_code=404, detail="Host not found")
    
    if host.get("configured"):
        raise HTTPException(status_code=400, detail="Device already configured")
    
    # Create device
    data = load_json(DEVICES_FILE)
    if "devices" not in data:
        data["devices"] = []
    
    # Generate name
    name = host.get("hostname") or f"Device {ip.split('.')[-1]}"
    
    # Generate unique ID
    import re
    device_id = re.sub(r'[^a-z0-9]', '_', name.lower())
    base_id = device_id
    counter = 1
    existing_ids = [d["id"] for d in data["devices"]]
    while device_id in existing_ids:
        device_id = f"{base_id}_{counter}"
        counter += 1
    
    new_device = {
        "id": device_id,
        "name": name,
        "ip": ip,
        "mac": host.get("mac", ""),
        "mode": "default",
        "services": [],
        "enabled": False
    }
    
    data["devices"].append(new_device)
    save_json(DEVICES_FILE, data)
    
    return new_device

# ============ Statistics Database (SQLite) ============

class StatsDatabase:
    """SQLite-based statistics storage for traffic and system metrics.
    
    Tables:
    - traffic_minutes: raw traffic data, 30 days retention
    - system_minutes: raw CPU/RAM data, 30 days retention  
    - traffic_hours: hourly traffic aggregates, 90 days retention
    - system_hours: hourly system aggregates, 90 days retention
    - traffic_days: daily traffic aggregates, 1 year retention
    - system_days: daily system aggregates, 1 year retention
    """
    _instance = None
    _conn = None
    _last_traffic_bytes = 0
    _last_hour_ts = 0
    _last_day_ts = 0
    
    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
            cls._instance._init_db()
        return cls._instance
    
    def _get_conn(self):
        """Get database connection (create if needed)"""
        if self._conn is None:
            self._conn = sqlite3.connect(str(STATS_DB_FILE), check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
        return self._conn
    
    def _init_db(self):
        """Initialize database schema"""
        conn = self._get_conn()
        
        # Traffic stats tables
        conn.execute('''
            CREATE TABLE IF NOT EXISTS traffic_minutes (
                timestamp INTEGER PRIMARY KEY,
                total_bytes INTEGER,
                delta_bytes INTEGER,
                total_packets INTEGER,
                delta_packets INTEGER
            )
        ''')
        
        conn.execute('''
            CREATE TABLE IF NOT EXISTS traffic_hours (
                timestamp INTEGER PRIMARY KEY,
                delta_bytes INTEGER,
                samples INTEGER
            )
        ''')
        
        conn.execute('''
            CREATE TABLE IF NOT EXISTS traffic_days (
                timestamp INTEGER PRIMARY KEY,
                delta_bytes INTEGER,
                samples INTEGER
            )
        ''')
        
        # System stats tables
        conn.execute('''
            CREATE TABLE IF NOT EXISTS system_minutes (
                timestamp INTEGER PRIMARY KEY,
                cpu INTEGER,
                ram REAL,
                pinpoint_cpu REAL,
                pinpoint_ram REAL
            )
        ''')
        
        conn.execute('''
            CREATE TABLE IF NOT EXISTS system_hours (
                timestamp INTEGER PRIMARY KEY,
                cpu_avg REAL,
                ram_avg REAL,
                cpu_max INTEGER,
                ram_max REAL,
                samples INTEGER
            )
        ''')
        
        conn.execute('''
            CREATE TABLE IF NOT EXISTS system_days (
                timestamp INTEGER PRIMARY KEY,
                cpu_avg REAL,
                ram_avg REAL,
                cpu_max INTEGER,
                ram_max REAL,
                samples INTEGER
            )
        ''')
        
        # Create indexes for faster queries
        conn.execute('CREATE INDEX IF NOT EXISTS idx_traffic_min_ts ON traffic_minutes(timestamp)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_traffic_hour_ts ON traffic_hours(timestamp)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_traffic_day_ts ON traffic_days(timestamp)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_system_min_ts ON system_minutes(timestamp)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_system_hour_ts ON system_hours(timestamp)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_system_day_ts ON system_days(timestamp)')
        
        conn.commit()
        
        # Get last known total bytes for delta calculation
        row = conn.execute('SELECT total_bytes FROM traffic_minutes ORDER BY timestamp DESC LIMIT 1').fetchone()
        if row:
            self._last_traffic_bytes = row['total_bytes']
        
        # Get last aggregation timestamps
        row = conn.execute('SELECT MAX(timestamp) as ts FROM traffic_hours').fetchone()
        self._last_hour_ts = row['ts'] or 0
        row = conn.execute('SELECT MAX(timestamp) as ts FROM traffic_days').fetchone()
        self._last_day_ts = row['ts'] or 0
        
        # Cleanup old data on startup
        self._cleanup_old_data()
    
    def _cleanup_old_data(self):
        """Remove data older than retention period"""
        conn = self._get_conn()
        now = int(time.time())
        
        # Minutes: 30 days
        cutoff_30d = now - (30 * 24 * 3600)
        conn.execute('DELETE FROM traffic_minutes WHERE timestamp < ?', (cutoff_30d,))
        conn.execute('DELETE FROM system_minutes WHERE timestamp < ?', (cutoff_30d,))
        
        # Hours: 90 days
        cutoff_90d = now - (90 * 24 * 3600)
        conn.execute('DELETE FROM traffic_hours WHERE timestamp < ?', (cutoff_90d,))
        conn.execute('DELETE FROM system_hours WHERE timestamp < ?', (cutoff_90d,))
        
        # Days: 1 year
        cutoff_1y = now - (365 * 24 * 3600)
        conn.execute('DELETE FROM traffic_days WHERE timestamp < ?', (cutoff_1y,))
        conn.execute('DELETE FROM system_days WHERE timestamp < ?', (cutoff_1y,))
        
        conn.commit()
    
    def collect_traffic(self):
        """Collect traffic stats from nftables"""
        success, output = run_command(["nft", "list", "chain", "inet", "pinpoint", "prerouting"])
        
        now = int(time.time())
        dns_bytes = 0
        static_bytes = 0
        dns_packets = 0
        static_packets = 0
        
        if success:
            for line in output.split('\n'):
                match = re.search(r'counter packets (\d+) bytes (\d+)', line)
                if match:
                    packets = int(match.group(1))
                    bytes_count = int(match.group(2))
                    # tunnel_ips = DNS resolved IPs, tunnel_nets = static IP lists
                    if '@tunnel_ips' in line or 'tunnel_ips' in line:
                        dns_packets = packets
                        dns_bytes = bytes_count
                    elif '@tunnel_nets' in line or 'tunnel_nets' in line:
                        static_packets = packets
                        static_bytes = bytes_count
        
        total_bytes = dns_bytes + static_bytes
        total_packets = dns_packets + static_packets
        
        # Calculate delta
        delta_bytes = max(0, total_bytes - self._last_traffic_bytes) if self._last_traffic_bytes > 0 else 0
        delta_packets = 0  # Not tracking packet deltas in DB
        self._last_traffic_bytes = total_bytes
        
        # Insert into database
        conn = self._get_conn()
        try:
            conn.execute('''
                INSERT OR REPLACE INTO traffic_minutes 
                (timestamp, total_bytes, delta_bytes, total_packets, delta_packets)
                VALUES (?, ?, ?, ?, ?)
            ''', (now, total_bytes, delta_bytes, total_packets, delta_packets))
            conn.commit()
        except:
            pass
        
        # Check for hourly/daily aggregation
        current_hour = now // 3600 * 3600
        if current_hour > self._last_hour_ts:
            self._aggregate_traffic_hour(current_hour)
            self._last_hour_ts = current_hour
        
        current_day = now // 86400 * 86400
        if current_day > self._last_day_ts:
            self._aggregate_traffic_day(current_day)
            self._last_day_ts = current_day
        
        return {"timestamp": now, "total_bytes": total_bytes, "delta_bytes": delta_bytes}
    
    def collect_system(self, cpu: int, ram: float, pinpoint_cpu: float, pinpoint_ram: float):
        """Store system stats"""
        now = int(time.time())
        conn = self._get_conn()
        
        try:
            conn.execute('''
                INSERT OR REPLACE INTO system_minutes 
                (timestamp, cpu, ram, pinpoint_cpu, pinpoint_ram)
                VALUES (?, ?, ?, ?, ?)
            ''', (now, cpu, ram, pinpoint_cpu, pinpoint_ram))
            conn.commit()
        except:
            pass
        
        return {"timestamp": now, "cpu": cpu, "ram": ram}
    
    def _aggregate_traffic_hour(self, hour_ts):
        """Aggregate minute data into hourly"""
        conn = self._get_conn()
        hour_start = hour_ts - 3600
        
        row = conn.execute('''
            SELECT SUM(delta_bytes) as total_delta, COUNT(*) as samples
            FROM traffic_minutes 
            WHERE timestamp >= ? AND timestamp < ?
        ''', (hour_start, hour_ts)).fetchone()
        
        if row and row['samples'] > 0:
            conn.execute('''
                INSERT OR REPLACE INTO traffic_hours (timestamp, delta_bytes, samples)
                VALUES (?, ?, ?)
            ''', (hour_ts, row['total_delta'] or 0, row['samples']))
            conn.commit()
    
    def _aggregate_traffic_day(self, day_ts):
        """Aggregate hourly data into daily"""
        conn = self._get_conn()
        day_start = day_ts - 86400
        
        row = conn.execute('''
            SELECT SUM(delta_bytes) as total_delta, COUNT(*) as samples
            FROM traffic_hours
            WHERE timestamp >= ? AND timestamp < ?
        ''', (day_start, day_ts)).fetchone()
        
        if row and row['samples'] > 0:
            conn.execute('''
                INSERT OR REPLACE INTO traffic_days (timestamp, delta_bytes, samples)
                VALUES (?, ?, ?)
            ''', (day_ts, row['total_delta'] or 0, row['samples']))
            conn.commit()
    
    def get_traffic_history(self, minutes: int = 60):
        """Get traffic history for specified period"""
        conn = self._get_conn()
        now = int(time.time())
        cutoff = now - (minutes * 60)
        
        # Up to 24 hours: minute data
        if minutes <= 24 * 60:
            rows = conn.execute('''
                SELECT timestamp, delta_bytes, total_bytes
                FROM traffic_minutes
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
            ''', (cutoff,)).fetchall()
            return [dict(r) for r in rows]
        
        # Up to 7 days: try hourly data first
        if minutes <= 7 * 24 * 60:
            rows = conn.execute('''
                SELECT timestamp, delta_bytes
                FROM traffic_hours
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
            ''', (cutoff,)).fetchall()
            # If not enough hourly data, aggregate from minutes
            if len(rows) < 5:
                rows = conn.execute('''
                    SELECT (timestamp / 3600) * 3600 as timestamp,
                           SUM(delta_bytes) as delta_bytes,
                           MAX(total_bytes) as total_bytes
                    FROM traffic_minutes
                    WHERE timestamp >= ?
                    GROUP BY timestamp
                    ORDER BY timestamp ASC
                ''', (cutoff,)).fetchall()
            return [dict(r) for r in rows]
        
        # Longer: try daily data, fallback to aggregated hourly
        rows = conn.execute('''
            SELECT timestamp, delta_bytes
            FROM traffic_days
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        ''', (cutoff,)).fetchall()
        # If not enough daily data, aggregate from hours or minutes
        if len(rows) < 3:
            # Try aggregating from minutes by day
            rows = conn.execute('''
                SELECT (timestamp / 86400) * 86400 as timestamp,
                       SUM(delta_bytes) as delta_bytes,
                       MAX(total_bytes) as total_bytes
                FROM traffic_minutes
                WHERE timestamp >= ?
                GROUP BY timestamp
                ORDER BY timestamp ASC
            ''', (cutoff,)).fetchall()
        return [dict(r) for r in rows]
    
    def get_system_history(self, minutes: int = 60):
        """Get system stats history"""
        conn = self._get_conn()
        now = int(time.time())
        cutoff = now - (minutes * 60)
        
        # Up to 24 hours: minute data
        if minutes <= 24 * 60:
            rows = conn.execute('''
                SELECT timestamp, cpu, ram, pinpoint_cpu, pinpoint_ram
                FROM system_minutes
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
            ''', (cutoff,)).fetchall()
            return [dict(r) for r in rows]
        
        # Up to 7 days: hourly data (aggregate on the fly if not stored)
        if minutes <= 7 * 24 * 60:
            rows = conn.execute('''
                SELECT timestamp, cpu_avg as cpu, ram_avg as ram
                FROM system_hours
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
            ''', (cutoff,)).fetchall()
            if rows:
                return [dict(r) for r in rows]
            # Fallback to minute data with sampling
            rows = conn.execute('''
                SELECT timestamp, cpu, ram
                FROM system_minutes
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
            ''', (cutoff,)).fetchall()
            return [dict(r) for r in rows]
        
        # Longer: daily data
        rows = conn.execute('''
            SELECT timestamp, cpu_avg as cpu, ram_avg as ram
            FROM system_days
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        ''', (cutoff,)).fetchall()
        return [dict(r) for r in rows]
    
    def get_stats_info(self):
        """Get database statistics"""
        conn = self._get_conn()
        
        traffic_min = conn.execute('SELECT COUNT(*) as c, MIN(timestamp) as oldest FROM traffic_minutes').fetchone()
        traffic_hour = conn.execute('SELECT COUNT(*) as c, MIN(timestamp) as oldest FROM traffic_hours').fetchone()
        traffic_day = conn.execute('SELECT COUNT(*) as c, MIN(timestamp) as oldest FROM traffic_days').fetchone()
        system_min = conn.execute('SELECT COUNT(*) as c, MIN(timestamp) as oldest FROM system_minutes').fetchone()
        
        return {
            "traffic_minutes": traffic_min['c'],
            "traffic_hours": traffic_hour['c'],
            "traffic_days": traffic_day['c'],
            "system_minutes": system_min['c'],
            "oldest_traffic": traffic_min['oldest'],
            "oldest_system": system_min['oldest']
        }


# Wrapper classes for backward compatibility
class TrafficStats:
    """Traffic statistics wrapper using SQLite database"""
    _instance = None
    
    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    def load_history(self):
        pass  # DB handles this
    
    def save_history(self):
        pass  # DB handles this
    
    def collect(self):
        return StatsDatabase.get_instance().collect_traffic()
    
    def get_history(self, minutes: int = 60):
        return StatsDatabase.get_instance().get_traffic_history(minutes)
    
    def get_stats_info(self):
        info = StatsDatabase.get_instance().get_stats_info()
        return {
            "minutes_stored": info["traffic_minutes"],
            "hours_stored": info["traffic_hours"],
            "days_stored": info["traffic_days"],
            "oldest_minute": info["oldest_traffic"],
            "oldest_hour": None,
            "oldest_day": None
        }


class SystemStats:
    """System statistics wrapper using SQLite database"""
    _instance = None
    
    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    def load_history(self):
        pass  # DB handles this
    
    def save_history(self):
        pass  # DB handles this
    
    def collect(self):
        """Collect current CPU/RAM stats and store in DB"""
        cpu = 0
        ram = 0.0
        pinpoint_cpu = 0.0
        pinpoint_ram = 0.0
        
        # Get CPU from top
        try:
            success, top_out = run_command(["top", "-b", "-n", "1"], timeout=3)
            if success:
                for line in top_out.split('\n'):
                    if line.startswith('CPU:') and 'idle' in line:
                        parts = line.split()
                        for i, part in enumerate(parts):
                            if part == 'idle' and i > 0:
                                idle_pct = int(parts[i-1].replace('%', ''))
                                cpu = 100 - idle_pct
                                break
                        break
                # Get sing-box CPU
                for line in top_out.split('\n'):
                    if 'sing-box' in line:
                        parts = line.split()
                        if len(parts) >= 7:
                            try:
                                pinpoint_cpu = float(parts[6].replace('%', ''))
                            except:
                                pass
                        break
        except:
            pass
        
        # Get RAM usage
        meminfo = {}
        try:
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2:
                        meminfo[parts[0].rstrip(':')] = int(parts[1]) * 1024
            
            total = meminfo.get('MemTotal', 0)
            free = meminfo.get('MemFree', 0)
            buffers = meminfo.get('Buffers', 0)
            cached = meminfo.get('Cached', 0)
            used = total - free - buffers - cached
            
            if total > 0:
                ram = round(used / total * 100, 1)
        except:
            pass
        
        # Get Pinpoint RAM
        try:
            success, output = run_command(["pgrep", "-f", "sing-box"])
            if success and output.strip():
                pid = output.strip().split()[0]
                with open(f'/proc/{pid}/status', 'r') as f:
                    for line in f:
                        if line.startswith('VmRSS:'):
                            ram_kb = int(line.split()[1])
                            total = meminfo.get('MemTotal', 0)
                            if total > 0:
                                pinpoint_ram = round(ram_kb * 1024 / total * 100, 1)
                            break
        except:
            pass
        
        # Store in database
        result = StatsDatabase.get_instance().collect_system(cpu, ram, pinpoint_cpu, pinpoint_ram)
        
        return {
            "timestamp": result["timestamp"],
            "cpu": cpu,
            "ram": ram,
            "pinpoint_cpu": pinpoint_cpu,
            "pinpoint_ram": pinpoint_ram
        }
    
    def get_history(self, minutes: int = 60):
        return StatsDatabase.get_instance().get_system_history(minutes)


@app.get("/api/system/history")
async def get_system_history(minutes: int = 60):
    """Get system stats history (CPU/RAM) for specified period"""
    stats = SystemStats.get_instance()
    history = stats.get_history(minutes)
    return {
        "history": history,
        "count": len(history)
    }


@app.get("/api/system/collect-now")
async def collect_system_now():
    """Manually trigger system stats collection (debug)"""
    try:
        stats = SystemStats.get_instance()
        result = stats.collect()
        db_info = StatsDatabase.get_instance().get_stats_info()
        return {"status": "ok", "collected": result, "db_stats": db_info}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.get("/api/traffic/history")
async def get_traffic_history(minutes: int = 60):
    """Get traffic history for specified period"""
    stats = TrafficStats.get_instance()
    history = stats.get_history(minutes)
    info = stats.get_stats_info()
    return {
        "history": history, 
        "count": len(history),
        "storage_info": info
    }

@app.get("/api/traffic/stats-info")
async def get_traffic_stats_info():
    """Get info about stored traffic statistics"""
    return StatsDatabase.get_instance().get_stats_info()

@app.get("/api/traffic/current")
async def get_traffic_current():
    """Get current traffic snapshot"""
    stats = TrafficStats.get_instance()
    current = stats.collect()
    return current

@app.get("/api/traffic/by-service")
async def get_traffic_by_service():
    """Get traffic breakdown by service (estimated from nftables)"""
    # This requires per-service counters - simplified version
    services_data = load_json(SERVICES_FILE)
    enabled_services = [s for s in services_data.get("services", []) if s.get("enabled")]
    
    result = []
    for service in enabled_services:
        # Read list file to count CIDRs
        list_file = LISTS_DIR / f"{service['id']}.txt"
        cidr_count = 0
        if list_file.exists():
            with open(list_file) as f:
                cidr_count = sum(1 for _ in f)
        
        result.append({
            "id": service["id"],
            "name": service["name"],
            "cidrs": cidr_count,
            "domains": len(service.get("domains", []))
        })
    
    return {"services": result}

@app.get("/api/traffic/by-device")
async def get_traffic_by_device():
    """Get VPN traffic per device from conntrack"""
    device_stats = {}
    
    # Read directly from /proc/net/nf_conntrack
    # VPN traffic is identified by reply dst being 10.0.0.x (tunnel IP)
    try:
        with open('/proc/net/nf_conntrack', 'r') as f:
            for line in f:
                # Check if this connection goes through VPN tunnel
                # VPN connections have reply destination = 10.0.0.x (tunnel IP)
                if 'dst=10.0.0.' not in line:
                    continue  # Skip non-VPN traffic
                
                # Parse conntrack line for source IP (LAN device)
                src_match = re.search(r'src=(\d+\.\d+\.\d+\.\d+)', line)
                if src_match:
                    ip = src_match.group(1)
                    if ip.startswith("192.168."):
                        if ip not in device_stats:
                            device_stats[ip] = {"connections": 0, "bytes": 0}
                        device_stats[ip]["connections"] += 1
                        
                        # Get bytes - conntrack has two bytes values, sum them
                        bytes_matches = re.findall(r'bytes=(\d+)', line)
                        for b in bytes_matches:
                            device_stats[ip]["bytes"] += int(b)
    except:
        pass
    
    # Enrich with device names from DHCP leases
    device_map = {}
    
    # Load configured devices
    devices_data = load_json(DEVICES_FILE)
    for d in devices_data.get("devices", []):
        device_map[d["ip"]] = d.get("name", d["ip"])
    
    # Also try to get names from DHCP leases
    try:
        with open('/tmp/dhcp.leases', 'r') as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 4:
                    ip = parts[2]
                    name = parts[3] if parts[3] != '*' else None
                    if ip not in device_map and name:
                        device_map[ip] = name
    except:
        pass
    
    result = []
    for ip, stats in sorted(device_stats.items(), key=lambda x: x[1]["bytes"], reverse=True):
        result.append({
            "ip": ip,
            "name": device_map.get(ip, ip),
            "connections": stats["connections"],
            "bytes": stats["bytes"]
        })
    
    return {"devices": result[:20]}  # Top 20

# ============ Connection History API ============

@app.get("/api/connections")
async def get_connections(limit: int = 100):
    """Get active connections through tunnel"""
    connections = []
    
    # Read directly from /proc/net/nf_conntrack
    try:
        with open('/proc/net/nf_conntrack', 'r') as f:
            for line in f:
                if not line.strip():
                    continue
                
                # Parse connection - format: ipv4 2 tcp 6 ... src=x dst=y ...
                parts = line.split()
                if len(parts) < 4:
                    continue
                
                proto = parts[2]  # tcp, udp
                
                src_match = re.search(r'src=(\d+\.\d+\.\d+\.\d+)', line)
                dst_match = re.search(r'dst=(\d+\.\d+\.\d+\.\d+)', line)
                dport_match = re.search(r'dport=(\d+)', line)
                
                if src_match and dst_match:
                    src_ip = src_match.group(1)
                    dst_ip = dst_match.group(1)
                    
                    # Only show LAN -> external connections (through tunnel)
                    # Filter: src is LAN, dst is not LAN/localhost
                    if src_ip.startswith("192.168.") and not dst_ip.startswith(("192.168.", "127.", "10.0.0.")):
                        connections.append({
                            "proto": proto.upper(),
                            "src": src_ip,
                            "dst": dst_ip,
                            "dport": dport_match.group(1) if dport_match else None,
                            "timestamp": int(time.time())
                        })
    except:
        pass
    
    return {"connections": connections[:limit], "total": len(connections)}

# ============ Service Test API ============

@app.post("/api/services/{service_id}/test")
async def test_service(service_id: str):
    """Test if service is accessible through tunnel"""
    data = load_json(SERVICES_FILE)
    
    service = None
    for s in data.get("services", []):
        if s["id"] == service_id:
            service = s
            break
    
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    
    # Get first domain to test
    domains = service.get("domains", [])
    if not domains:
        return {"status": "error", "message": "No domains configured"}
    
    test_domain = domains[0]
    
    # Test DNS resolution
    try:
        ips = socket.gethostbyname_ex(test_domain)[2]
    except socket.gaierror:
        return {
            "service_id": service_id,
            "domain": test_domain,
            "status": "dns_error",
            "message": "Could not resolve domain"
        }
    
    # Test connectivity through tunnel
    success, output = run_command([
        "curl", "-sI", "--max-time", "5", 
        "--interface", "tun1", 
        f"https://{test_domain}"
    ], timeout=10)
    
    http_status = None
    if success:
        match = re.search(r'HTTP/\d+(?:\.\d+)?\s+(\d+)', output)
        if match:
            http_status = int(match.group(1))
    
    return {
        "service_id": service_id,
        "domain": test_domain,
        "ips": ips,
        "status": "ok" if http_status and http_status < 400 else "error",
        "http_status": http_status,
        "through_tunnel": True
    }

# ============ Ping/Latency API ============

@app.get("/api/ping/{target}")
async def ping_target(target: str, interface: str = "tun1"):
    """Measure latency to target"""
    # Sanitize target
    target = re.sub(r'[^a-zA-Z0-9.\-]', '', target)
    
    cmd = ["ping", "-c", "3", "-W", "2"]
    if interface:
        cmd.extend(["-I", interface])
    cmd.append(target)
    
    success, output = run_command(cmd, timeout=15)
    
    latency = None
    packet_loss = 100
    
    if success:
        # Parse avg latency
        match = re.search(r'min/avg/max.*=\s*[\d.]+/([\d.]+)/', output)
        if match:
            latency = float(match.group(1))
        
        # Parse packet loss
        loss_match = re.search(r'(\d+)% packet loss', output)
        if loss_match:
            packet_loss = int(loss_match.group(1))
    
    return {
        "target": target,
        "interface": interface,
        "latency_ms": latency,
        "packet_loss": packet_loss,
        "status": "ok" if latency else "unreachable"
    }

@app.get("/api/latency/services")
async def get_services_latency():
    """Get latency to all enabled services"""
    data = load_json(SERVICES_FILE)
    enabled = [s for s in data.get("services", []) if s.get("enabled")]
    
    results = []
    for service in enabled[:10]:  # Limit to 10 to avoid timeout
        domain = service.get("domains", [""])[0]
        if domain:
            try:
                # Quick ping
                success, output = run_command([
                    "ping", "-c", "1", "-W", "2", "-I", "tun1", domain
                ], timeout=5)
                
                latency = None
                if success:
                    match = re.search(r'time=([\d.]+)', output)
                    if match:
                        latency = float(match.group(1))
                
                results.append({
                    "id": service["id"],
                    "name": service["name"],
                    "domain": domain,
                    "latency_ms": latency,
                    "status": "ok" if latency else "timeout"
                })
            except:
                pass
    
    return {"services": results}

# ============ Healthcheck API ============

@app.get("/api/health")
async def get_health():
    """Get system health status"""
    health = {
        "timestamp": int(time.time()),
        "components": {}
    }
    
    # Check sing-box
    success, output = run_command(["pgrep", "-f", "sing-box"])
    health["components"]["sing_box"] = {
        "status": "running" if success else "stopped",
        "pid": output.strip() if success else None
    }
    
    # Check tun1 interface
    tun_up = Path("/sys/class/net/tun1").exists()
    health["components"]["tunnel"] = {
        "status": "up" if tun_up else "down",
        "interface": "tun1"
    }
    
    # Check DNS service (dnsmasq or alternative)
    # First try pgrep, then check if DNS resolution works
    success, output = run_command(["pgrep", "-f", "dnsmasq"])
    if not success:
        # Maybe it's running with different name, check if port 53 is listening
        success, output = run_command(["netstat", "-uln"])
        dns_listening = ":53 " in output or ":53\t" in output if success else False
        success = dns_listening
    
    health["components"]["dnsmasq"] = {
        "status": "running" if success else "stopped"
    }
    
    # Check nftables
    success, output = run_command(["nft", "list", "table", "inet", "pinpoint"])
    health["components"]["nftables"] = {
        "status": "ok" if success else "error"
    }
    
    # Check DNS resolution (test actual DNS functionality)
    dns_ok = False
    try:
        # Try to resolve via system DNS
        socket.setdefaulttimeout(3)
        socket.gethostbyname("ya.ru")
        dns_ok = True
    except:
        # Try nslookup as fallback
        success, output = run_command(["nslookup", "ya.ru"], timeout=5)
        dns_ok = success and "Address" in output
    
    health["components"]["dns"] = {"status": "ok" if dns_ok else "error"}
    
    # Check if VPN tunnel is actually configured (not just direct)
    vpn_configured = False
    try:
        config_path = Path("/etc/sing-box/config.json")
        if config_path.exists():
            import json as json_module
            config = json_module.loads(config_path.read_text())
            outbounds = config.get("outbounds", [])
            # Check for VPN outbounds (vless, vmess, trojan, shadowsocks, hysteria2)
            vpn_types = ["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "hysteria"]
            vpn_configured = any(
                ob.get("type") in vpn_types 
                for ob in outbounds
            )
    except Exception:
        pass
    
    # Check internet connectivity through tunnel
    vpn_ok = False
    vpn_ip = None
    
    if vpn_configured:
        # Try curl first
        success, output = run_command([
            "curl", "-s", "--max-time", "5", "--interface", "tun1",
            "http://ifconfig.me"
        ], timeout=8)
        
        if success and output.strip():
            # Validate it looks like an IP address
            ip_candidate = output.strip().split('\n')[0].strip()
            if re.match(r'^\d+\.\d+\.\d+\.\d+$', ip_candidate):
                vpn_ok = True
                vpn_ip = ip_candidate
        
        # Fallback: try ping through tunnel
        if not vpn_ok:
            success, output = run_command([
                "ping", "-c", "1", "-W", "3", "-I", "tun1", "8.8.8.8"
            ], timeout=5)
            if success and "1 received" in output:
                vpn_ok = True
                vpn_ip = "connectivity ok"
    
    health["components"]["internet_via_tunnel"] = {
        "status": "ok" if vpn_ok else ("disabled" if not vpn_configured else "error"),
        "ip": vpn_ip,
        "vpn_configured": vpn_configured
    }
    
    # Overall status (disabled is also acceptable - means VPN intentionally off)
    all_ok = all(
        c.get("status") in ["running", "up", "ok", "disabled"] 
        for c in health["components"].values()
    )
    health["overall"] = "healthy" if all_ok else "degraded"
    
    return health

# ============ Dependencies Management ============

# Define all required dependencies for PinPoint
DEPENDENCIES = {
    "sing-box": {
        "name": "sing-box",
        "description": "VPN клиент (proxy/tunnel)",
        "required": True,
        "check_cmd": ["which", "sing-box"],
        "check_file": "/usr/bin/sing-box",
        "install_cmd": "opkg update && opkg install sing-box",
        "remove_cmd": "opkg remove sing-box",
        "category": "vpn"
    },
    "nftables": {
        "name": "nftables",
        "description": "Firewall и маршрутизация",
        "required": True,
        "check_cmd": ["which", "nft"],
        "check_file": "/usr/sbin/nft",
        "install_cmd": "opkg update && opkg install nftables",
        "remove_cmd": "opkg remove nftables",
        "category": "network"
    },
    "kmod-tun": {
        "name": "kmod-tun",
        "description": "Модуль ядра TUN/TAP",
        "required": True,
        "check_cmd": ["ls", "/dev/net/tun"],
        "check_file": "/dev/net/tun",
        "install_cmd": "opkg update && opkg install kmod-tun",
        "remove_cmd": "opkg remove kmod-tun",
        "category": "kernel"
    },
    "python3": {
        "name": "python3",
        "description": "Python 3 интерпретатор",
        "required": True,
        "check_cmd": ["which", "python3"],
        "check_file": "/usr/bin/python3",
        "install_cmd": "opkg update && opkg install python3",
        "remove_cmd": "opkg remove python3",
        "category": "runtime"
    },
    "python3-pip": {
        "name": "python3-pip",
        "description": "Менеджер пакетов Python",
        "required": False,
        "check_cmd": ["which", "pip3"],
        "check_file": "/usr/bin/pip3",
        "install_cmd": "opkg update && opkg install python3-pip",
        "remove_cmd": "opkg remove python3-pip",
        "category": "runtime"
    },
    "curl": {
        "name": "curl",
        "description": "HTTP клиент для проверок",
        "required": True,
        "check_cmd": ["which", "curl"],
        "check_file": "/usr/bin/curl",
        "install_cmd": "opkg update && opkg install curl",
        "remove_cmd": "opkg remove curl",
        "category": "tools"
    },
    "ca-certificates": {
        "name": "ca-certificates",
        "description": "SSL сертификаты",
        "required": True,
        "check_cmd": ["ls", "/etc/ssl/certs"],
        "check_file": "/etc/ssl/certs/ca-certificates.crt",
        "install_cmd": "opkg update && opkg install ca-certificates ca-bundle",
        "remove_cmd": "opkg remove ca-certificates ca-bundle",
        "category": "security"
    },
    "dnsmasq-full": {
        "name": "dnsmasq-full",
        "description": "DNS сервер с ipset поддержкой",
        "required": False,
        "check_cmd": ["which", "dnsmasq"],
        "check_file": "/usr/sbin/dnsmasq",
        "install_cmd": "opkg update && opkg remove dnsmasq && opkg install dnsmasq-full",
        "remove_cmd": "opkg remove dnsmasq-full && opkg install dnsmasq",
        "category": "dns"
    },
    "luci": {
        "name": "luci",
        "description": "Веб-интерфейс OpenWRT",
        "required": False,
        "check_cmd": ["ls", "/www/luci-static"],
        "check_file": "/www/luci-static",
        "install_cmd": "opkg update && opkg install luci",
        "remove_cmd": "",  # Don't allow removing luci
        "category": "ui"
    }
}

# Python packages required (installed via pip)
PYTHON_PACKAGES = {
    "fastapi": {
        "name": "fastapi",
        "description": "Web framework",
        "required": True,
        "import_name": "fastapi",
        "install_cmd": "pip3 install fastapi"
    },
    "uvicorn": {
        "name": "uvicorn",
        "description": "ASGI сервер",
        "required": True,
        "import_name": "uvicorn",
        "install_cmd": "pip3 install uvicorn"
    },
    "pyyaml": {
        "name": "PyYAML",
        "description": "YAML парсер (для Clash подписок)",
        "required": False,
        "import_name": "yaml",
        "install_cmd": "pip3 install pyyaml"
    }
}

def check_dependency(dep_id: str) -> dict:
    """Check if a single dependency is installed"""
    if dep_id not in DEPENDENCIES:
        return {"id": dep_id, "installed": False, "error": "Unknown dependency"}
    
    dep = DEPENDENCIES[dep_id]
    installed = False
    version = None
    
    # Check via file existence
    if "check_file" in dep:
        installed = Path(dep["check_file"]).exists()
    
    # If not found via file, try command
    if not installed and "check_cmd" in dep:
        success, output = run_command(dep["check_cmd"], timeout=5)
        installed = success
    
    # Try to get version
    if installed and dep_id == "sing-box":
        success, output = run_command(["sing-box", "version"], timeout=5)
        if success:
            match = re.search(r'version\s+([\d.]+)', output)
            if match:
                version = match.group(1)
    
    return {
        "id": dep_id,
        "name": dep["name"],
        "description": dep["description"],
        "category": dep["category"],
        "required": dep["required"],
        "installed": installed,
        "version": version
    }

def check_python_package(pkg_id: str) -> dict:
    """Check if a Python package is installed"""
    if pkg_id not in PYTHON_PACKAGES:
        return {"id": pkg_id, "installed": False, "error": "Unknown package"}
    
    pkg = PYTHON_PACKAGES[pkg_id]
    installed = False
    version = None
    
    # Use pip show to check if package is actually installed (not cached)
    success, output = run_command(["pip3", "show", pkg["name"]], timeout=10)
    if success and "Name:" in output:
        installed = True
        # Extract version from pip show output
        for line in output.split('\n'):
            if line.startswith('Version:'):
                version = line.split(':', 1)[1].strip()
                break
    
    return {
        "id": pkg_id,
        "name": pkg["name"],
        "description": pkg["description"],
        "required": pkg["required"],
        "installed": installed,
        "version": version,
        "type": "python"
    }

@app.get("/api/dependencies")
async def get_dependencies():
    """Get status of all dependencies"""
    result = {
        "system": [],
        "python": [],
        "summary": {
            "total": 0,
            "installed": 0,
            "missing_required": 0,
            "missing_optional": 0
        }
    }
    
    # Check system dependencies
    for dep_id in DEPENDENCIES:
        status = check_dependency(dep_id)
        result["system"].append(status)
        result["summary"]["total"] += 1
        if status["installed"]:
            result["summary"]["installed"] += 1
        elif status["required"]:
            result["summary"]["missing_required"] += 1
        else:
            result["summary"]["missing_optional"] += 1
    
    # Check Python packages
    for pkg_id in PYTHON_PACKAGES:
        status = check_python_package(pkg_id)
        result["python"].append(status)
        result["summary"]["total"] += 1
        if status["installed"]:
            result["summary"]["installed"] += 1
        elif status["required"]:
            result["summary"]["missing_required"] += 1
        else:
            result["summary"]["missing_optional"] += 1
    
    result["summary"]["ready"] = result["summary"]["missing_required"] == 0
    
    return result

@app.post("/api/dependencies/install/{dep_id}")
async def install_dependency(dep_id: str):
    """Install a specific dependency"""
    if dep_id in DEPENDENCIES:
        dep = DEPENDENCIES[dep_id]
        if not dep.get("install_cmd"):
            raise HTTPException(400, "This dependency cannot be installed automatically")
        
        # Run install command
        success, output = run_command(
            ["sh", "-c", dep["install_cmd"]], 
            timeout=120
        )
        
        # Verify installation
        status = check_dependency(dep_id)
        
        return {
            "success": status["installed"],
            "output": output,
            "status": status
        }
    
    elif dep_id in PYTHON_PACKAGES:
        pkg = PYTHON_PACKAGES[dep_id]
        
        # Run pip install
        success, output = run_command(
            ["sh", "-c", pkg["install_cmd"]], 
            timeout=120
        )
        
        # Verify installation
        status = check_python_package(dep_id)
        
        return {
            "success": status["installed"],
            "output": output,
            "status": status
        }
    
    else:
        raise HTTPException(404, f"Unknown dependency: {dep_id}")

@app.post("/api/dependencies/install-all")
async def install_all_dependencies():
    """Install all missing required dependencies"""
    results = []
    
    # First update opkg
    run_command(["opkg", "update"], timeout=60)
    
    # Install missing system dependencies
    for dep_id, dep in DEPENDENCIES.items():
        status = check_dependency(dep_id)
        if not status["installed"] and dep["required"]:
            if dep.get("install_cmd"):
                success, output = run_command(
                    ["sh", "-c", dep["install_cmd"]], 
                    timeout=120
                )
                new_status = check_dependency(dep_id)
                results.append({
                    "id": dep_id,
                    "success": new_status["installed"],
                    "output": output[:500] if output else ""
                })
    
    # Install missing Python packages
    for pkg_id, pkg in PYTHON_PACKAGES.items():
        status = check_python_package(pkg_id)
        if not status["installed"] and pkg["required"]:
            success, output = run_command(
                ["sh", "-c", pkg["install_cmd"]], 
                timeout=120
            )
            new_status = check_python_package(pkg_id)
            results.append({
                "id": pkg_id,
                "success": new_status["installed"],
                "output": output[:500] if output else ""
            })
    
    # Get final status
    final_status = await get_dependencies()
    
    return {
        "results": results,
        "summary": final_status["summary"]
    }

class RemoveRequest(BaseModel):
    force: bool = False

@app.post("/api/dependencies/remove/{dep_id}")
async def remove_dependency(dep_id: str, force: bool = False):
    """Remove a specific dependency (use with caution)"""
    
    # Check system dependencies
    if dep_id in DEPENDENCIES:
        dep = DEPENDENCIES[dep_id]
        
        if not dep.get("remove_cmd"):
            raise HTTPException(400, "This dependency cannot be removed")
        
        if dep["required"] and not force:
            raise HTTPException(400, "Cannot remove required dependency. Use force=true to override.")
        
        success, output = run_command(
            ["sh", "-c", dep["remove_cmd"]], 
            timeout=60
        )
        
        status = check_dependency(dep_id)
        
        return {
            "success": not status["installed"],
            "output": output,
            "status": status
        }
    
    # Check Python packages
    elif dep_id in PYTHON_PACKAGES:
        pkg = PYTHON_PACKAGES[dep_id]
        
        if pkg["required"] and not force:
            raise HTTPException(400, "Cannot remove required package. Use force=true to override.")
        
        success, output = run_command(
            ["pip3", "uninstall", "-y", pkg["name"]], 
            timeout=60
        )
        
        status = check_python_package(dep_id)
        
        return {
            "success": not status["installed"],
            "output": output,
            "status": status
        }
    
    else:
        raise HTTPException(404, f"Unknown dependency: {dep_id}")

@app.get("/api/dependencies/service-status")
async def get_service_status():
    """Check if PinPoint is installed as a service"""
    init_path = Path("/etc/init.d/pinpoint")
    
    installed = init_path.exists()
    enabled = False
    running = False
    
    if installed:
        # Check if enabled (has symlink in /etc/rc.d/)
        success, output = run_command(["ls", "/etc/rc.d/"], timeout=5)
        if success:
            enabled = "pinpoint" in output
        
        # Check if running
        success, output = run_command(["pgrep", "-f", "pinpoint/backend/main.py"], timeout=5)
        running = success and output.strip() != ""
    
    return {
        "installed": installed,
        "enabled": enabled,
        "running": running
    }

@app.post("/api/dependencies/setup-pinpoint")
async def setup_pinpoint_service():
    """Setup PinPoint as a system service (init.d)"""
    init_script = """#!/bin/sh /etc/rc.common

START=99
STOP=10

USE_PROCD=1
PROG=/usr/bin/python3
PINPOINT_DIR=/opt/pinpoint

start_service() {
    procd_open_instance
    procd_set_param command $PROG $PINPOINT_DIR/backend/main.py
    procd_set_param respawn
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_set_param pidfile /var/run/pinpoint.pid
    procd_close_instance
}
"""
    
    try:
        # Write init script
        init_path = Path("/etc/init.d/pinpoint")
        init_path.write_text(init_script)
        os.chmod(init_path, 0o755)
        
        # Enable service
        run_command(["/etc/init.d/pinpoint", "enable"])
        
        return {
            "success": True,
            "message": "PinPoint service installed and enabled"
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to setup service: {str(e)}")

@app.post("/api/dependencies/disable-pinpoint")
async def disable_pinpoint_service():
    """Disable and remove PinPoint service"""
    init_path = Path("/etc/init.d/pinpoint")
    
    try:
        if init_path.exists():
            # Disable service first
            run_command(["/etc/init.d/pinpoint", "disable"], timeout=10)
            # Remove init script
            init_path.unlink()
        
        return {
            "success": True,
            "message": "PinPoint service disabled and removed"
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to disable service: {str(e)}")

@app.get("/api/dependencies/opkg-info")
async def get_opkg_info():
    """Get OpenWRT package manager info"""
    result = {
        "arch": "",
        "feeds": [],
        "installed_count": 0
    }
    
    # Get architecture
    success, output = run_command(["opkg", "print-architecture"], timeout=10)
    if success:
        lines = output.strip().split('\n')
        for line in lines:
            if 'arch' in line:
                parts = line.split()
                if len(parts) >= 2:
                    result["arch"] = parts[1]
                    break
    
    # Get feeds
    success, output = run_command(["cat", "/etc/opkg/distfeeds.conf"], timeout=5)
    if success:
        for line in output.strip().split('\n'):
            if line.startswith('src/gz'):
                parts = line.split()
                if len(parts) >= 3:
                    result["feeds"].append({
                        "name": parts[1],
                        "url": parts[2]
                    })
    
    # Count installed packages
    success, output = run_command(["opkg", "list-installed"], timeout=30)
    if success:
        result["installed_count"] = len(output.strip().split('\n'))
    
    return result

@app.get("/api/system/resources")
async def get_system_resources():
    """Get system resource usage (CPU, RAM, Disk) for router and PinPoint"""
    resources = {
        "cpu_percent": 0,
        "ram_percent": 0,
        "ram_used": 0,
        "ram_total": 0,
        "disk_percent": 0,
        "disk_used": 0,
        "disk_total": 0,
        "uptime": "",
        # Pinpoint service stats
        "pinpoint_cpu": 0,
        "pinpoint_ram": 0,
        "pinpoint_ram_mb": 0,
        "pinpoint_connections": 0,
        "pinpoint_status": "stopped"
    }
    
    # Get CPU usage from top (instant reading)
    try:
        success, top_out = run_command(["top", "-b", "-n", "1"], timeout=3)
        if success:
            # Parse header line: CPU:   0% usr   1% sys   0% nic  98% idle   0% io   0% irq   0% sirq
            for line in top_out.split('\n'):
                if line.startswith('CPU:') and 'idle' in line:
                    # Extract idle percentage
                    parts = line.split()
                    for i, part in enumerate(parts):
                        if part == 'idle' and i > 0:
                            idle_pct = int(parts[i-1].replace('%', ''))
                            resources["cpu_percent"] = 100 - idle_pct
                            break
                    break
    except:
        pass
    
    # Get RAM usage from /proc/meminfo
    try:
        meminfo = {}
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    key = parts[0].rstrip(':')
                    value = int(parts[1]) * 1024  # Convert from KB to bytes
                    meminfo[key] = value
        
        total = meminfo.get('MemTotal', 0)
        free = meminfo.get('MemFree', 0)
        buffers = meminfo.get('Buffers', 0)
        cached = meminfo.get('Cached', 0)
        
        used = total - free - buffers - cached
        if total > 0:
            resources["ram_percent"] = round((used / total) * 100, 1)
            resources["ram_used"] = used
            resources["ram_total"] = total
    except:
        pass
    
    # Get disk usage
    try:
        success, output = run_command(["df", "/overlay"])
        if success:
            lines = output.strip().split('\n')
            if len(lines) >= 2:
                parts = lines[1].split()
                if len(parts) >= 5:
                    total = int(parts[1]) * 1024
                    used = int(parts[2]) * 1024
                    percent = int(parts[4].rstrip('%'))
                    resources["disk_percent"] = percent
                    resources["disk_used"] = used
                    resources["disk_total"] = total
    except:
        pass
    
    # Get uptime
    try:
        with open('/proc/uptime', 'r') as f:
            uptime_seconds = float(f.read().split()[0])
            days = int(uptime_seconds // 86400)
            hours = int((uptime_seconds % 86400) // 3600)
            minutes = int((uptime_seconds % 3600) // 60)
            
            if days > 0:
                resources["uptime"] = f"{days}д {hours}ч {minutes}м"
            elif hours > 0:
                resources["uptime"] = f"{hours}ч {minutes}м"
            else:
                resources["uptime"] = f"{minutes}м"
    except:
        resources["uptime"] = "—"
    
    # Get Pinpoint (sing-box) service stats
    try:
        # Find sing-box process
        success, output = run_command(["pgrep", "-f", "sing-box"])
        if success and output.strip():
            pid = output.strip().split()[0]
            resources["pinpoint_status"] = "active"
            
            # Get CPU from top (more accurate for instantaneous reading)
            try:
                success, top_out = run_command(["top", "-b", "-n", "1"], timeout=3)
                if success:
                    for line in top_out.split('\n'):
                        if 'sing-box' in line:
                            # Format: PID PPID USER STAT VSZ %VSZ %CPU COMMAND
                            parts = line.split()
                            if len(parts) >= 7:
                                try:
                                    cpu_pct = float(parts[6].replace('%', ''))
                                    resources["pinpoint_cpu"] = cpu_pct
                                except:
                                    pass
                            break
            except:
                pass
            
            # Get memory usage from /proc/[pid]/status
            try:
                with open(f'/proc/{pid}/status', 'r') as f:
                    for line in f:
                        if line.startswith('VmRSS:'):
                            ram_kb = int(line.split()[1])
                            resources["pinpoint_ram_mb"] = round(ram_kb / 1024, 1)
                            if resources["ram_total"] > 0:
                                resources["pinpoint_ram"] = round(ram_kb * 1024 / resources["ram_total"] * 100, 1)
                            break
            except:
                pass
            
            # Count VPN connections from conntrack
            try:
                with open('/proc/net/nf_conntrack', 'r') as f:
                    vpn_conns = sum(1 for line in f if 'dst=10.0.0.' in line)
                    resources["pinpoint_connections"] = vpn_conns
            except:
                pass
    except:
        pass
    
    return resources

# ============ Alerts API ============

class AlertManager:
    """Simple alert manager"""
    _alerts = []
    _max_alerts = 100
    
    @classmethod
    def add_alert(cls, level: str, message: str, component: str = None):
        alert = {
            "id": int(time.time() * 1000),
            "timestamp": int(time.time()),
            "level": level,  # info, warning, error, critical
            "message": message,
            "component": component,
            "acknowledged": False
        }
        cls._alerts.append(alert)
        if len(cls._alerts) > cls._max_alerts:
            cls._alerts = cls._alerts[-cls._max_alerts:]
        return alert
    
    @classmethod
    def get_alerts(cls, unacknowledged_only: bool = False):
        if unacknowledged_only:
            return [a for a in cls._alerts if not a["acknowledged"]]
        return cls._alerts
    
    @classmethod
    def acknowledge(cls, alert_id: int):
        for alert in cls._alerts:
            if alert["id"] == alert_id:
                alert["acknowledged"] = True
                return True
        return False

@app.get("/api/alerts")
async def get_alerts(unacknowledged: bool = False):
    """Get alerts"""
    alerts = AlertManager.get_alerts(unacknowledged)
    return {"alerts": alerts, "count": len(alerts)}

@app.post("/api/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: int):
    """Acknowledge an alert"""
    if AlertManager.acknowledge(alert_id):
        return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Alert not found")

@app.delete("/api/alerts")
async def clear_alerts():
    """Clear all alerts"""
    AlertManager._alerts = []
    return {"status": "ok"}

# ============ Import/Export API ============

@app.get("/api/config/export")
async def export_config():
    """Export full configuration"""
    config = {
        "version": "1.0",
        "exported_at": datetime.now().isoformat(),
        "services": load_json(SERVICES_FILE),
        "devices": load_json(DEVICES_FILE),
        "domains": load_json(DOMAINS_FILE),
        "settings": load_json(SETTINGS_FILE)
    }
    
    return Response(
        content=json.dumps(config, indent=2, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=pinpoint_config.json"}
    )

@app.post("/api/config/import")
async def import_config(config: dict):
    """Import configuration"""
    try:
        if "services" in config:
            save_json(SERVICES_FILE, config["services"])
        if "devices" in config:
            save_json(DEVICES_FILE, config["devices"])
        if "domains" in config:
            save_json(DOMAINS_FILE, config["domains"])
        if "settings" in config:
            save_json(SETTINGS_FILE, config["settings"])
        
        # Apply changes
        run_command(["python3", "/opt/pinpoint/scripts/pinpoint-update.py", "update"])
        
        return {"status": "ok", "message": "Configuration imported successfully"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ============ GeoIP Routing API ============

@app.get("/api/geoip/lookup/{ip}")
async def geoip_lookup(ip: str):
    """Lookup GeoIP for an IP address"""
    # Try using external service
    try:
        import urllib.request
        req = urllib.request.Request(
            f"http://ip-api.com/json/{ip}",
            headers={'User-Agent': 'PinPoint/1.0'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            return {
                "ip": ip,
                "country": data.get("country"),
                "country_code": data.get("countryCode"),
                "city": data.get("city"),
                "isp": data.get("isp"),
                "org": data.get("org")
            }
    except:
        return {"ip": ip, "error": "Lookup failed"}

@app.get("/api/geoip/connections")
async def get_connections_geoip():
    """Get connections with GeoIP data"""
    success, output = run_command(["conntrack", "-L"])
    
    destinations = {}
    if success:
        for line in output.split('\n'):
            dst_match = re.search(r'dst=(\d+\.\d+\.\d+\.\d+)', line)
            if dst_match:
                ip = dst_match.group(1)
                # Skip private IPs
                if not ip.startswith(("10.", "172.", "192.168.", "127.")):
                    destinations[ip] = destinations.get(ip, 0) + 1
    
    # Get top destinations
    top_ips = sorted(destinations.items(), key=lambda x: x[1], reverse=True)[:20]
    
    return {"destinations": [{"ip": ip, "count": count} for ip, count in top_ips]}

# ============ Ad Blocking API ============

ADBLOCK_FILE = DATA_DIR / "adblock.json"

@app.get("/api/adblock/status")
async def get_adblock_status():
    """Get ad blocking status"""
    data = load_json(ADBLOCK_FILE)
    return {
        "enabled": data.get("enabled", False),
        "lists": data.get("lists", []),
        "blocked_domains": data.get("blocked_count", 0),
        "last_update": data.get("last_update")
    }

@app.post("/api/adblock/toggle")
async def toggle_adblock(enabled: bool):
    """Enable/disable ad blocking"""
    data = load_json(ADBLOCK_FILE)
    data["enabled"] = enabled
    save_json(ADBLOCK_FILE, data)
    
    if enabled:
        # Apply adblock lists
        await update_adblock_lists()
    else:
        # Remove adblock from dnsmasq
        adblock_conf = Path("/tmp/dnsmasq.d/adblock.conf")
        if adblock_conf.exists():
            adblock_conf.unlink()
        run_command(["/etc/init.d/dnsmasq", "restart"])
    
    return {"status": "ok", "enabled": enabled}

@app.post("/api/adblock/update")
async def update_adblock_lists():
    """Update ad blocking lists"""
    import urllib.request
    
    data = load_json(ADBLOCK_FILE)
    if not data.get("enabled"):
        return {"status": "disabled"}
    
    # Default lists
    lists = data.get("lists", [
        {"name": "StevenBlack", "url": "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts", "enabled": True},
        {"name": "AdGuard DNS", "url": "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt", "enabled": True}
    ])
    
    blocked_domains = set()
    
    for lst in lists:
        if not lst.get("enabled"):
            continue
        try:
            req = urllib.request.Request(lst["url"], headers={'User-Agent': 'Pinpoint/1.0'})
            with urllib.request.urlopen(req, timeout=30) as response:
                content = response.read().decode('utf-8', errors='ignore')
                
                for line in content.split('\n'):
                    line = line.strip()
                    
                    # Skip empty lines and comments
                    if not line or line.startswith('#') or line.startswith('!') or line.startswith('['):
                        continue
                    
                    # Parse hosts format: 0.0.0.0 domain.com or 127.0.0.1 domain.com
                    if line.startswith(('0.0.0.0', '127.0.0.1')):
                        parts = line.split()
                        if len(parts) >= 2:
                            domain = parts[1].lower().strip()
                            # Validate domain format
                            if domain and domain != 'localhost' and '.' in domain:
                                if re.match(r'^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$', domain):
                                    blocked_domains.add(domain)
                    
                    # Parse AdGuard/uBlock format: ||domain.com^
                    elif line.startswith('||') and '^' in line:
                        domain = line[2:].split('^')[0].lower().strip()
                        if domain and '.' in domain and not domain.startswith('*'):
                            if re.match(r'^[a-z0-9]([a-z0-9\-\.]*[a-z0-9])?$', domain):
                                blocked_domains.add(domain)
        except:
            pass
    
    # Filter and validate domains before writing
    valid_domains = set()
    domain_pattern = re.compile(r'^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$')
    
    for domain in blocked_domains:
        domain = domain.lower().strip()
        # Skip invalid entries
        if not domain or len(domain) > 253:
            continue
        if domain.startswith(('.', '-', '_')) or domain.endswith(('.', '-', '_')):
            continue
        if ' ' in domain or '/' in domain or '!' in domain or '@' in domain:
            continue
        if not domain_pattern.match(domain):
            continue
        valid_domains.add(domain)
    
    # Write dnsmasq config
    adblock_conf = Path("/tmp/dnsmasq.d/adblock.conf")
    with open(adblock_conf, 'w') as f:
        f.write("# PinPoint Ad Blocking\n")
        for domain in sorted(valid_domains):
            f.write(f"address=/{domain}/0.0.0.0\n")
    
    # Update status
    data["blocked_count"] = len(valid_domains)
    data["last_update"] = datetime.now().isoformat()
    data["lists"] = lists
    save_json(ADBLOCK_FILE, data)
    
    # Restart dnsmasq
    run_command(["/etc/init.d/dnsmasq", "restart"])
    
    return {"status": "ok", "blocked_domains": len(valid_domains), "count": len(valid_domains)}

@app.get("/api/adblock/check")
async def check_adblock_domain(domain: str):
    """Check if a domain is blocked by adblock"""
    adblock_conf = Path("/tmp/dnsmasq.d/adblock.conf")
    
    if not adblock_conf.exists():
        return {"domain": domain, "blocked": False, "reason": "adblock_disabled"}
    
    # Check if domain is in the adblock file
    domain = domain.lower().strip()
    
    try:
        with open(adblock_conf, 'r') as f:
            for line in f:
                if f"address=/{domain}/" in line:
                    return {"domain": domain, "blocked": True}
                # Also check parent domains
                parts = domain.split('.')
                for i in range(len(parts) - 1):
                    parent = '.'.join(parts[i:])
                    if f"address=/{parent}/" in line:
                        return {"domain": domain, "blocked": True, "matched": parent}
    except:
        pass
    
    return {"domain": domain, "blocked": False}

@app.get("/api/adblock/test-random")
async def test_random_adblock():
    """Test a random domain from adblock list"""
    import random
    import socket
    
    adblock_conf = Path("/tmp/dnsmasq.d/adblock.conf")
    
    if not adblock_conf.exists():
        return {"error": "adblock_disabled", "message": "Блокировка отключена"}
    
    # Get random domains from the file
    domains = []
    try:
        with open(adblock_conf, 'r') as f:
            for line in f:
                if line.startswith('address=/') and '/0.0.0.0' in line:
                    # Extract domain: address=/domain.com/0.0.0.0
                    domain = line.split('/')[1]
                    if domain and '.' in domain:
                        domains.append(domain)
    except:
        return {"error": "read_error", "message": "Ошибка чтения списка"}
    
    if not domains:
        return {"error": "empty", "message": "Список пуст"}
    
    # Pick a random domain
    test_domain = random.choice(domains)
    
    # Try to resolve it - should return 0.0.0.0 if blocked
    try:
        result = socket.gethostbyname(test_domain)
        blocked = result == "0.0.0.0"
        return {
            "domain": test_domain,
            "blocked": blocked,
            "resolved_ip": result,
            "total_domains": len(domains)
        }
    except socket.gaierror:
        # NXDOMAIN or similar - also blocked
        return {
            "domain": test_domain,
            "blocked": True,
            "resolved_ip": None,
            "total_domains": len(domains)
        }
    except Exception as e:
        return {
            "domain": test_domain,
            "blocked": False,
            "error": str(e),
            "total_domains": len(domains)
        }

# ============ Split DNS API ============

SPLIT_DNS_FILE = DATA_DIR / "split_dns.json"

@app.get("/api/split-dns")
async def get_split_dns():
    """Get split DNS configuration"""
    data = load_json(SPLIT_DNS_FILE)
    return {
        "enabled": data.get("enabled", False),
        "rules": data.get("rules", [])
    }

@app.post("/api/split-dns")
async def set_split_dns(config: dict):
    """Set split DNS configuration"""
    save_json(SPLIT_DNS_FILE, config)
    
    # Apply to dnsmasq
    if config.get("enabled"):
        split_conf = Path("/tmp/dnsmasq.d/split-dns.conf")
        with open(split_conf, 'w') as f:
            f.write("# PinPoint Split DNS\n")
            for rule in config.get("rules", []):
                domain = rule.get("domain")
                server = rule.get("server")
                if domain and server:
                    f.write(f"server=/{domain}/{server}\n")
        
        run_command(["/etc/init.d/dnsmasq", "restart"])
    
    return {"status": "ok"}

# ============ Telegram Bot API ============

TELEGRAM_FILE = DATA_DIR / "telegram.json"

@app.get("/api/telegram/status")
async def get_telegram_status():
    """Get Telegram bot status"""
    data = load_json(TELEGRAM_FILE)
    return {
        "enabled": data.get("enabled", False),
        "bot_configured": bool(data.get("bot_token")),
        "chat_id": data.get("chat_id"),
        "notifications": data.get("notifications", {
            "tunnel_down": True,
            "service_error": True,
            "daily_report": False
        })
    }

@app.post("/api/telegram/configure")
async def configure_telegram(config: dict):
    """Configure Telegram bot"""
    data = load_json(TELEGRAM_FILE)
    
    if "bot_token" in config:
        data["bot_token"] = config["bot_token"]
    if "chat_id" in config:
        data["chat_id"] = config["chat_id"]
    if "enabled" in config:
        data["enabled"] = config["enabled"]
    if "notifications" in config:
        data["notifications"] = config["notifications"]
    
    save_json(TELEGRAM_FILE, data)
    return {"status": "ok"}

@app.post("/api/telegram/test")
async def test_telegram():
    """Send test message to Telegram"""
    data = load_json(TELEGRAM_FILE)
    
    token = data.get("bot_token")
    chat_id = data.get("chat_id")
    
    if not token or not chat_id:
        raise HTTPException(status_code=400, detail="Telegram not configured")
    
    try:
        import urllib.request
        message = "🎯 PinPoint: Test message - connection successful!"
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = json.dumps({"chat_id": chat_id, "text": message}).encode()
        req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
        
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode())
            if result.get("ok"):
                return {"status": "ok", "message": "Test message sent"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    raise HTTPException(status_code=500, detail="Failed to send message")

# ============ Theme Settings API ============

@app.get("/api/settings/theme")
async def get_theme():
    """Get UI theme setting"""
    data = load_json(SETTINGS_FILE)
    return {"theme": data.get("theme", "light")}

@app.post("/api/settings/theme")
async def set_theme(config: dict):
    """Set UI theme"""
    data = load_json(SETTINGS_FILE)
    data["theme"] = config.get("theme", "light")
    save_json(SETTINGS_FILE, data)
    return {"status": "ok", "theme": data["theme"]}

# ============ Manual Stats Collection Endpoint ============

@app.post("/api/traffic/collect")
async def collect_traffic_now():
    """Manually trigger traffic stats collection"""
    stats = TrafficStats.get_instance()
    current = stats.collect()
    stats.save_history()
    return {
        "status": "ok",
        "collected": current,
        "info": stats.get_stats_info()
    }

# ============ Background Tasks ============

_background_task_started = False

async def background_health_check():
    """Background task to check health and collect stats every minute"""
    global _background_task_started
    _background_task_started = True
    
    print("[pinpoint] Background task started", flush=True)
    
    # Initial collection
    try:
        stats = TrafficStats.get_instance()
        stats.collect()
        stats.save_history()
        
        # Also collect system stats initially
        sys_stats = SystemStats.get_instance()
        sys_stats.collect()
        sys_stats.save_history()
        
        print("[pinpoint] Initial stats collection done", flush=True)
    except Exception as e:
        print(f"[pinpoint] Initial collection error: {e}", flush=True)
    
    last_subscription_check = 0
    
    while True:
        await asyncio.sleep(60)  # Wait 60 seconds
        
        try:
            # Check tunnel
            if not Path("/sys/class/net/tun1").exists():
                AlertManager.add_alert("critical", "VPN tunnel is down!", "tunnel")
            
            # Check sing-box
            success, _ = run_command(["pgrep", "-f", "sing-box"])
            if not success:
                AlertManager.add_alert("critical", "sing-box process not running!", "sing_box")
            
            # Collect traffic stats (stored in SQLite)
            traffic_stats = TrafficStats.get_instance()
            traffic_stats.collect()
            
            # Collect system stats (stored in SQLite)
            try:
                system_stats = SystemStats.get_instance()
                system_stats.collect()
            except Exception as e:
                print(f"[pinpoint] SystemStats error: {e}", flush=True)
            
            # Auto-update subscriptions (check every 5 minutes to save resources)
            now = int(time.time())
            if now - last_subscription_check >= 300:  # 5 minutes
                last_subscription_check = now
                await auto_update_subscriptions()
            
        except Exception as e:
            print(f"[pinpoint] Background task error: {e}")

async def auto_update_subscriptions():
    """Check and update subscriptions that need auto-update"""
    try:
        subs = tunnel_mgr.load_subscriptions()
        now = int(time.time())
        updated_count = 0
        
        for sub in subs:
            # Skip if auto-update disabled
            if not sub.get("auto_update", False):
                continue
            
            # Check if update is due
            last_update = sub.get("last_update", 0)
            interval_hours = sub.get("update_interval", 24)
            interval_seconds = interval_hours * 3600
            
            if now - last_update < interval_seconds:
                continue
            
            # Time to update this subscription
            print(f"[pinpoint] Auto-updating subscription: {sub.get('name')}", flush=True)
            
            try:
                # Fetch subscription content
                import urllib.request
                req = urllib.request.Request(
                    sub["url"],
                    headers={"User-Agent": "PinPoint/1.1"}
                )
                with urllib.request.urlopen(req, timeout=30) as response:
                    content = response.read().decode('utf-8')
                
                # Parse new tunnels
                new_tunnels = tunnel_mgr.parse_subscription_content(
                    content, 
                    sub.get("format", "auto")
                )
                
                if not new_tunnels:
                    print(f"[pinpoint] No tunnels found in subscription: {sub.get('name')}", flush=True)
                    continue
                
                # Remove old tunnels from this subscription
                tunnels = tunnel_mgr.load_tunnels()
                tunnels = [t for t in tunnels if t.get("subscription_id") != sub["id"]]
                
                # Add new tunnels
                for t in new_tunnels:
                    t["source"] = "subscription"
                    t["subscription_id"] = sub["id"]
                tunnels.extend(new_tunnels)
                tunnel_mgr.save_tunnels(tunnels)
                
                # Update subscription metadata
                sub["last_update"] = now
                sub["tunnels_count"] = len(new_tunnels)
                
                updated_count += 1
                print(f"[pinpoint] Updated subscription: {sub.get('name')} ({len(new_tunnels)} tunnels)", flush=True)
                
            except Exception as e:
                print(f"[pinpoint] Failed to update subscription {sub.get('name')}: {e}", flush=True)
        
        # Save updated subscriptions metadata
        if updated_count > 0:
            tunnel_mgr.save_subscriptions(subs)
            print(f"[pinpoint] Auto-update complete: {updated_count} subscriptions updated", flush=True)
            
    except Exception as e:
        print(f"[pinpoint] Auto-update error: {e}", flush=True)

# Note: Background tasks are started in the lifespan handler above


# ============ Tunnel Management API ============

@app.get("/api/tunnels")
async def get_tunnels():
    """Get all tunnels"""
    tunnels = tunnel_mgr.load_tunnels()
    return {"tunnels": tunnels, "count": len(tunnels)}


@app.post("/api/tunnels")
async def create_tunnel(data: TunnelCreate):
    """Create a new tunnel manually"""
    tunnels = tunnel_mgr.load_tunnels()
    
    tunnel = {
        "id": tunnel_mgr.generate_id(),
        "name": data.name,
        "type": data.type,
        "enabled": True,
        "server": data.server,
        "port": data.port,
        "source": "manual",
        "subscription_id": None,
        "latency": None,
        "last_check": None,
        "settings": data.settings,
        "tls": data.tls,
        "transport": data.transport
    }
    
    tunnels.append(tunnel)
    tunnel_mgr.save_tunnels(tunnels)
    
    return {"status": "ok", "tunnel": tunnel}


@app.get("/api/tunnels/{tunnel_id}")
async def get_tunnel(tunnel_id: str):
    """Get tunnel by ID"""
    tunnels = tunnel_mgr.load_tunnels()
    
    for tunnel in tunnels:
        if tunnel["id"] == tunnel_id:
            return tunnel
    
    raise HTTPException(status_code=404, detail="Tunnel not found")


@app.put("/api/tunnels/{tunnel_id}")
async def update_tunnel(tunnel_id: str, data: TunnelUpdate):
    """Update tunnel"""
    tunnels = tunnel_mgr.load_tunnels()
    
    for i, tunnel in enumerate(tunnels):
        if tunnel["id"] == tunnel_id:
            if data.name is not None:
                tunnels[i]["name"] = data.name
            if data.enabled is not None:
                tunnels[i]["enabled"] = data.enabled
            if data.server is not None:
                tunnels[i]["server"] = data.server
            if data.port is not None:
                tunnels[i]["port"] = data.port
            if data.settings is not None:
                tunnels[i]["settings"] = data.settings
            if data.tls is not None:
                tunnels[i]["tls"] = data.tls
            if data.transport is not None:
                tunnels[i]["transport"] = data.transport
            
            tunnel_mgr.save_tunnels(tunnels)
            return {"status": "ok", "tunnel": tunnels[i]}
    
    raise HTTPException(status_code=404, detail="Tunnel not found")


@app.delete("/api/tunnels/{tunnel_id}")
async def delete_tunnel(tunnel_id: str):
    """Delete tunnel"""
    tunnels = tunnel_mgr.load_tunnels()
    
    tunnels = [t for t in tunnels if t["id"] != tunnel_id]
    tunnel_mgr.save_tunnels(tunnels)
    
    # Also remove from groups
    groups = tunnel_mgr.load_groups()
    for group in groups:
        if tunnel_id in group.get("tunnels", []):
            group["tunnels"].remove(tunnel_id)
    tunnel_mgr.save_groups(groups)
    
    return {"status": "ok"}


@app.post("/api/tunnels/{tunnel_id}/toggle")
async def toggle_tunnel(tunnel_id: str):
    """Toggle tunnel enabled state and regenerate config"""
    tunnels = tunnel_mgr.load_tunnels()
    
    for tunnel in tunnels:
        if tunnel["id"] == tunnel_id:
            tunnel["enabled"] = not tunnel.get("enabled", True)
            tunnel_mgr.save_tunnels(tunnels)
            
            # Regenerate and apply sing-box config
            try:
                groups = tunnel_mgr.load_groups()
                routing_rules = tunnel_mgr.load_routing_rules()
                settings = load_settings()
                active = settings.get("active_outbound", "direct")
                config = tunnel_mgr.generate_singbox_config(tunnels, groups, active, routing_rules)
                tunnel_mgr.apply_singbox_config(config)
            except Exception as e:
                print(f"Warning: Failed to apply config after toggle: {e}")
            
            return {"status": "ok", "enabled": tunnel["enabled"]}
    
    raise HTTPException(status_code=404, detail="Tunnel not found")


@app.post("/api/tunnels/{tunnel_id}/test")
async def test_tunnel(tunnel_id: str):
    """Test tunnel connection and measure latency"""
    tunnels = tunnel_mgr.load_tunnels()
    
    tunnel = None
    for t in tunnels:
        if t["id"] == tunnel_id:
            tunnel = t
            break
    
    if not tunnel:
        raise HTTPException(status_code=404, detail="Tunnel not found")
    
    # Simple TCP connection test
    import socket
    import time
    
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect((tunnel["server"], tunnel["port"]))
        sock.close()
        latency = int((time.time() - start) * 1000)
        
        # Update tunnel latency
        tunnel["latency"] = latency
        tunnel["last_check"] = int(time.time())
        tunnel_mgr.save_tunnels(tunnels)
        
        return {"status": "ok", "latency": latency, "reachable": True}
    except Exception as e:
        tunnel["latency"] = None
        tunnel["last_check"] = int(time.time())
        tunnel_mgr.save_tunnels(tunnels)
        return {"status": "error", "error": str(e), "reachable": False}


@app.post("/api/tunnels/import")
async def import_tunnel(data: TunnelImport):
    """Import tunnel from share link"""
    tunnel = tunnel_mgr.parse_share_link(data.link)
    
    if not tunnel:
        raise HTTPException(status_code=400, detail="Invalid or unsupported share link")
    
    tunnels = tunnel_mgr.load_tunnels()
    tunnels.append(tunnel)
    tunnel_mgr.save_tunnels(tunnels)
    
    return {"status": "ok", "tunnel": tunnel}


@app.post("/api/tunnels/import-batch")
async def import_tunnels_batch(links: List[str]):
    """Import multiple tunnels from share links"""
    tunnels = tunnel_mgr.load_tunnels()
    imported = []
    failed = []
    
    for link in links:
        tunnel = tunnel_mgr.parse_share_link(link.strip())
        if tunnel:
            tunnels.append(tunnel)
            imported.append(tunnel)
        else:
            failed.append(link[:50])
    
    if imported:
        tunnel_mgr.save_tunnels(tunnels)
    
    return {
        "status": "ok",
        "imported": len(imported),
        "failed": len(failed),
        "tunnels": imported
    }


# ============ Subscription API ============

@app.get("/api/subscriptions")
async def get_subscriptions():
    """Get all subscriptions"""
    subs = tunnel_mgr.load_subscriptions()
    return {"subscriptions": subs, "count": len(subs)}


@app.post("/api/subscriptions")
async def create_subscription(data: SubscriptionCreate):
    """Add a new subscription"""
    import urllib.request
    
    subs = tunnel_mgr.load_subscriptions()
    
    # Fetch subscription content
    try:
        req = urllib.request.Request(data.url, headers={'User-Agent': 'PinPoint/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read().decode('utf-8')
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch subscription: {e}")
    
    # Parse tunnels
    new_tunnels = tunnel_mgr.parse_subscription_content(content, data.format)
    
    if not new_tunnels:
        raise HTTPException(status_code=400, detail="No tunnels found in subscription")
    
    # Create subscription
    sub_id = tunnel_mgr.generate_id()
    subscription = {
        "id": sub_id,
        "name": data.name,
        "url": data.url,
        "format": data.format,
        "auto_update": data.auto_update,
        "update_interval": data.update_interval,
        "last_update": int(time.time()),
        "tunnels_count": len(new_tunnels)
    }
    
    # Mark tunnels with subscription ID
    for t in new_tunnels:
        t["source"] = "subscription"
        t["subscription_id"] = sub_id
    
    # Save
    subs.append(subscription)
    tunnel_mgr.save_subscriptions(subs)
    
    tunnels = tunnel_mgr.load_tunnels()
    tunnels.extend(new_tunnels)
    tunnel_mgr.save_tunnels(tunnels)
    
    return {
        "status": "ok",
        "subscription": subscription,
        "tunnels_added": len(new_tunnels)
    }


@app.post("/api/subscriptions/{sub_id}/update")
async def update_subscription_tunnels(sub_id: str):
    """Update subscription - fetch and sync tunnels"""
    import urllib.request
    
    subs = tunnel_mgr.load_subscriptions()
    
    sub = None
    for s in subs:
        if s["id"] == sub_id:
            sub = s
            break
    
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    
    # Fetch subscription content
    try:
        req = urllib.request.Request(sub["url"], headers={'User-Agent': 'PinPoint/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read().decode('utf-8')
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch subscription: {e}")
    
    # Parse tunnels
    new_tunnels = tunnel_mgr.parse_subscription_content(content, sub.get("format", "auto"))
    
    # Remove old tunnels from this subscription
    tunnels = tunnel_mgr.load_tunnels()
    tunnels = [t for t in tunnels if t.get("subscription_id") != sub_id]
    
    # Add new tunnels
    for t in new_tunnels:
        t["source"] = "subscription"
        t["subscription_id"] = sub_id
    tunnels.extend(new_tunnels)
    tunnel_mgr.save_tunnels(tunnels)
    
    # Update subscription metadata
    sub["last_update"] = int(time.time())
    sub["tunnels_count"] = len(new_tunnels)
    tunnel_mgr.save_subscriptions(subs)
    
    return {
        "status": "ok",
        "tunnels_updated": len(new_tunnels)
    }


@app.put("/api/subscriptions/{sub_id}")
async def update_subscription(sub_id: str, data: SubscriptionUpdate):
    """Update subscription settings"""
    subs = tunnel_mgr.load_subscriptions()
    
    for sub in subs:
        if sub["id"] == sub_id:
            if data.name is not None:
                sub["name"] = data.name
            if data.url is not None:
                sub["url"] = data.url
            if data.auto_update is not None:
                sub["auto_update"] = data.auto_update
            if data.update_interval is not None:
                sub["update_interval"] = data.update_interval
            
            tunnel_mgr.save_subscriptions(subs)
            return {"status": "ok", "subscription": sub}
    
    raise HTTPException(status_code=404, detail="Subscription not found")


@app.delete("/api/subscriptions/{sub_id}")
async def delete_subscription(sub_id: str):
    """Delete subscription and its tunnels"""
    subs = tunnel_mgr.load_subscriptions()
    subs = [s for s in subs if s["id"] != sub_id]
    tunnel_mgr.save_subscriptions(subs)
    
    # Remove tunnels from this subscription
    tunnels = tunnel_mgr.load_tunnels()
    tunnels = [t for t in tunnels if t.get("subscription_id") != sub_id]
    tunnel_mgr.save_tunnels(tunnels)
    
    return {"status": "ok"}


# ============ Tunnel Groups API ============

@app.get("/api/tunnel-groups")
async def get_tunnel_groups():
    """Get all tunnel groups"""
    groups = tunnel_mgr.load_groups()
    return {"groups": groups, "count": len(groups)}


@app.post("/api/tunnel-groups")
async def create_tunnel_group(data: TunnelGroupCreate):
    """Create a new tunnel group"""
    groups = tunnel_mgr.load_groups()
    
    group = {
        "id": tunnel_mgr.generate_id(),
        "name": data.name,
        "tag": f"group-{data.name.lower().replace(' ', '-')}",
        "type": data.type,
        "tunnels": data.tunnels,
        "interval": data.interval,
        "tolerance": data.tolerance
    }
    
    groups.append(group)
    tunnel_mgr.save_groups(groups)
    
    return {"status": "ok", "group": group}


@app.put("/api/tunnel-groups/{group_id}")
async def update_tunnel_group(group_id: str, data: TunnelGroupUpdate):
    """Update tunnel group"""
    groups = tunnel_mgr.load_groups()
    
    for group in groups:
        if group["id"] == group_id:
            if data.name is not None:
                group["name"] = data.name
                group["tag"] = f"group-{data.name.lower().replace(' ', '-')}"
            if data.tunnels is not None:
                group["tunnels"] = data.tunnels
            if data.interval is not None:
                group["interval"] = data.interval
            if data.tolerance is not None:
                group["tolerance"] = data.tolerance
            
            tunnel_mgr.save_groups(groups)
            return {"status": "ok", "group": group}
    
    raise HTTPException(status_code=404, detail="Group not found")


@app.delete("/api/tunnel-groups/{group_id}")
async def delete_tunnel_group(group_id: str):
    """Delete tunnel group"""
    groups = tunnel_mgr.load_groups()
    groups = [g for g in groups if g["id"] != group_id]
    tunnel_mgr.save_groups(groups)
    
    return {"status": "ok"}


# ============ Routing Rules API ============

@app.get("/api/routing-rules")
async def get_routing_rules():
    """Get all routing rules"""
    rules_data = tunnel_mgr.load_routing_rules()
    return rules_data


@app.post("/api/routing-rules")
async def create_routing_rule(data: RoutingRuleCreate):
    """Create a new routing rule"""
    rules_data = tunnel_mgr.load_routing_rules()
    
    rule = {
        "id": tunnel_mgr.generate_id(),
        "name": data.name,
        "outbound": data.outbound,
        "domains": data.domains,
        "domain_keywords": data.domain_keywords,
        "enabled": data.enabled
    }
    
    rules_data["rules"].append(rule)
    tunnel_mgr.save_routing_rules(rules_data)
    
    return {"status": "ok", "rule": rule}


@app.put("/api/routing-rules/{rule_id}")
async def update_routing_rule(rule_id: str, data: RoutingRuleUpdate):
    """Update a routing rule"""
    rules_data = tunnel_mgr.load_routing_rules()
    
    for i, rule in enumerate(rules_data["rules"]):
        if rule["id"] == rule_id:
            if data.name is not None:
                rules_data["rules"][i]["name"] = data.name
            if data.outbound is not None:
                rules_data["rules"][i]["outbound"] = data.outbound
            if data.domains is not None:
                rules_data["rules"][i]["domains"] = data.domains
            if data.domain_keywords is not None:
                rules_data["rules"][i]["domain_keywords"] = data.domain_keywords
            if data.enabled is not None:
                rules_data["rules"][i]["enabled"] = data.enabled
            
            tunnel_mgr.save_routing_rules(rules_data)
            return {"status": "ok", "rule": rules_data["rules"][i]}
    
    raise HTTPException(status_code=404, detail="Rule not found")


@app.delete("/api/routing-rules/{rule_id}")
async def delete_routing_rule(rule_id: str):
    """Delete a routing rule"""
    rules_data = tunnel_mgr.load_routing_rules()
    
    original_count = len(rules_data["rules"])
    rules_data["rules"] = [r for r in rules_data["rules"] if r["id"] != rule_id]
    
    if len(rules_data["rules"]) == original_count:
        raise HTTPException(status_code=404, detail="Rule not found")
    
    tunnel_mgr.save_routing_rules(rules_data)
    return {"status": "ok"}


@app.post("/api/routing-rules/{rule_id}/toggle")
async def toggle_routing_rule(rule_id: str):
    """Toggle routing rule enabled state"""
    rules_data = tunnel_mgr.load_routing_rules()
    
    for rule in rules_data["rules"]:
        if rule["id"] == rule_id:
            rule["enabled"] = not rule.get("enabled", True)
            tunnel_mgr.save_routing_rules(rules_data)
            return {"status": "ok", "enabled": rule["enabled"]}
    
    raise HTTPException(status_code=404, detail="Rule not found")


@app.post("/api/routing-rules/set-default")
async def set_default_outbound(data: RoutingDefaultSet):
    """Set the default outbound for unmatched traffic"""
    rules_data = tunnel_mgr.load_routing_rules()
    rules_data["default_outbound"] = data.default_outbound
    tunnel_mgr.save_routing_rules(rules_data)
    
    return {"status": "ok", "default_outbound": data.default_outbound}


class BatchRoutingRules(BaseModel):
    rules: List[Dict[str, Any]]

@app.post("/api/routing-rules/batch")
async def batch_update_routing_rules(data: BatchRoutingRules):
    """Replace all routing rules at once (for service-based routing)"""
    rules_data = tunnel_mgr.load_routing_rules()
    
    # Generate IDs for new rules
    new_rules = []
    for rule in data.rules:
        new_rule = {
            "id": rule.get("id") or tunnel_mgr.generate_id(),
            "name": rule.get("name", ""),
            "service_id": rule.get("service_id"),
            "outbound": rule.get("outbound", ""),
            "domains": rule.get("domains", []),
            "domain_keywords": rule.get("domain_keywords", []),
            "enabled": rule.get("enabled", True)
        }
        new_rules.append(new_rule)
    
    rules_data["rules"] = new_rules
    tunnel_mgr.save_routing_rules(rules_data)
    
    return {"status": "ok", "count": len(new_rules)}


@app.post("/api/routing-rules/reorder")
async def reorder_routing_rules(rule_ids: List[str]):
    """Reorder routing rules (first rule has highest priority)"""
    rules_data = tunnel_mgr.load_routing_rules()
    
    # Create a map of existing rules
    rules_map = {r["id"]: r for r in rules_data["rules"]}
    
    # Reorder based on provided IDs
    new_rules = []
    for rule_id in rule_ids:
        if rule_id in rules_map:
            new_rules.append(rules_map[rule_id])
    
    # Add any rules not in the provided list at the end
    for rule in rules_data["rules"]:
        if rule["id"] not in rule_ids:
            new_rules.append(rule)
    
    rules_data["rules"] = new_rules
    tunnel_mgr.save_routing_rules(rules_data)
    
    return {"status": "ok", "rules": new_rules}


# ============ Sing-box Config API ============

@app.get("/api/singbox/config")
async def get_singbox_config():
    """Get current sing-box configuration"""
    if tunnel_mgr.SINGBOX_CONFIG.exists():
        try:
            with open(tunnel_mgr.SINGBOX_CONFIG) as f:
                return json.load(f)
        except:
            pass
    return {}


@app.post("/api/singbox/generate")
async def generate_singbox_config():
    """Generate sing-box config from tunnels, groups, and routing rules"""
    tunnels = tunnel_mgr.load_tunnels()
    groups = tunnel_mgr.load_groups()
    routing_rules = tunnel_mgr.load_routing_rules()
    
    # Get active outbound from settings
    settings = load_json(SETTINGS_FILE)
    active = settings.get("active_outbound")
    
    config = tunnel_mgr.generate_singbox_config(tunnels, groups, active, routing_rules)
    
    return {"status": "ok", "config": config}


@app.post("/api/singbox/apply")
async def apply_singbox_config():
    """Generate and apply sing-box config"""
    tunnels = tunnel_mgr.load_tunnels()
    groups = tunnel_mgr.load_groups()
    routing_rules = tunnel_mgr.load_routing_rules()
    
    settings = load_json(SETTINGS_FILE)
    active = settings.get("active_outbound")
    
    config = tunnel_mgr.generate_singbox_config(tunnels, groups, active, routing_rules)
    success = tunnel_mgr.apply_singbox_config(config)
    
    if success:
        return {"status": "ok", "message": "Config applied and sing-box restarted"}
    else:
        raise HTTPException(status_code=500, detail="Failed to apply config")


@app.post("/api/singbox/set-active")
async def set_active_outbound(data: ActiveOutboundSet):
    """Set the active outbound for routing"""
    settings = load_json(SETTINGS_FILE)
    settings["active_outbound"] = data.outbound_tag
    save_json(SETTINGS_FILE, settings)
    
    return {"status": "ok", "active_outbound": data.outbound_tag}


@app.get("/api/singbox/outbounds")
async def get_available_outbounds():
    """Get list of available outbounds (tunnels and groups)"""
    tunnels = tunnel_mgr.load_tunnels()
    groups = tunnel_mgr.load_groups()
    
    outbounds = []
    
    # Add enabled tunnels
    for t in tunnels:
        if t.get("enabled"):
            outbounds.append({
                "tag": f"{t['type']}-{t['id']}",
                "name": t["name"],
                "type": "tunnel",
                "tunnel_type": t["type"],
                "server": t["server"],
                "latency": t.get("latency")
            })
    
    # Add groups
    for g in groups:
        outbounds.append({
            "tag": g.get("tag", f"group-{g['id']}"),
            "name": g["name"],
            "type": "group",
            "group_type": g["type"],
            "tunnels_count": len(g.get("tunnels", []))
        })
    
    # Get current active
    settings = load_json(SETTINGS_FILE)
    active = settings.get("active_outbound")
    
    return {
        "outbounds": outbounds,
        "active": active
    }


# Serve frontend
@app.get("/")
async def serve_index():
    """Serve frontend index.html"""
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"message": "PinPoint API", "docs": "/docs"}

@app.get("/login.html")
async def serve_login():
    """Serve login page"""
    login_path = FRONTEND_DIR / "login.html"
    if login_path.exists():
        return FileResponse(login_path)
    return RedirectResponse(url="/")

# Mount static files if frontend exists
if FRONTEND_DIR.exists():
    app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
    app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
    if (FRONTEND_DIR / "assets").exists():
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")

if __name__ == "__main__":
    import uvicorn
    
    # Load config
    config = load_json(CONFIG_FILE)
    api_config = config.get("api", {})
    
    host = api_config.get("host", "0.0.0.0")
    port = api_config.get("port", 8080)
    
    uvicorn.run(app, host=host, port=port)
