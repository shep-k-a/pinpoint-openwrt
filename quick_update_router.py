#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Быстрая загрузка обновлённых файлов на роутер"""

import paramiko
import sys
import io
from scp import SCPClient

# Фикс кодировки для Windows
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROUTER_IP = '192.168.5.1'
ROUTER_USER = 'root'
ROUTER_PASS = 'k512566K'

# Только критичные файлы
FILES_TO_SYNC = {
    'luci-app-pinpoint/root/usr/share/rpcd/ucode/pinpoint.uc': '/usr/share/rpcd/ucode/pinpoint.uc',
    'luci-app-pinpoint/htdocs/luci-static/resources/view/pinpoint/settings.js': '/www/luci-static/resources/view/pinpoint/settings.js',
    'luci-app-pinpoint/htdocs/luci-static/resources/view/pinpoint/tunnels.js': '/www/luci-static/resources/view/pinpoint/tunnels.js',
    'luci-app-pinpoint/htdocs/luci-static/resources/view/pinpoint/custom.js': '/www/luci-static/resources/view/pinpoint/custom.js',
    'luci-app-pinpoint/htdocs/luci-static/resources/view/pinpoint/services.js': '/www/luci-static/resources/view/pinpoint/services.js',
    'luci-app-pinpoint/root/usr/share/rpcd/acl.d/luci-app-pinpoint.json': '/usr/share/rpcd/acl.d/luci-app-pinpoint.json',
}

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print("[*] Подключаюсь к роутеру...")
        ssh.connect(ROUTER_IP, username=ROUTER_USER, password=ROUTER_PASS, timeout=15)
        print("[OK] Подключено\n")
        
        scp = SCPClient(ssh.get_transport())
        
        print("=" * 60)
        print("[UPDATE] Загрузка обновлённых файлов")
        print("=" * 60)
        
        for local, remote in FILES_TO_SYNC.items():
            try:
                print(f"\n[→] {local} -> {remote}")
                scp.put(local, remote)
                print(f"[OK] Загружено")
            except Exception as e:
                print(f"[ERROR] {e}")
        
        print("\n[→] Установка прав доступа...")
        ssh.exec_command("chmod +x /usr/share/rpcd/ucode/pinpoint.uc 2>/dev/null || true")
        
        print("[→] Перезапуск rpcd...")
        ssh.exec_command("/etc/init.d/rpcd restart 2>/dev/null")
        
        print("[→] Перезапуск uhttpd...")
        ssh.exec_command("/etc/init.d/uhttpd restart 2>/dev/null")
        
        print("[→] Очистка кэша LuCI...")
        ssh.exec_command("rm -rf /tmp/luci-* 2>/dev/null || true")
        
        print("\n" + "=" * 60)
        print("[SUCCESS] Файлы обновлены!")
        print("=" * 60)
        print("\nОбновлено:")
        for local in FILES_TO_SYNC.keys():
            print(f"  ✓ {local}")
        
    except paramiko.ssh_exception.SSHException as e:
        print(f"[ERROR] SSH ошибка: {e}")
        print("[INFO] Проверьте подключение к роутеру")
    except Exception as e:
        print(f"[ERROR] Ошибка: {e}")
        import traceback
        traceback.print_exc()
    finally:
        try:
            scp.close()
        except:
            pass
        ssh.close()

if __name__ == '__main__':
    main()
