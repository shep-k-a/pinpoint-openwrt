# PinPoint Installation - Production Ready Checklist

## Критические исправления (применены)

### 1. ✅ Sing-box конфигурация при установке
- **Проблема**: DNS серверы не имели `detour: "direct-out"`, что приводило к DNS loopback
- **Исправление**: Добавлен `"detour": "direct-out"` для всех DNS серверов в `install.sh`
- **Файл**: `install.sh` - функция `create_singbox_config()`

### 2. ✅ Route.final в начальной конфигурации
- **Проблема**: `route.final` не был установлен, sing-box использовал `auto` по умолчанию
- **Исправление**: Установлен `"final": "direct-out"` в дефолтном конфиге (до добавления VPN туннелей)
- **Файл**: `install.sh` - функция `create_singbox_config()`

### 3. ✅ Порядок outbounds и route.final после обновления подписки
- **Проблема**: После добавления VPN туннелей `direct-out` оставался первым, весь трафик шёл напрямую
- **Исправление**: 
  - Функция `clean_config_outbounds()` теперь размещает VPN туннели первыми
  - Автоматически устанавливает `route.final` на первый VPN туннель
- **Файл**: `luci-app-pinpoint/root/usr/share/rpcd/ucode/pinpoint.uc`

### 4. ✅ Обязательные outbounds: direct-out и dns-out
- **Проблема**: В некоторых случаях outbound с тегом `direct-out` отсутствовал или не имел тега
- **Исправление**: 
  - `clean_config_outbounds()` гарантирует наличие `direct-out` и `dns-out` с правильными тегами
  - Правильный порядок: [VPN туннели] → direct-out → dns-out → [другие]
- **Файл**: `luci-app-pinpoint/root/usr/share/rpcd/ucode/pinpoint.uc`

### 5. ✅ Версионная совместимость (address vs inet4_address)
- **Проблема**: Sing-box < 1.11.0 использует `address`, >= 1.11.0 использует `inet4_address`
- **Исправление**: 
  - `install.sh` определяет версию и создаёт правильный конфиг
  - `clean_config_outbounds()` определяет версию и использует правильное поле
- **Файлы**: `install.sh`, `pinpoint.uc`

### 6. ✅ DNS detour для всех DNS серверов
- **Проблема**: DNS запросы могли уходить в VPN туннель, вызывая loopback
- **Исправление**: Все DNS серверы получают `"detour": "direct-out"` в `clean_config_outbounds()`
- **Файл**: `luci-app-pinpoint/root/usr/share/rpcd/ucode/pinpoint.uc`

### 7. ✅ NFTables: правильный приоритет и conntrack
- **Проблема**: Пакеты маркировались, но не роутились через VPN из-за неправильных hook'ов
- **Исправление**: 
  - `prerouting` chain использует `priority raw - 1` (не `mangle - 1`)
  - Добавлены conntrack правила для отслеживания соединений
  - `ip rule` приоритет изменён с 100 на 50
- **Файлы**: `etc/nftables.d/pinpoint.nft`, `install.sh`, `scripts/pinpoint-init.sh`

### 8. ✅ Fwmark консистентность
- **Проблема**: В разных файлах использовался разный fwmark (0x100 vs 0x1)
- **Исправление**: Везде используется `0x1`
- **Файлы**: `etc/nftables.d/pinpoint.nft`, `install.sh`, `scripts/pinpoint-init.sh`

## Что происходит при чистой установке

### Шаг 1: Установка sing-box
1. Приоритет: `opkg` из официального репозитория OpenWRT
2. Затем: `opkg` из ImmortalWRT репозитория
3. Затем: Прямое скачивание из ImmortalWRT
4. Затем: GitHub SagerNet (pinned version) с MIPS variants
5. Затем: GitHub SagerNet (latest release)
6. Затем: Старые версии для MIPS совместимости

### Шаг 2: Создание начального конфига sing-box
```json
{
  "dns": {
    "servers": [
      {"tag": "google", "address": "8.8.8.8", "detour": "direct-out"},
      {"tag": "local", "address": "127.0.0.1", "detour": "direct-out"}
    ]
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "inet4_address": "10.0.0.1/30",  // или "address" для < 1.11.0
      ...
    }
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct-out"},
    {"type": "dns", "tag": "dns-out"}
  ],
  "route": {
    "rules": [{"protocol": "dns", "outbound": "dns-out"}],
    "final": "direct-out",  // ВАЖНО: до добавления VPN
    "auto_detect_interface": true
  }
}
```

### Шаг 3: Установка LuCI приложения
- Создаётся `/etc/config/pinpoint`
- Очищается кэш LuCI (`rm -rf /tmp/luci-*`)
- Перезапускается `rpcd`
- Меню доступно в: **Services → PinPoint**

### Шаг 4: Настройка DNS
- Проверяется, работает ли `https-dns-proxy` на порту 5053
- Если да: `dnsmasq` настраивается на DoH
- Если нет: используются публичные DNS (8.8.8.8, 1.1.1.1)
- `dnsmasq` перезапускается

