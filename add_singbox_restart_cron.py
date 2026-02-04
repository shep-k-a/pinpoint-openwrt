#!/usr/bin/env python3
"""Add daily sing-box restart cron"""

import paramiko
import sys

ROUTER_IP = "192.168.5.1"
ROUTER_USER = "root"
ROUTER_PASS = "k512566K"

def main():
    print("\n" + "="*60)
    print("  Adding Daily sing-box Restart Cron")
    print("="*60)
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"\nConnecting to {ROUTER_IP}...")
        ssh.connect(ROUTER_IP, username=ROUTER_USER, password=ROUTER_PASS, timeout=10)
        print("[OK] Connected\n")
        
        # Check if cron exists
        print("1. Checking existing cron...")
        stdin, stdout, stderr = ssh.exec_command("cat /etc/crontabs/root 2>/dev/null | grep sing-box || echo 'not found'")
        existing = stdout.read().decode().strip()
        print(f"Current: {existing}")
        
        if 'sing-box restart' not in existing:
            print("\n2. Adding daily restart cron (4:00 AM)...")
            stdin, stdout, stderr = ssh.exec_command("""
echo '0 4 * * * /etc/init.d/sing-box restart >/dev/null 2>&1' >> /etc/crontabs/root
""")
            stdout.channel.recv_exit_status()
            print("[OK] Cron added")
        else:
            print("\n2. Cron already exists, skipping")
        
        print("\n3. Verifying cron...")
        stdin, stdout, stderr = ssh.exec_command("cat /etc/crontabs/root | grep sing-box")
        result = stdout.read().decode()
        print(result)
        
        print("\n4. Restarting cron daemon...")
        stdin, stdout, stderr = ssh.exec_command("/etc/init.d/cron restart")
        stdout.channel.recv_exit_status()
        print("[OK] Cron daemon restarted")
        
        print("\n" + "="*60)
        print("  Complete!")
        print("="*60)
        print("\nsing-box will restart daily at 4:00 AM")
        print("This prevents memory leaks from accumulating")
        
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
