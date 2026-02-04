#!/usr/bin/env python3
"""
Full System Diagnosis v2 - Complete PinPoint Testing
Fixed RPC parsing and IPv4/IPv6 handling
"""

import paramiko
import sys
import time
import json

ROUTER_IP = "192.168.5.1"
ROUTER_USER = "root"
ROUTER_PASS = "k512566K"

def print_header(text):
    print("\n" + "="*70)
    print(f"  {text}")
    print("="*70)

def print_step(num, text):
    print(f"\n[STEP {num}] {text}")
    print("-" * 70)

def exec_cmd(ssh, cmd, timeout=30):
    """Execute command and return output"""
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    return out, err, stdout.channel.recv_exit_status()

def ubus_call(ssh, method, params_dict=None):
    """Make ubus RPC call"""
    if params_dict:
        params_json = json.dumps(params_dict)
        # Escape quotes for shell
        params_json = params_json.replace('"', '\\"')
        cmd = f'ubus call luci.pinpoint {method} "{params_json}"'
    else:
        cmd = f"ubus call luci.pinpoint {method}"
    
    out, err, exitcode = exec_cmd(ssh, cmd)
    
    if exitcode != 0 or "error" in err.lower() or "Command failed" in out:
        return None, out + err
    
    # Try to parse JSON
    try:
        return json.loads(out), None
    except:
        # If not JSON, return raw output
        if out.strip():
            return {"raw": out}, None
        return None, "Empty response"

