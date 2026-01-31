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
			E('p', {}, _('Configure per-device VPN routing.'))
		]);
		
		if (devices.length === 0) {
			view.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('p', { 'style': 'text-align: center; padding: 20px; color: #666;' }, 
						_('No devices configured. Add devices from the network hosts list.'))
				])
			]));
		} else {
			var table = E('div', { 'class': 'table cbi-section-table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, _('Device')),
					E('div', { 'class': 'th' }, _('IP Address')),
					E('div', { 'class': 'th' }, _('Mode')),
					E('div', { 'class': 'th', 'style': 'width:100px' }, _('Enabled'))
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
					])
				]);
				
				table.appendChild(row);
			});
			
			view.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [table])
			]));
		}
		
		// Apply button
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
