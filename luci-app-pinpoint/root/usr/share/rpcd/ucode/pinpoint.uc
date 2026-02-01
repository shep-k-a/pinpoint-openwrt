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

// Get VPN status
function get_status() {
	// Check if tun1 is up
	let tun_up = (stat('/sys/class/net/tun1') != null);
	
	// Check sing-box process
	let singbox_running = false;
	let ps_out = run_cmd('pgrep sing-box');
	if (ps_out && trim(ps_out) != '') {
		singbox_running = true;
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
	
	return {
		tunnel_up: tun_up,
		singbox_running: singbox_running,
		vpn_active: tun_up && singbox_running,
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

// Get all services
function get_services() {
	let data = read_json(SERVICES_FILE);
	if (!data) {
		return { services: [], categories: {} };
	}
	return {
		services: data.services || [],
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
	return { success: true, id: service_id, enabled: !!enabled };
}

// Get all devices
function get_devices() {
	let data = read_json(DEVICES_FILE);
	if (!data) {
		return { devices: [] };
	}
	return { devices: data.devices || [] };
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

// Apply changes (run update script)
function apply() {
	let result = run_cmd('/opt/pinpoint/scripts/pinpoint-update.sh update 2>&1');
	return {
		success: true,
		output: result
	};
}

// Restart sing-box
function restart() {
	run_cmd('/etc/init.d/sing-box restart 2>&1');
	return { success: true };
}

// Get tunnel/VPN configurations
function get_tunnels() {
	// Read sing-box config
	let config = read_json('/etc/sing-box/config.json');
	let tunnels = [];
	let active = '';
	
	if (config && config.outbounds) {
		for (let ob in config.outbounds) {
			if (ob.type && ob.type != 'direct' && ob.type != 'block' && ob.type != 'dns') {
				push(tunnels, {
					tag: ob.tag || 'unknown',
					type: ob.type,
					server: ob.server || '',
					enabled: true
				});
			}
		}
		// First tunnel is active by default
		if (length(tunnels) > 0) {
			active = tunnels[0].tag;
		}
	}
	
	// Get subscriptions
	let subs = read_json(SUBSCRIPTIONS_FILE);
	
	return { 
		tunnels: tunnels, 
		active: active,
		subscriptions: subs ? subs.subscriptions || [] : []
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
	
	return { success: true, id: id };
}

// Update all subscriptions
function update_subscriptions() {
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
	
	// Remove outbounds from previous subscription updates (keep non-subscription ones)
	let keep_outbounds = [];
	for (let ob in config.outbounds) {
		// Keep system outbounds (direct, block, dns) and manually imported
		if (!ob._subscription) {
			push(keep_outbounds, ob);
		}
	}
	config.outbounds = keep_outbounds;
	
	let total_imported = 0;
	
	// For each subscription, download and parse
	for (let i = 0; i < length(subs.subscriptions); i++) {
		let sub = subs.subscriptions[i];
		let content = run_cmd('curl -s -L --max-time 30 "' + sub.url + '" 2>/dev/null');
		
		if (!content || trim(content) == '') {
			continue;
		}
		
		content = trim(content);
		let links = [];
		
		// Try to decode as Base64 first
		if (!match(content, /^[a-z]+:\/\//i) && !match(content, /^\{/) && !match(content, /^proxies:/)) {
			let decoded = run_cmd('echo "' + content + '" | base64 -d 2>/dev/null');
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
			try {
				let sb_config = json(content);
				if (sb_config.outbounds) {
					for (let ob in sb_config.outbounds) {
						if (ob.type && ob.type != 'direct' && ob.type != 'block' && ob.type != 'dns') {
							ob._subscription = sub.id;
							push(config.outbounds, ob);
							total_imported++;
						}
					}
				}
			} catch(e) {}
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
	
	write_json('/etc/sing-box/config.json', config);
	write_json(SUBSCRIPTIONS_FILE, subs);
	
	// Restart sing-box
	run_cmd('/etc/init.d/sing-box restart 2>&1');
	
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
	if (config.outbounds) {
		for (let i = 0; i < length(config.outbounds); i++) {
			if (config.outbounds[i].tag == tag) {
				let ob = splice(config.outbounds, i, 1)[0];
				unshift(config.outbounds, ob);
				found = true;
				break;
			}
		}
	}
	
	if (!found) {
		return { error: 'Tunnel not found' };
	}
	
	write_json('/etc/sing-box/config.json', config);
	run_cmd('/etc/init.d/sing-box restart 2>&1');
	
	return { success: true, active: tag };
}

// Health check for tunnels
function health_check() {
	let tunnels = get_tunnels().tunnels;
	let results = [];
	
	for (let t in tunnels) {
		// Ping test via tunnel
		let latency = null;
		let test_out = run_cmd('ping -c 1 -W 3 8.8.8.8 2>/dev/null');
		
		if (test_out) {
			let m = match(test_out, /time=([0-9.]+)/);
			if (m) {
				latency = int(+m[1]);
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
	let ips = params.ips || [];
	
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
		ips: ips,
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
			tunnel_interface: 'tun1',
			tunnel_mark: '0x100'
		};
	}
	return settings;
}

// Save settings
function save_settings(params) {
	let settings = params.settings || params;
	
	let current = get_settings();
	
	if (settings.auto_update != null) current.auto_update = settings.auto_update;
	if (settings.update_interval != null) current.update_interval = settings.update_interval;
	if (settings.tunnel_interface != null) current.tunnel_interface = settings.tunnel_interface;
	if (settings.tunnel_mark != null) current.tunnel_mark = settings.tunnel_mark;
	
	write_json(SETTINGS_FILE, current);
	
	return { success: true };
}

// Get system info
function get_system_info() {
	let singbox_ver = run_cmd('sing-box version 2>/dev/null | head -1');
	
	let mem_info = run_cmd('free | grep Mem');
	let mem_total = 0, mem_used = 0;
	if (mem_info) {
		let parts = split(trim(mem_info), /\s+/);
		if (length(parts) >= 3) {
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

// ===== IMPORT LINKS =====

// Parse VPN link and extract outbound config
function parse_vpn_link(link) {
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
				for (let pair in pairs) {
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
		let json_str = run_cmd('echo "' + b64 + '" | base64 -d 2>/dev/null');
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
			let userinfo = run_cmd('echo "' + m[1] + '" | base64 -d 2>/dev/null');
			if (userinfo) {
				let parts = split(trim(userinfo), ':');
				if (length(parts) >= 2) {
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
}

// URL decode helper
function urldecode(str) {
	if (!str) return '';
	return replace(replace(str, /\+/g, ' '), /%([0-9A-Fa-f]{2})/g, function(m, hex) {
		return chr(int('0x' + hex));
	});
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
	write_json('/etc/sing-box/config.json', config);
	
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
	
	write_json('/etc/sing-box/config.json', config);
	
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
	write_json('/etc/sing-box/config.json', config);
	
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
	
	return {
		logs: split(trim(output), '\n'),
		type: log_type
	};
}

// Get network hosts (from DHCP leases and ARP)
function get_network_hosts() {
	let hosts = [];
	let seen = {};
	
	// Read DHCP leases
	let leases = readfile('/tmp/dhcp.leases');
	if (leases) {
		let lines = split(trim(leases), '\n');
		for (let line in lines) {
			let parts = split(line, /\s+/);
			if (length(parts) >= 4) {
				let mac = parts[1];
				let ip = parts[2];
				let name = parts[3];
				if (name == '*') name = '';
				
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
	
	// Read ARP table for additional hosts
	let arp = run_cmd('cat /proc/net/arp 2>/dev/null');
	if (arp) {
		let lines = split(trim(arp), '\n');
		for (let i = 1; i < length(lines); i++) {
			let parts = split(lines[i], /\s+/);
			if (length(parts) >= 4) {
				let ip = parts[0];
				let mac = parts[3];
				
				if (mac != '00:00:00:00:00:00' && !seen[mac]) {
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
	devices: {
		call: function() {
			return get_devices();
		}
	},
	set_device: {
		args: { id: 'id', enabled: true, mode: 'mode', name: 'name' },
		call: function(req) {
			return set_device(req.args);
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
	custom_services: {
		call: function() {
			return get_custom_services();
		}
	},
	add_custom_service: {
		args: { name: 'name', domains: [], ips: [] },
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
	}
};

// Register as 'luci.pinpoint' ubus object
return { 'luci.pinpoint': methods };
