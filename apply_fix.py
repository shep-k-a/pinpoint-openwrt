#!/usr/bin/env python3
import paramiko

# Upload script
local = r"c:\Files\Projects\openwrt-sftp\luci-app-pinpoint\root\opt\pinpoint\scripts\pinpoint-update.sh"
remote = "/opt/pinpoint/scripts/pinpoint-update.sh"

with open(local, 'r', encoding='utf-8') as f:
    content = f.read().replace('\r\n', '\n')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.5.1', username='root', password='k512566K', timeout=10)

stdin, stdout, stderr = ssh.exec_command(f'cat > {remote}')
stdin.write(content.encode('utf-8'))
stdin.channel.shutdown_write()
stdout.read()
ssh.exec_command(f'chmod +x {remote}')
print("Script uploaded")

def run(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=60)
    return stdout.read().decode('utf-8', errors='replace').strip()

# Run update
print("\nRunning update...")
print(run('/opt/pinpoint/scripts/pinpoint-update.sh update 2>&1'))

# Check tunnel_nets
print("\n=== tunnel_nets after update ===")
print(run('nft list set inet pinpoint tunnel_nets 2>&1'))

ssh.close()
