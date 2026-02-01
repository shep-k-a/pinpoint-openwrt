#!/usr/bin/env python3
"""Deploy all fixes to router 192.168.1.1"""
import paramiko
import sys
from pathlib import Path

ROUTER_IP = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.1"
PROJECT_DIR = Path(__file__).parent

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"Connecting to {ROUTER_IP}...")
ssh.connect(ROUTER_IP, username='root', password='k512566K')

def upload_file(local_path, remote_path):
    print(f"  {local_path.name} -> {remote_path}")
    content = local_path.read_text(encoding='utf-8')
    transport = ssh.get_transport()
    channel = transport.open_session()
    channel.exec_command(f'cat > {remote_path}')
    channel.sendall(content.encode('utf-8'))
    channel.shutdown_write()
    channel.recv_exit_status()
    channel.close()

def run(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd)
    return stdout.read().decode('utf-8', errors='replace').strip()

# Deploy backend
print("\n=== Deploying backend ===")
upload_file(PROJECT_DIR / "backend" / "main.py", "/opt/pinpoint/backend/main.py")

# Deploy update scripts
print("\n=== Deploying update scripts ===")
upload_file(PROJECT_DIR / "scripts" / "pinpoint-update.py", "/opt/pinpoint/scripts/pinpoint-update.py")
run("chmod +x /opt/pinpoint/scripts/pinpoint-update.py")

# Deploy cron
print("\n=== Deploying cron job ===")
run("mkdir -p /etc/cron.d")
upload_file(PROJECT_DIR / "etc" / "cron.d" / "pinpoint", "/etc/cron.d/pinpoint")

# Restart services
print("\n=== Restarting services ===")
print("Restarting pinpoint API...")
print(run("/etc/init.d/pinpoint restart 2>&1"))

import time
time.sleep(2)

print("Running update script...")
print(run("python3 /opt/pinpoint/scripts/pinpoint-update.py update 2>&1 | tail -10"))

# Restart cron
print("\nRestarting cron...")
print(run("/etc/init.d/cron restart 2>&1"))

# Verify
print("\n=== Verification ===")
print("API process:", run("pgrep -a python | grep main"))
print("Cron job:", run("cat /etc/cron.d/pinpoint"))

ssh.close()
print("\nDone!")
