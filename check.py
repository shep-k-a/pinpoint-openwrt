#!/usr/bin/env python3
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.5.1', username='root', password='k512566K', timeout=10)

# Check if enabled-only-filter exists in services.js
stdin, stdout, stderr = ssh.exec_command('grep -c "enabled-only-filter" /www/luci-static/resources/view/pinpoint/services.js')
print("enabled-only-filter count:", stdout.read().decode().strip())

# Check file size
stdin, stdout, stderr = ssh.exec_command('ls -la /www/luci-static/resources/view/pinpoint/services.js')
print(stdout.read().decode())

# Clear cache again
ssh.exec_command('rm -rf /tmp/luci-* /var/luci-*')
print("Cache cleared")

ssh.close()
