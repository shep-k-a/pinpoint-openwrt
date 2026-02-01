#!/usr/bin/env python3
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.5.1', username='root', password='k512566K', timeout=10)

def run(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    return stdout.read().decode('utf-8', errors='replace').strip()

print("Clearing LuCI cache...")
print(run('rm -rf /tmp/luci-* 2>&1'))
print(run('rm -rf /tmp/luci-indexcache* 2>&1'))
print(run('rm -rf /var/luci-* 2>&1'))
print("Done!")

ssh.close()
