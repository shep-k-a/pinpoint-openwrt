#!/usr/bin/env python3
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.5.1', username='root', password='k512566K', timeout=10)

# Check rpcd logs
print("=== Check what JS sends - enable rpcd debug ===")
stdin, stdout, stderr = ssh.exec_command('''
# Create a wrapper to log rpcd calls
cat > /tmp/test_rpc.sh << 'EOFSH'
#!/bin/sh
echo "Testing RPC..." > /tmp/rpc_test.log
ubus call luci.pinpoint set_device '{"id":"ca:2a:50:a7:fd:36","enabled":true}' >> /tmp/rpc_test.log 2>&1
cat /opt/pinpoint/data/devices.json >> /tmp/rpc_test.log
EOFSH
chmod +x /tmp/test_rpc.sh
/tmp/test_rpc.sh
cat /tmp/rpc_test.log
''')
print(stdout.read().decode())
print(stderr.read().decode())

# Now check current state
print("\n=== Current devices.json ===")
stdin, stdout, stderr = ssh.exec_command('cat /opt/pinpoint/data/devices.json')
print(stdout.read().decode())

ssh.close()
