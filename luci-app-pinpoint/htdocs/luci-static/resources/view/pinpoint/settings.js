'use strict';
'require view';
'require rpc';
'require ui';
'require uci';

var callGetSettings = rpc.declare({
	object: 'luci.pinpoint',
	method: 'get_settings',
	expect: { }
});

var callSaveSettings = rpc.declare({
	object: 'luci.pinpoint',
	method: 'save_settings',
	params: ['settings'],
	expect: { }
});

var callUpdateLists = rpc.declare({
	object: 'luci.pinpoint',
	method: 'apply',
	expect: { }
});

var callRestart = rpc.declare({
	object: 'luci.pinpoint',
	method: 'restart',
	expect: { }
});

var callGetSystemInfo = rpc.declare({
	object: 'luci.pinpoint',
	method: 'system_info',
	expect: { }
});

function formatBytes(bytes) {
	if (!bytes) return '0 B';
	var k = 1024;
	var sizes = ['B', 'KB', 'MB', 'GB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

return view.extend({
	load: function() {
		return Promise.all([
			callGetSettings(),
			callGetSystemInfo().catch(function() { return {}; })
		]);
	},

	render: function(data) {
		var settings = data[0] || {};
		var sysinfo = data[1] || {};
		var self = this;
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('PinPoint Settings'))
		]);
		
		// System Info
		view.appendChild(E('h3', {}, _('System Information')));
		view.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'class': 'table' }, [
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left', 'style': 'width: 200px;' }, _('PinPoint Version')),
						E('div', { 'class': 'td' }, sysinfo.version || '1.0.0')
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Sing-box Version')),
						E('div', { 'class': 'td' }, sysinfo.singbox_version || _('Not installed'))
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Memory Usage')),
						E('div', { 'class': 'td' }, sysinfo.memory_used ? 
							formatBytes(sysinfo.memory_used) + ' / ' + formatBytes(sysinfo.memory_total) : '-')
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Data Directory')),
						E('div', { 'class': 'td' }, '/opt/pinpoint/data')
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Services Count')),
						E('div', { 'class': 'td' }, sysinfo.services_count || 0)
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Last Update')),
						E('div', { 'class': 'td' }, sysinfo.last_update || _('Never'))
					])
				])
			])
		]));
		
		// Update settings
		view.appendChild(E('h3', {}, _('Update Settings')));
		view.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'class': 'table' }, [
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left', 'style': 'width: 200px;' }, _('Auto Update')),
						E('div', { 'class': 'td' }, [
							E('input', {
								'type': 'checkbox',
								'id': 'auto-update',
								'checked': settings.auto_update !== false
							}),
							E('label', { 'for': 'auto-update', 'style': 'margin-left: 8px;' }, 
								_('Automatically update IP lists'))
						])
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Update Interval')),
						E('div', { 'class': 'td' }, [
							E('select', { 'id': 'update-interval', 'class': 'cbi-input-select' }, [
								E('option', { 'value': '3600', 'selected': settings.update_interval == 3600 }, _('Every hour')),
								E('option', { 'value': '21600', 'selected': settings.update_interval == 21600 }, _('Every 6 hours')),
								E('option', { 'value': '43200', 'selected': settings.update_interval == 43200 }, _('Every 12 hours')),
								E('option', { 'value': '86400', 'selected': settings.update_interval == 86400 }, _('Every 24 hours'))
							])
						])
					])
				])
			])
		]));
		
		// VPN Settings
		view.appendChild(E('h3', {}, _('VPN Settings')));
		view.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'class': 'table' }, [
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left', 'style': 'width: 200px;' }, _('Tunnel Interface')),
						E('div', { 'class': 'td' }, [
							E('input', {
								'type': 'text',
								'id': 'tunnel-iface',
								'class': 'cbi-input-text',
								'value': settings.tunnel_interface || 'tun1',
								'style': 'width: 100px;'
							})
						])
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Routing Mark')),
						E('div', { 'class': 'td' }, [
							E('input', {
								'type': 'text',
								'id': 'tunnel-mark',
								'class': 'cbi-input-text',
								'value': settings.tunnel_mark || '0x100',
								'style': 'width: 100px;'
							})
						])
					])
				])
			])
		]));
		
		// Actions
		view.appendChild(E('h3', {}, _('Maintenance')));
		view.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							ui.showModal(_('Updating...'), [
								E('p', { 'class': 'spinning' }, _('Downloading IP lists...'))
							]);
							
							return callUpdateLists().then(function() {
								ui.hideModal();
								ui.addNotification(null, E('p', _('Lists updated')), 'success');
							});
						})
					}, _('Update Lists Now')),
					
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							return callRestart().then(function() {
								ui.addNotification(null, E('p', _('Sing-box restarted')), 'success');
							});
						})
					}, _('Restart VPN')),
					
					E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'click': ui.createHandlerFn(self, function() {
							if (!confirm(_('Clear all cached data and lists?'))) return;
							// TODO: implement clear cache
							ui.addNotification(null, E('p', _('Cache cleared')), 'success');
						})
					}, _('Clear Cache'))
				])
			])
		]));
		
		// Save button
		view.appendChild(E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-save',
				'click': ui.createHandlerFn(self, function() {
					var newSettings = {
						auto_update: document.getElementById('auto-update').checked,
						update_interval: parseInt(document.getElementById('update-interval').value),
						tunnel_interface: document.getElementById('tunnel-iface').value,
						tunnel_mark: document.getElementById('tunnel-mark').value
					};
					
					return callSaveSettings(newSettings).then(function(result) {
						if (result.success) {
							ui.addNotification(null, E('p', _('Settings saved')), 'success');
						} else {
							ui.addNotification(null, E('p', result.error || _('Failed')), 'danger');
						}
					});
				})
			}, _('Save Settings'))
		]));
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
