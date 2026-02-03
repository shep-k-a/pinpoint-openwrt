'use strict';
'require view';
'require rpc';
'require ui';

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

var callGetCustomServices = rpc.declare({
	object: 'luci.pinpoint',
	method: 'custom_services',
	// Backend returns { services: [...] }
	// but be tolerant to other shapes (plain array, nested objects, etc.)
	expect: { }
});

var callAddCustomService = rpc.declare({
	object: 'luci.pinpoint',
	method: 'add_custom_service',
	params: ['name', 'domains', 'ips'],
	expect: { }
});

var callDeleteCustomService = rpc.declare({
	object: 'luci.pinpoint',
	method: 'delete_custom_service',
	params: ['id'],
	expect: { }
});

var callToggleCustomService = rpc.declare({
	object: 'luci.pinpoint',
	method: 'toggle_custom_service',
	params: ['id', 'enabled'],
	expect: { }
});

var callApply = rpc.declare({
	object: 'luci.pinpoint',
	method: 'apply',
	expect: { }
});

// Helper: применить правила (без теста - тест некорректен на роутере)
function applyAndTest(services, messagePrefix) {
	var progressModal = createProgressModal(_('Applying Rules'), _('Updating routing rules...'));
	ui.showModal(_('Applying Rules'), progressModal);
	
	// Simulate progress
	var progress = 0;
	var progressInterval = setInterval(function() {
		progress += Math.random() * 20;
		if (progress > 85) progress = 85;
		
		var status = '';
		if (progress < 40) {
			status = _('Loading IP lists...');
		} else if (progress < 70) {
			status = _('Updating nftables rules...');
		} else {
			status = _('Applying DNS configuration...');
		}
		
		updateProgress(progress, status);
	}, 200);

	return callApply().then(function(result) {
		clearInterval(progressInterval);
		updateProgress(100, _('Complete!'));
		
		setTimeout(function() {
			ui.hideModal();
			var msg = (messagePrefix || '') + _('Rules applied successfully');
			ui.addNotification(null, E('p', msg), 'success');
		}, 500);
	}).catch(function(e) {
		clearInterval(progressInterval);
		ui.hideModal();
		ui.addNotification(null, E('p', _('Failed to apply rules: ') + (e && e.message ? e.message : e)), 'danger');
	});
}

