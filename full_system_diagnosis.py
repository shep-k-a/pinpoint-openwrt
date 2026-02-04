#!/usr/bin/env python3
"""
Full System Diagnosis - Complete PinPoint Testing
Simulating user actions in LuCI interface
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
    return out, err

def ubus_call(ssh, method, params=''):
    """Make ubus RPC call"""
    if params:
        cmd = f"ubus call luci.pinpoint {method} '{params}'"
    else:
        cmd = f"ubus call luci.pinpoint {method}"
    out, err = exec_cmd(ssh, cmd)
    if err and "error" in err.lower():
        return None, err
    try:
        return json.loads(out), None
    except:
        return out, None

def main():
    print_header("FULL SYSTEM DIAGNOSIS - PINPOINT OPENWRT")
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
            results["errors"].append(f"Status check failed: {err}")
        
        # ========================================
        # STEP 2: Enable Test Services
        # ========================================
        print_step(2, "Enable Test Services (like clicking toggle in Services page)")
        
        # We'll enable 2 services: instagram and youtube
        test_services = ["instagram", "youtube"]
        
        for service_id in test_services:
            print(f"\nEnabling service: {service_id}")
            params = json.dumps({"service_id": service_id, "enabled": True})
            result, err = ubus_call(ssh, "set_service", params)
            
            if result and result.get('success'):
                print(f"[OK] Service {service_id} enabled")
                results["services_enabled"].append(service_id)
                
                # Wait for rules to apply
                print(f"  Waiting for rules to activate (10 seconds)...")
                time.sleep(10)
            else:
                print(f"[ERROR] Failed to enable {service_id}: {err}")
                results["errors"].append(f"Failed to enable {service_id}")
        
        # ========================================
        # STEP 3: Verify Services are Routed Through VPN
        # ========================================
        print_step(3, "Verify Services Route Through VPN")
        
        # Check nftables sets
        print("\nChecking nftables sets (tunnel_ips and tunnel_nets)...")
        out, _ = exec_cmd(ssh, "nft list set inet pinpoint tunnel_ips | grep elements")
        print(f"tunnel_ips count: {out.count('.')}")
        
        out, _ = exec_cmd(ssh, "nft list set inet pinpoint tunnel_nets | grep elements")
        print(f"tunnel_nets count: {out.count('/')}")
        
        # Check dnsmasq config
        print("\nChecking dnsmasq configuration...")
        out, _ = exec_cmd(ssh, "cat /etc/dnsmasq.d/pinpoint.conf 2>/dev/null | wc -l")
        dns_lines = int(out.strip()) if out.strip() else 0
        print(f"dnsmasq rules: {dns_lines} lines")
        
        # Test actual routing for each service
        for service_id in test_services:
            print(f"\n--- Testing routing for {service_id} ---")
            
            # Get test domain for this service
            test_domains = {
                "instagram": "instagram.com",
                "youtube": "youtube.com"
            }
            test_domain = test_domains.get(service_id)
            
            if test_domain:
                # Check if domain is in dnsmasq config
                out, _ = exec_cmd(ssh, f"grep '{test_domain}' /etc/dnsmasq.d/pinpoint.conf")
                if test_domain in out:
                    print(f"  [OK] {test_domain} in dnsmasq config")
                else:
                    print(f"  [ERROR] {test_domain} NOT in dnsmasq config")
                    results["errors"].append(f"{test_domain} not in dnsmasq config")
                    continue
                
                # Resolve domain and check if IP is in tunnel_ips
                out, _ = exec_cmd(ssh, f"nslookup {test_domain} 127.0.0.1 | grep 'Address:' | tail -1")
                if "Address:" in out:
                    ip = out.split()[-1]
                    print(f"  Resolved {test_domain} -> {ip}")
                    
                    # Check if IP is in tunnel_ips set
                    out, _ = exec_cmd(ssh, f"nft list set inet pinpoint tunnel_ips | grep '{ip}'")
                    if ip in out:
                        print(f"  [OK] {ip} is in tunnel_ips set - will route through VPN")
                        results["services_routed"].append(service_id)
                    else:
                        print(f"  [ERROR] {ip} NOT in tunnel_ips set")
                        results["errors"].append(f"{service_id} IP not in tunnel_ips")
                else:
                    print(f"  [ERROR] Failed to resolve {test_domain}")
                    results["errors"].append(f"Failed to resolve {test_domain}")
        
        # ========================================
        # STEP 4: Check Device Routing
        # ========================================
        print_step(4, "Check Device Routing Configuration")
        
        devices, err = ubus_call(ssh, "get_devices")
        if devices and devices.get('devices'):
            print(f"Total devices: {len(devices['devices'])}")
            
            # Count devices by mode
            vpn_devices = [d for d in devices['devices'] if d.get('mode') == 'vpn']
            global_devices = [d for d in devices['devices'] if d.get('mode') == 'global']
            direct_devices = [d for d in devices['devices'] if d.get('mode') == 'direct']
            
            print(f"  VPN mode: {len(vpn_devices)} devices")
            print(f"  Global mode: {len(global_devices)} devices")
            print(f"  Direct mode: {len(direct_devices)} devices")
            
            # Show example device
            if vpn_devices:
                device = vpn_devices[0]
                print(f"\n  Example VPN device:")
                print(f"    MAC: {device.get('mac')}")
                print(f"    IP: {device.get('ip')}")
                print(f"    Hostname: {device.get('hostname', 'N/A')}")
                print(f"    Mode: {device.get('mode')}")
        else:
            print("[ERROR] Failed to get devices")
            results["errors"].append("Failed to get devices")
        
        # ========================================
        # STEP 5: Add Custom Rule
        # ========================================
        print_step(5, "Add Custom Rule (like adding in Custom Services page)")
        
        custom_service_name = "test_custom_service"
        custom_domains = ["example.com", "test.com"]
        custom_ips = ["1.1.1.1/32", "8.8.8.8/32"]
        
        print(f"\nAdding custom service: {custom_service_name}")
        print(f"  Domains: {', '.join(custom_domains)}")
        print(f"  IPs: {', '.join(custom_ips)}")
        
        params = json.dumps({
            "name": custom_service_name,
            "domains": custom_domains,
            "ip_ranges": custom_ips
        })
        
        result, err = ubus_call(ssh, "add_custom_service", params)
        
        if result and result.get('success'):
            print(f"[OK] Custom service added successfully")
            results["custom_rule_added"] = True
            
            # Wait for rules to apply
            print("  Waiting for rules to activate (10 seconds)...")
            time.sleep(10)
        else:
            print(f"[ERROR] Failed to add custom service: {err}")
            results["errors"].append(f"Failed to add custom service: {err}")
        
        # ========================================
        # STEP 6: Verify Custom Rule Routes Through VPN
        # ========================================
        print_step(6, "Verify Custom Rule Routes Through VPN")
        
        if results["custom_rule_added"]:
            # Check if custom domains are in dnsmasq
            print("\nChecking if custom domains are in dnsmasq config...")
            for domain in custom_domains:
                out, _ = exec_cmd(ssh, f"grep '{domain}' /etc/dnsmasq.d/pinpoint.conf")
                if domain in out:
                    print(f"  [OK] {domain} in dnsmasq config")
                else:
                    print(f"  [ERROR] {domain} NOT in dnsmasq config")
                    results["errors"].append(f"Custom domain {domain} not in dnsmasq")
            
            # Check if custom IPs are in nftables
            print("\nChecking if custom IPs are in nftables...")
            for ip_cidr in custom_ips:
                ip = ip_cidr.split('/')[0]
                out, _ = exec_cmd(ssh, f"nft list set inet pinpoint tunnel_nets | grep '{ip}'")
                if ip in out:
                    print(f"  [OK] {ip_cidr} in tunnel_nets set")
                    results["custom_rule_routed"] = True
                else:
                    print(f"  [ERROR] {ip_cidr} NOT in tunnel_nets set")
                    results["errors"].append(f"Custom IP {ip_cidr} not in tunnel_nets")
        
        # ========================================
        # STEP 7: Test Update All Enabled Services
        # ========================================
        print_step(7, "Test Update All Enabled Services (button in Settings)")
        
        print("\nGetting list of enabled services...")
        services, err = ubus_call(ssh, "get_services")
        if services and services.get('services'):
            enabled = [s for s in services['services'] if s.get('enabled')]
            print(f"Currently enabled services: {len(enabled)}")
            for s in enabled[:5]:
                print(f"  - {s.get('id')}")
            if len(enabled) > 5:
                print(f"  ... and {len(enabled) - 5} more")
        
        # Check file modification times before update
        print("\nChecking list files before update...")
        out, _ = exec_cmd(ssh, "ls -lt /opt/pinpoint/data/lists/*.txt 2>/dev/null | head -5")
        print("Last 5 modified files:")
        print(out)
        before_times = out
        
        # Trigger update via RPC (like clicking button)
        print("\nTriggering update via RPC call...")
        result, err = ubus_call(ssh, "update_lists")
        
        if result:
            print(f"[OK] Update RPC call result: {result}")
            
            # Wait for update to start
            print("  Waiting 5 seconds for update to start...")
            time.sleep(5)
            
            # Check if update process is running
            out, _ = exec_cmd(ssh, "ps w | grep -E 'pinpoint-update' | grep -v grep")
            if out.strip():
                print(f"[OK] Update process is running")
                print(out)
                results["update_works"] = True
            else:
                print("[!] No update process found (may have completed or not started)")
                
                # Check if it completed via direct script execution
                print("\n  Testing direct script execution...")
                out, _ = exec_cmd(ssh, "/opt/pinpoint/scripts/pinpoint-update.sh update 2>&1 | head -20", timeout=60)
                if "Processing service:" in out or "Starting list update" in out:
                    print("[OK] Direct script execution works")
                    print(out)
                    results["update_works"] = True
                else:
                    print(f"[ERROR] Direct script execution failed or unexpected output")
                    results["errors"].append("Update script execution issue")
        else:
            print(f"[ERROR] Update RPC call failed: {err}")
            print("\n  Trying direct script execution as fallback...")
            out, _ = exec_cmd(ssh, "/opt/pinpoint/scripts/pinpoint-update.sh update 2>&1 | head -20", timeout=60)
            if "Processing service:" in out or "Starting list update" in out:
                print("[OK] Direct script execution works (RPC issue, but functionality OK)")
                print(out)
                results["update_works"] = True
                results["errors"].append("RPC call failed but direct execution works")
            else:
                print(f"[ERROR] Both RPC and direct execution failed")
                results["errors"].append("Update failed completely")
        
        # Wait for update to complete
        print("\n  Waiting 15 seconds for update to process...")
        time.sleep(15)
        
        # Check file modification times after update
        print("\nChecking list files after update...")
        out, _ = exec_cmd(ssh, "ls -lt /opt/pinpoint/data/lists/*.txt 2>/dev/null | head -5")
        print("Last 5 modified files:")
        print(out)
        after_times = out
        
        if before_times != after_times:
            print("[OK] List files were updated!")
        else:
            print("[!] List files may not have been updated (or update too fast)")
        
        # Check logs for update activity
        print("\nChecking logs for update activity...")
        out, _ = exec_cmd(ssh, "logread | grep -i pinpoint | tail -10")
        if out.strip():
            print("Recent log entries:")
            print(out)
        
        # ========================================
        # STEP 8: Final System Health Check
        # ========================================
        print_step(8, "Final System Health Check")
        
        # Check memory
        out, _ = exec_cmd(ssh, "free | grep Mem")
        print(f"\nMemory: {out.strip()}")
        
        # Check load
        out, _ = exec_cmd(ssh, "uptime")
        print(f"Load: {out.strip()}")
        
        # Check sing-box memory
        out, _ = exec_cmd(ssh, "ps aux | grep sing-box | grep -v grep")
        if out.strip():
            parts = out.split()
            vsz = parts[4] if len(parts) > 4 else "N/A"
            print(f"sing-box VSZ: {vsz} KB")
        
        # Check nftables counters
        print("\nChecking nftables counters...")
        out, _ = exec_cmd(ssh, "nft list chain inet pinpoint prerouting | grep -E 'counter packets' | head -3")
        if out.strip():
            print(out)
        
        # ========================================
        # FINAL REPORT
        # ========================================
        print_header("DIAGNOSIS COMPLETE - FINAL REPORT")
        
        print("\nOK PASSED TESTS:")
        if results["vpn_status"]:
            print("  вЂў VPN is active and running")
        if results["services_enabled"]:
            print(f"  вЂў Services enabled: {', '.join(results['services_enabled'])}")
        if results["services_routed"]:
            print(f"  вЂў Services routed through VPN: {', '.join(results['services_routed'])}")
        if results["custom_rule_added"]:
            print("  вЂў Custom rule added successfully")
        if results["custom_rule_routed"]:
            print("  вЂў Custom rule routes through VPN")
        if results["update_works"]:
            print("  вЂў Update all enabled services works")
        
        if results["errors"]:
            print("\nERROR ISSUES FOUND:")
            for i, error in enumerate(results["errors"], 1):
                print(f"  {i}. {error}")
        else:
            print("\nSUCCESS NO ISSUES FOUND - SYSTEM WORKING PERFECTLY!")
        
        # Calculate success rate
        total_tests = 6
        passed = sum([
            results["vpn_status"],
            bool(results["services_enabled"]),
            bool(results["services_routed"]),
            results["custom_rule_added"],
            results["custom_rule_routed"],
            results["update_works"]
        ])
        
        print(f"\nSTATS SUCCESS RATE: {passed}/{total_tests} ({passed*100//total_tests}%)")
        
        return 0 if not results["errors"] else 1
        
    except Exception as e:
        print(f"\n[ERROR] CRITICAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        ssh.close()

if __name__ == "__main__":
    sys.exit(main())

