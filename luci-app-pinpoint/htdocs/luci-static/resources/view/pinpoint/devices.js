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
		return callGetDevices();
	},

	render: function(data) {
		var devices = data.devices || [];
		var self = this;
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'Устройства PinPoint'),
			E('p', {}, 'Настройте маршрутизацию VPN для каждого устройства.')
		]);
		
		// ===== ADD DEVICE SECTION =====
		view.appendChild(E('h3', {}, 'Добавить устройство'));
		
		var addSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;' }, [
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #888; margin-bottom: 4px;' }, 'IP-адрес'),
						E('input', {
							'type': 'text',
							'id': 'add-device-ip',
							'class': 'cbi-input-text',
							'placeholder': '192.168.1.100',
							'style': 'width: 140px;'
						})
					]),
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #888; margin-bottom: 4px;' }, 'MAC-адрес'),
						E('input', {
							'type': 'text',
							'id': 'add-device-mac',
							'class': 'cbi-input-text',
							'placeholder': 'AA:BB:CC:DD:EE:FF',
							'style': 'width: 160px;'
						})
					]),
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #888; margin-bottom: 4px;' }, 'Название'),
						E('input', {
							'type': 'text',
							'id': 'add-device-name',
							'class': 'cbi-input-text',
							'placeholder': 'Мой телефон',
							'style': 'width: 150px;'
						})
					]),
					E('div', {}, [
						E('label', { 'style': 'display: block; font-size: 12px; color: #888; margin-bottom: 4px;' }, 'Режим'),
						E('select', { 'id': 'add-device-mode', 'class': 'cbi-input-select', 'style': 'width: 180px;' }, [
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
							if (isLoading) return;
							
							var ip = document.getElementById('add-device-ip').value.trim();
							var mac = document.getElementById('add-device-mac').value.trim();
							var name = document.getElementById('add-device-name').value.trim();
							var mode = document.getElementById('add-device-mode').value;
							
							if (!ip && !mac) {
								ui.addNotification(null, E('p', 'Введите IP или MAC адрес'), 'warning');
								return;
							}
							
							return withLoading('Добавление устройства...', 
								callAddDevice(ip || null, mac || null, name || null, mode)
									.then(function(result) {
										if (result.success) {
											return callApply().then(function() {
												ui.addNotification(null, E('p', 'Устройство добавлено'), 'success');
												window.location.reload();
											});
										} else {
											ui.addNotification(null, E('p', result.error || 'Ошибка добавления'), 'danger');
										}
									})
							);
						})
					}, 'Добавить')
				]),
				E('div', { 'style': 'margin-top: 15px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							if (isLoading) return;
							
							showLoading('Поиск устройств в сети...');
							
							return callNetworkHosts().then(function(result) {
								hideLoading();
								
								if (!result.hosts || result.hosts.length === 0) {
									ui.addNotification(null, E('p', 'Устройства не найдены'), 'info');
									return;
								}
								
								var hostsList = E('div', { 'style': 'max-height: 400px; overflow-y: auto;' });
								
								var existingIps = {};
								var existingMacs = {};
								devices.forEach(function(d) {
									if (d.ip) existingIps[d.ip] = true;
									if (d.mac) existingMacs[d.mac.toLowerCase()] = true;
								});
								
								result.hosts.forEach(function(host) {
									var isExisting = existingIps[host.ip] || existingMacs[(host.mac || '').toLowerCase()];
									
									hostsList.appendChild(E('div', { 
										'style': 'display: flex; align-items: center; gap: 10px; padding: 8px; border-bottom: 1px solid #333;' + 
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
											E('small', { 'style': 'color: #888;' }, host.ip + (host.mac ? ' (' + host.mac + ')' : ''))
										]),
										isExisting ? E('span', { 'style': 'color: #22c55e; font-size: 12px;' }, 'Уже добавлено') : null
									]));
								});
								
								ui.showModal('Устройства в сети (' + result.hosts.length + ')', [
									hostsList,
									E('div', { 'style': 'margin-top: 15px; display: flex; gap: 10px;' }, [
										E('button', {
											'class': 'btn cbi-button cbi-button-add',
											'click': function() {
												var checkboxes = hostsList.querySelectorAll('input[type="checkbox"]:checked');
												if (checkboxes.length === 0) {
													ui.addNotification(null, E('p', 'Выберите хотя бы одно устройство'), 'warning');
													return;
												}
												
												ui.hideModal();
												showLoading('Добавление ' + checkboxes.length + ' устройств...');
												
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
													return callApply();
												}).then(function() {
													hideLoading();
													ui.addNotification(null, E('p', 'Добавлено ' + promises.length + ' устройств'), 'success');
													window.location.reload();
												}).catch(function(e) {
													hideLoading();
													ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
												});
											}
										}, 'Добавить выбранные'),
										E('button', {
											'class': 'btn cbi-button',
											'click': function() { ui.hideModal(); }
										}, 'Отмена')
									])
								]);
							}).catch(function(e) {
								hideLoading();
								ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
							});
						})
					}, 'Найти устройства в сети')
				])
			])
		]);
		
		view.appendChild(addSection);
		
		// ===== DEVICES LIST =====
		view.appendChild(E('h3', {}, 'Настроенные устройства (' + devices.length + ')'));
		
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
					E('div', { 'class': 'th' }, 'Режим'),
					E('div', { 'class': 'th', 'style': 'width:100px' }, 'Включено'),
					E('div', { 'class': 'th', 'style': 'width:80px' }, 'Действия')
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
								'style': 'min-width: 160px;',
								'change': ui.createHandlerFn(self, function(ev) {
									if (isLoading) return;
									
									var s = ev.target;
									var deviceId = s.getAttribute('data-device');
									var newMode = s.value;
									s.disabled = true;
									
									return withLoading('Сохранение...', 
										callSetDevice(deviceId, null, newMode, null)
											.then(function(result) {
												if (result.error) {
													ui.addNotification(null, E('p', result.error), 'danger');
												} else {
													return callApply();
												}
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
							return sel;
						})()
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button ' + (device.enabled ? 'cbi-button-positive' : 'cbi-button-neutral'),
							'data-device': device.id,
							'data-enabled': device.enabled ? '1' : '0',
							'style': 'min-width: 80px',
							'click': ui.createHandlerFn(self, function(ev) {
								if (isLoading) return;
								
								var btn = ev.target;
								var deviceId = btn.getAttribute('data-device');
								var currentState = btn.getAttribute('data-enabled') === '1';
								var newState = !currentState;
								
								btn.disabled = true;
								var origText = btn.textContent;
								btn.textContent = '...';
								
								return withLoading(newState ? 'Включение...' : 'Выключение...', 
									callSetDevice(deviceId, newState, null, null)
										.then(function(result) {
											if (result.success) {
												btn.setAttribute('data-enabled', newState ? '1' : '0');
												btn.textContent = newState ? 'ВКЛ' : 'ВЫКЛ';
												btn.className = 'btn cbi-button ' + (newState ? 'cbi-button-positive' : 'cbi-button-neutral');
												return callApply();
											} else {
												btn.textContent = origText;
												if (result.error) {
													ui.addNotification(null, E('p', result.error), 'danger');
												}
											}
										})
								).then(function() {
									btn.disabled = false;
								}).catch(function(e) {
									btn.disabled = false;
									btn.textContent = origText;
									ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
								});
							})
						}, device.enabled ? 'ВКЛ' : 'ВЫКЛ')
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'title': 'Удалить',
							'data-device': device.id,
							'click': ui.createHandlerFn(self, function(ev) {
								if (isLoading) return;
								
								var deviceId = ev.target.getAttribute('data-device');
								if (!confirm('Удалить это устройство?')) return;
								
								return withLoading('Удаление...', 
									callDeleteDevice(deviceId)
										.then(function(result) {
											if (result.success) {
												return callApply().then(function() {
													var row = document.querySelector('[data-device-id="' + deviceId + '"]');
													if (row) row.remove();
													ui.addNotification(null, E('p', 'Устройство удалено'), 'success');
												});
											} else {
												ui.addNotification(null, E('p', result.error || 'Ошибка удаления'), 'danger');
											}
										})
								);
							})
						}, '✕')
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
