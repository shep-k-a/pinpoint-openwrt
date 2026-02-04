#!/usr/bin/env python3
"""Deep diagnosis of router configuration"""

import paramiko
import sys

ROUTER_IP = "192.168.5.1"
ROUTER_USER = "root"
ROUTER_PASS = "k512566K"

def exec_cmd(ssh, cmd, desc="", timeout=15):
    """Execute command"""
    if desc:
        print(f"\n{desc}")
    print(f"$ {cmd}")
    try:
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        if out:
            print(out)
        if err and "No such file" not in err:
            print(f"[stderr] {err}")
        return out
    except Exception as e:
        print(f"[ERROR] {e}")
        return ""

def main():
    print("\n" + "="*60)
    print("  Deep Router Configuration Diagnosis")
    print("="*60)
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"\nConnecting to {ROUTER_IP}...")
        ssh.connect(ROUTER_IP, username=ROUTER_USER, password=ROUTER_PASS, timeout=10)
        print("[OK] Connected\n")
        
        # 1. Check dnsmasq listening interfaces
        print("="*60)
        print("  1. dnsmasq Listening Interfaces")
        print("="*60)
        exec_cmd(ssh, "netstat -tuln | grep :53 || ss -tuln | grep :53")
        exec_cmd(ssh, "ps aux | grep dnsmasq | grep -v grep")
        
        # 2. Check dnsmasq config file location
        print("\n" + "="*60)
        print("  2. dnsmasq Configuration Files")
        print("="*60)
        exec_cmd(ssh, "cat /var/etc/dnsmasq.conf.cfg* 2>/dev/null | grep -E 'conf-dir|confdir|addn-hosts' | head -10")
        exec_cmd(ssh, "ls -la /etc/dnsmasq.d/ 2>&1")
        exec_cmd(ssh, "ls -la /tmp/dnsmasq.d/ 2>&1")
        exec_cmd(ssh, "cat /etc/dnsmasq.conf 2>/dev/null | head -20")
        
        # 3. Check if pinpoint.conf is being read
        print("\n" + "="*60)
        print("  3. pinpoint.conf Location and Content")
        print("="*60)
        exec_cmd(ssh, "find /etc /tmp -name 'pinpoint.conf' 2>/dev/null")
        exec_cmd(ssh, "grep -i instagram /etc/dnsmasq.d/pinpoint.conf 2>&1 | head -3")
        exec_cmd(ssh, "grep -i instagram /tmp/dnsmasq.d/pinpoint.conf 2>&1 | head -3")
        
        # 4. Check dnsmasq UCI config
        print("\n" + "="*60)
        print("  4. dnsmasq UCI Configuration")
        print("="*60)
        exec_cmd(ssh, "uci show dhcp.@dnsmasq[0]")
        exec_cmd(ssh, "uci show dhcp.lan")
        
        # 5. Check firewall rules
        print("\n" + "="*60)
        print("  5. Firewall Rules (DNS port 53)")
        print("="*60)
        exec_cmd(ssh, "nft list ruleset | grep -E '53|dns' | head -10")
        exec_cmd(ssh, "iptables -L -n | grep -E '53|dns' | head -10")
        
        # 6. Check if dnsmasq is actually using nftset
        print("\n" + "="*60)
        print("  6. dnsmasq nftset Support")
        print("="*60)
        exec_cmd(ssh, "dnsmasq --version 2>&1")
        exec_cmd(ssh, "opkg list-installed | grep dnsmasq")
        
        # 7. Test DNS from router itself
        print("\n" + "="*60)
        print("  7. DNS Test from Router")
        print("="*60)
        exec_cmd(ssh, "nslookup instagram.com 127.0.0.1 2>&1")
        exec_cmd(ssh, "nslookup instagram.com 192.168.5.1 2>&1")
        
        # 8. Check if nftset is working
        print("\n" + "="*60)
        print("  8. nftset Test")
        print("="*60)
        exec_cmd(ssh, "nslookup instagram.com 127.0.0.1 >/dev/null 2>&1; sleep 2; nft list set inet pinpoint tunnel_ips 2>&1 | tail -3")
        
        # 9. Check dnsmasq logs with verbose
        print("\n" + "="*60)
        print("  9. dnsmasq Log Configuration")
        print("="*60)
        exec_cmd(ssh, "uci show dhcp.@dnsmasq[0].logqueries")
        exec_cmd(ssh, "cat /var/etc/dnsmasq.conf.cfg* 2>/dev/null | grep -E 'log-queries|log-facility'")
        
        # 10. Check network interface binding
        print("\n" + "="*60)
        print("  10. Network Interface Configuration")
        print("="*60)
        exec_cmd(ssh, "ip addr show br-lan")
        exec_cmd(ssh, "ip addr show lan")
        
        # 11. Check if dnsmasq is binding to all interfaces
        print("\n" + "="*60)
        print("  11. dnsmasq Interface Binding")
        print("="*60)
        exec_cmd(ssh, "cat /var/etc/dnsmasq.conf.cfg* 2>/dev/null | grep -E 'interface|bind-interfaces|bind-dynamic'")
        
        # 12. Check DHCP lease file
        print("\n" + "="*60)
        print("  12. DHCP Lease File")
        print("="*60)
        exec_cmd(ssh, "ls -la /var/dhcp.leases")
        exec_cmd(ssh, "cat /var/dhcp.leases")
        
        # 13. Check if dnsmasq is reading pinpoint.conf
        print("\n" + "="*60)
        print("  13. dnsmasq Config Loading")
        print("="*60)
        exec_cmd(ssh, "dnsmasq --test 2>&1 | head -20")
        exec_cmd(ssh, "killall -USR1 dnsmasq 2>&1; sleep 1; logread | tail -10")
        
        # Analysis
        print("\n" + "="*60)
        print("  POTENTIAL ISSUES")
        print("="*60)
        
        print("\nCommon router-side issues:")
        print("  1. dnsmasq not listening on LAN interface")
        print("  2. dnsmasq not reading pinpoint.conf (wrong confdir)")
        print("  3. Firewall blocking DNS port 53")
        print("  4. dnsmasq-full not installed (no nftset support)")
        print("  5. DHCP not configured to send DNS option")
        print("  6. dnsmasq binding to wrong interface")
        
    except Exception as e:
        print(f"\n[ERROR] {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        ssh.close()
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
