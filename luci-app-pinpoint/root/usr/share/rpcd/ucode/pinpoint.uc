// SPDX-License-Identifier: GPL-2.0-only
// PinPoint RPC backend for LuCI (Full Version)

'use strict';

import { readfile, writefile, popen, stat, mkdir, unlink } from 'fs';

const PINPOINT_DIR = '/opt/pinpoint';
const DATA_DIR = PINPOINT_DIR + '/data';
const SERVICES_FILE = DATA_DIR + '/services.json';
const DEVICES_FILE = DATA_DIR + '/devices.json';
const CUSTOM_FILE = DATA_DIR + '/custom_services.json';
const SUBSCRIPTIONS_FILE = DATA_DIR + '/subscriptions.json';
const SETTINGS_FILE = DATA_DIR + '/settings.json';

// Helper: read JSON file
function read_json(path) {
	let content = readfile(path);
	if (!content) return null;
	try {
		return json(content);
	} catch(e) {
		return null;
	}
}

// Helper: write JSON file
function write_json(path, data) {
	return writefile(path, sprintf('%J', data));
}

// Helper: run command and get output
function run_cmd(cmd) {
	let p = popen(cmd, 'r');
	if (!p) return null;
	let out = p.read('all');
	p.close();
	return out;
}

// Helper: clean outbound from internal fields before saving
function clean_outbound(ob) {
	// Create a clean copy without internal fields
	let clean = {};
	for (let key in ob) {
		// Skip internal fields that sing-box doesn't understand
		if (key != '_subscription') {
			clean[key] = ob[key];
		}
	}
	return clean;
}

// Helper: clean all outbounds in config
function clean_config_outbounds(config) {
	if (!config || !config.outbounds) return config;
	
	let cleaned = {};
	for (let key in config) {
		if (key == 'dns') continue;
		if (key == 'outbounds') {
			cleaned[key] = [];
			for (let ob in config.outbounds) {
				push(cleaned[key], clean_outbound(ob));
			}
		} else if (key == 'inbounds' && config.inbounds) {
			// Migrate TUN legacy "address" to "inet4_address" (sing-box 1.10+)
			cleaned.inbounds = [];
			for (let i = 0; i < length(config.inbounds); i++) {
				let ib = config.inbounds[i];
				if (ib && ib.type == 'tun' && ib.address !== undefined) {
					let new_ib = {};
					for (let k in ib) if (k != 'address') new_ib[k] = ib[k];
					new_ib.inet4_address = (ib.address && length(ib.address) > 0) ? ib.address[0] : '10.0.0.1/30';
					push(cleaned.inbounds, new_ib);
				} else {
					push(cleaned.inbounds, ib);
				}
			}
		} else {
			cleaned[key] = config[key];
		}
	}
	
	// Ensure TUN inbound exists
	if (!cleaned.inbounds || length(cleaned.inbounds) == 0) {
		// Detect sing-box version to use correct format
		let sb_version = run_cmd('sing-box version 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" | head -1');
		let use_legacy_format = false;
		
		if (sb_version) {
			sb_version = trim(sb_version);
			let version_parts = split(sb_version, '.');
			if (version_parts && length(version_parts) >= 2) {
				let major = int(version_parts[0]);
				let minor = int(version_parts[1]);
				// Versions < 1.10.0 use "address"; 1.10+ use "inet4_address" (deprecation)
				if (major < 1 || (major == 1 && minor < 10)) {
					use_legacy_format = true;
				}
			}
		}
		
		let tun_inbound = {
			type: 'tun',
			tag: 'tun-in',
			interface_name: 'tun1',
			mtu: 1400,
			auto_route: false,
			sniff: true,
			stack: 'gvisor'
		};
		tun_inbound[use_legacy_format ? 'address' : 'inet4_address'] = use_legacy_format ? ['10.0.0.1/30'] : '10.0.0.1/30';
		
		cleaned.inbounds = [tun_inbound];
	} else {
		let has_tun = false;
		for (let inbound in cleaned.inbounds) {
			if (inbound.type == 'tun') {
				has_tun = true;
				break;
			}
		}
		
		if (!has_tun) {
			let sb_version = run_cmd('sing-box version 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" | head -1');
			let use_legacy_format = false;
			if (sb_version) {
				sb_version = trim(sb_version);
				let version_parts = split(sb_version, '.');
				if (version_parts && length(version_parts) >= 2) {
					let major = int(version_parts[0]);
					let minor = int(version_parts[1]);
					if (major < 1 || (major == 1 && minor < 10)) use_legacy_format = true;
				}
			}
			let tun_inbound = {
				type: 'tun',
				tag: 'tun-in',
				interface_name: 'tun1',
				mtu: 1400,
				auto_route: false,
				sniff: true,
				stack: 'gvisor'
			};
			tun_inbound[use_legacy_format ? 'address' : 'inet4_address'] = use_legacy_format ? ['10.0.0.1/30'] : '10.0.0.1/30';
			
			// Insert at beginning
			let new_inbounds = [tun_inbound];
			for (let inbound in cleaned.inbounds) {
				push(new_inbounds, inbound);
			}
			cleaned.inbounds = new_inbounds;
		}
	}
	
	// Reorder outbounds: VPN tunnels first, then direct-out, then others
	// NOTE: dns-out is NOT added (removed to prevent memory leaks)
	// This ensures that with final='auto', sing-box will use the first VPN tunnel
	let vpn_outbounds = [];
	let direct_out = null;
	let other_outbounds = [];
	
	for (let ob in cleaned.outbounds) {
		let tag = ob.tag || '';
		let ob_type = ob.type || '';
		
		// Remove DNS outbounds - they cause memory leaks
		if (tag == 'dns-out' || ob_type == 'dns') {
			continue; // Skip DNS outbounds completely
		}
		
		if (tag == 'direct-out') {
			direct_out = ob;
		} else {
			// Check if it's a VPN tunnel type
			let is_vpn = (ob_type == 'vless' || ob_type == 'vmess' || ob_type == 'trojan' || 
			              ob_type == 'shadowsocks' || ob_type == 'wireguard' || 
			              ob_type == 'hysteria' || ob_type == 'hysteria2');
			
			if (is_vpn) {
				push(vpn_outbounds, ob);
			} else {
				push(other_outbounds, ob);
			}
		}
	}
	
	// Rebuild outbounds in correct order
	let new_outbounds = [];
	
	// 1. VPN tunnels first (so they're used by default with final='auto')
	if (vpn_outbounds) {
		for (let i = 0; i < length(vpn_outbounds); i++) {
			push(new_outbounds, vpn_outbounds[i]);
		}
	}
	
	// 2. direct-out (create if missing)
	if (!direct_out) {
		direct_out = { type: 'direct', tag: 'direct-out' };
	}
	push(new_outbounds, direct_out);
	
	// 3. dns-out - REMOVED to prevent memory leaks
	// DNS is handled by dnsmasq + https-dns-proxy, not sing-box
	// Do NOT add dns-out outbound
	
	// 4. Other outbounds
	if (other_outbounds) {
		for (let i = 0; i < length(other_outbounds); i++) {
			push(new_outbounds, other_outbounds[i]);
		}
	}
	
	cleaned.outbounds = new_outbounds;
	
	// Ensure route section exists with DNS rule and final outbound
	if (!cleaned.route) {
		cleaned.route = {
			rules: [],
			auto_detect_interface: true
		};
	}
	
	// Set final outbound to first VPN tunnel (if exists)
	if (vpn_outbounds && length(vpn_outbounds) > 0) {
		let first_vpn = vpn_outbounds[0];
		if (first_vpn && first_vpn.tag) {
			cleaned.route.final = first_vpn.tag;
		} else {
			cleaned.route.final = 'direct-out';
		}
	} else {
		// Fallback to auto if no VPN tunnels
		cleaned.route.final = 'direct-out';
	}
	
	// DNS rule - REMOVED to prevent memory leaks
	// DNS is handled by dnsmasq + https-dns-proxy, not sing-box
	// Remove any existing DNS rules
	let filtered_rules = [];
	for (let rule in cleaned.route.rules) {
		if (rule.protocol != 'dns') {
			push(filtered_rules, rule);
		}
	}
	cleaned.route.rules = filtered_rules;
	
	// DNS configuration - REMOVED to prevent memory leaks
	// DNS is handled by dnsmasq + https-dns-proxy, not sing-box
	// Remove DNS section completely to prevent hanging DNS over TLS connections
	if (cleaned.dns) {
		delete cleaned.dns;
	}
	
	return cleaned;
}

// Base64 decode using ucode built-in b64dec function
function b64decode(str) {
	if (!str) return null;
	str = trim(str);
	// Use built-in b64dec (handles whitespace internally)
	return b64dec(str);
}

// URL decode function
function urldecode(str) {
	if (!str) return str;
	// Replace + with space
	str = replace(str, /\+/g, ' ');
	// Replace %XX with character
	let result = '';
	let i = 0;
	while (i < length(str)) {
		let ch = substr(str, i, 1);
		if (ch == '%' && i + 2 < length(str)) {
			let hex_str = substr(str, i + 1, 2);
			let code = int(hex_str, 16);
			if (code != null) {
				result += chr(code);
				i += 3;
				continue;
			}
		}
		result += ch;
		i++;
	}
	return result;
}

// ===== IMPORT LINKS =====

