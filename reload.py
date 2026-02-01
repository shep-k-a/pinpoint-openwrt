#!/usr/bin/env python3
import paramiko

files = [
    (r"c:\Files\Projects\openwrt-sftp\luci-app-pinpoint\htdocs\luci-static\resources\view\pinpoint\devices.js",
     "/www/luci-static/resources/view/pinpoint/devices.js"),
    (r"c:\Files\Projects\openwrt-sftp\luci-app-pinpoint\htdocs\luci-static\resources\view\pinpoint\services.js",
     "/www/luci-static/resources/view/pinpoint/services.js"),
]

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.5.1', username='root', password='k512566K', timeout=10)

for local, remote in files:
    with open(local, 'rb') as f:
        content = f.read()
    
    # Delete old file first
    ssh.exec_command(f'rm -f {remote}')
    
    # Upload new file
    stdin, stdout, stderr = ssh.exec_command(f'cat > {remote}')
    stdin.write(content)
    stdin.channel.shutdown_write()
    stdout.read()
    
    # Verify
    stdin2, stdout2, stderr2 = ssh.exec_command(f'wc -c {remote}')
    size = stdout2.read().decode().strip()
    print(f"Uploaded {remote.split('/')[-1]}: {size}")

# Clear all caches
ssh.exec_command('rm -rf /tmp/luci-* /var/luci-* 2>/dev/null')
print("Cache cleared")

ssh.close()
print("\nDone! Now close browser completely and reopen.")