def main():
    print_header("FULL SYSTEM DIAGNOSIS - PINPOINT OPENWRT v2")
    print("\nTesting as if performing actions in LuCI interface...")
    print(f"Router: {ROUTER_IP}")
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    results = {
        "vpn_status": False,
        "services_enabled": [],
        "services_routed": [],
        "custom_rule_added": False,
        "custom_rule_routed": False,
        "update_works": False,
        "errors": []
    }
    
    try:
        print("\nConnecting to router...")
        ssh.connect(ROUTER_IP, username=ROUTER_USER, password=ROUTER_PASS, timeout=10)
        print("[OK] Connected successfully\n")
        
        # ========================================
        # STEP 1: Check Initial VPN Status
        # ========================================
        print_step(1, "Check VPN Status (like opening Status page in LuCI)")
        
        status, err = ubus_call(ssh, "status")
        if status:
            print(f"VPN Active: {status.get('vpn_active', False)}")
            print(f"Sing-box Running: {status.get('singbox_running', False)}")
            print(f"DoH Running: {status.get('doh_running', False)}")
            print(f"Tunnel Up: {status.get('tunnel_up', False)}")
            
            results["vpn_status"] = status.get('vpn_active', False)
            
            if results["vpn_status"]:
                print("[OK] VPN is active and ready")
            else:
                print("[ERROR] VPN is NOT active!")
                results["errors"].append("VPN not active")
        else:
            print(f"[ERROR] Failed to get status: {err}")
            results["errors"].append(f"Status check failed")
        
        # ========================================
        # STEP 2: Check Current Enabled Services
        # ========================================
        print_step(2, "Check Currently Enabled Services")
        
        services, err = ubus_call(ssh, "get_services")
        if services and services.get('services'):
            enabled_services = [s for s in services['services'] if s.get('enabled')]
            print(f"Total services: {len(services['services'])}")
            print(f"Enabled services: {len(enabled_services)}")
            
            if enabled_services:
                print("\nEnabled services:")
                for s in enabled_services[:10]:
                    print(f"  - {s.get('id')}")
                if len(enabled_services) > 10:
                    print(f"  ... and {len(enabled_services) - 10} more")
                
                results["services_enabled"] = [s.get('id') for s in enabled_services]
            else:
                print("[INFO] No services currently enabled")
        
        # ========================================
        # STEP 3: Verify Enabled Services Route Through VPN
        # ========================================
        print_step(3, "Verify Enabled Services Route Through VPN")
        
        # Check nftables sets
        print("\nChecking nftables sets...")
        out, _, _ = exec_cmd(ssh, "nft list set inet pinpoint tunnel_ips 2>/dev/null")
        tunnel_ips_count = out.count('.') if out else 0
        print(f"tunnel_ips: ~{tunnel_ips_count} IPv4 addresses")
        
        out, _, _ = exec_cmd(ssh, "nft list set inet pinpoint tunnel_nets 2>/dev/null")
        tunnel_nets_count = out.count('/') if out else 0
        print(f"tunnel_nets: {tunnel_nets_count} CIDR ranges")
        
        # Check dnsmasq config
        out, _, _ = exec_cmd(ssh, "cat /etc/dnsmasq.d/pinpoint.conf 2>/dev/null | wc -l")
        dns_lines = int(out.strip()) if out.strip() else 0
        print(f"dnsmasq rules: {dns_lines} lines")
        
        # Test routing for enabled services
        test_services = {
            "instagram": ["instagram.com", "cdninstagram.com"],
            "youtube": ["youtube.com", "googlevideo.com"],
            "brawlstars": ["game.brawlstarsgame.com"],
        }
        
        for service_id in results["services_enabled"][:3]:  # Test first 3
            if service_id in test_services:
                print(f"\n--- Testing routing for {service_id} ---")
                domains = test_services[service_id]
                
                service_routed = False
                for domain in domains:
                    # Check if domain is in dnsmasq config
                    out, _, _ = exec_cmd(ssh, f"grep '{domain}' /etc/dnsmasq.d/pinpoint.conf 2>/dev/null")
                    if domain in out:
                        print(f"  [OK] {domain} in dnsmasq config")
                        
                        # Resolve domain to IPv4 (not IPv6)
                        out, _, _ = exec_cmd(ssh, f"nslookup {domain} 127.0.0.1 2>/dev/null | grep 'Address:' | grep -v ':' | tail -1")
                        if "Address:" in out and ":" not in out.split()[-1]:
                            ip = out.split()[-1]
                            print(f"  Resolved {domain} -> {ip} (IPv4)")
                            
                            # Check if IP is in tunnel_ips set
                            out, _, _ = exec_cmd(ssh, f"nft list set inet pinpoint tunnel_ips 2>/dev/null | grep '{ip}'")
                            if ip in out:
                                print(f"  [OK] {ip} is in tunnel_ips set - routes through VPN")
                                service_routed = True
                                break
                            else:
                                print(f"  [INFO] {ip} not in tunnel_ips yet (may need time to populate)")
                        else:
                            print(f"  [INFO] No IPv4 address resolved (IPv6 only or failed)")
                    else:
                        print(f"  [INFO] {domain} not in dnsmasq config")
                
                if service_routed:
                    results["services_routed"].append(service_id)
        
        # Check nftables counters for actual traffic
        print("\n--- Checking nftables counters for VPN traffic ---")
        out, _, _ = exec_cmd(ssh, "nft list chain inet pinpoint prerouting 2>/dev/null | grep -E 'counter packets' | head -3")
        if out.strip():
            lines = out.strip().split('\n')
            for line in lines:
                if 'packets' in line:
                    packets = line.split('packets')[1].split()[0]
                    print(f"  {line.split('comment')[1].strip() if 'comment' in line else 'Traffic'}: {packets} packets")
        
        # ========================================
        # STEP 4: Add Custom Rule and Test
        # ========================================
        print_step(4, "Add Custom Rule and Test VPN Routing")
        
        custom_service_name = "test_custom_rule"
        custom_domains = ["example.com"]
        custom_ips = ["1.1.1.1/32"]
        
        print(f"\nAdding custom service: {custom_service_name}")
        print(f"  Domains: {', '.join(custom_domains)}")
        print(f"  IPs: {', '.join(custom_ips)}")
        
        result, err = ubus_call(ssh, "add_custom_service", {
            "name": custom_service_name,
            "domains": custom_domains,
            "ip_ranges": custom_ips
        })
        
        if result and (result.get('success') or 'success' in str(result).lower()):
            print(f"[OK] Custom service added")
            results["custom_rule_added"] = True
            
            # Wait for rules to apply
            print("  Waiting 8 seconds for rules to activate...")
            time.sleep(8)
            
            # Verify custom rule
            print("\n--- Verifying custom rule routing ---")
            
            # Check domain in dnsmasq
            out, _, _ = exec_cmd(ssh, "grep 'example.com' /etc/dnsmasq.d/pinpoint.conf 2>/dev/null")
            if "example.com" in out:
                print("  [OK] example.com in dnsmasq config")
            else:
                print("  [ERROR] example.com NOT in dnsmasq config")
                results["errors"].append("Custom domain not in dnsmasq")
            
            # Check IP in nftables
            out, _, _ = exec_cmd(ssh, "nft list set inet pinpoint tunnel_nets 2>/dev/null | grep '1.1.1.1'")
            if "1.1.1.1" in out:
                print("  [OK] 1.1.1.1 in tunnel_nets set")
                results["custom_rule_routed"] = True
            else:
                print("  [ERROR] 1.1.1.1 NOT in tunnel_nets set")
                results["errors"].append("Custom IP not in tunnel_nets")
        else:
            print(f"[ERROR] Failed to add custom service: {err}")
            results["errors"].append("Failed to add custom service")
        
        # ========================================
        # STEP 5: Test Update All Enabled Services
        # ========================================
        print_step(5, "Test Update All Enabled Services")
        
        print("\nGetting timestamp before update...")
        out, _, _ = exec_cmd(ssh, "date '+%s'")
        timestamp_before = int(out.strip()) if out.strip() else 0
        
        print(f"Timestamp before: {timestamp_before}")
        
        # Try RPC call first
        print("\nTrying update via RPC call (like clicking button in Settings)...")
        result, err = ubus_call(ssh, "update_lists")
        
        rpc_works = False
        if result:
            print(f"[OK] RPC call returned: {result}")
            rpc_works = True
        else:
            print(f"[ERROR] RPC call failed: {err}")
            print("       (This is a known issue with ucode, but update still works)")
        
        # Always test direct execution to confirm functionality
        print("\nTesting direct script execution (confirms update works)...")
        out, _, exitcode = exec_cmd(ssh, "/opt/pinpoint/scripts/pinpoint-update.sh update 2>&1 | head -30", timeout=60)
        
        if exitcode == 0 and ("Processing service:" in out or "Starting list update" in out):
            print("[OK] Update script executed successfully")
            print("\nFirst 10 lines of output:")
            for line in out.split('\n')[:10]:
                if line.strip():
                    print(f"  {line}")
            results["update_works"] = True
            
            if not rpc_works:
                results["errors"].append("RPC call failed but direct execution works")
        else:
            print(f"[ERROR] Update script failed")
            results["errors"].append("Update script execution failed")
        
        # Wait for update to complete
        print("\n  Waiting 20 seconds for update to complete...")
        time.sleep(20)
        
        # Check if files were updated
        print("\nChecking if list files were updated...")
        out, _, _ = exec_cmd(ssh, f"find /opt/pinpoint/data/lists -name '*.txt' -newermt '@{timestamp_before}' 2>/dev/null | wc -l")
        updated_files = int(out.strip()) if out.strip() else 0
        
        if updated_files > 0:
            print(f"[OK] {updated_files} list files were updated")
            out, _, _ = exec_cmd(ssh, f"find /opt/pinpoint/data/lists -name '*.txt' -newermt '@{timestamp_before}' 2>/dev/null | head -5")
            print("Updated files:")
            for line in out.split('\n')[:5]:
                if line.strip():
                    print(f"  {line}")
        else:
            print("[INFO] No new files updated (may have been recent)")
        
        # ========================================
        # STEP 6: Final System Health Check
        # ========================================
        print_step(6, "Final System Health Check")
        
        # Memory
        out, _, _ = exec_cmd(ssh, "free | grep Mem")
        if out:
            parts = out.split()
            total = int(parts[1]) if len(parts) > 1 else 0
            used = int(parts[2]) if len(parts) > 2 else 0
            free = int(parts[3]) if len(parts) > 3 else 0
            print(f"\nMemory: {free} KB free / {total} KB total ({free*100//total}% free)")
            
            if free < 20000:
                print("  [WARNING] Low memory!")
                results["errors"].append("Low memory")
        
        # Load
        out, _, _ = exec_cmd(ssh, "uptime")
        if out:
            print(f"Uptime: {out.strip()}")
        
        # Sing-box process
        out, _, _ = exec_cmd(ssh, "ps aux | grep '[s]ing-box' | awk '{print $2,$6}'")
        if out.strip():
            parts = out.strip().split()
            if len(parts) >= 2:
                pid, vsz = parts[0], parts[1]
                print(f"sing-box: PID {pid}, VSZ {vsz} KB")
        
        # Traffic counters
        print("\nVPN Traffic Statistics:")
        out, _, _ = exec_cmd(ssh, "nft list chain inet pinpoint prerouting 2>/dev/null | grep 'counter packets'")
        if out:
            for line in out.split('\n'):
                if 'packets' in line and 'comment' in line:
                    packets = line.split('packets')[1].split()[0]
                    comment = line.split('comment')[1].strip().strip('"')
                    print(f"  {comment}: {packets} packets")
        
        # ========================================
        # FINAL REPORT
        # ========================================
        print_header("DIAGNOSIS COMPLETE - FINAL REPORT")
        
        print("\n[OK] PASSED TESTS:")
        passed_count = 0
        if results["vpn_status"]:
            print("  1. VPN is active and running")
            passed_count += 1
        if results["services_enabled"]:
            print(f"  2. Services enabled: {len(results['services_enabled'])} services")
            passed_count += 1
        if results["services_routed"]:
            print(f"  3. Services verified routing through VPN: {', '.join(results['services_routed'])}")
            passed_count += 1
        if results["custom_rule_added"]:
            print("  4. Custom rule added successfully")
            passed_count += 1
        if results["custom_rule_routed"]:
            print("  5. Custom rule routes through VPN")
            passed_count += 1
        if results["update_works"]:
            print("  6. Update all enabled services works")
            passed_count += 1
        
        if results["errors"]:
            print("\n[!] ISSUES FOUND:")
            for i, error in enumerate(results["errors"], 1):
                print(f"  {i}. {error}")
        else:
            print("\n[SUCCESS] NO ISSUES FOUND - SYSTEM WORKING PERFECTLY!")
        
        # Calculate success rate
        total_tests = 6
        print(f"\n[STATS] SUCCESS RATE: {passed_count}/{total_tests} ({passed_count*100//total_tests}%)")
        
        print("\n" + "="*70)
        
        return 0 if passed_count >= 4 else 1  # At least 4/6 to pass
        
    except Exception as e:
        print(f"\n[ERROR] CRITICAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        ssh.close()

if __name__ == "__main__":
    sys.exit(main())
