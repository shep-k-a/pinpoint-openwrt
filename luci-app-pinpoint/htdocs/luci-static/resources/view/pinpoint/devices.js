'use strict';
'require view';
'require rpc';
'require ui';
'require dom';

var callGetDevices = rpc.declare({
	object: 'luci.pinpoint',
	method: 'devices',
	expect: { }
});

var callSetDevice = rpc.declare({
	object: 'luci.pinpoint',
	method: 'set_device',
	params: ['id', 'enabled', 'mode', 'name'],
	expect: { }
});

var callAddDevice = rpc.declare({
	object: 'luci.pinpoint',
	method: 'add_device',
	params: ['ip', 'mac', 'name', 'mode'],
	expect: { }
});

var callDeleteDevice = rpc.declare({
	object: 'luci.pinpoint',
	method: 'delete_device',
	params: ['id'],
	expect: { }
});

var callNetworkHosts = rpc.declare({
	object: 'luci.pinpoint',
	method: 'network_hosts',
	expect: { }
});

var callApply = rpc.declare({
	object: 'luci.pinpoint',
	method: 'apply',
	expect: { }
});

var modeLabels = {
	'default': 'Global Settings',
	'vpn_all': 'All Traffic → VPN',
	'direct_all': 'All Traffic → Direct',
	'custom': 'Custom Services'
};

