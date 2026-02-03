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

var callEnableDevice = rpc.declare({
	object: 'luci.pinpoint',
	method: 'set_device',
	params: ['id', 'enabled'],
	expect: { success: false }
});

var callSetDeviceMode = rpc.declare({
	object: 'luci.pinpoint',
	method: 'set_device',
	params: ['id', 'enabled', 'mode'],
	expect: { success: false }
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

var callGetServices = rpc.declare({
	object: 'luci.pinpoint',
	method: 'services',
	expect: { }
});

var callSetDeviceServices = rpc.declare({
	object: 'luci.pinpoint',
	method: 'set_device_services',
	params: ['id', 'services'],
	expect: { success: false }
});

var modeLabels = {
	'default': 'Глобальные настройки',
	'vpn_all': 'Весь трафик → VPN',
	'direct_all': 'Весь трафик → Напрямую',
	'custom': 'Выбранные сервисы'
};

// Global loading state
var isLoading = false;

function showLoading(message) {
	isLoading = true;
	ui.showModal(message || 'Загрузка...', [
		E('p', { 'class': 'spinning' }, message || 'Пожалуйста, подождите...')
	]);
}

function hideLoading() {
	isLoading = false;
	ui.hideModal();
}

function withLoading(message, promise) {
	showLoading(message);
	return promise.then(function(result) {
		hideLoading();
		return result;
	}).catch(function(e) {
		hideLoading();
		throw e;
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			callGetDevices(),
			callGetServices(),
			callNetworkHosts()
		]);
	},

	render: function(data) {
		var devicesData = data[0] || {};
		var servicesData = data[1] || {};
		var networkData = data[2] || {};
		var configuredDevices = devicesData.devices || [];
		var allServices = servicesData.services || [];
		var networkHosts = networkData.hosts || [];
		var self = this;
		
		// Build lookup map for configured devices by MAC and IP
		var configuredByMac = {};
		var configuredByIp = {};
		configuredDevices.forEach(function(d) {
			if (d.mac) configuredByMac[d.mac.toLowerCase()] = d;
			if (d.ip) configuredByIp[d.ip] = d;
		});
		
		// Merge network hosts with configured devices
		var devices = [];
		var seenMacs = {};
		var seenIps = {};
		
		// First add all configured devices
		configuredDevices.forEach(function(d) {
			devices.push(d);
			if (d.mac) seenMacs[d.mac.toLowerCase()] = true;
			if (d.ip) seenIps[d.ip] = true;
		});
		
		// Then add network hosts that are not configured
		networkHosts.forEach(function(h) {
			var mac = (h.mac || '').toLowerCase();
			var ip = h.ip;
			
			if ((mac && seenMacs[mac]) || (ip && seenIps[ip])) {
				return; // Already configured
			}
			
			// Add as unconfigured device with default mode
			devices.push({
				id: mac || ('ip_' + ip.replace(/\./g, '_')),
				ip: ip,
				mac: h.mac,
				name: h.name || ip,
				mode: 'default',
				enabled: true,
				_network: true // Mark as discovered from network
			});
			
			if (mac) seenMacs[mac] = true;
			if (ip) seenIps[ip] = true;
		});
		
		// Function to show services selection modal
		function showServicesModal(device) {
			var deviceServices = device.services || [];
			var checkboxes = [];
			
			// Group services by category
			var categories = servicesData.categories || {};
			var grouped = {};
			
			allServices.forEach(function(svc) {
				var cat = svc.category || 'other';
				if (!grouped[cat]) grouped[cat] = [];
				grouped[cat].push(svc);
			});
			
			var content = E('div', { 'style': 'max-height: 400px; overflow-y: auto;' });
			
			Object.keys(grouped).sort().forEach(function(cat) {
				var catName = categories[cat] || cat;
				var catDiv = E('div', { 'style': 'margin-bottom: 15px;' }, [
					E('strong', { 'style': 'display: block; margin-bottom: 5px; color: #22c55e;' }, catName)
				]);
				
				grouped[cat].forEach(function(svc) {
					var isChecked = deviceServices.indexOf(svc.id) !== -1;
					var label = E('label', { 'style': 'display: block; padding: 3px 0; cursor: pointer;' }, [
						E('input', {
							'type': 'checkbox',
							'data-service': svc.id,
							'checked': isChecked ? 'checked' : null,
							'style': 'margin-right: 8px;'
						}),
						svc.name
					]);
					catDiv.appendChild(label);
				});
				
				content.appendChild(catDiv);
			});
			
			ui.showModal('Выберите сервисы для ' + (device.name || device.id), [
				E('p', {}, 'Выберите сервисы, трафик которых будет идти через VPN для этого устройства:'),
				content,
				E('div', { 'class': 'right', 'style': 'margin-top: 15px;' }, [
					E('button', {
						'class': 'btn',
						'click': function() { ui.hideModal(); }
					}, 'Отмена'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var selected = [];
							content.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
								selected.push(cb.getAttribute('data-service'));
							});
							
							ui.hideModal();
							showLoading('Сохранение...');
							
							callSetDeviceServices(device.id, selected)
								.then(function() {
									return callApply();
								})
								.then(function() {
									hideLoading();
									window.location.reload();
								})
								.catch(function(e) {
									hideLoading();
									ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
								});
						}
					}, 'Сохранить')
				])
			]);
		}
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'Устройства PinPoint'),
			E('p', {}, 'Настройте маршрутизацию VPN для каждого устройства.')
		]);
		
		// ===== DEVICES LIST =====
		view.appendChild(E('h3', {}, 'Устройства в сети (' + devices.length + ')'));
		
		var devicesSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (devices.length === 0) {
			devicesSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; padding: 20px; color: #888;' }, 
					'Нет настроенных устройств. Добавьте вручную или найдите в сети.')
			);
		} else {
			var table = E('div', { 'class': 'table cbi-section-table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, 'Устройство'),
					E('div', { 'class': 'th' }, 'IP-адрес'),
					E('div', { 'class': 'th' }, 'Режим')
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
						device.mac ? E('small', { 'style': 'color: #888' }, device.mac) : null
					]),
					E('div', { 'class': 'td' }, device.ip || '-'),
					E('div', { 'class': 'td' }, [
						(function() {
							var sel = E('select', {
								'class': 'cbi-input-select',
								'data-device': device.id,
								'data-network': device._network ? '1' : '',
								'data-ip': device.ip || '',
								'data-mac': device.mac || '',
								'data-name': device.name || '',
								'style': 'min-width: 160px;',
								'change': ui.createHandlerFn(self, function(ev) {
									if (isLoading) return;
									
									var s = ev.target;
									var deviceId = s.getAttribute('data-device');
									var newMode = s.value;
									var isNetworkDevice = s.getAttribute('data-network') === '1';
									
									// For network devices, add them first
									var savePromise;
									if (isNetworkDevice && newMode !== 'default') {
										var ip = s.getAttribute('data-ip');
										var mac = s.getAttribute('data-mac');
										var name = s.getAttribute('data-name');
										savePromise = callAddDevice(ip, mac || null, name, newMode);
										// Mark as no longer network device
										s.setAttribute('data-network', '');
									} else {
										savePromise = callSetDeviceMode(deviceId, null, newMode);
									}
									
									// If custom mode selected, show services modal
									if (newMode === 'custom') {
										var currentDevice = null;
										for (var i = 0; i < devices.length; i++) {
											if (devices[i].id === deviceId) {
												currentDevice = devices[i];
												break;
											}
										}
										if (currentDevice) {
											s.disabled = true;
											withLoading('Сохранение...', 
												savePromise.then(function() {
													return callApply();
												})
											).then(function() {
												s.disabled = false;
												currentDevice.mode = 'custom';
												currentDevice._network = false;
												showServicesModal(currentDevice);
											}).catch(function(e) {
												s.disabled = false;
												ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
											});
										}
										return;
									}
									
									s.disabled = true;
								return withLoading('Сохранение...', 
										savePromise.then(function() {
											return callApply();
										})
								).then(function() {
									s.disabled = false;
								}).catch(function(e) {
									s.disabled = false;
									ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
								});
								})
							}, [
								E('option', { 'value': 'default' }, modeLabels['default']),
								E('option', { 'value': 'vpn_all' }, modeLabels['vpn_all']),
								E('option', { 'value': 'direct_all' }, modeLabels['direct_all']),
								E('option', { 'value': 'custom' }, modeLabels['custom'])
							]);
							sel.value = device.mode || 'default';
							
							var container = E('div', { 'style': 'display: flex; gap: 5px; align-items: center;' }, [sel]);
							
							// Add edit button for custom mode
							if (device.mode === 'custom') {
								var editBtn = E('button', {
									'class': 'btn cbi-button',
									'title': 'Редактировать сервисы',
									'style': 'padding: 2px 8px;'
								}, '⚙');
								editBtn.onclick = function() {
									showServicesModal(device);
								};
								container.appendChild(editBtn);
								
								// Show count of selected services
								var count = (device.services || []).length;
								if (count > 0) {
									container.appendChild(E('span', { 
										'style': 'font-size: 11px; color: #888;' 
									}, '(' + count + ')'));
								}
							}
							
							return container;
						})()
					])
				]);
				
				table.appendChild(row);
			});
			
			devicesSection.querySelector('.cbi-section-node').appendChild(table);
		}
		
		view.appendChild(devicesSection);
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
