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
			callGetServices()
		]);
	},

	render: function(data) {
		var devicesData = data[0] || {};
		var servicesData = data[1] || {};
		var devices = devicesData.devices || [];
		var allServices = servicesData.services || [];
		var self = this;
		
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
											// First save mode, then show modal
											s.disabled = true;
											withLoading('Сохранение...', 
												callSetDeviceMode(deviceId, null, newMode)
													.then(function() {
														return callApply();
													})
											).then(function() {
												s.disabled = false;
												// Update local device mode
												currentDevice.mode = 'custom';
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
										callSetDeviceMode(deviceId, null, newMode)
											.then(function() {
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
					]),
					E('div', { 'class': 'td' }, [
						(function() {
							var btn = E('button', {
								'class': 'btn cbi-button ' + (device.enabled ? 'cbi-button-positive' : 'cbi-button-neutral'),
								'data-device': device.id,
								'data-enabled': device.enabled ? '1' : '0',
								'style': 'min-width: 80px'
							}, device.enabled ? 'ВКЛ' : 'ВЫКЛ');
							
							btn.onclick = function(e) {
								if (isLoading) return;
								
								var deviceId = this.getAttribute('data-device');
								var currentState = this.getAttribute('data-enabled') === '1';
								var newState = !currentState;
								var that = this;
								
								that.disabled = true;
								that.textContent = '...';
								showLoading(newState ? 'Включение...' : 'Выключение...');
								
								callEnableDevice(deviceId, newState)
									.then(function() {
										return callApply();
									})
									.then(function() {
										that.setAttribute('data-enabled', newState ? '1' : '0');
										that.textContent = newState ? 'ВКЛ' : 'ВЫКЛ';
										that.className = 'btn cbi-button ' + (newState ? 'cbi-button-positive' : 'cbi-button-neutral');
										hideLoading();
										that.disabled = false;
									})
									.catch(function(e) {
										hideLoading();
										that.disabled = false;
										that.textContent = currentState ? 'ВКЛ' : 'ВЫКЛ';
										ui.addNotification(null, E('p', 'Ошибка: ' + (e.message || e)), 'danger');
									});
							};
							
							return btn;
						})()
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