return view.extend({
	load: function() {
		// Один RPC-запрос, возвращаем его как есть
		return callGetCustomServices();
	},

	render: function(data) {
		// Ответ нашего RPC (может быть объектом или сразу массивом)
		var resp = data;

		// На всякий случай лог в консоль, чтобы можно было посмотреть структуру
		try { console.log('PinPoint custom_services response:', resp); } catch (e) {}

		// Нормализуем ответ:
		//  - ожидаемый формат: { services: [...] }
		//  - на всякий случай поддерживаем: [...] или { data: { services: [...] } }
		var services = [];
		if (Array.isArray(resp)) {
			services = resp;
		} else if (resp && Array.isArray(resp.services)) {
			services = resp.services;
		} else if (resp && resp.data && Array.isArray(resp.data.services)) {
			services = resp.data.services;
		}
		var self = this;
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Custom Services')),
			E('p', {}, _('Add your own domains and IPs to route through VPN.'))
		]);
		
		// Custom services list
		var section = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (services.length === 0) {
			section.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; color: #666; padding: 20px;' },
					_('No custom services. Add one below.'))
			);
		} else {
			var table = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, _('Name')),
					E('div', { 'class': 'th' }, _('Domains')),
					E('div', { 'class': 'th' }, _('IPs')),
					E('div', { 'class': 'th', 'style': 'width: 80px;' }, _('Status')),
					E('div', { 'class': 'th', 'style': 'width: 80px;' }, _('Actions'))
				])
			]);
			
			services.forEach(function(svc) {
				table.appendChild(E('div', { 'class': 'tr', 'data-id': svc.id }, [
					E('div', { 'class': 'td' }, E('strong', {}, svc.name || svc.id)),
					E('div', { 'class': 'td' }, [
						E('small', {}, (svc.domains || []).slice(0, 3).join(', ') +
							((svc.domains || []).length > 3 ? '...' : ''))
					]),
					E('div', { 'class': 'td' }, [
						E('small', {}, (svc.ips || []).slice(0, 2).join(', ') +
							((svc.ips || []).length > 2 ? '...' : ''))
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button ' + (svc.enabled ? 'cbi-button-positive' : 'cbi-button-neutral'),
							'style': 'min-width: 60px;',
							'data-id': svc.id,
							'data-enabled': svc.enabled ? '1' : '0',
							'click': ui.createHandlerFn(self, function(ev) {
								var btn = ev.target;
								var id = btn.getAttribute('data-id');
								var newState = btn.getAttribute('data-enabled') !== '1';
								
								btn.disabled = true;
								return callToggleCustomService(id, newState).then(function(result) {
									// Обновим локальный список
									if (result && result.success) {
										services.forEach(function(s) {
											if (s.id === id)
												s.enabled = !!newState;
										});
									}
									// Мгновенно применяем и тестируем
									return applyAndTest(services, '');
								}).finally(function() {
									btn.disabled = false;
								});
							})
						}, svc.enabled ? _('ON') : _('OFF'))
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'data-id': svc.id,
							'click': ui.createHandlerFn(self, function(ev) {
								var id = ev.target.getAttribute('data-id');
								if (!confirm(_('Delete this custom service?'))) return;
								
								return callDeleteCustomService(id).then(function(result) {
									if (result && result.success) {
										// Удаляем из локального списка
										services = services.filter(function(s) { return s.id !== id; });
										var row = document.querySelector('[data-id="' + id + '"]');
										if (row) row.remove();
									}
									// Применяем и тестируем с обновлённым набором
									return applyAndTest(services, '');
								});
							})
						}, '✕')
					])
				]));
			});
			
			section.querySelector('.cbi-section-node').appendChild(table);
		}
		
		view.appendChild(section);
		
		// Add new custom service form
		view.appendChild(E('h3', {}, _('Add Custom Service')));
		
		var formSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'class': 'table' }, [
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left', 'style': 'width: 150px;' }, _('Name')),
						E('div', { 'class': 'td' }, [
							E('input', {
								'type': 'text',
								'id': 'custom-name',
								'class': 'cbi-input-text',
								'placeholder': _('My Custom Service'),
								'style': 'width: 300px;'
							})
						])
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('Domains')),
						E('div', { 'class': 'td' }, [
							E('textarea', {
								'id': 'custom-domains',
								'class': 'cbi-input-textarea',
								'placeholder': _('example.com\ntest.example.com'),
								'style': 'width: 100%; height: 80px;'
							})
						])
					]),
					E('div', { 'class': 'tr' }, [
						E('div', { 'class': 'td left' }, _('IP Addresses')),
						E('div', { 'class': 'td' }, [
							E('textarea', {
								'id': 'custom-ips',
								'class': 'cbi-input-textarea',
								'placeholder': _('1.2.3.4\n10.0.0.0/8'),
								'style': 'width: 100%; height: 80px;'
							})
						])
					])
				]),
				E('div', { 'style': 'margin-top: 15px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-add',
						'click': ui.createHandlerFn(self, function() {
							var name = document.getElementById('custom-name').value;
							var domainsText = document.getElementById('custom-domains').value;
							var ipsText = document.getElementById('custom-ips').value;
							
							if (!name) {
								ui.addNotification(null, E('p', _('Please enter a name')), 'warning');
								return;
							}
							
							var domains = domainsText.split('\n').map(function(d) { 
								return d.trim(); 
							}).filter(function(d) { return d; });
							
							var ips = ipsText.split('\n').map(function(i) { 
								return i.trim(); 
							}).filter(function(i) { return i; });
							
							if (domains.length === 0 && ips.length === 0) {
								ui.addNotification(null, E('p', _('Add at least one domain or IP')), 'warning');
								return;
							}
							
							return callAddCustomService(name, domains, ips).then(function(result) {
								if (result && !result.error) {
									// Добавляем в локальный список, чтобы сразу можно было тестировать
									services.push({
										id: result.id || ('custom_' + (new Date().getTime())),
										name: name,
										domains: domains,
										ips: ips,
										enabled: true
									});
									return applyAndTest(services, _('Custom service added. '));
								} else {
									ui.addNotification(null, E('p', (result && result.error) || _('Failed')), 'danger');
								}
							}).catch(function(e) {
								ui.addNotification(null, E('p', 'Ошибка: ' + (e && e.message ? e.message : e)), 'danger');
							});
						})
					}, _('Add Custom Service'))
				])
			])
		]);
		
		view.appendChild(formSection);
		
		// Hide "Apply Changes" button - changes are applied automatically
		var self = this;
		setTimeout(function() {
			var applyBtn = document.querySelector('.cbi-page-actions .cbi-button-apply');
			if (applyBtn) {
				applyBtn.style.display = 'none';
			}
			// Also hide the entire actions section if empty
			var actionsSection = document.querySelector('.cbi-page-actions');
			if (actionsSection) {
				var visibleButtons = actionsSection.querySelectorAll('button:not([style*="display: none"])');
				if (visibleButtons.length === 0) {
					actionsSection.style.display = 'none';
				}
			}
		}, 100);
		
		return view;
	},

	handleSaveApply: function() {
		// Do nothing - changes are applied automatically
		return Promise.resolve();
	},
	handleSave: function() {
		// Do nothing
		return Promise.resolve();
	},
	handleReset: function() {
		// Do nothing
		return Promise.resolve();
	}
});
