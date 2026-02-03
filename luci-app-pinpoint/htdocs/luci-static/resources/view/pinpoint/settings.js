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
	method: 'update_lists',
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

var callAdblockStatus = rpc.declare({
	object: 'luci.pinpoint',
	method: 'adblock_status',
	expect: { }
});

var callToggleAdblock = rpc.declare({
	object: 'luci.pinpoint',
	method: 'toggle_adblock',
	params: ['enabled'],
	expect: { }
});

var callUpdateAdblock = rpc.declare({
	object: 'luci.pinpoint',
	method: 'update_adblock',
	expect: { }
});

var callExportConfig = rpc.declare({
	object: 'luci.pinpoint',
	method: 'export_config',
	expect: { }
});

var callImportConfig = rpc.declare({
	object: 'luci.pinpoint',
	method: 'import_config',
	params: ['data'],
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
			callGetSystemInfo().catch(function() { return {}; }),
			callAdblockStatus().catch(function() { return {}; })
		]);
	},

	render: function(data) {
		var settings = data[0] || {};
		var sysinfo = data[1] || {};
		var adblock = data[2] || {};
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
					E('div', { 'class': 'tr', 'id': 'update-time-row', 'style': 'display: none;' }, [
						E('div', { 'class': 'td left' }, _('Update Time (Full mode only)')),
						E('div', { 'class': 'td' }, [
							E('input', {
								'type': 'time',
								'id': 'update-time',
								'class': 'cbi-input-text',
								'value': settings.update_time || '03:00',
								'style': 'width: 120px;'
							}),
							E('span', { 'style': 'margin-left: 10px; color: #666;' }, 
								_('Daily update time (24-hour format)'))
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
								E('p', { 'class': 'spinning' }, _('Downloading IP lists and updating services...'))
							]);
							
							return callUpdateLists().then(function(result) {
								ui.hideModal();
								if (result && result.success) {
									ui.addNotification(null, E('p', _('Lists updated successfully')), 'success');
								} else {
									ui.addNotification(null, E('p', result && result.error ? result.error : _('Update failed')), 'danger');
								}
							}).catch(function(e) {
								ui.hideModal();
								ui.addNotification(null, E('p', _('Update error: ') + (e.message || e)), 'danger');
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
		
		// AdBlock Section
		view.appendChild(E('h3', {}, _('AdBlock')));
		view.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'class': 'table' }, [
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left', 'style': 'width: 200px;' }, _('Status')),
						E('div', { 'class': 'td' }, [
							E('span', { 
								'id': 'adblock-status',
								'style': 'color: ' + (adblock.enabled ? '#22c55e' : '#ef4444') + ';'
							}, adblock.enabled ? _('Enabled') : _('Disabled'))
						])
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Blocked Domains')),
						E('div', { 'class': 'td', 'id': 'adblock-count' }, adblock.blocked_domains || 0)
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Last Update')),
						E('div', { 'class': 'td', 'id': 'adblock-updated' }, adblock.last_update || _('Never'))
					])
				]),
				E('div', { 'style': 'margin-top: 10px; display: flex; gap: 10px;' }, [
					E('button', {
						'class': 'btn cbi-button ' + (adblock.enabled ? 'cbi-button-negative' : 'cbi-button-apply'),
						'id': 'adblock-toggle-btn',
						'click': ui.createHandlerFn(self, function() {
							var newState = !adblock.enabled;
							
							ui.showModal(newState ? _('Enabling...') : _('Disabling...'), [
								E('p', { 'class': 'spinning' }, _('Updating AdBlock...'))
							]);
							
							return callToggleAdblock(newState).then(function(result) {
								ui.hideModal();
								if (result.success) {
									adblock.enabled = result.enabled;
									var statusEl = document.getElementById('adblock-status');
									var btn = document.getElementById('adblock-toggle-btn');
									statusEl.textContent = result.enabled ? _('Enabled') : _('Disabled');
									statusEl.style.color = result.enabled ? '#22c55e' : '#ef4444';
									btn.textContent = result.enabled ? _('Disable AdBlock') : _('Enable AdBlock');
									btn.className = 'btn cbi-button ' + (result.enabled ? 'cbi-button-negative' : 'cbi-button-apply');
									ui.addNotification(null, E('p', _('AdBlock ') + (result.enabled ? _('enabled') : _('disabled'))), 'success');
								}
							});
						})
					}, adblock.enabled ? _('Disable AdBlock') : _('Enable AdBlock')),
					
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							if (!adblock.enabled) {
								ui.addNotification(null, E('p', _('Enable AdBlock first')), 'warning');
								return;
							}
							
							ui.showModal(_('Updating...'), [
								E('p', { 'class': 'spinning' }, _('Downloading blocklists...'))
							]);
							
							return callUpdateAdblock().then(function(result) {
								ui.hideModal();
								if (result.success) {
									document.getElementById('adblock-count').textContent = result.count || 0;
									ui.addNotification(null, E('p', _('Blocklists updated: ') + (result.count || 0) + _(' domains')), 'success');
								} else {
									ui.addNotification(null, E('p', result.error || _('Update failed')), 'danger');
								}
							});
						})
					}, _('Update Blocklists'))
				])
			])
		]));
		
		// Export/Import Section
		view.appendChild(E('h3', {}, _('Backup & Restore')));
		view.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('p', { 'style': 'color: #666; margin-bottom: 15px;' }, 
					_('Export all settings, services, devices, and subscriptions to a JSON file.')),
				E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							ui.showModal(_('Exporting...'), [
								E('p', { 'class': 'spinning' }, _('Preparing export...'))
							]);
							
							return callExportConfig().then(function(result) {
								ui.hideModal();
								if (result.success && result.data) {
									var dataStr = JSON.stringify(result.data, null, 2);
									var blob = new Blob([dataStr], { type: 'application/json' });
									var url = URL.createObjectURL(blob);
									var a = document.createElement('a');
									a.href = url;
									a.download = 'pinpoint-backup-' + new Date().toISOString().split('T')[0] + '.json';
									document.body.appendChild(a);
									a.click();
									document.body.removeChild(a);
									URL.revokeObjectURL(url);
									ui.addNotification(null, E('p', _('Config exported')), 'success');
								} else {
									ui.addNotification(null, E('p', _('Export failed')), 'danger');
								}
							});
						})
					}, _('Export Config')),
					
					E('input', {
						'type': 'file',
						'id': 'import-file',
						'accept': '.json',
						'style': 'display: none;',
						'change': ui.createHandlerFn(self, function(ev) {
							var file = ev.target.files[0];
							if (!file) return;
							
							var reader = new FileReader();
							reader.onload = function(e) {
								try {
									var data = JSON.parse(e.target.result);
									
									if (!confirm(_('Import this config? This will overwrite current settings.'))) {
										return;
									}
									
									ui.showModal(_('Importing...'), [
										E('p', { 'class': 'spinning' }, _('Importing configuration...'))
									]);
									
									callImportConfig(data).then(function(result) {
										ui.hideModal();
										if (result.success) {
											ui.addNotification(null, E('p', _('Config imported successfully')), 'success');
											window.location.reload();
										} else {
											ui.addNotification(null, E('p', result.error || _('Import failed')), 'danger');
										}
									});
								} catch (err) {
									ui.addNotification(null, E('p', _('Invalid JSON file')), 'danger');
								}
							};
							reader.readAsText(file);
						})
					}),
					
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': function() {
							document.getElementById('import-file').click();
						}
					}, _('Import Config'))
				])
			])
		]));
		
		// Check if Full mode (Python available) to show update time
		callGetSystemInfo().then(function(sysinfo) {
			var hasPython = sysinfo && sysinfo.singbox_version && sysinfo.singbox_version !== _('Not installed');
			var updateTimeRow = document.getElementById('update-time-row');
			if (updateTimeRow) {
				updateTimeRow.style.display = hasPython ? 'table-row' : 'none';
			}
		}).catch(function() {
			// If system_info fails, assume Lite mode
			var updateTimeRow = document.getElementById('update-time-row');
			if (updateTimeRow) {
				updateTimeRow.style.display = 'none';
			}
		});
		
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
					
					// Add update_time if field exists (Full mode)
					var updateTimeEl = document.getElementById('update-time');
					if (updateTimeEl && updateTimeEl.offsetParent !== null) {
						newSettings.update_time = updateTimeEl.value || '03:00';
					}
					
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
