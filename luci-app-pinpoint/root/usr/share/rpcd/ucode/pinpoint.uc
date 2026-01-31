// SPDX-License-Identifier: GPL-2.0-only
// PinPoint RPC backend for LuCI

'use strict';

import { readfile, writefile, popen, stat } from 'fs';

const PINPOINT_DIR = '/opt/pinpoint';
const DATA_DIR = PINPOINT_DIR + '/data';
const SERVICES_FILE = DATA_DIR + '/services.json';
const DEVICES_FILE = DATA_DIR + '/devices.json';

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
	}
	
	return { tunnels: tunnels };
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
	}
};

// Register as 'luci.pinpoint' ubus object
return { 'luci.pinpoint': methods };