return view.extend({
	load: function() {
		return callGetDevices();
	},

	render: function(data) {
		var devices = data.devices || [];
		var self = this;
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('PinPoint Devices')),
			E('p', {}, _('Configure per-device VPN routing. Add devices from network or manually.'))
		]);
		
		// ===== ADD DEVICE SECTION =====
		view.appendChild(E('h3', {}, _('Add Device')));
		
		var addSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;' }, [
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #666; margin-bottom: 4px;' }, _('IP Address')),
						E('input', {
							'type': 'text',
							'id': 'add-device-ip',
							'class': 'cbi-input-text',
							'placeholder': '192.168.1.100',
							'style': 'width: 140px;'
						})
					]),
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #666; margin-bottom: 4px;' }, _('MAC Address')),
						E('input', {
							'type': 'text',
							'id': 'add-device-mac',
							'class': 'cbi-input-text',
							'placeholder': 'AA:BB:CC:DD:EE:FF',
							'style': 'width: 160px;'
						})
					]),
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #666; margin-bottom: 4px;' }, _('Name')),
						E('input', {
							'type': 'text',
							'id': 'add-device-name',
							'class': 'cbi-input-text',
							'placeholder': _('Device name'),
							'style': 'width: 150px;'
						})
					]),
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #666; margin-bottom: 4px;' }, _('Mode')),
						E('select', { 'id': 'add-device-mode', 'class': 'cbi-input-select', 'style': 'width: 150px;' }, [
							E('option', { 'value': 'default' }, modeLabels['default']),
							E('option', { 'value': 'vpn_all' }, modeLabels['vpn_all']),
							E('option', { 'value': 'direct_all' }, modeLabels['direct_all']),
							E('option', { 'value': 'custom' }, modeLabels['custom'])
						])
					]),
					E('button', {
						'class': 'btn cbi-button cbi-button-add',
						'style': 'height: 34px;',
						'click': ui.createHandlerFn(self, function() {
							var ip = document.getElementById('add-device-ip').value.trim();
							var mac = document.getElementById('add-device-mac').value.trim();
							var name = document.getElementById('add-device-name').value.trim();
							var mode = document.getElementById('add-device-mode').value;
							
							if (!ip && !mac) {
								ui.addNotification(null, E('p', _('Enter IP or MAC address')), 'warning');
								return;
							}
							
							return callAddDevice(ip || null, mac || null, name || null, mode).then(function(result) {
								if (result.success) {
									ui.addNotification(null, E('p', _('Device added')), 'success');
									window.location.reload();
								} else {
									ui.addNotification(null, E('p', result.error || _('Failed to add device')), 'danger');
								}
							});
						})
					}, _('Add'))
				]),
				E('div', { 'style': 'margin-top: 15px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							ui.showModal(_('Discovering...'), [
								E('p', { 'class': 'spinning' }, _('Scanning network for devices...'))
							]);
							
							return callNetworkHosts().then(function(result) {
								ui.hideModal();
								
								if (!result.hosts || result.hosts.length === 0) {
									ui.addNotification(null, E('p', _('No devices found on network')), 'info');
									return;
								}
								
								// Show modal with discovered hosts
								var hostsList = E('div', { 'style': 'max-height: 400px; overflow-y: auto;' });
								
								// Get existing device IPs/MACs
								var existingIps = {};
								var existingMacs = {};
								devices.forEach(function(d) {
									if (d.ip) existingIps[d.ip] = true;
									if (d.mac) existingMacs[d.mac.toLowerCase()] = true;
								});
								
								result.hosts.forEach(function(host) {
									var isExisting = existingIps[host.ip] || existingMacs[(host.mac || '').toLowerCase()];
									
									hostsList.appendChild(E('div', { 
										'style': 'display: flex; align-items: center; gap: 10px; padding: 8px; border-bottom: 1px solid #eee;' + 
											(isExisting ? ' opacity: 0.5;' : '')
									}, [
										E('input', {
											'type': 'checkbox',
											'data-ip': host.ip,
											'data-mac': host.mac || '',
											'data-name': host.name || host.ip,
											'disabled': isExisting
										}),
										E('div', { 'style': 'flex: 1;' }, [
											E('strong', {}, host.name || host.ip),
											E('br'),
											E('small', { 'style': 'color: #666;' }, host.ip + (host.mac ? ' (' + host.mac + ')' : ''))
										]),
										isExisting ? E('span', { 'style': 'color: #22c55e; font-size: 12px;' }, _('Already added')) : null
									]));
								});
								
								ui.showModal(_('Network Devices') + ' (' + result.hosts.length + ')', [
									hostsList,
									E('div', { 'style': 'margin-top: 15px; display: flex; gap: 10px;' }, [
										E('button', {
											'class': 'btn cbi-button cbi-button-add',
											'click': function() {
												var checkboxes = hostsList.querySelectorAll('input[type="checkbox"]:checked');
												if (checkboxes.length === 0) {
													ui.addNotification(null, E('p', _('Select at least one device')), 'warning');
													return;
												}
												
												var promises = [];
												checkboxes.forEach(function(cb) {
													promises.push(callAddDevice(
														cb.getAttribute('data-ip'),
														cb.getAttribute('data-mac') || null,
														cb.getAttribute('data-name'),
														'default'
													));
												});
												
												Promise.all(promises).then(function() {
													ui.hideModal();
													ui.addNotification(null, E('p', _('Added ') + promises.length + _(' device(s)')), 'success');
													window.location.reload();
												});
											}
										}, _('Add Selected')),
										E('button', {
											'class': 'btn cbi-button',
											'click': function() { ui.hideModal(); }
										}, _('Cancel'))
									])
								]);
							}).catch(function(e) {
								ui.hideModal();
								ui.addNotification(null, E('p', _('Error: ') + e.message), 'danger');
							});
						})
					}, _('Discover Network Devices'))
				])
			])
		]);
		
		view.appendChild(addSection);
		
		// ===== DEVICES LIST =====
		view.appendChild(E('h3', {}, _('Configured Devices') + ' (' + devices.length + ')'));
		
		var devicesSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (devices.length === 0) {
			devicesSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; padding: 20px; color: #666;' }, 
					_('No devices configured. Add devices manually or discover from network.'))
			);
		} else {
			var table = E('div', { 'class': 'table cbi-section-table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, _('Device')),
					E('div', { 'class': 'th' }, _('IP Address')),
					E('div', { 'class': 'th' }, _('Mode')),
					E('div', { 'class': 'th', 'style': 'width:100px' }, _('Enabled')),
					E('div', { 'class': 'th', 'style': 'width:80px' }, _('Actions'))
				])
			]);
			
			devices.forEach(function(device) {
				var row = E('div', { 
					'class': 'tr',
					'data-device-id': device.id
				}, [
					E('div', { 'class': 'td' }, [
						E('strong', {}, device.name || device.id),
						device.mac ? E('br') : null,
						device.mac ? E('small', { 'style': 'color: #666' }, device.mac) : null
					]),
					E('div', { 'class': 'td' }, device.ip || '-'),
					E('div', { 'class': 'td' }, [
						E('select', {
							'class': 'cbi-input-select',
							'data-device': device.id,
							'change': ui.createHandlerFn(self, function(ev) {
								var sel = ev.target;
								var deviceId = sel.getAttribute('data-device');
								var newMode = sel.value;
								
								return callSetDevice(deviceId, null, newMode, null).then(function(result) {
									if (!result.success && result.error) {
										ui.addNotification(null, E('p', result.error), 'danger');
									}
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Error: ') + e.message), 'danger');
								});
							})
						}, [
							E('option', { 'value': 'default', 'selected': device.mode === 'default' }, modeLabels['default']),
							E('option', { 'value': 'vpn_all', 'selected': device.mode === 'vpn_all' }, modeLabels['vpn_all']),
							E('option', { 'value': 'direct_all', 'selected': device.mode === 'direct_all' }, modeLabels['direct_all']),
							E('option', { 'value': 'custom', 'selected': device.mode === 'custom' }, modeLabels['custom'])
						])
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button ' + (device.enabled ? 'cbi-button-positive' : 'cbi-button-neutral'),
							'data-device': device.id,
							'data-enabled': device.enabled ? '1' : '0',
							'style': 'min-width: 80px',
							'click': ui.createHandlerFn(self, function(ev) {
								var btn = ev.target;
								var deviceId = btn.getAttribute('data-device');
								var currentState = btn.getAttribute('data-enabled') === '1';
								var newState = !currentState;
								
								btn.disabled = true;
								btn.textContent = '...';
								
								return callSetDevice(deviceId, newState, null, null).then(function(result) {
									if (result.success) {
										btn.setAttribute('data-enabled', newState ? '1' : '0');
										btn.textContent = newState ? _('ON') : _('OFF');
										btn.className = 'btn cbi-button ' + (newState ? 'cbi-button-positive' : 'cbi-button-neutral');
									} else if (result.error) {
										ui.addNotification(null, E('p', result.error), 'danger');
										btn.textContent = currentState ? _('ON') : _('OFF');
									}
									btn.disabled = false;
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Error: ') + e.message), 'danger');
									btn.disabled = false;
									btn.textContent = currentState ? _('ON') : _('OFF');
								});
							})
						}, device.enabled ? _('ON') : _('OFF'))
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'title': _('Delete'),
							'data-device': device.id,
							'click': ui.createHandlerFn(self, function(ev) {
								var deviceId = ev.target.getAttribute('data-device');
								if (!confirm(_('Delete this device?'))) return;
								
								return callDeleteDevice(deviceId).then(function(result) {
									if (result.success) {
										var row = document.querySelector('[data-device-id="' + deviceId + '"]');
										if (row) row.remove();
										ui.addNotification(null, E('p', _('Device deleted')), 'success');
									} else {
										ui.addNotification(null, E('p', result.error || _('Delete failed')), 'danger');
									}
								});
							})
						}, '✕')
					])
				]);
				
				table.appendChild(row);
			});
			
			devicesSection.querySelector('.cbi-section-node').appendChild(table);
		}
		
		view.appendChild(devicesSection);
		
		// ===== APPLY BUTTON =====
		view.appendChild(E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, function() {
					ui.showModal(_('Applying...'), [
						E('p', { 'class': 'spinning' }, _('Updating device rules...'))
					]);
					
					return callApply().then(function() {
						ui.hideModal();
						ui.addNotification(null, E('p', _('Device rules applied')), 'success');
					}).catch(function(e) {
						ui.hideModal();
						ui.addNotification(null, E('p', _('Error: ') + e.message), 'danger');
					});
				})
			}, _('Apply Changes'))
		]));
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
