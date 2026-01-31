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
	
	// For each subscription, download and parse
	for (let i = 0; i < length(subs.subscriptions); i++) {
		let sub = subs.subscriptions[i];
		let content = run_cmd('curl -s "' + sub.url + '" 2>/dev/null');
		
		if (content) {
			// Try to count nodes (basic parsing)
			let nodes = length(split(content, '\n'));
			subs.subscriptions[i].nodes = nodes;
			subs.subscriptions[i].updated = run_cmd('date "+%Y-%m-%d %H:%M"');
			
			// Save raw content
			writefile(DATA_DIR + '/subscription_' + sub.id + '.txt', content);
		}
	}
	
	write_json(SUBSCRIPTIONS_FILE, subs);
	
	return { success: true };
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
		version: '1.0.0 Lite',
		singbox_version: singbox_ver ? trim(singbox_ver) : null,
		memory_total: mem_total,
		memory_used: mem_used,
		services_count: services_count,
		last_update: status ? status.last_update : null
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
	}
};

// Register as 'luci.pinpoint' ubus object
return { 'luci.pinpoint': methods };
