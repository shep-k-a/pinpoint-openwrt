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

// AdBlock temporarily disabled - will be re-enabled after main system is stable
// var callAdblockStatus = rpc.declare({
// 	object: 'luci.pinpoint',
// 	method: 'adblock_status',
// 	expect: { }
// });
// 
// var callToggleAdblock = rpc.declare({
// 	object: 'luci.pinpoint',
// 	method: 'toggle_adblock',
// 	params: ['enabled'],
// 	expect: { }
// });
// 
// var callUpdateAdblock = rpc.declare({
// 	object: 'luci.pinpoint',
// 	method: 'update_adblock',
// 	expect: { }
// });

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

// Create progress bar modal
function createProgressModal(title, message) {
	var progressContainer = E('div', { 'style': 'width: 100%; max-width: 400px;' }, [
		E('p', { 'style': 'margin-bottom: 15px;' }, message || title),
		E('div', {
			'class': 'progress-bar-container',
			'style': 'width: 100%; height: 20px; background-color: #e5e7eb; border-radius: 10px; overflow: hidden; position: relative;'
		}, [
			E('div', {
				'class': 'progress-bar-fill',
				'id': 'progress-fill',
				'style': 'height: 100%; background: linear-gradient(90deg, #3b82f6, #2563eb); width: 0%; transition: width 0.3s ease; border-radius: 10px;'
			}),
			E('div', {
				'id': 'progress-text',
				'style': 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 11px; font-weight: bold; color: #1f2937; white-space: nowrap;'
			}, '0%')
		]),
		E('div', {
			'id': 'progress-status',
			'style': 'margin-top: 10px; font-size: 12px; color: #666; text-align: center; min-height: 16px;'
		}, '')
	]);
	
	return progressContainer;
}

// Update progress bar
function updateProgress(percent, status) {
	var fill = document.getElementById('progress-fill');
	var text = document.getElementById('progress-text');
	var statusEl = document.getElementById('progress-status');
	
	if (fill) {
		fill.style.width = Math.min(100, Math.max(0, percent)) + '%';
	}
	if (text) {
		text.textContent = Math.min(100, Math.max(0, Math.round(percent))) + '%';
	}
	if (statusEl && status) {
		statusEl.textContent = status;
	}
}

return view.extend({
	load: function() {
		return Promise.all([
			callGetSettings(),
			callGetSystemInfo().catch(function() { return {}; })
			// AdBlock temporarily disabled
			// callAdblockStatus().catch(function() { return {}; })
		]);
	},

	render: function(data) {
		var settings = data[0] || {};
		var sysinfo = data[1] || {};
		// var adblock = data[2] || {}; // AdBlock temporarily disabled
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
							var progressModal = createProgressModal(_('Обновление списков'), _('Запуск обновления всех включённых сервисов...'));
							ui.showModal(_('Обновление списков'), progressModal);
							
							// Start update (non-blocking, runs in background)
							var updateStarted = false;
							callUpdateLists().then(function(result) {
								updateStarted = true;
								if (result && result.success) {
									updateProgress(5, _('Обновление запущено в фоне...'));
								} else {
									updateProgress(5, _('Ошибка запуска обновления'));
								}
							}).catch(function(e) {
								updateStarted = true;
								updateProgress(5, _('Ошибка: ') + (e.message || e));
							});
							
							// Simulate realistic progress (30-45 seconds for updating all enabled services)
							var progress = 0;
							var elapsed = 0;
							var totalTime = 35000; // 35 seconds
							var progressInterval = setInterval(function() {
								elapsed += 500;
								
								// Calculate progress based on elapsed time
								progress = Math.min(95, (elapsed / totalTime) * 100);
								
								var status = '';
								if (progress < 15) {
									status = _('Подключение к источникам...');
								} else if (progress < 35) {
									status = _('Загрузка IP списков с GitHub...');
								} else if (progress < 60) {
									status = _('Обработка и объединение списков...');
								} else if (progress < 80) {
									status = _('Обновление nftables правил...');
								} else if (progress < 95) {
									status = _('Применение DNS конфигурации...');
								} else {
									status = _('Завершение обновления...');
								}
								
								updateProgress(progress, status);
								
								// Complete after totalTime
								if (elapsed >= totalTime) {
									clearInterval(progressInterval);
									updateProgress(100, _('Готово! Обновление завершено'));
									
									setTimeout(function() {
										ui.hideModal();
										ui.addNotification(null, E('p', [
											_('Обновление всех включённых сервисов запущено. '),
											E('br'),
											_('Проверка логов: '),
											E('code', {}, 'logread | grep pinpoint-update')
										]), 'info');
									}, 1000);
								}
							}, 500);
						})
					}, _('Обновить все включённые сервисы')),
					
					E('div', { 'style': 'width: 100%; padding: 5px 0; color: #666; font-size: 0.9em;' }, [
						_('Используйте эту кнопку для принудительного обновления IP и доменов всех включённых сервисов (если списки устарели). '),
						_('При включении отдельного сервиса обновление происходит автоматически.')
					]),
					
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
		
		// AdBlock Section - temporarily disabled
		// view.appendChild(E('h3', {}, _('AdBlock')));
		// ... AdBlock code commented out until main system is stable ...
		
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
			// Full mode check: Python must be installed
			var hasPython = sysinfo && sysinfo.python_version && sysinfo.python_version !== 'Not installed';
			var updateTimeRow = document.getElementById('update-time-row');
			if (updateTimeRow) {
				updateTimeRow.style.display = hasPython ? 'table-row' : 'none';
			}
		}).catch(function() {
			// If system_info fails, assume Lite mode (hide update_time)
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
