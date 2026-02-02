#!/bin/sh
# Готовое решение для исправления Instagram и задержки

echo "=== Исправление Instagram и задержки ==="

# 1. Создать NFTables таблицу
echo "1. Создание NFTables таблицы..."
if ! nft list table inet pinpoint >/dev/null 2>&1; then
    if [ -f /opt/pinpoint/scripts/pinpoint-init.sh ]; then
        /opt/pinpoint/scripts/pinpoint-init.sh start
    else
        # Создать таблицу вручную
        nft -f - << 'EOF'
table inet pinpoint {
    set tunnel_ips {
        type ipv4_addr
        flags timeout
        timeout 1h
    }
    
    set tunnel_nets {
        type ipv4_addr
        flags interval
    }
    
    chain prerouting {
        type filter hook prerouting priority raw - 1; policy accept;
        
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        
        ip daddr @tunnel_ips ct mark set 0x1 counter comment "pinpoint: mark-connection"
        ip daddr @tunnel_nets ct mark set 0x1 counter comment "pinpoint: mark-connection-static"
        
        ct mark 0x1 meta mark set 0x1 counter comment "pinpoint: mark-by-connection"
        
        ip daddr @tunnel_ips meta mark set 0x1 counter comment "pinpoint: dns-resolved"
        ip daddr @tunnel_nets meta mark set 0x1 counter comment "pinpoint: static-lists"
    }
    
    chain output {
        type route hook output priority mangle - 1; policy accept;
        
        ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } return
        
        ip daddr @tunnel_ips meta mark set 0x1 counter comment "pinpoint: dns-resolved"
        ip daddr @tunnel_nets meta mark set 0x1 counter comment "pinpoint: static-lists"
    }
}
EOF
    fi
    echo "   NFTables таблица создана"
else
    echo "   NFTables таблица уже существует"
fi

# 2. Переместить dnsmasq конфиг
echo "2. Настройка dnsmasq..."
mkdir -p /tmp/dnsmasq.d
if [ -f /etc/dnsmasq.d/pinpoint-services.conf ]; then
    cp /etc/dnsmasq.d/pinpoint-services.conf /tmp/dnsmasq.d/pinpoint.conf
    echo "   Конфиг перемещён"
fi

# 3. Обновить сервисы
echo "3. Обновление сервисов..."
if [ -f /opt/pinpoint/scripts/pinpoint-update.sh ]; then
    /opt/pinpoint/scripts/pinpoint-update.sh update >/dev/null 2>&1
    echo "   Сервисы обновлены"
fi

# 4. Добавить Instagram IP
echo "4. Добавление Instagram IP..."
INSTAGRAM_IP=$(nslookup instagram.com 8.8.8.8 2>/dev/null | grep -A2 "Name:" | grep "Address:" | grep -E "^[[:space:]]*Address:[[:space:]]*[0-9]" | awk '{print $2}' | grep -E "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$" | head -1)
if [ -n "$INSTAGRAM_IP" ]; then
    nft add element inet pinpoint tunnel_ips { $INSTAGRAM_IP } 2>/dev/null && echo "   Добавлен: $INSTAGRAM_IP"
fi

# 5. Обновить pinpoint.uc
echo "5. Обновление pinpoint.uc..."
cd /tmp
wget -q -O pinpoint.uc "https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/luci-app-pinpoint/root/usr/share/rpcd/ucode/pinpoint.uc"
if [ -f pinpoint.uc ]; then
    cp pinpoint.uc /usr/share/rpcd/ucode/pinpoint.uc
    rm -rf /tmp/luci-*
    /etc/init.d/rpcd restart >/dev/null 2>&1
    echo "   pinpoint.uc обновлён"
fi

# 6. Перезапустить dnsmasq
echo "6. Перезапуск dnsmasq..."
/etc/init.d/dnsmasq restart >/dev/null 2>&1

echo ""
echo "=== Готово! ==="
echo "Instagram должен работать, задержка должна отображаться в LuCI."
