#!/usr/bin/env python3
"""
Pinpoint - List Downloader and Parser
Downloads IP lists from various sources and converts them to CIDR format
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

PINPOINT_DIR = Path("/opt/pinpoint")
DATA_DIR = PINPOINT_DIR / "data"
LISTS_DIR = DATA_DIR / "lists"
SERVICES_FILE = DATA_DIR / "services.json"
DEVICES_FILE = DATA_DIR / "devices.json"
# OpenWRT uses /tmp/dnsmasq.d/ for additional configs
DNSMASQ_CONF = Path("/tmp/dnsmasq.d/pinpoint.conf")
DEVICES_NFT = DATA_DIR / "devices.nft"

def log(msg):
    """Log message to syslog and stdout"""
    print(f"[pinpoint] {msg}")
    subprocess.run(["logger", "-t", "pinpoint", msg], capture_output=True)

def mask_to_cidr(mask):
    """Convert netmask to CIDR prefix length"""
    masks = {
        "255.255.255.255": 32, "255.255.255.254": 31, "255.255.255.252": 30,
        "255.255.255.248": 29, "255.255.255.240": 28, "255.255.255.224": 27,
        "255.255.255.192": 26, "255.255.255.128": 25, "255.255.255.0": 24,
        "255.255.254.0": 23, "255.255.252.0": 22, "255.255.248.0": 21,
        "255.255.240.0": 20, "255.255.224.0": 19, "255.255.192.0": 18,
        "255.255.128.0": 17, "255.255.0.0": 16, "255.254.0.0": 15,
        "255.252.0.0": 14, "255.248.0.0": 13, "255.240.0.0": 12,
        "255.224.0.0": 11, "255.192.0.0": 10, "255.128.0.0": 9, "255.0.0.0": 8,
    }
    return masks.get(mask, 32)

def download_file(url, timeout=60):
    """Download file from URL with timeout"""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Pinpoint/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read().decode('utf-8', errors='ignore')
    except urllib.error.URLError as e:
        log(f"Download failed: {url} - {e}")
        return None
    except Exception as e:
        log(f"Download error: {url} - {e}")
        return None

def parse_keenetic_format(content):
    """Parse Keenetic route format: route add IP mask NETMASK 0.0.0.0 (case-insensitive)"""
    cidrs = set()
    for line in content.split('\n'):
        line = line.strip()
        # Case-insensitive match for 'route add' or 'route ADD'
        if line.lower().startswith('route add'):
            parts = line.split()
            if len(parts) >= 5:
                ip = parts[2]
                mask = parts[4]
                cidr = mask_to_cidr(mask)
                cidrs.add(f"{ip}/{cidr}")
    return sorted(cidrs)

def parse_plain_ip(content):
    """Parse plain IP/CIDR list"""
    cidrs = set()
    ip_pattern = re.compile(r'^(\d+\.\d+\.\d+\.\d+)(/\d+)?$')
    for line in content.split('\n'):
        line = line.strip()
        if line and not line.startswith('#'):
            match = ip_pattern.match(line)
            if match:
                ip = match.group(1)
                prefix = match.group(2) or '/32'
                cidrs.add(f"{ip}{prefix}")
    return sorted(cidrs)

def parse_domains_list(content):
    """Parse plain domain list (one domain per line)"""
    domains = set()
    for line in content.split('\n'):
        line = line.strip()
        if line and not line.startswith('#'):
            # Remove any wildcards like *.domain.com -> domain.com
            if line.startswith('*.'):
                line = line[2:]
            if '.' in line and not line.startswith('.'):
                domains.add(line.lower())
    return sorted(domains)

def parse_content(content, format_type='auto'):
    """Auto-detect and parse content format"""
    if not content:
        return []
    
    # Handle domains type separately
    if format_type == 'domains':
        return parse_domains_list(content)
    
    # Auto-detect format
    if format_type == 'auto':
        if 'route add' in content:
            format_type = 'keenetic'
        else:
            format_type = 'ip'
    
    if format_type == 'keenetic':
        return parse_keenetic_format(content)
    elif format_type == 'plain':
        return parse_plain_ip(content)
    else:
        return parse_plain_ip(content)

def process_service(service):
    """Process a single service - download sources and extract domains/IPs"""
    service_id = service['id']
    enabled = service.get('enabled', False)
    
    if not enabled:
        log(f"Skipping disabled service: {service_id}")
        return
    
    log(f"Processing service: {service_id}")
    
    # Create lists directory
    LISTS_DIR.mkdir(parents=True, exist_ok=True)
    
    # Extract domains to file (including custom domains)
    domains = set(service.get('domains', []))
    custom_domains = set(service.get('custom_domains', []))
    all_domains = domains | custom_domains
    
    if all_domains:
        domains_file = LISTS_DIR / f"{service_id}_domains.txt"
        with open(domains_file, 'w') as f:
            for domain in sorted(all_domains):
                f.write(f"{domain}\n")
        log(f"  Saved {len(all_domains)} domains ({len(custom_domains)} custom)")
    
    # Extract static IP ranges (including custom IPs)
    ip_ranges = set(service.get('ip_ranges', []))
    custom_ips = set(service.get('custom_ips', []))
    all_static = ip_ranges | custom_ips
    
    if all_static:
        static_file = LISTS_DIR / f"{service_id}_static.txt"
        with open(static_file, 'w') as f:
            for ip in sorted(all_static):
                f.write(f"{ip}\n")
        log(f"  Saved {len(all_static)} static IPs ({len(custom_ips)} custom)")
    
    # Download and process external sources
    sources = service.get('sources', [])
    all_cidrs = set()
    extra_domains = set()
    
    for source in sources:
        url = source.get('url')
        source_type = source.get('type', 'auto')
        
        if not url:
            continue
        
        log(f"  Downloading: {url}")
        content = download_file(url)
        
        if content:
            if source_type == 'domains':
                # Parse as domain list and add to domains
                parsed_domains = parse_content(content, source_type)
                extra_domains.update(parsed_domains)
                log(f"  Parsed {len(parsed_domains)} domains from source")
            else:
                # Parse as IP/CIDR list
                cidrs = parse_content(content, source_type)
                all_cidrs.update(cidrs)
                log(f"  Parsed {len(cidrs)} CIDRs")
    
    # Add extra domains from sources to domains file
    if extra_domains:
        all_domains = all_domains | extra_domains
        domains_file = LISTS_DIR / f"{service_id}_domains.txt"
        with open(domains_file, 'w') as f:
            for domain in sorted(all_domains):
                f.write(f"{domain}\n")
        log(f"  Updated domains file with {len(extra_domains)} extra domains (total: {len(all_domains)})")
    
    # Add static IP ranges to CIDRs
    all_cidrs.update(ip_ranges)
    
    # Save CIDRs to file
    if all_cidrs:
        cidrs_file = LISTS_DIR / f"{service_id}.txt"
        with open(cidrs_file, 'w') as f:
            for cidr in sorted(all_cidrs):
                f.write(f"{cidr}\n")
        log(f"  Total: {len(all_cidrs)} CIDRs saved to {cidrs_file}")

def generate_dnsmasq_config():
    """Generate dnsmasq nftset configuration"""
    log("Generating dnsmasq config...")
    
    # Remove old config location if exists (migration from /etc to /tmp)
    old_config = Path("/etc/dnsmasq.d/pinpoint.conf")
    if old_config.exists():
        log("Removing old config: /etc/dnsmasq.d/pinpoint.conf")
        old_config.unlink()
    
    # Collect all domains from enabled services
    all_domains = set()
    
    if SERVICES_FILE.exists():
        with open(SERVICES_FILE) as f:
            data = json.load(f)
        
        for service in data.get('services', []):
            if service.get('enabled', False):
                domains = service.get('domains', [])
                all_domains.update(domains)
    
    # Also check for custom domains file (legacy)
    custom_file = DATA_DIR / "domains.json"
    if custom_file.exists():
        with open(custom_file) as f:
            data = json.load(f)
        for item in data.get('domains', []):
            if isinstance(item, dict):
                all_domains.add(item.get('domain', ''))
            else:
                all_domains.add(item)
    
    # Load custom services
    custom_services_file = DATA_DIR / "custom_services.json"
    if custom_services_file.exists():
        with open(custom_services_file) as f:
            data = json.load(f)
        for service in data.get('services', []):
            if service.get('enabled', True):
                for domain in service.get('domains', []):
                    if domain:
                        all_domains.add(domain)
    
    # Generate config
    config_lines = [
        "# Pinpoint - Domain routing via nftset",
        "# Auto-generated - do not edit manually",
        "#",
        "# Domains listed here will have their resolved IPs",
        "# added to nftables set for policy routing",
        ""
    ]
    
    for domain in sorted(all_domains):
        if domain:
            config_lines.append(f"nftset=/{domain}/4#inet#pinpoint#tunnel_ips")
    
    # Block IPv6 for YouTube/Google Video domains to force IPv4
    # This ensures traffic goes through our IPv4 tunnel
    youtube_domains = [
        "googlevideo.com", "youtube.com", "music.youtube.com", 
        "ytimg.com", "ggpht.com", "youtubei.googleapis.com",
        "wide-youtube.l.google.com", "youtube-ui.l.google.com"
    ]
    config_lines.append("")
    config_lines.append("# Block IPv6 for YouTube to force IPv4 routing")
    for domain in youtube_domains:
        config_lines.append(f"address=/{domain}/::")
    
    # Write config
    DNSMASQ_CONF.parent.mkdir(parents=True, exist_ok=True)
    with open(DNSMASQ_CONF, 'w') as f:
        f.write('\n'.join(config_lines) + '\n')
    
    log(f"Saved {len(all_domains)} domains to {DNSMASQ_CONF}")

def load_nftables_sets():
    """Load IP CIDRs into nftables sets"""
    log("Loading nftables sets...")
    
    # Flush existing set
    subprocess.run(["nft", "flush", "set", "inet", "pinpoint", "tunnel_nets"], 
                   capture_output=True)
    
    # Get list of enabled services
    enabled_services = set()
    if SERVICES_FILE.exists():
        with open(SERVICES_FILE) as f:
            data = json.load(f)
        for service in data.get('services', []):
            if service.get('enabled', False):
                enabled_services.add(service.get('id', ''))
    
    # Load CIDR files only for enabled services
    loaded = 0
    for cidr_file in LISTS_DIR.glob("*.txt"):
        # Skip domain files
        if "_domains" in cidr_file.name:
            continue
        if "_static" in cidr_file.name:
            continue
        
        # Check if this file belongs to an enabled service
        service_id = cidr_file.stem  # filename without extension
        if service_id not in enabled_services:
            continue
        
        with open(cidr_file) as f:
            for line in f:
                cidr = line.strip()
                if cidr and '/' in cidr:
                    result = subprocess.run(
                        ["nft", "add", "element", "inet", "pinpoint", 
                         "tunnel_nets", "{", cidr, "}"],
                        capture_output=True
                    )
                    if result.returncode == 0:
                        loaded += 1
    
    # Also load static files (only for enabled services)
    for static_file in LISTS_DIR.glob("*_static.txt"):
        # Check if this file belongs to an enabled service
        service_id = static_file.stem.replace("_static", "")
        if service_id not in enabled_services:
            continue
            
        with open(static_file) as f:
            for line in f:
                cidr = line.strip()
                if cidr:
                    if '/' not in cidr:
                        cidr = f"{cidr}/32"
                    result = subprocess.run(
                        ["nft", "add", "element", "inet", "pinpoint", 
                         "tunnel_nets", "{", cidr, "}"],
                        capture_output=True
                    )
                    if result.returncode == 0:
                        loaded += 1
    
    # Load custom IPs from domains.json (legacy)
    custom_file = DATA_DIR / "domains.json"
    if custom_file.exists():
        with open(custom_file) as f:
            data = json.load(f)
        for item in data.get('custom_ips', []):
            if isinstance(item, dict):
                ip = item.get('ip', '')
            else:
                ip = item
            if ip:
                if '/' not in ip:
                    ip = f"{ip}/32"
                result = subprocess.run(
                    ["nft", "add", "element", "inet", "pinpoint", 
                     "tunnel_nets", "{", ip, "}"],
                    capture_output=True
                )
                if result.returncode == 0:
                    loaded += 1
    
    # Load IPs from custom services
    custom_services_file = DATA_DIR / "custom_services.json"
    if custom_services_file.exists():
        with open(custom_services_file) as f:
            data = json.load(f)
        for service in data.get('services', []):
            if service.get('enabled', True):
                for ip in service.get('ips', []):
                    if ip:
                        if '/' not in ip:
                            ip = f"{ip}/32"
                        result = subprocess.run(
                            ["nft", "add", "element", "inet", "pinpoint", 
                             "tunnel_nets", "{", ip, "}"],
                            capture_output=True
                        )
                        if result.returncode == 0:
                            loaded += 1
    
    # Always add essential Meta/Instagram IP ranges as fallback
    # These are critical because ISP DNS hijacking returns CDN IPs that don't work through VPN
    essential_ranges = [
        "31.13.24.0/21",      # Facebook
        "31.13.64.0/18",      # Facebook/Instagram
        "157.240.0.0/16",     # Meta
        "179.60.192.0/22",    # Meta
        "185.60.216.0/22",    # Meta
        "66.220.144.0/20",    # Facebook
        "69.63.176.0/20",     # Facebook
        "69.171.224.0/19",    # Facebook
        "74.119.76.0/22",     # Facebook
        "102.132.96.0/20",    # Meta
        "129.134.0.0/16",     # Meta
        "147.75.208.0/20",    # Meta
        "163.70.128.0/17",    # Meta
    ]
    
    for cidr in essential_ranges:
        result = subprocess.run(
            ["nft", "add", "element", "inet", "pinpoint", 
             "tunnel_nets", "{", cidr, "}"],
            capture_output=True
        )
        if result.returncode == 0:
            loaded += 1
    
    log(f"Loaded {loaded} CIDRs to nftables")

def restart_dnsmasq():
    """Restart dnsmasq to apply new config"""
    log("Restarting dnsmasq...")
    result = subprocess.run(["/etc/init.d/dnsmasq", "restart"], capture_output=True)
    if result.returncode == 0:
        log("dnsmasq restarted")
    else:
        log(f"dnsmasq restart failed: {result.stderr.decode()}")

def clean_device_rules():
    """Remove all existing device-specific rules from nftables"""
    log("Cleaning old device rules...")
    
    # Get all rules with 'pinpoint: device' comment
    result = subprocess.run(
        ["nft", "-a", "list", "chain", "inet", "pinpoint", "prerouting"],
        capture_output=True, text=True
    )
    
    if result.returncode != 0:
        return
    
    # Find and delete rules with device comments
    import re
    handles_to_delete = []
    for line in result.stdout.split('\n'):
        if 'pinpoint: device' in line:
            # Extract handle number
            match = re.search(r'# handle (\d+)', line)
            if match:
                handles_to_delete.append(match.group(1))
    
    # Delete rules by handle (in reverse order to avoid reordering issues)
    for handle in reversed(handles_to_delete):
        subprocess.run(
            ["nft", "delete", "rule", "inet", "pinpoint", "prerouting", "handle", handle],
            capture_output=True
        )
    
    if handles_to_delete:
        log(f"Removed {len(handles_to_delete)} old device rules")
    
    # Also clean up device-specific sets
    result = subprocess.run(
        ["nft", "list", "sets", "inet", "pinpoint"],
        capture_output=True, text=True
    )
    
    if result.returncode == 0:
        for line in result.stdout.split('\n'):
            if 'set device_' in line:
                match = re.search(r'set (device_\w+)', line)
                if match:
                    set_name = match.group(1)
                    subprocess.run(
                        ["nft", "delete", "set", "inet", "pinpoint", set_name],
                        capture_output=True
                    )
                    log(f"Removed old device set: {set_name}")

def generate_device_rules():
    """Generate nftables rules for device-specific routing"""
    log("Generating device routing rules...")
    
    # First, clean all old device rules
    clean_device_rules()
    
    if not DEVICES_FILE.exists():
        log("No devices file found, skipping device rules")
        return
    
    with open(DEVICES_FILE) as f:
        data = json.load(f)
    
    devices = data.get('devices', [])
    enabled_devices = [d for d in devices if d.get('enabled', False)]
    
    if not enabled_devices:
        log("No enabled devices")
        return
    
    # Get enabled services and their domains for custom mode
    services_data = {}
    if SERVICES_FILE.exists():
        with open(SERVICES_FILE) as f:
            svc_data = json.load(f)
        for svc in svc_data.get('services', []):
            services_data[svc['id']] = svc
    
    # Build nftables rules
    nft_rules = []
    nft_rules.append("# Pinpoint device-specific routing rules")
    nft_rules.append("# Auto-generated - do not edit manually")
    nft_rules.append("")
    
    # Create sets for devices with custom services
    device_sets = {}
    
    for device in enabled_devices:
        device_id = device['id']
        device_ip = device['ip']
        mode = device.get('mode', 'default')
        
        if mode == 'vpn_all':
            # All traffic through VPN - mark all packets from this IP
            nft_rules.append(f"# Device: {device.get('name', device_id)} - All VPN")
            nft_rules.append(f"add rule inet pinpoint prerouting ip saddr {device_ip} meta mark set 0x100 counter comment \"pinpoint: device {device_id} vpn_all\"")
            
        elif mode == 'direct_all':
            # All traffic direct - return early for this IP (skip VPN marking)
            nft_rules.append(f"# Device: {device.get('name', device_id)} - All Direct")
            nft_rules.append(f"add rule inet pinpoint prerouting ip saddr {device_ip} return comment \"pinpoint: device {device_id} direct_all\"")
            
        elif mode == 'custom':
            # Custom services for this device
            device_services = device.get('services', [])
            
            # Collect all domains and IPs for these services
            set_name = f"device_{device_id.replace('-', '_')}"
            device_domains = set()
            device_cidrs = set()
            
            # Add device's own custom domains and IPs
            device_domains.update(device.get('custom_domains', []))
            device_cidrs.update(device.get('custom_ips', []))
            
            for svc_id in device_services:
                svc = services_data.get(svc_id, {})
                device_domains.update(svc.get('domains', []))
                device_domains.update(svc.get('custom_domains', []))
                device_cidrs.update(svc.get('custom_ips', []))
                
                # Load CIDRs from list files
                list_file = LISTS_DIR / f"{svc_id}.txt"
                if list_file.exists():
                    with open(list_file) as f:
                        for line in f:
                            cidr = line.strip()
                            if cidr:
                                device_cidrs.add(cidr)
            
            # Only add if there are domains, IPs, or services
            if device_domains or device_cidrs or device_services:
                device_sets[device_id] = {
                    'set_name': set_name,
                    'ip': device_ip,
                    'name': device.get('name', device_id),
                    'domains': device_domains,
                    'cidrs': device_cidrs
                }
    
    # Write rules to file
    DEVICES_NFT.parent.mkdir(parents=True, exist_ok=True)
    with open(DEVICES_NFT, 'w') as f:
        f.write('\n'.join(nft_rules) + '\n')
    
    # Apply simple rules (vpn_all, direct_all)
    for line in nft_rules:
        if line.startswith('add rule'):
            cmd = ['nft'] + line.split()
            subprocess.run(cmd, capture_output=True)
    
    # Handle custom device sets
    for device_id, dev_data in device_sets.items():
        set_name = dev_data['set_name']
        device_ip = dev_data['ip']
        
        # Create IP set for this device
        subprocess.run(['nft', 'add', 'set', 'inet', 'pinpoint', set_name, 
                       '{', 'type', 'ipv4_addr;', 'flags', 'interval;', '}'], 
                       capture_output=True)
        
        # Add CIDRs to the set
        for cidr in dev_data['cidrs']:
            subprocess.run(['nft', 'add', 'element', 'inet', 'pinpoint', 
                           set_name, '{', cidr, '}'], capture_output=True)
        
        # Add rule to mark traffic from this device to IPs in its set
        subprocess.run(['nft', 'add', 'rule', 'inet', 'pinpoint', 'prerouting',
                       'ip', 'saddr', device_ip, 'ip', 'daddr', f'@{set_name}',
                       'meta', 'mark', 'set', '0x100', 'counter',
                       'comment', f'"pinpoint: device {device_id} custom"'],
                       capture_output=True)
        
        # Add return rule so global rules don't apply to this device
        subprocess.run(['nft', 'add', 'rule', 'inet', 'pinpoint', 'prerouting',
                       'ip', 'saddr', device_ip, 'return',
                       'comment', f'"pinpoint: device {device_id} skip global"'],
                       capture_output=True)
        
        log(f"  Device {dev_data['name']}: {len(dev_data['cidrs'])} CIDRs, {len(dev_data['domains'])} domains (custom only)")
    
    log(f"Applied rules for {len(enabled_devices)} devices")

def update_all():
    """Main update function"""
    log("=== Starting list update ===")
    
    if not SERVICES_FILE.exists():
        log(f"Services file not found: {SERVICES_FILE}")
        return 1
    
    with open(SERVICES_FILE) as f:
        data = json.load(f)
    
    # Process each service
    for service in data.get('services', []):
        try:
            process_service(service)
        except Exception as e:
            log(f"Error processing {service.get('id')}: {e}")
    
    # Generate dnsmasq config
    generate_dnsmasq_config()
    
    # Load nftables sets
    load_nftables_sets()
    
    # Generate and apply device-specific rules
    generate_device_rules()
    
    # Restart dnsmasq
    restart_dnsmasq()
    
    # Save last update timestamp
    save_update_status()
    
    log("=== Update complete ===")
    return 0

def save_update_status():
    """Save last update timestamp to status file"""
    from datetime import datetime
    status_file = DATA_DIR / "status.json"
    
    # Count entries
    total_cidrs = 0
    total_domains = 0
    services_count = 0
    
    if LISTS_DIR.exists():
        for f in LISTS_DIR.glob("*.txt"):
            if "_domains" in f.name:
                total_domains += sum(1 for _ in open(f))
            elif "_static" not in f.name:
                total_cidrs += sum(1 for _ in open(f))
    
    if SERVICES_FILE.exists():
        with open(SERVICES_FILE) as f:
            data = json.load(f)
        services_count = len([s for s in data.get('services', []) if s.get('enabled', False)])
    
    status = {
        "last_update": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "last_update_timestamp": int(datetime.now().timestamp()),
        "total_cidrs": total_cidrs,
        "total_domains": total_domains,
        "enabled_services": services_count
    }
    
    with open(status_file, 'w') as f:
        json.dump(status, f, indent=2)
    
    log(f"Status saved: {total_cidrs} CIDRs, {total_domains} domains, {services_count} services")

def show_status():
    """Show current lists status"""
    print("=== Downloaded Lists ===")
    if LISTS_DIR.exists():
        for f in sorted(LISTS_DIR.glob("*.txt")):
            count = sum(1 for _ in open(f))
            size = f.stat().st_size
            print(f"  {f.name}: {count} entries ({size} bytes)")
    else:
        print("  No lists downloaded")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "update"
    
    if cmd == "update":
        sys.exit(update_all())
    elif cmd in ("show", "status"):
        show_status()
    else:
        print(f"Usage: {sys.argv[0]} {{update|show}}")
        sys.exit(1)
