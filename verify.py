#!/usr/bin/env python3
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.5.1', username='root', password='k512566K', timeout=10)

def run(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    return stdout.read().decode('utf-8', errors='replace').strip()

print("=== Verifying routing ===")

# Clear tunnel_ips for clean test
run('nft flush set inet pinpoint tunnel_ips 2>/dev/null')
print("1. Cleared tunnel_ips")

# Resolve instagram (should add to tunnel_ips)
print("\n2. Resolving instagram.com...")
print(run('nslookup instagram.com 127.0.0.1 2>&1 | grep "Address:" | tail -1'))

time.sleep(1)

# Check tunnel_ips
print("\n3. tunnel_ips after instagram lookup:")
out = run('nft list set inet pinpoint tunnel_ips 2>&1 | grep -A5 elements')
print(out or "Empty")

# Resolve facebook (should NOT add - not in pinpoint.conf)
print("\n4. Resolving facebook.com...")
print(run('nslookup facebook.com 127.0.0.1 2>&1 | grep "Address:" | tail -1'))

time.sleep(1)

# Check if facebook IP was added
fb_ip = run('nslookup facebook.com 127.0.0.1 2>&1 | grep "Address:" | tail -1 | awk "{print \\$2}"')
print(f"\n5. Facebook IP: {fb_ip}")

out = run('nft list set inet pinpoint tunnel_ips 2>&1')
if fb_ip and fb_ip in out:
    print("   PROBLEM: Facebook IP is in tunnel_ips!")
else:
    print("   OK: Facebook IP NOT in tunnel_ips")

ssh.close()