// Parse VPN link and extract outbound config
function parse_vpn_link(link) {
	// Wrap in try-catch to catch any exceptions
	try {
		link = trim(link);
		if (!link) return null;
		
		let outbound = null;
	
	if (match(link, /^vless:\/\//)) {
		// Parse VLESS link
		let m = match(link, /^vless:\/\/([^@]+)@([^:]+):(\d+)/);
		if (m) {
			let uuid = m[1];
			let server = m[2];
			let port = +m[3];
			
			// Parse query params
			let params = {};
			let query_match = match(link, /\?([^#]+)/);
			if (query_match) {
				let pairs = split(query_match[1], '&');
				for (let i = 0; i < length(pairs); i++) {
					let pair = pairs[i];
					let kv = split(pair, '=');
					if (length(kv) == 2) {
						params[kv[0]] = kv[1];
					}
				}
			}
			
			// Get name from fragment
			let name_match = match(link, /#(.+)$/);
			let name = name_match ? urldecode(name_match[1]) : 'vless-' + server;
			
			outbound = {
				type: 'vless',
				tag: name,
				server: server,
				server_port: port,
				uuid: uuid,
				flow: params.flow || '',
				tls: {
					enabled: params.security == 'tls' || params.security == 'reality',
					server_name: params.sni || server,
					utls: { enabled: true, fingerprint: params.fp || 'chrome' }
				}
			};
			
			// Reality settings
			if (params.security == 'reality') {
				outbound.tls.reality = {
					enabled: true,
					public_key: params.pbk || '',
					short_id: params.sid || ''
				};
			}
			
			// Transport
			if (params.type == 'ws') {
				outbound.transport = {
					type: 'ws',
					path: urldecode(params.path || '/'),
					headers: { Host: params.host || server }
				};
			} else if (params.type == 'grpc') {
				outbound.transport = {
					type: 'grpc',
					service_name: params.serviceName || ''
				};
			}
		}
	} else if (match(link, /^vmess:\/\//)) {
		// Parse VMess link (base64 JSON)
		let b64 = substr(link, 8);
		let json_str = b64decode(b64);
		if (json_str) {
			try {
				let cfg = json(json_str);
				outbound = {
					type: 'vmess',
					tag: cfg.ps || 'vmess-' + cfg.add,
					server: cfg.add,
					server_port: +cfg.port,
					uuid: cfg.id,
					alter_id: +cfg.aid || 0,
					security: cfg.scy || 'auto'
				};
				
				if (cfg.tls == 'tls') {
					outbound.tls = {
						enabled: true,
						server_name: cfg.sni || cfg.add
					};
				}
				
				if (cfg.net == 'ws') {
					outbound.transport = {
						type: 'ws',
						path: cfg.path || '/',
						headers: { Host: cfg.host || cfg.add }
					};
				}
			} catch(e) {}
		}
	} else if (match(link, /^ss:\/\//)) {
		// Parse Shadowsocks link
		let rest = substr(link, 5);
		let name = '';
		let name_match = match(rest, /#(.+)$/);
		if (name_match) {
			name = urldecode(name_match[1]);
			rest = substr(rest, 0, index(rest, '#'));
		}
		
		// Try userinfo@host:port format
		let m = match(rest, /^([^@]+)@([^:]+):(\d+)/);
		if (m) {
			let userinfo = b64decode(m[1]);
			if (userinfo) {
				userinfo = trim(userinfo);
				let parts = split(userinfo, ':');
				if (parts && length(parts) >= 2) {
					outbound = {
						type: 'shadowsocks',
						tag: name || 'ss-' + m[2],
						server: m[2],
						server_port: +m[3],
						method: parts[0],
						password: parts[1]
					};
				}
			}
		}
	} else if (match(link, /^trojan:\/\//)) {
		// Parse Trojan link
		let m = match(link, /^trojan:\/\/([^@]+)@([^:]+):(\d+)/);
		if (m) {
			let password = m[1];
			let server = m[2];
			let port = +m[3];
			
			let name_match = match(link, /#(.+)$/);
			let name = name_match ? urldecode(name_match[1]) : 'trojan-' + server;
			
			outbound = {
				type: 'trojan',
				tag: name,
				server: server,
				server_port: port,
				password: password,
				tls: {
					enabled: true,
					server_name: server
				}
			};
		}
	} else if (match(link, /^hysteria2:\/\// ) || match(link, /^hy2:\/\//)) {
		// Parse Hysteria2 link
		let m = match(link, /^(?:hysteria2|hy2):\/\/([^@]+)@([^:]+):(\d+)/);
		if (m) {
			let password = m[1];
			let server = m[2];
			let port = +m[3];
			
			let name_match = match(link, /#(.+)$/);
			let name = name_match ? urldecode(name_match[1]) : 'hy2-' + server;
			
			outbound = {
				type: 'hysteria2',
				tag: name,
				server: server,
				server_port: port,
				password: password,
				tls: {
					enabled: true,
					server_name: server
				}
			};
		}
	}
	
	return outbound;
	} catch(e) {
		// Return null on any error
		return null;
	}
}

// Get VPN status
function get_status() {
	// Check if we have Python (Full mode) or shell-only (Lite mode)
	let has_python = run_cmd('command -v python3 >/dev/null 2>&1 && echo yes');
	let is_full_mode = (has_python && trim(has_python) == 'yes');
	
	// Check if tun1 is up
	let tun_up = (stat('/sys/class/net/tun1') != null);
	
	// Check sing-box process (both modes use VPN!)
	let singbox_running = false;
	let ps_out = run_cmd('pgrep sing-box');
	if (ps_out && trim(ps_out) != '') {
		singbox_running = true;
	}
	
	// Check https-dns-proxy (DoH)
	let doh_running = false;
	let doh_out = run_cmd('pgrep https-dns-proxy');
	if (doh_out && trim(doh_out) != '') {
		doh_running = true;
	}
	
	// Get nftables stats
	let packets = 0, bytes = 0, nets = 0, ips = 0;
	let nft_out = run_cmd('nft list chain inet pinpoint prerouting 2>/dev/null');
	if (nft_out) {
		let m = match(nft_out, /counter packets (\d+) bytes (\d+)/);
		if (m) {
			packets = +m[1];
			bytes = +m[2];
		}
	}
	
	// Count set elements
	let nets_out = run_cmd('nft list set inet pinpoint tunnel_nets 2>/dev/null');
	if (nets_out) {
		nets = length(split(nets_out, ','));
	}
	let ips_out = run_cmd('nft list set inet pinpoint tunnel_ips 2>/dev/null');
	if (ips_out) {
		ips = length(split(ips_out, ','));
	}
	
	// Check if routing is active (nftables rules exist)
	let routing_active = false;
	let nft_check = run_cmd('nft list table inet pinpoint 2>/dev/null');
	if (nft_check && length(trim(nft_check)) > 0) {
		routing_active = true;
	}
	
	// Count enabled services
	let services_data = read_json(SERVICES_FILE);
	let enabled_services = 0;
	if (services_data && services_data.services) {
		for (let s in services_data.services) {
			if (s.enabled) enabled_services++;
		}
	}
	
	// Read status file for last update
	let status_data = read_json(DATA_DIR + '/status.json') || {};
	
	// Both modes use VPN! Check if tun1 is up AND sing-box is running
	let vpn_active = tun_up && singbox_running;
	
	return {
		tunnel_up: tun_up,
		singbox_running: singbox_running,
		doh_running: doh_running,
		vpn_active: vpn_active,
		routing_active: routing_active,
		is_lite_mode: !is_full_mode,
		stats: {
			packets: packets,
			bytes: bytes,
			networks: nets,
			ips: ips
		},
		enabled_services: enabled_services,
		last_update: status_data.last_update || null
	};
}

// Get all services (with IPs loaded from files)
function get_services() {
	let data = read_json(SERVICES_FILE);
	if (!data) {
		return { services: [], categories: {} };
	}
	
	// Load IPs from files for each service
	let services = data.services || [];
	for (let i = 0; i < length(services); i++) {
		let service = services[i];
		let service_id = service.id;
		
		// Load IPs from {service_id}.txt file
		let ips_file = DATA_DIR + '/lists/' + service_id + '.txt';
		let ips_content = readfile(ips_file);
		let ips = [];
		
		if (ips_content) {
			ips_content = trim(ips_content);
			let lines = split(ips_content, '\n');
			for (let j = 0; j < length(lines); j++) {
				let line = trim(lines[j]);
				// Skip comments and empty lines
				if (line && !match(line, /^#/)) {
					push(ips, line);
				}
			}
		}
		
		// Add ips field to service
		services[i].ips = ips;
	}
	
	return {
		services: services,
		categories: data.categories || {}
	};
}

// Update service enabled state
function set_service(params) {
	let service_id = params.id;
	let enabled = params.enabled;
	
	if (!service_id) {
		return { error: 'Missing service id' };
	}
	
	let data = read_json(SERVICES_FILE);
	if (!data || !data.services) {
		return { error: 'Services file not found' };
	}
	
	let found = false;
	for (let i = 0; i < length(data.services); i++) {
		if (data.services[i].id == service_id) {
			data.services[i].enabled = !!enabled;
			found = true;
			break;
		}
	}
	
	if (!found) {
		return { error: 'Service not found' };
	}
	
	write_json(SERVICES_FILE, data);
	
	// Check if service needs IP list update (when enabling without existing lists)
	let needs_update = false;
	if (enabled) {
		let ips_file = DATA_DIR + '/lists/' + service_id + '.txt';
		let ips_stat = stat(ips_file);
		needs_update = (!ips_stat || ips_stat.size == 0);
	}
	
	// IMPORTANT: Do NOT call reload/update here!
	// Frontend will handle applying changes via separate apply() call
	// This keeps RPC response instant and prevents timeout
	
	return { 
		success: true, 
		id: service_id, 
		enabled: !!enabled,
		needs_update: needs_update,
		message: enabled ? 'Service enabled' : 'Service disabled'
	};
}

// Edit service (add custom domains and IPs)
function edit_service(params) {
	let service_id = params.id;
	let custom_domains = params.custom_domains || [];
	let custom_ips = params.custom_ips || [];
	
	if (!service_id) {
		return { error: 'Missing service id' };
	}
	
	let data = read_json(SERVICES_FILE);
	if (!data || !data.services) {
		return { error: 'Services file not found' };
	}
	
	let found = false;
	for (let i = 0; i < length(data.services); i++) {
		if (data.services[i].id == service_id) {
			// Store custom entries
			data.services[i].custom_domains = custom_domains;
			data.services[i].custom_ips = custom_ips;
			found = true;
			break;
		}
	}
	
	if (!found) {
		return { error: 'Service not found' };
	}
	
	write_json(SERVICES_FILE, data);
	
	// Apply changes immediately
	run_cmd('/opt/pinpoint/scripts/pinpoint-apply.sh reload >/dev/null 2>&1 &');
	
	return { success: true, id: service_id };
}

// Check if IP is in LAN subnet
function is_lan_ip(ip) {
	if (!ip || ip == '') return false;
	
	// Get LAN interface IP
	let lan_ip_raw = run_cmd("ip -4 addr show br-lan 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d'/' -f1 | head -1");
	if (!lan_ip_raw || trim(lan_ip_raw) == '') {
		// Try lan interface
		lan_ip_raw = run_cmd("ip -4 addr show lan 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d'/' -f1 | head -1");
	}
	
	if (!lan_ip_raw || trim(lan_ip_raw) == '') {
		// Fallback: try UCI
		lan_ip_raw = run_cmd("uci get network.lan.ipaddr 2>/dev/null");
	}
	
	let lan_ip = trim(lan_ip_raw);
	if (!lan_ip || lan_ip == '') return false; // If can't determine, reject (be strict)
	
	// Simple check: if IP starts with same first 3 octets as LAN IP, it's in LAN
	// This works for /24 networks (most common)
	let lan_parts = split(lan_ip, /\./);
	let ip_parts = split(ip, /\./);
	
	if (length(lan_parts) >= 3 && length(ip_parts) >= 3) {
		// Check first 3 octets match (for /24 subnet)
		if (lan_parts[0] == ip_parts[0] && 
		    lan_parts[1] == ip_parts[1] && 
		    lan_parts[2] == ip_parts[2]) {
			return true;
		}
	}
	
	return false;
}

// Get all devices
function get_devices() {
	let data = read_json(DEVICES_FILE);
	if (!data) {
		return { devices: [] };
	}
	
	let all_devices = data.devices || [];
	let filtered_devices = [];
	
	// Filter devices: only show LAN devices
	for (let i = 0; i < length(all_devices); i++) {
		let device = all_devices[i];
		let ip = device.ip;
		
		// If device has IP, check if it's in LAN
		if (ip && is_lan_ip(ip)) {
			push(filtered_devices, device);
		} else if (!ip) {
			// If no IP, include it (might be configured by MAC only)
			push(filtered_devices, device);
		}
		// Otherwise exclude (not in LAN)
	}
	
	return { devices: filtered_devices };
}

// Update device settings
function set_device(params) {
	let device_id = params.id;
	
	if (!device_id) {
		return { error: 'Missing device id' };
	}
	
	let data = read_json(DEVICES_FILE);
	if (!data) {
		data = { devices: [] };
	}
	
	let found = false;
	for (let i = 0; i < length(data.devices); i++) {
		if (data.devices[i].id == device_id) {
			if (params.enabled != null) data.devices[i].enabled = !!params.enabled;
			if (params.mode != null) data.devices[i].mode = params.mode;
			if (params.name != null) data.devices[i].name = params.name;
			if (params.services != null) data.devices[i].services = params.services;
			found = true;
			break;
		}
	}
	
	if (!found) {
		return { error: 'Device not found' };
	}
	
	write_json(DEVICES_FILE, data);
	return { success: true, id: device_id };
}

// Set device services (for custom mode)
function set_device_services(params) {
	let device_id = params.id;
	let services = params.services || [];
	
	if (!device_id) {
		return { error: 'Missing device id' };
	}
	
	let data = read_json(DEVICES_FILE);
	if (!data) {
		return { error: 'Devices file not found' };
	}
	
	let found = false;
	for (let i = 0; i < length(data.devices); i++) {
		if (data.devices[i].id == device_id) {
			data.devices[i].services = services;
			found = true;
			break;
		}
	}
	
	if (!found) {
		return { error: 'Device not found' };
	}
	
	write_json(DEVICES_FILE, data);
	return { success: true, id: device_id, services: services };
}

// Apply changes (reload routing rules)
function apply() {
	// Ensure nftables and policy routing (tun1) are set up first (Lite: needed after subscription add)
	run_cmd('/opt/pinpoint/scripts/pinpoint-init.sh start 2>/dev/null');
	// Reload rules: nft sets, dnsmasq pinpoint.conf, restart dnsmasq
	let result = run_cmd('/opt/pinpoint/scripts/pinpoint-apply.sh reload 2>&1');
	
	run_cmd('sleep 2');
	
	return {
		success: true,
		output: result,
		message: 'Rules applied successfully'
	};
}

// Restart sing-box
function restart() {
	// Validate config before restart
	let config = read_json('/etc/sing-box/config.json');
	if (!config) {
		return { success: false, error: 'Cannot read sing-box config' };
	}
	
	// Check if config has required fields
	if (!config.outbounds || length(config.outbounds) == 0) {
		return { success: false, error: 'No outbounds configured' };
	}
	
	// Clean config to ensure it's in correct state (order, route.final, DNS detour, etc.)
	// This fixes any issues if config was modified externally
	let clean_config = clean_config_outbounds(config);
	
	// Save cleaned config (ensures consistency)
	write_json('/etc/sing-box/config.json', clean_config);
	
	// Restart sing-box
	let result = run_cmd('/etc/init.d/sing-box restart 2>&1');
	
	// Wait for tun1 to come up, then restore policy routing (kernel removes route when tun1 goes down)
	run_cmd('sleep 3');
	run_cmd('/opt/pinpoint/scripts/pinpoint-init.sh start 2>/dev/null');
	
	let ps_out = run_cmd('pgrep sing-box');
	let started = (ps_out && trim(ps_out) != '');
	
	return { 
		success: started,
		output: result,
		error: started ? null : 'sing-box failed to start'
	};
}

// Stop routing (remove all rules, but keep web interface running)
function stop_routing() {
	// Call pinpoint-init.sh stop to remove all routing rules
	let result = run_cmd('/opt/pinpoint/scripts/pinpoint-init.sh stop 2>&1');
	
	// Also remove dnsmasq config if it exists
	run_cmd('rm -f /etc/dnsmasq.d/pinpoint.conf 2>/dev/null');
	run_cmd('/etc/init.d/dnsmasq restart >/dev/null 2>&1');
	
	return {
		success: true,
		output: result,
		message: 'Routing stopped - all rules removed, traffic goes through normal internet'
	};
}

// Start routing (re-apply rules)
function start_routing() {
	// Call pinpoint-init.sh start to set up routing rules
	let result = run_cmd('/opt/pinpoint/scripts/pinpoint-init.sh start 2>&1');
	
	// Apply current rules
	run_cmd('/opt/pinpoint/scripts/pinpoint-apply.sh reload >/dev/null 2>&1');
	
	return {
		success: true,
		output: result,
		message: 'Routing started - rules applied'
	};
}

// Get tunnel/VPN configurations
function get_tunnels() {
	// Read sing-box config
	let config = read_json('/etc/sing-box/config.json');
	let tunnels = [];
	let active = '';
	
	if (config && config.outbounds) {
		for (let i = 0; i < length(config.outbounds); i++) {
			let ob = config.outbounds[i];
			if (ob.type && ob.type != 'direct' && ob.type != 'block' && ob.type != 'dns') {
				// Get latency from ping
				let latency = null;
				let server = ob.server || '';
				if (server) {
					let test_out = run_cmd('ping -c 1 -W 3 "' + server + '" 2>/dev/null');
					if (test_out) {
						let m = match(test_out, /time=([0-9.]+)/);
						if (m) {
							latency = int(+m[1]);
						}
					}
				}
				
				push(tunnels, {
					tag: ob.tag || 'unknown',
					type: ob.type,
					server: server,
					enabled: true,
					latency: latency
				});
			}
		}
		// First tunnel is active by default
		if (length(tunnels) > 0) {
			active = tunnels[0].tag;
		}
	}
	
	// Get subscriptions and count nodes from config
	let subs = read_json(SUBSCRIPTIONS_FILE);
	let subscriptions = [];
	if (subs && subs.subscriptions) {
		for (let sub in subs.subscriptions) {
			// Count nodes for this subscription from sing-box config
			let nodes_count = 0;
			if (config && config.outbounds) {
				for (let ob in config.outbounds) {
					if (ob._subscription == sub.id) {
						nodes_count++;
					}
				}
			}
			
			// Update subscription data
			let sub_data = {
				id: sub.id,
				name: sub.name || 'Subscription',
				url: sub.url || '',
				nodes: nodes_count,
				updated: sub.updated || null
			};
			push(subscriptions, sub_data);
		}
	}
	
	return { 
		tunnels: tunnels, 
		active: active,
		subscriptions: subscriptions
	};
}

// Add VPN subscription
function add_subscription(params) {
	let url = params.url;
	let name = params.name || 'Subscription';
	
	if (!url) {
		return { error: 'URL is required' };
	}
	
	let subs = read_json(SUBSCRIPTIONS_FILE);
	if (!subs) {
		subs = { subscriptions: [] };
	}
	
	// Generate unique ID
	let id = 'sub_' + time();
	
	push(subs.subscriptions, {
		id: id,
		name: name,
		url: url,
		nodes: 0,
		updated: null
	});
	
	write_json(SUBSCRIPTIONS_FILE, subs);
	
	// Automatically update the newly added subscription
	// Use a small delay to ensure file is written
	run_cmd('sleep 0.5');
	let update_result = update_subscriptions();
	
	if (update_result && update_result.success) {
		// Apply routing so pre-installed services (e.g. Instagram) work immediately
		apply();
		return { 
			success: true, 
			id: id,
			updated: true,
			nodes: update_result.total_updated || 0,
			message: 'Подписка добавлена и обновлена'
		};
	} else {
		// Subscription added but update failed - return success with warning
		return { 
			success: true, 
			id: id,
			updated: false,
			update_error: update_result ? update_result.error : 'Unknown error',
			message: 'Подписка добавлена, но обновление не удалось. Нажмите "Обновить подписки" вручную.'
		};
	}
}

// Update all subscriptions
function update_subscriptions() {
	// Ensure parse_vpn_link is accessible
	let parse_fn = parse_vpn_link;
	
	try {
		let subs = read_json(SUBSCRIPTIONS_FILE);
		if (!subs || !subs.subscriptions || length(subs.subscriptions) == 0) {
			return { success: false, error: 'No subscriptions configured' };
		}
		
		let config = read_json('/etc/sing-box/config.json');
		if (!config) {
			config = { outbounds: [] };
		}
		if (!config.outbounds) {
			config.outbounds = [];
		}
		
		// Remove outbounds from previous subscription updates
		// Keep only one 'direct' outbound and system outbounds
		let keep_outbounds = [];
		let direct_count = 0;
		for (let ob in config.outbounds) {
			if (ob.type == 'direct') {
				// Keep only first direct outbound
				if (direct_count == 0) {
					push(keep_outbounds, ob);
					direct_count++;
				}
			} else if (ob.type == 'dns' || ob.type == 'block') {
				push(keep_outbounds, ob);
			} else if (!ob._subscription) {
				// Keep manually added tunnels
				push(keep_outbounds, ob);
			}
		}
		config.outbounds = keep_outbounds;
		
		let total_updated = 0;
		let errors = [];
		
		// For each subscription, download and parse
		for (let i = 0; i < length(subs.subscriptions); i++) {
			let sub = subs.subscriptions[i];
			
			// Download subscription content
			let content = run_cmd('curl -fsSL --connect-timeout 30 --max-time 60 "' + sub.url + '" 2>/dev/null');
			
			if (!content || trim(content) == '') {
				push(errors, 'Failed to download: ' + (sub.name || sub.url));
				subs.subscriptions[i].nodes = 0;
				subs.subscriptions[i].updated = null;
				continue;
			}
			
			content = trim(content);
			let links = [];
			
			// Try to decode as Base64 first
			if (!match(content, /^[a-z]+:\/\//i) && !match(content, /^\{/) && !match(content, /^proxies:/)) {
				let decoded = b64decode(content);
				if (decoded && trim(decoded) != '') {
					content = trim(decoded);
				}
			}
			
			// Parse content based on format
			let nodes_count = 0;
			if (match(content, /^[a-z]+:\/\//i)) {
				// Plain links (one per line)
				let content_lines = split(content, '\n');
				links = [];
				for (let idx = 0; idx < length(content_lines); idx++) {
					let line = trim(content_lines[idx]);
					if (line) {
						push(links, line);
					}
				}
			} else if (match(content, /^\{/)) {
				// sing-box JSON format - extract outbounds directly
				try {
					let sb_config = json(content);
					if (sb_config && sb_config.outbounds) {
						for (let k = 0; k < length(sb_config.outbounds); k++) {
							let ob = sb_config.outbounds[k];
							if (ob.type && ob.type != 'direct' && ob.type != 'block' && ob.type != 'dns') {
								ob._subscription = sub.id;
								// Ensure unique tag
								let base_tag = ob.tag || 'tunnel';
								let counter = 1;
								while (true) {
									let duplicate = false;
									for (let j = 0; j < length(config.outbounds); j++) {
										let existing = config.outbounds[j];
										if (existing.tag == ob.tag) {
											duplicate = true;
											break;
										}
									}
									if (!duplicate) break;
									ob.tag = base_tag + '_' + counter;
									counter++;
								}
								push(config.outbounds, ob);
								nodes_count++;
								total_updated++;
							}
						}
					}
					links = []; // Already processed
				} catch(e) {
					push(errors, 'Failed to parse JSON: ' + (sub.name || sub.url) + ' - ' + e);
					subs.subscriptions[i].nodes = 0;
					subs.subscriptions[i].updated = null;
					continue;
				}
			}
			
			// Parse VPN links
			for (let idx = 0; idx < length(links); idx++) {
				let link = trim(links[idx]);
				if (!link || !match(link, /^[a-z]+:\/\//i)) continue;
				
				let outbound = parse_fn(link);
				if (outbound && outbound.tag) {
					outbound._subscription = sub.id;
					
					// Ensure unique tag
					let base_tag = outbound.tag;
					let counter = 1;
					while (true) {
						let duplicate = false;
						for (let j = 0; j < length(config.outbounds); j++) {
							let existing = config.outbounds[j];
							if (existing.tag == outbound.tag) {
								duplicate = true;
								break;
							}
						}
						if (!duplicate) break;
						outbound.tag = base_tag + '_' + counter;
						counter++;
					}
					
					push(config.outbounds, outbound);
					nodes_count++;
					total_updated++;
				}
			}
			
		// Update subscription metadata
		subs.subscriptions[i].nodes = nodes_count;
		let date_cmd = run_cmd('date "+%Y-%m-%d %H:%M:%S"');
		subs.subscriptions[i].updated = date_cmd ? trim(date_cmd) : null;
		subs.subscriptions[i].last_update = time();
		}
		
		// Clean config from internal fields before saving
		// clean_config_outbounds will:
		// - Remove _subscription fields
		// - Reorder outbounds: VPN tunnels first, then direct-out
		// - Remove DNS configuration (dns-out, DNS rules, DNS servers) to prevent memory leaks
		// - Set route.final to first VPN tunnel (or direct-out if no VPN)
		// - Ensure TUN inbound exists
		// - DNS is handled by dnsmasq + https-dns-proxy, NOT sing-box
		let clean_config = clean_config_outbounds(config);
		
		// Save updated config and subscriptions
		if (!write_json('/etc/sing-box/config.json', clean_config)) {
			return { success: false, error: 'Failed to save sing-box config' };
		}
		if (!write_json(SUBSCRIPTIONS_FILE, subs)) {
			return { success: false, error: 'Failed to save subscriptions' };
		}
		
		// Restart sing-box (run in background, don't wait)
		run_cmd('/etc/init.d/sing-box restart >/dev/null 2>&1 &');
		run_cmd('sleep 2');
		// Apply routing so pinpoint.conf and nft sets are created/updated (Lite out-of-the-box)
		apply();
		
		return { 
			success: true, 
			total_updated: total_updated,
			errors: length(errors) > 0 ? errors : null
		};
	} catch(e) {
		return { 
			success: false, 
			error: 'Update failed: ' + (e ? e : 'unknown error')
		};
	}
}

// Update all subscriptions (sync version - currently has issues with rpcd)
function update_subscriptions_sync() {
	let subs = read_json(SUBSCRIPTIONS_FILE);
	if (!subs || !subs.subscriptions || length(subs.subscriptions) == 0) {
		return { error: 'No subscriptions configured' };
	}
	
	let config = read_json('/etc/sing-box/config.json');
	if (!config) {
		config = { outbounds: [] };
	}
	if (!config.outbounds) {
		config.outbounds = [];
	}
	
	// Remove outbounds from previous subscription updates
	let keep_outbounds = [];
	for (let ob in config.outbounds) {
		if (!ob._subscription) {
			push(keep_outbounds, ob);
		}
	}
	config.outbounds = keep_outbounds;
	
	let total_imported = 0;
	
	// For each subscription, download and parse
	for (let i = 0; i < length(subs.subscriptions); i++) {
		let sub = subs.subscriptions[i];
		
		let content = run_cmd('curl -fsSL --connect-timeout 30 "' + sub.url + '" 2>/dev/null');
		
		if (!content || trim(content) == '') {
			continue;
		}
		
		content = trim(content);
		let links = [];
		
		// Try to decode as Base64 first (content looks like base64 - no protocol prefix)
		if (!match(content, /^[a-z]+:\/\//i) && !match(content, /^\{/) && !match(content, /^proxies:/)) {
			// Use pure ucode base64 decoder (works without external tools)
			let decoded = b64decode(content);
			if (decoded && trim(decoded) != '') {
				content = trim(decoded);
			}
		}
		
		// Parse content based on format
		if (match(content, /^[a-z]+:\/\//i)) {
			// Plain links (one per line)
			links = split(content, '\n');
		} else if (match(content, /^\{/)) {
			// sing-box JSON format
			let sb_config = json(content);
			if (sb_config && sb_config.outbounds) {
				for (let ob in sb_config.outbounds) {
					if (ob.type && ob.type != 'direct' && ob.type != 'block' && ob.type != 'dns') {
						ob._subscription = sub.id;
						push(config.outbounds, ob);
						total_imported++;
					}
				}
			}
			links = []; // Already processed
		}
		
		// Parse VPN links
		let nodes_count = 0;
		for (let link in links) {
			link = trim(link);
			if (!link || !match(link, /^[a-z]+:\/\//i)) continue;
			
			let outbound = parse_vpn_link(link);
			if (outbound) {
				outbound._subscription = sub.id;
				
				// Ensure unique tag
				let base_tag = outbound.tag;
				let counter = 1;
				while (true) {
					let duplicate = false;
					for (let ob in config.outbounds) {
						if (ob.tag == outbound.tag) {
							duplicate = true;
							break;
						}
					}
					if (!duplicate) break;
					outbound.tag = base_tag + '_' + counter;
					counter++;
				}
				
				push(config.outbounds, outbound);
				nodes_count++;
				total_imported++;
			}
		}
		
		subs.subscriptions[i].nodes = nodes_count;
		subs.subscriptions[i].updated = trim(run_cmd('date "+%Y-%m-%d %H:%M"'));
		
		// Save raw content
		writefile(DATA_DIR + '/subscription_' + sub.id + '.txt', content);
	}
	
	// Clean config before saving
	let clean_config = clean_config_outbounds(config);
	write_json('/etc/sing-box/config.json', clean_config);
	write_json(SUBSCRIPTIONS_FILE, subs);
	
	// Restart sing-box in background (don't block)
	system('/etc/init.d/sing-box restart &');
	
	return { success: true, imported: total_imported };
}

// Set active tunnel
function set_active_tunnel(params) {
	let tag = params.tag;
	if (!tag) {
		return { error: 'Tunnel tag required' };
	}
	
	// Update sing-box config to use this outbound
	let config = read_json('/etc/sing-box/config.json');
	if (!config) {
		return { error: 'Cannot read sing-box config' };
	}
	
	// Find and move outbound to top (make it default)
	let found = false;
	let target_ob = null;
	let new_outbounds = [];
	
	if (config.outbounds) {
		// First, find the target outbound
		for (let ob in config.outbounds) {
			if (ob.tag == tag) {
				target_ob = ob;
				found = true;
				break;
			}
		}
		
		// If found, rebuild array with target at the beginning
		if (found && target_ob) {
			// Add target first
			push(new_outbounds, target_ob);
			// Add all others except target
			for (let ob in config.outbounds) {
				if (ob.tag != tag) {
					push(new_outbounds, ob);
				}
			}
			config.outbounds = new_outbounds;
		}
	}
	
	if (!found) {
		return { error: 'Tunnel not found' };
	}
	
	// Clean config before saving
	let clean_config = clean_config_outbounds(config);
	write_json('/etc/sing-box/config.json', clean_config);
	run_cmd('/etc/init.d/sing-box restart 2>&1');
	
	return { success: true, active: tag };
}

// Health check for tunnels
function health_check() {
	let tunnels = get_tunnels().tunnels;
	let results = [];
	
	// Get sing-box config to find server addresses
	let config = read_json('/etc/sing-box/config.json');
	let outbound_map = {};
	if (config && config.outbounds) {
		for (let i = 0; i < length(config.outbounds); i++) {
			let ob = config.outbounds[i];
			if (ob.tag && ob.server) {
				outbound_map[ob.tag] = ob.server;
			}
		}
	}
	
	for (let i = 0; i < length(tunnels); i++) {
		let t = tunnels[i];
		let latency = null;
		let server = outbound_map[t.tag] || t.server || null;
		
		if (server) {
			// Ping server directly (simplified check)
			let test_out = run_cmd('ping -c 1 -W 3 "' + server + '" 2>/dev/null');
			
			if (test_out) {
				let m = match(test_out, /time=([0-9.]+)/);
				if (m) {
					latency = int(+m[1]);
				}
			}
		} else {
			// Fallback: try to ping through default route
			let test_out = run_cmd('ping -c 1 -W 3 8.8.8.8 2>/dev/null');
			if (test_out) {
				let m = match(test_out, /time=([0-9.]+)/);
				if (m) {
					latency = int(+m[1]);
				}
			}
		}
		
		push(results, {
			tag: t.tag,
			latency: latency,
			status: latency ? 'online' : 'timeout'
		});
	}
	
	return { results: results };
}

// ===== CUSTOM SERVICES =====

// Get custom services
function get_custom_services() {
	let data = read_json(CUSTOM_FILE);
	if (!data) {
		return { services: [] };
	}
	return { services: data.services || [] };
}

// Add custom service
function add_custom_service(params) {
	let name = params.name;
	let domains = params.domains || [];
	let ip_ranges = params.ip_ranges || [];
	
	if (!name) {
		return { error: 'Name is required' };
	}
	
	let data = read_json(CUSTOM_FILE);
	if (!data) {
		data = { services: [] };
	}
	
	let id = 'custom_' + time();
	
	push(data.services, {
		id: id,
		name: name,
		domains: domains,
		ips: ip_ranges,
		enabled: true
	});
	
	write_json(CUSTOM_FILE, data);
	
	return { success: true, id: id };
}

// Delete custom service
function delete_custom_service(params) {
	let id = params.id;
	
	if (!id) {
		return { error: 'ID is required' };
	}
	
	let data = read_json(CUSTOM_FILE);
	if (!data || !data.services) {
		return { error: 'No custom services' };
	}
	
	let newServices = [];
	for (let s in data.services) {
		if (s.id != id) {
			push(newServices, s);
		}
	}
	
	data.services = newServices;
	write_json(CUSTOM_FILE, data);
	
	return { success: true };
}

// Toggle custom service
function toggle_custom_service(params) {
	let id = params.id;
	let enabled = params.enabled;
	
	if (!id) {
		return { error: 'ID is required' };
	}
	
	let data = read_json(CUSTOM_FILE);
	if (!data || !data.services) {
		return { error: 'No custom services' };
	}
	
	for (let i = 0; i < length(data.services); i++) {
		if (data.services[i].id == id) {
			data.services[i].enabled = !!enabled;
			break;
		}
	}
	
	write_json(CUSTOM_FILE, data);
	
	return { success: true };
}

// ===== SETTINGS =====

// Get settings
function get_settings() {
	let settings = read_json(SETTINGS_FILE);
	if (!settings) {
		settings = {
			auto_update: true,
			update_interval: 21600,
			update_time: '03:00',  // Default: 3 AM
			tunnel_interface: 'tun1',
			tunnel_mark: '0x100'
		};
	}
	// Ensure update_time exists (for backward compatibility)
	if (!settings.update_time) {
		settings.update_time = '03:00';
	}
	return settings;
}

// Save settings
function save_settings(params) {
	let settings = params.settings || params;
	
	let current = get_settings();
	
	if (settings.auto_update != null) current.auto_update = settings.auto_update;
	if (settings.update_interval != null) current.update_interval = settings.update_interval;
	if (settings.update_time != null) current.update_time = settings.update_time;
	if (settings.tunnel_interface != null) current.tunnel_interface = settings.tunnel_interface;
	if (settings.tunnel_mark != null) current.tunnel_mark = settings.tunnel_mark;
	
	write_json(SETTINGS_FILE, current);
	
	// Update cron if update_time changed (Full mode only)
	let has_python = run_cmd('command -v python3 >/dev/null 2>&1 && echo yes');
	if (settings.update_time != null && has_python == 'yes\n' || has_python == 'yes') {
		update_cron_schedule(current.update_time);
	}
	
	return { success: true };
}

// Update cron schedule based on settings
function update_cron_schedule(update_time) {
	if (!update_time) return;
	
	// Parse time (HH:MM format) using shell
	let time_check = run_cmd(sprintf('echo "%s" | grep -qE "^[0-9]{1,2}:[0-9]{2}$" && echo "valid" || echo "invalid"', update_time));
	if (!time_check || !match(time_check, /valid/)) return;
	
	// Extract hour and minute using shell
	let hour_str = run_cmd(sprintf('echo "%s" | cut -d: -f1', update_time));
	let minute_str = run_cmd(sprintf('echo "%s" | cut -d: -f2', update_time));
	
	// Clean and convert to int
	let hour = 3;
	let minute = 0;
	if (hour_str) {
		let h_clean = match(hour_str, /(\d+)/);
		if (h_clean && h_clean[1]) hour = int(h_clean[1]);
	}
	if (minute_str) {
		let m_clean = match(minute_str, /(\d+)/);
		if (m_clean && m_clean[1]) minute = int(m_clean[1]);
	}
	
	// Validate
	if (hour < 0 || hour > 23) hour = 3;
	if (minute < 0 || minute > 59) minute = 0;
	
	// Update cron file using shell heredoc
	let cron_cmd = sprintf('cat > /etc/cron.d/pinpoint << \'CRONEOF\'\n# Pinpoint - Daily list update at %s\n%d %d * * * root /usr/bin/python3 /opt/pinpoint/scripts/pinpoint-update.py update >/dev/null 2>&1 || /opt/pinpoint/scripts/pinpoint-update.sh update >/dev/null 2>&1\n# Pinpoint - Force update from GitHub (once per day at 3 AM)\n0 3 * * * root /usr/bin/python3 /opt/pinpoint/scripts/pinpoint-update.py update-github >/dev/null 2>&1 || true\nCRONEOF\n', update_time, minute, hour);
	run_cmd(cron_cmd);
	
	// Restart cron
	run_cmd('/etc/init.d/cron restart >/dev/null 2>&1');
}

// Manual update lists (for Lite mode and manual updates)
function update_lists() {
	// Launch update in background (non-blocking)
	// This prevents RPC timeout and allows UI to show progress
	
	// Check if Python is available (Full mode)
	let has_python = run_cmd('command -v python3 >/dev/null 2>&1 && echo yes');
	let is_python = (trim(has_python) == 'yes');
	
	// Start update in background using simple system call
	if (is_python) {
		// Full mode: use Python script
		system('sh -c "/usr/bin/python3 /opt/pinpoint/scripts/pinpoint-update.py update >/dev/null 2>&1 &"');
	} else {
		// Lite mode: use shell script
		system('sh -c "/opt/pinpoint/scripts/pinpoint-update.sh update >/dev/null 2>&1 &"');
	}
	
	// Return immediately - update runs in background
	return { 
		success: true, 
		message: 'Update started in background'
	};
}

// Update single service by ID
function update_single_service(params) {
	let service_id = params.service_id;
	
	if (!service_id) {
		return { success: false, error: 'Service ID required' };
	}
	
	// Try Python first (Full mode), fallback to shell (Lite mode)
	let python_result = run_cmd('/usr/bin/python3 /opt/pinpoint/scripts/pinpoint-update.py update-single ' + service_id + ' 2>&1');
	
	if (python_result !== null && python_result != '') {
		// Python script executed (Full mode)
		return { success: true, service_id: service_id, output: python_result };
	}
	
	// Fallback to shell script (Lite mode)
	let shell_result = run_cmd('/opt/pinpoint/scripts/pinpoint-update.sh update-single ' + service_id + ' 2>&1');
	
	if (shell_result !== null && shell_result != '') {
		return { success: true, service_id: service_id, output: shell_result };
	}
	
	return { success: false, error: 'Update failed for service: ' + service_id };
}

// Get system info
function get_system_info() {
	let singbox_ver = run_cmd('sing-box version 2>/dev/null | head -1');
	
	let mem_info = run_cmd('free | grep Mem');
	let mem_total = 0, mem_used = 0;
	if (mem_info) {
		mem_info = trim(mem_info);
		let parts = split(mem_info, /\s+/);
		if (parts && length(parts) >= 3) {
			mem_total = +parts[1] * 1024;
			mem_used = +parts[2] * 1024;
		}
	}
	
	// Count services
	let services_data = read_json(SERVICES_FILE);
	let services_count = 0;
	if (services_data && services_data.services) {
		services_count = length(services_data.services);
	}
	
	// Last update
	let status = read_json(DATA_DIR + '/status.json');
	
	return {
		version: '1.0.0',
		singbox_version: singbox_ver ? trim(singbox_ver) : null,
		memory_total: mem_total,
		memory_used: mem_used,
		services_count: services_count,
		last_update: status ? status.last_update : null
	};
}

// Import single VPN link
function import_link(params) {
	let link = params.link;
	if (!link) {
		return { error: 'Link is required' };
	}
	
	let outbound = parse_vpn_link(link);
	if (!outbound) {
		return { error: 'Failed to parse link' };
	}
	
	// Add to sing-box config
	let config = read_json('/etc/sing-box/config.json');
	if (!config) {
		config = { outbounds: [] };
	}
	if (!config.outbounds) {
		config.outbounds = [];
	}
	
	// Check for duplicate tag
	for (let ob in config.outbounds) {
		if (ob.tag == outbound.tag) {
			outbound.tag = outbound.tag + '_' + time();
			break;
		}
	}
	
	push(config.outbounds, outbound);
	// Clean config before saving
	let clean_config = clean_config_outbounds(config);
	write_json('/etc/sing-box/config.json', clean_config);
	
	return { success: true, tag: outbound.tag, type: outbound.type };
}

// Import multiple VPN links
function import_batch(params) {
	let links = params.links;
	if (!links || length(links) == 0) {
		return { error: 'Links array is required' };
	}
	
	let config = read_json('/etc/sing-box/config.json');
	if (!config) {
		config = { outbounds: [] };
	}
	if (!config.outbounds) {
		config.outbounds = [];
	}
	
	let imported = [];
	let failed = [];
	
	for (let link in links) {
		let outbound = parse_vpn_link(link);
		if (outbound) {
			// Check for duplicate tag
			for (let ob in config.outbounds) {
				if (ob.tag == outbound.tag) {
					outbound.tag = outbound.tag + '_' + time();
					break;
				}
			}
			push(config.outbounds, outbound);
			push(imported, outbound.tag);
		} else {
			push(failed, link);
		}
	}
	
	// Clean config before saving
	let clean_config = clean_config_outbounds(config);
	write_json('/etc/sing-box/config.json', clean_config);
	
	return { 
		success: true, 
		imported: imported, 
		failed: failed,
		count: length(imported)
	};
}

// Delete subscription
function delete_subscription(params) {
	let id = params.id;
	if (!id) {
		return { error: 'Subscription ID required' };
	}
	
	let subs = read_json(SUBSCRIPTIONS_FILE);
	if (!subs || !subs.subscriptions) {
		return { error: 'No subscriptions found' };
	}
	
	let newSubs = [];
	let found = false;
	for (let s in subs.subscriptions) {
		if (s.id != id) {
			push(newSubs, s);
		} else {
			found = true;
			// Delete subscription data file
			unlink(DATA_DIR + '/subscription_' + id + '.txt');
		}
	}
	
	if (!found) {
		return { error: 'Subscription not found' };
	}
	
	subs.subscriptions = newSubs;
	write_json(SUBSCRIPTIONS_FILE, subs);
	
	return { success: true };
}

// Edit subscription (rename)
function edit_subscription(params) {
	let id = params.id;
	let name = params.name;
	
	if (!id) {
		return { error: 'Subscription ID required' };
	}
	
	let subs = read_json(SUBSCRIPTIONS_FILE);
	if (!subs || !subs.subscriptions) {
		return { error: 'No subscriptions found' };
	}
	
	let found = false;
	for (let i = 0; i < length(subs.subscriptions); i++) {
		if (subs.subscriptions[i].id == id) {
			if (name) subs.subscriptions[i].name = name;
			found = true;
			break;
		}
	}
	
	if (!found) {
		return { error: 'Subscription not found' };
	}
	
	write_json(SUBSCRIPTIONS_FILE, subs);
	
	return { success: true };
}

// Delete tunnel from sing-box config
function delete_tunnel(params) {
	let tag = params.tag;
	if (!tag) {
		return { error: 'Tunnel tag required' };
	}
	
	let config = read_json('/etc/sing-box/config.json');
	if (!config || !config.outbounds) {
		return { error: 'No sing-box config' };
	}
	
	let newOutbounds = [];
	let found = false;
	for (let ob in config.outbounds) {
		if (ob.tag != tag) {
			push(newOutbounds, ob);
		} else {
			found = true;
		}
	}
	
	if (!found) {
		return { error: 'Tunnel not found' };
	}
	
	config.outbounds = newOutbounds;
	// Clean config before saving
	let clean_config = clean_config_outbounds(config);
	write_json('/etc/sing-box/config.json', clean_config);
	
	return { success: true };
}

// Get logs
function get_logs(params) {
	let log_type = params.type || 'singbox';
	let lines = params.lines || 50;
	
	let cmd = '';
	if (log_type == 'singbox') {
		cmd = 'logread -e sing-box 2>/dev/null | tail -n ' + lines;
	} else if (log_type == 'pinpoint') {
		cmd = 'logread -e pinpoint 2>/dev/null | tail -n ' + lines;
	} else {
		cmd = 'logread 2>/dev/null | tail -n ' + lines;
	}
	
	let output = run_cmd(cmd);
	if (!output) output = '';
	
	let output_trimmed = trim(output);
	return {
		logs: split(output_trimmed, '\n'),
		type: log_type
	};
}

// Get network hosts (from DHCP leases and ARP)
function get_network_hosts() {
	let hosts = [];
	let seen = {};
	
	// Get gateway IP (router itself) to exclude
	let gateway_ip_raw = run_cmd("ip route | grep default | awk '{print $3}' | head -1");
	let gateway_ip = trim(gateway_ip_raw);
	
	// Get LAN IP to determine subnet
	let lan_ip = run_cmd("ip -4 addr show br-lan 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d'/' -f1 | head -1");
	if (!lan_ip || trim(lan_ip) == '') {
		lan_ip = run_cmd("ip -4 addr show lan 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d'/' -f1 | head -1");
	}
	if (!lan_ip || trim(lan_ip) == '') {
		lan_ip = run_cmd("uci get network.lan.ipaddr 2>/dev/null");
	}
	lan_ip = trim(lan_ip);
	
	// Read DHCP leases (these are always in LAN)
	let leases = readfile('/tmp/dhcp.leases');
	if (leases) {
		leases = trim(leases);
		let lines = split(leases, '\n');
		for (let line in lines) {
			let parts = split(line, /\s+/);
			if (length(parts) >= 4) {
				let mac = parts[1];
				let ip = parts[2];
				let name = parts[3];
				if (name == '*') name = '';
				
				// Filter: only LAN IPs, exclude gateway and router itself
				// Check if IP is in same subnet as LAN IP (first 3 octets match for /24)
				let ip_parts = split(ip, /\./);
				let lan_parts = split(lan_ip, /\./);
				let is_lan = (length(lan_parts) >= 3 && length(ip_parts) >= 3 &&
				              lan_parts[0] == ip_parts[0] && 
				              lan_parts[1] == ip_parts[1] && 
				              lan_parts[2] == ip_parts[2]);
				
				if (is_lan && ip != gateway_ip && ip != lan_ip) {
					if (!seen[mac]) {
						push(hosts, {
							mac: mac,
							ip: ip,
							name: name || ip,
							source: 'dhcp'
						});
						seen[mac] = true;
					}
				}
			}
		}
	}
	
	// Read ARP table for additional hosts (filter by LAN subnet and interface)
	let arp = run_cmd('cat /proc/net/arp 2>/dev/null');
	if (arp) {
		arp = trim(arp);
		let lines = split(arp, '\n');
		for (let i = 1; i < length(lines); i++) {
			let parts = split(lines[i], /\s+/);
			if (length(parts) >= 6) {
				let ip = parts[0];
				let mac = parts[3];
				let interface = parts[5] || '';
				
				// Filter: ONLY devices from LAN interface (br-lan or lan), exclude ALL other interfaces
				// Interface check is the primary and most reliable filter
				// Devices from WAN interface (wan) or any other interface should NEVER be shown
				let interface_trimmed = trim(interface);
				
				// Only allow br-lan or lan interfaces - exclude everything else (wan, etc.)
				// This is a strict whitelist approach - use nested if instead of continue
				if ((interface_trimmed == 'br-lan' || interface_trimmed == 'lan') &&
				    mac != '00:00:00:00:00:00' && 
				    ip != gateway_ip && 
				    ip != lan_ip && 
				    !seen[mac]) {
					push(hosts, {
						mac: mac,
						ip: ip,
						name: ip,
						source: 'arp'
					});
					seen[mac] = true;
				}
			}
		}
	}
	
	return { hosts: hosts };
}

// Add device
function add_device(params) {
	let ip = params.ip;
	let mac = params.mac;
	let name = params.name;
	let mode = params.mode || 'default';
	
	if (!ip && !mac) {
		return { error: 'IP or MAC required' };
	}
	
	let data = read_json(DEVICES_FILE);
	if (!data) {
		data = { devices: [] };
	}
	
	// Check if already exists
	for (let d in data.devices) {
		if ((ip && d.ip == ip) || (mac && d.mac == mac)) {
			return { error: 'Device already exists' };
		}
	}
	
	let id = mac || ('ip_' + replace(ip, /\./g, '_'));
	
	push(data.devices, {
		id: id,
		ip: ip,
		mac: mac,
		name: name || ip,
		mode: mode,
		enabled: true
	});
	
	write_json(DEVICES_FILE, data);
	
	return { success: true, id: id };
}

// Delete device
function delete_device(params) {
	let id = params.id;
	if (!id) {
		return { error: 'Device ID required' };
	}
	
	let data = read_json(DEVICES_FILE);
	if (!data || !data.devices) {
		return { error: 'No devices found' };
	}
	
	let newDevices = [];
	let found = false;
	for (let d in data.devices) {
		if (d.id != id) {
			push(newDevices, d);
		} else {
			found = true;
		}
	}
	
	if (!found) {
		return { error: 'Device not found' };
	}
	
	data.devices = newDevices;
	write_json(DEVICES_FILE, data);
	
	return { success: true };
}

// Test domain routing
function test_domain(params) {
	let domain = params.domain;
	if (!domain) {
		return { error: 'Domain required' };
	}
	
	// Resolve domain
	let dig_out = run_cmd('nslookup ' + domain + ' 2>/dev/null | grep -A1 "Name:" | tail -1');
	let ips = [];
	if (dig_out) {
		let m = match(dig_out, /Address:\s*([0-9.]+)/);
		if (m) {
			push(ips, m[1]);
		}
	}
	
	// Check if IP is in tunnel sets
	let routed = false;
	if (length(ips) > 0) {
		let check = run_cmd('nft get element inet pinpoint tunnel_ips { ' + ips[0] + ' } 2>/dev/null');
		if (check && !match(check, /error/i)) {
			routed = true;
		}
	}
	
	return {
		domain: domain,
		ips: ips,
		routed: routed
	};
}

// ===== SERVER GROUPS =====
const GROUPS_FILE = DATA_DIR + '/groups.json';

function get_groups() {
	let data = read_json(GROUPS_FILE);
	if (!data) {
		return { groups: [] };
	}
	return { groups: data.groups || [] };
}

function add_group(params) {
	let name = params.name;
	let type = params.type || 'urltest';
	let outbounds = params.outbounds || [];
	let interval = params.interval || '5m';
	
	if (!name) {
		return { error: 'Name is required' };
	}
	if (length(outbounds) < 2) {
		return { error: 'At least 2 outbounds required' };
	}
	
	let data = read_json(GROUPS_FILE);
	if (!data) {
		data = { groups: [] };
	}
	
	let id = 'group_' + time();
	let tag = replace(name, /[^a-zA-Z0-9_-]/g, '_');
	
	push(data.groups, {
		id: id,
		tag: tag,
		name: name,
		type: type,
		outbounds: outbounds,
		interval: interval,
		enabled: true
	});
	
	write_json(GROUPS_FILE, data);
	
	// Update sing-box config
	apply_groups_to_config();
	
	return { success: true, id: id };
}

function delete_group(params) {
	let id = params.id;
	if (!id) {
		return { error: 'Group ID required' };
	}
	
	let data = read_json(GROUPS_FILE);
	if (!data || !data.groups) {
		return { error: 'No groups found' };
	}
	
	let newGroups = [];
	for (let g in data.groups) {
		if (g.id != id) {
			push(newGroups, g);
		}
	}
	
	data.groups = newGroups;
	write_json(GROUPS_FILE, data);
	
	apply_groups_to_config();
	
	return { success: true };
}

function apply_groups_to_config() {
	let groups = read_json(GROUPS_FILE);
	let config = read_json('/etc/sing-box/config.json');
	
	if (!config) return;
	if (!config.outbounds) config.outbounds = [];
	
	// Remove existing group outbounds
	let newOutbounds = [];
	for (let ob in config.outbounds) {
		if (ob.type != 'urltest' && ob.type != 'selector') {
			push(newOutbounds, ob);
		}
	}
	
	// Add groups
	if (groups && groups.groups) {
		for (let g in groups.groups) {
			if (!g.enabled) continue;
			
			let group_ob = {
				type: g.type,
				tag: g.tag,
				outbounds: g.outbounds
			};
			
			if (g.type == 'urltest') {
				group_ob.url = 'https://www.gstatic.com/generate_204';
				group_ob.interval = g.interval || '5m';
				group_ob.tolerance = 50;
			}
			
			push(newOutbounds, group_ob);
		}
	}
	
	config.outbounds = newOutbounds;
	// Clean config before saving
	let clean_config = clean_config_outbounds(config);
	write_json('/etc/sing-box/config.json', clean_config);
}

// ===== SERVICE ROUTES =====
const ROUTES_FILE = DATA_DIR + '/service_routes.json';

function get_service_routes() {
	let data = read_json(ROUTES_FILE);
	if (!data) {
		return { routes: [] };
	}
	return { routes: data.routes || [] };
}

function set_service_route(params) {
	let service_id = params.service_id;
	let outbound = params.outbound;  // tunnel tag or group tag
	
	if (!service_id) {
		return { error: 'Service ID required' };
	}
	
	let data = read_json(ROUTES_FILE);
	if (!data) {
		data = { routes: [] };
	}
	
	// Update or add route
	let found = false;
	for (let i = 0; i < length(data.routes); i++) {
		if (data.routes[i].service_id == service_id) {
			if (outbound) {
				data.routes[i].outbound = outbound;
			} else {
				// Remove route if outbound is empty (use default)
				// Rebuild array without this route
				let new_routes = [];
				for (let j = 0; j < length(data.routes); j++) {
					if (j != i) {
						push(new_routes, data.routes[j]);
					}
				}
				data.routes = new_routes;
			}
			found = true;
			break;
		}
	}
	
	if (!found && outbound) {
		push(data.routes, {
			service_id: service_id,
			outbound: outbound
		});
	}
	
	write_json(ROUTES_FILE, data);
	
	return { success: true };
}

// ===== ADBLOCK =====

function get_adblock_status() {
	// Check if adblock hosts file exists
	let hosts_file = '/tmp/dnsmasq.d/adblock.conf';
	let exists = (stat(hosts_file) != null);
	
	// Check if enabled in settings
	let settings = read_json(SETTINGS_FILE) || {};
	let enabled = settings.adblock_enabled || false;
	
	// Count blocked domains
	let count = 0;
	if (exists) {
		let content = readfile(hosts_file);
		if (content) {
			count = length(split(content, '\n'));
		}
	}
	
	return {
		enabled: enabled,
		active: exists,
		blocked_domains: count,
		last_update: settings.adblock_updated || null
	};
}

function toggle_adblock(params) {
	let enabled = params.enabled;
	
	let settings = read_json(SETTINGS_FILE) || {};
	settings.adblock_enabled = !!enabled;
	write_json(SETTINGS_FILE, settings);
	
	if (enabled) {
		// Download and apply adblock list
		update_adblock();
	} else {
		// Remove adblock file
		unlink('/tmp/dnsmasq.d/adblock.conf');
		run_cmd('/etc/init.d/dnsmasq restart 2>&1');
	}
	
	return { success: true, enabled: !!enabled };
}

function update_adblock() {
	let settings = read_json(SETTINGS_FILE) || {};
	
	if (!settings.adblock_enabled) {
		return { error: 'AdBlock is disabled' };
	}
	
	// Download adblock hosts
	let sources = [
		'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
		'https://adaway.org/hosts.txt'
	];
	
	let all_domains = {};
	
	for (let url in sources) {
		let content = run_cmd('wget -q -O - --timeout=30 "' + url + '" 2>/dev/null');
		if (content) {
			let lines = split(content, '\n');
			for (let line in lines) {
				line = trim(line);
				if (!line || substr(line, 0, 1) == '#') continue;
				
				// Parse hosts format: 0.0.0.0 domain.com
				let m = match(line, /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-zA-Z0-9.-]+)/);
				if (m && m[1] != 'localhost') {
					all_domains[m[1]] = true;
				}
			}
		}
	}
	
	// Generate dnsmasq config
	let config_lines = ['# AdBlock - Auto-generated'];
	for (let domain in all_domains) {
		push(config_lines, 'address=/' + domain + '/');
	}
	
	mkdir('/tmp/dnsmasq.d', 0755);
	writefile('/tmp/dnsmasq.d/adblock.conf', join('\n', config_lines));
	
	settings.adblock_updated = trim(run_cmd('date "+%Y-%m-%d %H:%M"'));
	write_json(SETTINGS_FILE, settings);
	
	run_cmd('/etc/init.d/dnsmasq restart 2>&1');
	
	return { success: true, count: length(keys(all_domains)) };
}

// ===== EXPORT/IMPORT =====

function export_config() {
	let export_data = {
		version: '1.0',
		exported: trim(run_cmd('date "+%Y-%m-%d %H:%M:%S"')),
		services: read_json(SERVICES_FILE),
		devices: read_json(DEVICES_FILE),
		custom_services: read_json(CUSTOM_FILE),
		subscriptions: read_json(SUBSCRIPTIONS_FILE),
		groups: read_json(GROUPS_FILE),
		service_routes: read_json(ROUTES_FILE),
		settings: read_json(SETTINGS_FILE)
	};
	
	return { success: true, data: export_data };
}

function import_config(params) {
	let data = params.data;
	
	if (!data || !data.version) {
		return { error: 'Invalid config data' };
	}
	
	// Import each section if present
	if (data.services) {
		write_json(SERVICES_FILE, data.services);
	}
	if (data.devices) {
		write_json(DEVICES_FILE, data.devices);
	}
	if (data.custom_services) {
		write_json(CUSTOM_FILE, data.custom_services);
	}
	if (data.subscriptions) {
		write_json(SUBSCRIPTIONS_FILE, data.subscriptions);
	}
	if (data.groups) {
		write_json(GROUPS_FILE, data.groups);
	}
	if (data.service_routes) {
		write_json(ROUTES_FILE, data.service_routes);
	}
	if (data.settings) {
		write_json(SETTINGS_FILE, data.settings);
	}
	
	// Apply changes
	apply_groups_to_config();
	apply();
	
	return { success: true, message: 'Config imported successfully' };
}

// RPC methods object
const methods = {
	status: {
		call: function() {
			return get_status();
		}
	},
	services: {
		call: function() {
			return get_services();
		}
	},
	set_service: {
		args: { id: 'id', enabled: true },
		call: function(req) {
			return set_service(req.args);
		}
	},
	edit_service: {
		args: { id: 'id', custom_domains: [], custom_ips: [] },
		call: function(req) {
			return edit_service(req.args);
		}
	},
	devices: {
		call: function() {
			return get_devices();
		}
	},
	set_device: {
		args: { id: 'id', enabled: true, mode: 'mode', name: 'name', services: [] },
		call: function(req) {
			return set_device(req.args);
		}
	},
	set_device_services: {
		args: { id: 'id', services: [] },
		call: function(req) {
			return set_device_services(req.args);
		}
	},
	apply: {
		call: function() {
			return apply();
		}
	},
	restart: {
		call: function() {
			return restart();
		}
	},
	stop_routing: {
		call: function() {
			return stop_routing();
		}
	},
	start_routing: {
		call: function() {
			return start_routing();
		}
	},
	tunnels: {
		call: function() {
			return get_tunnels();
		}
	},
	add_subscription: {
		args: { url: 'url', name: 'name' },
		call: function(req) {
			return add_subscription(req.args);
		}
	},
	update_subscriptions: {
		call: function() {
			return update_subscriptions();
		}
	},
	set_active_tunnel: {
		args: { tag: 'tag' },
		call: function(req) {
			return set_active_tunnel(req.args);
		}
	},
	health_check: {
		call: function() {
			return health_check();
		}
	},
	services: {
		call: function() {
			return get_services();
		}
	},
	custom_services: {
		call: function() {
			return get_custom_services();
		}
	},
	add_custom_service: {
		args: { name: '', domains: [], ip_ranges: [] },
		call: function(req) {
			return add_custom_service(req.args);
		}
	},
	delete_custom_service: {
		args: { id: 'id' },
		call: function(req) {
			return delete_custom_service(req.args);
		}
	},
	toggle_custom_service: {
		args: { id: 'id', enabled: true },
		call: function(req) {
			return toggle_custom_service(req.args);
		}
	},
	get_settings: {
		call: function() {
			return get_settings();
		}
	},
	save_settings: {
		args: { settings: {} },
		call: function(req) {
			return save_settings(req.args);
		}
	},
	update_lists: {
		call: function() {
			return update_lists();
		}
	},
	update_single_service: {
		args: { service_id: 'service_id' },
		call: function(req) {
			return update_single_service(req.args);
		}
	},
	system_info: {
		call: function() {
			return get_system_info();
		}
	},
	// ===== NEW METHODS =====
	import_link: {
		args: { link: 'link' },
		call: function(req) {
			return import_link(req.args);
		}
	},
	import_batch: {
		args: { links: [] },
		call: function(req) {
			return import_batch(req.args);
		}
	},
	delete_subscription: {
		args: { id: 'id' },
		call: function(req) {
			return delete_subscription(req.args);
		}
	},
	edit_subscription: {
		args: { id: 'id', name: 'name' },
		call: function(req) {
			return edit_subscription(req.args);
		}
	},
	delete_tunnel: {
		args: { tag: 'tag' },
		call: function(req) {
			return delete_tunnel(req.args);
		}
	},
	get_logs: {
		args: { type: 'type', lines: 50 },
		call: function(req) {
			return get_logs(req.args);
		}
	},
	network_hosts: {
		call: function() {
			return get_network_hosts();
		}
	},
	add_device: {
		args: { ip: 'ip', mac: 'mac', name: 'name', mode: 'mode' },
		call: function(req) {
			return add_device(req.args);
		}
	},
	delete_device: {
		args: { id: 'id' },
		call: function(req) {
			return delete_device(req.args);
		}
	},
	test_domain: {
		args: { domain: 'domain' },
		call: function(req) {
			return test_domain(req.args);
		}
	},
	// ===== GROUPS =====
	groups: {
		call: function() {
			return get_groups();
		}
	},
	add_group: {
		args: { name: 'name', type: 'type', outbounds: [], interval: 'interval' },
		call: function(req) {
			return add_group(req.args);
		}
	},
	delete_group: {
		args: { id: 'id' },
		call: function(req) {
			return delete_group(req.args);
		}
	},
	// ===== SERVICE ROUTES =====
	service_routes: {
		call: function() {
			return get_service_routes();
		}
	},
	set_service_route: {
		args: { service_id: 'service_id', outbound: 'outbound' },
		call: function(req) {
			return set_service_route(req.args);
		}
	},
	// ===== ADBLOCK =====
	adblock_status: {
		call: function() {
			return get_adblock_status();
		}
	},
	toggle_adblock: {
		args: { enabled: true },
		call: function(req) {
			return toggle_adblock(req.args);
		}
	},
	update_adblock: {
		call: function() {
			return update_adblock();
		}
	},
	// ===== EXPORT/IMPORT =====
	export_config: {
		call: function() {
			return export_config();
		}
	},
	import_config: {
		args: { data: {} },
		call: function(req) {
			return import_config(req.args);
		}
	}
};

// Register as 'luci.pinpoint' ubus object
return { 'luci.pinpoint': methods };