### Шаг 5: Настройка firewall и routing
- NFTables правила для маркировки пакетов (fwmark 0x1)
- IP правила для маршрутизации маркированных пакетов через table 100
- Conntrack отслеживание для двунаправленной маршрутизации
- Masquerade для tun1

## Что происходит при первом добавлении подписки

### 1. Пользователь добавляет subscription URL
### 2. При нажатии "Update Subscriptions":

```
update_subscriptions() вызывается:
  1. Скачивается subscription content
  2. Декодируется Base64 (если нужно)
  3. Парсится (JSON или plain links)
  4. Создаются outbound'ы с _subscription метаданными
  5. config.outbounds обновляется
  6. clean_config_outbounds() вызывается:
     - Удаляет _subscription поля
     - Переупорядочивает: [VPN] → direct-out → dns-out
     - Устанавливает route.final на первый VPN туннель
     - Обеспечивает TUN inbound
     - Обеспечивает DNS detour для всех DNS серверов
  7. Config сохраняется
  8. sing-box перезапускается
```

### 3. После перезапуска sing-box:
- Первый outbound = VPN туннель
- `route.final` = тег VPN туннеля
- Весь трафик, попадающий в `tunnel_ips`/`tunnel_nets`, идёт через VPN

## Что происходит при смене активного туннеля

```
set_active_tunnel({tag: "new_tunnel"}) вызывается:
  1. Читается config
  2. Находится outbound с указанным тегом
  3. Перемещается на первую позицию
  4. clean_config_outbounds() вызывается (переупорядочивает VPN первым, устанавливает route.final)
  5. Config сохраняется
  6. sing-box перезапускается
```

## Критические функции в pinpoint.uc

### clean_config_outbounds(config)
**Цель**: Очистка конфига от внутренних полей и обеспечение корректной структуры

**Действия**:
1. Удаляет `_subscription` из всех outbounds
2. Переупорядочивает outbounds:
   - VPN туннели (vless, vmess, trojan, shadowsocks, wireguard, hysteria, hysteria2)
   - direct-out (создаёт, если нет)
   - dns-out (создаёт, если нет)
   - Остальные
3. Обеспечивает TUN inbound (определяет версию для address/inet4_address)
4. Устанавливает `route.final` на первый VPN туннель (или direct-out, если VPN нет)
5. Обеспечивает DNS routing rule
6. Устанавливает `detour: "direct-out"` для всех DNS серверов

**Используется в**:
- `update_subscriptions()` - после добавления туннелей
- `set_active_tunnel()` - после смены активного туннеля
- `restart()` - перед перезапуском
- `apply()` - при применении изменений
- `set_service_route()` - при изменении роутинга сервисов
- `enable_service()` / `disable_service()` - при вкл/выкл сервисов
- `update_service()` - при обновлении сервисов

## Тестирование новой установки

### 1. Чистая установка
```bash
curl -fsSL https://raw.githubusercontent.com/shep-k-a/pinpoint-openwrt/master/install.sh | sh
```

### 2. Проверка после установки
```bash
# Sing-box установлен и работает
pgrep sing-box

# Конфиг валиден
sing-box check -c /etc/sing-box/config.json

# LuCI доступен
# http://<router-ip>/cgi-bin/luci/admin/services/pinpoint

# NFTables правила загружены
nft list table inet pinpoint
```

### 3. Добавление подписки через UI
1. Services → PinPoint → Tunnels
2. Add Subscription → вставить URL
3. Update Subscriptions
4. Проверить логи: `logread | grep sing-box`
5. Должно быть: `outbound/vless[tunnel_tag]`, НЕ `outbound/direct[direct-out]`

### 4. Включение сервиса (например, Instagram)
1. Services → Enable Instagram
2. Update Services
3. Проверить routing: `curl -v https://www.instagram.com`
4. Логи должны показывать VPN outbound

### 5. Финальная проверка
```bash
# VPN активен
ubus call luci.pinpoint status
# vpn_active: true
# singbox_running: true

# Трафик идёт через VPN
logread | grep sing-box | tail -5
# Должно быть: outbound/vless[tunnel_name]

# Внешний IP изменён (если VPN работает)
curl ifconfig.me
```

## Известные ограничения

1. **MIPS архитектура**: Не все версии sing-box доступны для MIPS. Скрипт пробует несколько вариантов.
2. **Память роутера**: Минимум 128MB RAM рекомендуется.
3. **DoH (https-dns-proxy)**: Устанавливается только в "Full" режиме, в "Lite" используются публичные DNS.

## Файлы, затронутые исправлениями

1. `install.sh` - основной скрипт установки
2. `luci-app-pinpoint/root/usr/share/rpcd/ucode/pinpoint.uc` - LuCI RPC backend
3. `etc/nftables.d/pinpoint.nft` - NFTables правила
4. `scripts/pinpoint-init.sh` - Инициализация routing при загрузке
5. `luci-app-pinpoint/root/usr/share/luci/menu.d/luci-app-pinpoint.json` - LuCI меню

## Commit History (последние исправления)

1. DNS detour и route.final в начальном конфиге
2. Переупорядочивание outbounds (VPN первым)
3. Обеспечение direct-out с тегом
4. NFTables приоритет и conntrack
5. Fwmark консистентность (0x1)
