#!/usr/bin/env python3
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.5.1', username='root', password='k512566K', timeout=10)

local = r"c:\Files\Projects\openwrt-sftp\luci-app-pinpoint\htdocs\luci-static\resources\view\pinpoint\devices.js"
remote = "/www/luci-static/resources/view/pinpoint/devices.js"

with open(local, 'rb') as f:
    content = f.read()

stdin, stdout, stderr = ssh.exec_command(f'cat > {remote}')
stdin.write(content)
stdin.channel.shutdown_write()
stdout.read()

ssh.exec_command('rm -rf /tmp/luci-* 2>/dev/null')
ssh.close()
print("Done!")
