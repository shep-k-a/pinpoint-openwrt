#!/usr/bin/env python3
"""Force clients to use router DNS"""

import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("192.168.5.1", username="root", password="k512566K", timeout=10)

print("\n" + "="*60)
print("  Forcing Clients to Use Router DNS")
print("="*60)

# 1. Verify DHCP DNS option
print("\n1. Checking DHCP DNS option...")
stdin, stdout, stderr = ssh.exec_command("uci show dhcp.lan.dhcp_option")
print(stdout.read().decode())

# 2. Ensure it's set correctly
print("\n2. Setting DHCP DNS option...")
stdin, stdout, stderr = ssh.exec_command("""
uci -q delete dhcp.lan.dhcp_option
uci add_list dhcp.lan.dhcp_option='6,192.168.5.1'
uci commit dhcp
""")
stdout.channel.recv_exit_status()
print("[OK] DHCP DNS option set to 192.168.5.1")

# 3. Restart DHCP server
print("\n3. Restarting DHCP server (odhcpd)...")
stdin, stdout, stderr = ssh.exec_command("/etc/init.d/odhcpd restart")
stdout.channel.recv_exit_status()
print("[OK] odhcpd restarted")

# 4. Restart dnsmasq
print("\n4. Restarting dnsmasq...")
stdin, stdout, stderr = ssh.exec_command("/etc/init.d/dnsmasq restart")
stdout.channel.recv_exit_status()
print("[OK] dnsmasq restarted")

# 5. Show active leases
print("\n5. Active DHCP Leases:")
stdin, stdout, stderr = ssh.exec_command("cat /var/dhcp.leases")
print(stdout.read().decode())

print("\n" + "="*60)
print("  ACTION REQUIRED ON CLIENT DEVICE")
print("="*60)

print("\n[CRITICAL] Clients must renew DHCP lease to get new DNS!")
print("\nOn CLIENT device (192.168.5.128 or 192.168.5.210):")
print("\nWindows:")
print("  1. Open Command Prompt (Admin)")
print("  2. Run: ipconfig /release")
print("  3. Run: ipconfig /renew")
print("  4. Run: ipconfig /flushdns")
print("  5. Verify: nslookup instagram.com")
print("     Should show: Server: 192.168.5.1")
print("\nAndroid:")
print("  1. WiFi -> Long press your network")
print("  2. Forget network")
print("  3. Reconnect")
print("  4. Check DNS: Settings -> WiFi -> Advanced -> DNS")
print("     Should show: 192.168.5.1")
print("\niOS:")
print("  1. Settings -> WiFi -> (i) next to network")
print("  2. Forget This Network")
print("  3. Reconnect")
print("  4. Check DNS: Should be 192.168.5.1")
print("\nAlternative (Manual DNS):")
print("  On client, manually set DNS to: 192.168.5.1")
print("  (This bypasses DHCP and works immediately)")

print("\n" + "="*60)
print("  After Renewing DHCP Lease")
print("="*60)
print("\n1. On client, run: nslookup instagram.com")
print("   Should show: Server: 192.168.5.1")
print("\n2. On router, check logs:")
print("   logread | grep query | tail -5")
print("   Should see queries from client IP")
print("\n3. Try opening: https://www.instagram.com/")
print("   Should work now!")

ssh.close()
