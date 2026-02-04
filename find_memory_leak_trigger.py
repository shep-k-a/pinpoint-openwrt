#!/usr/bin/env python3
"""Find what actions trigger memory leak in sing-box"""

import paramiko
import sys
import time

ROUTER_IP = "192.168.5.1"
ROUTER_USER = "root"
ROUTER_PASS = "k512566K"

def exec_cmd(ssh, cmd, desc="", timeout=30):
    """Execute command and return output"""
    if desc:
        print(f"\n{desc}")
    print(f"$ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if out:
        print(out)
    if err and err.strip():
        print(f"[stderr] {err}")
    return out

def get_singbox_memory(ssh):
    """Get sing-box memory usage"""
    pid = exec_cmd(ssh, "pgrep -f sing-box").strip()
    if not pid:
        return None
    status = exec_cmd(ssh, f"cat /proc/{pid}/status | grep -E 'VmSize|VmRSS'")
    # Parse VmRSS
    for line in status.split('\n'):
        if 'VmRSS' in line:
            try:
                rss_kb = int(line.split()[1])
                return rss_kb / 1024  # Convert to MB
            except:
                pass
    return None

def main():
    print("\n" + "="*60)
    print("  Find Memory Leak Trigger")
    print("="*60)
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"\nConnecting to {ROUTER_IP}...")
        ssh.connect(ROUTER_IP, username=ROUTER_USER, password=ROUTER_PASS, timeout=10)
        print("[OK] Connected\n")
        
        # 1. Check sing-box configuration
        print("="*60)
        print("  1. sing-box Configuration")
        print("="*60)
        exec_cmd(ssh, "cat /etc/sing-box/config.json | head -50")
        
        # 2. Check sing-box logs for errors
        print("\n" + "="*60)
        print("  2. sing-box Recent Logs (Errors/Warnings)")
        print("="*60)
        exec_cmd(ssh, "logread | grep sing-box | tail -30")
        
        # 3. Check current memory
        print("\n" + "="*60)
        print("  3. Current sing-box Memory")
        print("="*60)
        mem_before = get_singbox_memory(ssh)
        if mem_before:
            print(f"Current memory: {mem_before:.1f} MB")
        else:
            print("sing-box not running")
            return 1
        
        # 4. Check sing-box connections/state
        print("\n" + "="*60)
        print("  4. sing-box Connections & State")
        print("="*60)
        exec_cmd(ssh, "netstat -an | grep -E 'tun1|:1080|:2080' | head -10")
        exec_cmd(ssh, "ss -tn | grep -E 'ESTAB|CLOSE' | wc -l")
        
        # 5. Check DNS queries through sing-box
        print("\n" + "="*60)
        print("  5. DNS Activity")
        print("="*60)
        exec_cmd(ssh, "logread | grep -i 'dns\|query' | tail -20")
        
        # 6. Check subscription update activity
        print("\n" + "="*60)
        print("  6. Subscription Update Activity")
        print("="*60)
        exec_cmd(ssh, "ls -lth /etc/sing-box/config.json 2>&1 | head -1")
        exec_cmd(ssh, "stat /etc/sing-box/config.json 2>&1 | grep Modify")
        
        # 7. Check for large config file
        print("\n" + "="*60)
        print("  7. Config File Size")
        print("="*60)
        exec_cmd(ssh, "wc -l /etc/sing-box/config.json")
        exec_cmd(ssh, "ls -lh /etc/sing-box/config.json")
        
        # 8. Check for outbound connections in config
        print("\n" + "="*60)
        print("  8. Outbound Connections in Config")
        print("="*60)
        exec_cmd(ssh, "cat /etc/sing-box/config.json | jsonfilter -e '@.outbounds[*].tag' 2>&1 | head -20")
        exec_cmd(ssh, "cat /etc/sing-box/config.json | jsonfilter -e '@.outbounds[*].type' 2>&1 | head -20")
        
        # 9. Check route rules
        print("\n" + "="*60)
        print("  9. Route Rules in Config")
        print("="*60)
        exec_cmd(ssh, "cat /etc/sing-box/config.json | jsonfilter -e '@.route.rules[*].outbound' 2>&1 | head -20")
        exec_cmd(ssh, "cat /etc/sing-box/config.json | jsonfilter -e '@.route.rules[*].domain' 2>&1 | wc -l")
        exec_cmd(ssh, "cat /etc/sing-box/config.json | jsonfilter -e '@.route.rules[*].ip' 2>&1 | wc -l")
        
        # 10. Check for memory leak patterns
        print("\n" + "="*60)
        print("  10. Memory Leak Patterns")
        print("="*60)
        exec_cmd(ssh, "ps w | grep sing-box | grep -v grep")
        exec_cmd(ssh, "cat /proc/$(pgrep -f sing-box)/status | grep -E 'Threads|State|FDSize'")
        
        # 11. Check recent actions that might trigger leak
        print("\n" + "="*60)
        print("  11. Recent Actions (from logs)")
        print("="*60)
        exec_cmd(ssh, "logread | grep -E 'pinpoint|update|apply|subscription' | tail -20")
        
        # 12. Monitor memory during test action
        print("\n" + "="*60)
        print("  12. Test: Monitor Memory During Update")
        print("="*60)
        print("Memory before: {:.1f} MB".format(mem_before))
        print("\nTriggering update_lists (this may take time)...")
        print("Monitoring memory...")
        
        # Start monitoring
        import threading
        monitoring = True
        max_mem = mem_before
        
        def monitor_memory():
            nonlocal max_mem, monitoring
            while monitoring:
                time.sleep(2)
                mem = get_singbox_memory(ssh)
                if mem:
                    if mem > max_mem:
                        max_mem = mem
                    print(f"  Memory: {mem:.1f} MB (max: {max_mem:.1f} MB)")
        
        monitor_thread = threading.Thread(target=monitor_memory, daemon=True)
        monitor_thread.start()
        
        # Trigger update
        exec_cmd(ssh, "ubus call luci.pinpoint update_lists 2>&1", timeout=5)
        
        # Wait a bit
        time.sleep(10)
        monitoring = False
        
        mem_after = get_singbox_memory(ssh)
        if mem_after:
            print(f"\nMemory after: {mem_after:.1f} MB")
            print(f"Memory increase: {mem_after - mem_before:.1f} MB")
        
        print("\n" + "="*60)
        print("  ANALYSIS")
        print("="*60)
        
        print("\nPossible triggers:")
        print("  1. Subscription updates (large config reload)")
        print("  2. Route rules updates (many domains/IPs)")
        print("  3. DNS queries through sing-box")
        print("  4. Outbound connection handling")
        print("  5. Config file reload")
        print("  6. Large number of route rules")
        
        print("\nRecommendations:")
        print("  1. Check config file size (should be < 100KB)")
        print("  2. Limit route rules (use nftables instead)")
        print("  3. Avoid DNS through sing-box")
        print("  4. Reduce outbound connections")
        print("  5. Use sing-box only for VPN, not routing")
        
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
