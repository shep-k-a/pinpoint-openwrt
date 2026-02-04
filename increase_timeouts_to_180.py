#!/usr/bin/env python3
"""Increase timeouts to 180 seconds"""

import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("192.168.5.1", username="root", password="k512566K", timeout=10)

print("\n" + "="*60)
print("  Increasing Timeouts to 180 seconds")
print("="*60)

commands = """
# Increase rpcd timeout to 180s
uci set rpcd.@rpcd[0].socket_timeout='180'
uci commit rpcd

# Increase uhttpd timeout to 180s
uci set uhttpd.main.script_timeout='180'
uci set uhttpd.main.network_timeout='180'
uci commit uhttpd

# Restart services
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart

# Verify
echo "=== Configuration ==="
uci show rpcd | grep timeout
uci show uhttpd.main | grep timeout
"""

print("\nApplying timeout changes...")
stdin, stdout, stderr = ssh.exec_command(commands)
stdout.channel.recv_exit_status()

out = stdout.read().decode()
print(out)

print("\n" + "="*60)
print("  [SUCCESS] Timeouts set to 180 seconds")
print("="*60)
print("\nConfiguration:")
print("  - rpcd socket_timeout: 180s")
print("  - uhttpd script_timeout: 180s")
print("  - uhttpd network_timeout: 180s")
print("\nThis allows for very slow operations like:")
print("  - Loading all 81 services with IPs")
print("  - GitHub updates (slow connection)")
print("  - Mass IP list loading")

ssh.close()
