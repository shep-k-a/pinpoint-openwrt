#!/bin/sh
# Скрипт для восстановления сетевого доступа к роутерy после установки PinPoint
# Использование: скопируйте на роутер и выполните через SSH/консоль

echo "=== Восстановление сетевого доступа ==="

# 1. Восстановить DNS настройки
echo "Восстанавливаю DNS..."
uci set dhcp.@dnsmasq[0].noresolv='0' 2>/dev/null || true
uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
uci add_list dhcp.@dnsmasq[0].server='8.8.8.8' 2>/dev/null || true
uci add_list dhcp.@dnsmasq[0].server='1.1.1.1' 2>/dev/null || true
uci commit dhcp

# 2. Остановить https-dns-proxy если он мешает
/etc/init.d/https-dns-proxy stop 2>/dev/null || true
/etc/init.d/https-dns-proxy disable 2>/dev/null || true

# 3. Перезапустить dnsmasq
/etc/init.d/dnsmasq restart

# 4. Проверить сетевые интерфейсы
echo "Проверяю сетевые интерфейсы..."
ip link show

# 5. Проверить маршрутизацию
echo "Проверяю маршруты..."
ip route show

# 6. Проверить firewall
echo "Проверяю firewall..."
/etc/init.d/firewall status

echo "=== Готово ==="
echo "Попробуйте: ping 8.8.8.8"
