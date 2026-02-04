'use strict';
'require view';
'require rpc';
'require ui';
'require dom';

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

// Show edit service modal
function showEditServiceModal(service, onSave) {
	// Merge custom and original domains/IPs
	var allDomains = (service.domains || []).concat(service.custom_domains || []);
	var allIps = (service.ips || []).concat(service.custom_ips || []);
	
	var domainsText = E('textarea', {
		'id': 'edit-service-domains',
		'class': 'cbi-input-textarea',
		'style': 'width: calc(100% - 10px) !important; min-height: 150px; font-family: monospace; font-size: 12px; box-sizing: border-box !important; resize: vertical; margin: 0; padding: 8px;',
		'placeholder': 'Один домен на строку\nПример:\nyoutube.com\nytimg.com'
	}, allDomains.join('\n'));
	
	var ipsText = E('textarea', {
		'id': 'edit-service-ips',
		'class': 'cbi-input-textarea',
		'style': 'width: calc(100% - 10px) !important; min-height: 150px; font-family: monospace; font-size: 12px; box-sizing: border-box !important; resize: vertical; margin: 0; padding: 8px;',
		'placeholder': 'Один IP/CIDR на строку\nПример:\n8.8.8.8\n8.8.4.0/24\n172.217.0.0/16'
	}, allIps.join('\n'));
	
	var modalContent = E('div', { 'style': 'width: 550px; max-width: 85vw; padding: 15px; box-sizing: border-box;' }, [
		E('h3', { 'style': 'margin-top: 0;' }, 'Редактировать: ' + service.name),
		E('p', { 'style': 'margin: 10px 0; color: #666; font-size: 13px;' }, [
			E('strong', {}, 'Домены и IP из источников:'),
			' ' + ((service.domains || []).length || 0) + ' доменов, ' + ((service.ips || []).length || 0) + ' IP',
			E('br'),
			E('strong', {}, 'Ваши дополнения:'),
			' ' + ((service.custom_domains || []).length || 0) + ' доменов, ' + ((service.custom_ips || []).length || 0) + ' IP'
		]),
		E('div', { 'style': 'margin: 15px 0;' }, [
			E('label', { 'style': 'display: block; margin-bottom: 5px; font-weight: bold;' }, 'Домены:'),
			domainsText,
			E('small', { 'style': 'color: #666; display: block; margin-top: 5px;' }, 
				'Домены из источников отображаются серым (только для просмотра). Вы можете добавить свои домены.')
		]),
		E('div', { 'style': 'margin: 15px 0;' }, [
			E('label', { 'style': 'display: block; margin-bottom: 5px; font-weight: bold;' }, 'IP адреса и подсети:'),
			ipsText,
			E('small', { 'style': 'color: #666; display: block; margin-top: 5px;' }, 
				'IP из источников отображаются серым. Вы можете добавить свои IP/CIDR.')
		]),
		E('div', { 'style': 'margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end;' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': function() {
					ui.hideModal();
				}
			}, 'Отмена'),
			E('button', {
				'class': 'btn cbi-button cbi-button-positive',
				'click': function() {
					var domainsVal = document.getElementById('edit-service-domains').value;
					var ipsVal = document.getElementById('edit-service-ips').value;
					
					// Parse inputs
					var newDomains = domainsVal.split('\n')
						.map(function(d) { return d.trim(); })
						.filter(function(d) { return d.length > 0; });
					
					var newIps = ipsVal.split('\n')
						.map(function(ip) { return ip.trim(); })
						.filter(function(ip) { return ip.length > 0; });
					
					// Extract only custom (new) entries
					var customDomains = newDomains.filter(function(d) {
						return (service.domains || []).indexOf(d) === -1;
					});
					
					var customIps = newIps.filter(function(ip) {
						return (service.ips || []).indexOf(ip) === -1;
					});
					
					ui.hideModal();
					if (onSave) {
						onSave(customDomains, customIps);
					}
				}
			}, 'Сохранить')
		])
	]);
	
	ui.showModal('Редактировать сервис', modalContent);
	
	// Add CSS to fix modal overflow issues
	if (!document.getElementById('pinpoint-modal-fix')) {
		var modalStyle = document.createElement('style');
		modalStyle.id = 'pinpoint-modal-fix';
		modalStyle.textContent = `
			.modal-dialog {
				max-width: 90vw !important;
				overflow-x: hidden !important;
				box-sizing: border-box !important;
			}
			.modal-dialog > div {
				box-sizing: border-box !important;
				overflow-x: hidden !important;
			}
			.modal-dialog .cbi-input-textarea {
				box-sizing: border-box !important;
				width: calc(100% - 10px) !important;
				max-width: 100% !important;
				resize: vertical !important;
				margin: 0 !important;
				overflow-x: hidden !important;
			}
			.modal-dialog textarea {
				box-sizing: border-box !important;
			}
		`;
		document.head.appendChild(modalStyle);
	}
}

var callGetServices = rpc.declare({
	object: 'luci.pinpoint',
	method: 'services',
	expect: { }
});

var callSetService = rpc.declare({
	object: 'luci.pinpoint',
	method: 'set_service',
	params: ['id', 'enabled'],
	expect: { }
});

var callEditService = rpc.declare({
	object: 'luci.pinpoint',
	method: 'edit_service',
	params: ['id', 'custom_domains', 'custom_ips'],
	expect: { }
});

var callApply = rpc.declare({
	object: 'luci.pinpoint',
	method: 'apply',
	expect: { }
});

var callGetTunnels = rpc.declare({
	object: 'luci.pinpoint',
	method: 'tunnels',
	expect: { }
});

var callGetGroups = rpc.declare({
	object: 'luci.pinpoint',
	method: 'groups',
	expect: { }
});

var callGetServiceRoutes = rpc.declare({
	object: 'luci.pinpoint',
	method: 'service_routes',
	expect: { }
});

var callSetServiceRoute = rpc.declare({
	object: 'luci.pinpoint',
	method: 'set_service_route',
	params: ['service_id', 'outbound'],
	expect: { }
});

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
			callGetServices(),
			callGetTunnels().catch(function() { return { tunnels: [] }; }),
			callGetGroups().catch(function() { return { groups: [] }; }),
			callGetServiceRoutes().catch(function() { return { routes: [] }; })
		]);
	},

	filterServices: function(searchText, category, onlyEnabled) {
		var rows = document.querySelectorAll('[data-service-id]');
		var sections = document.querySelectorAll('.cbi-section[data-category]');
		
		rows.forEach(function(row) {
			var serviceId = row.getAttribute('data-service-id');
			var serviceName = row.querySelector('strong') ? row.querySelector('strong').textContent.toLowerCase() : '';
			var serviceCat = row.getAttribute('data-category');
			var btn = row.querySelector('button[data-enabled]');
			var isEnabled = btn && btn.getAttribute('data-enabled') === '1';
			
			var matchesSearch = !searchText || 
				serviceName.indexOf(searchText.toLowerCase()) !== -1 ||
				serviceId.indexOf(searchText.toLowerCase()) !== -1;
			
			var matchesCat = !category || category === 'all' || serviceCat === category;
			var matchesEnabled = !onlyEnabled || isEnabled;
			
			row.style.display = (matchesSearch && matchesCat && matchesEnabled) ? '' : 'none';
		});
		
		// Hide empty sections
		sections.forEach(function(section) {
			var cat = section.getAttribute('data-category');
			var visibleRows = section.querySelectorAll('[data-service-id]:not([style*="display: none"])');
			section.style.display = visibleRows.length > 0 ? '' : 'none';
		});
	},
	
	updateStats: function() {
		var allBtns = document.querySelectorAll('button[data-enabled]');
		var enabledCount = 0;
		allBtns.forEach(function(btn) {
			if (btn.getAttribute('data-enabled') === '1') enabledCount++;
		});
		
		var statsEl = document.getElementById('services-stats');
		if (statsEl) {
			statsEl.textContent = 'Всего: ' + allBtns.length + ', Включено: ' + enabledCount;
		}
		
		// Update category headers
		var sections = document.querySelectorAll('.cbi-section[data-category]');
		sections.forEach(function(section) {
			var cat = section.getAttribute('data-category');
			var catBtns = section.querySelectorAll('button[data-enabled]');
			var catEnabled = 0;
			catBtns.forEach(function(btn) {
				if (btn.getAttribute('data-enabled') === '1') catEnabled++;
			});
			var header = section.querySelector('h3');
			if (header) {
				var catName = header.textContent.split(' (')[0];
				header.textContent = catName + ' (' + catEnabled + '/' + catBtns.length + ')';
			}
		});
	},

	render: function(results) {
		var data = results[0] || {};
		var tunnelsData = results[1] || {};
		var groupsData = results[2] || {};
		var routesData = results[3] || {};
		
		var services = data.services || [];
		var categories = data.categories || {};
		var tunnels = tunnelsData.tunnels || [];
		var groups = groupsData.groups || [];
		var routes = routesData.routes || [];
		
		// Build route lookup map
		var routeMap = {};
		routes.forEach(function(r) {
			routeMap[r.service_id] = r.outbound;
		});
		
		// Build outbound options
		var outboundOptions = [{ tag: '', name: 'По умолчанию (первый туннель)' }];
		tunnels.forEach(function(t) {
			outboundOptions.push({ tag: t.tag, name: t.tag + ' (' + t.type + ')' });
		});
		groups.forEach(function(g) {
			outboundOptions.push({ tag: g.tag, name: g.name + ' [' + (g.type === 'urltest' ? 'Авто' : 'Ручной') + ']' });
		});
		
		// Group services by category
		var byCategory = {};
		services.forEach(function(s) {
			var cat = s.category || 'other';
			if (!byCategory[cat]) byCategory[cat] = [];
			byCategory[cat].push(s);
		});
		
		var self = this;
		var enabledCount = services.filter(function(s) { return s.enabled; }).length;
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'Сервисы PinPoint'),
			E('p', {}, [
				'Выберите сервисы для маршрутизации через VPN туннель. ',
				E('span', { 'id': 'services-stats' }, 'Всего: ' + services.length + ', Включено: ' + enabledCount)
			])
		]);
		
		// Search and filter bar
		var searchInput = E('input', {
			'type': 'text',
			'id': 'service-search',
			'class': 'cbi-input-text',
			'placeholder': 'Поиск сервисов...',
			'style': 'flex: 1; min-width: 200px;'
		});
		
		var categorySelect = E('select', {
			'id': 'category-filter',
			'class': 'cbi-input-select',
			'style': 'width: 200px;'
		}, [
			E('option', { 'value': 'all' }, 'Все категории')
		].concat(Object.keys(categories).sort().map(function(c) {
			return E('option', { 'value': c }, categories[c] + ' (' + (byCategory[c] ? byCategory[c].length : 0) + ')');
		})));
		
		// Checkbox for enabled only
		var enabledOnlyCheckbox = E('input', {
			'type': 'checkbox',
			'id': 'enabled-only-filter'
		});
		
		var enabledOnlyLabel = E('label', { 'style': 'display: flex; align-items: center; gap: 5px; cursor: pointer;' }, [
			enabledOnlyCheckbox,
			'Только включенные'
		]);
		
		// Add event listeners after elements are created
		var filterTimeout = null;
		
		function applyFilters() {
			var search = document.getElementById('service-search').value;
			var cat = document.getElementById('category-filter').value;
			var onlyEnabled = document.getElementById('enabled-only-filter').checked;
			self.filterServices(search, cat, onlyEnabled);
		}
		
		searchInput.addEventListener('input', function(ev) {
			clearTimeout(filterTimeout);
			filterTimeout = setTimeout(applyFilters, 150);
		});
		
		categorySelect.addEventListener('change', applyFilters);
		enabledOnlyCheckbox.addEventListener('change', applyFilters);
		
		var filterBar = E('div', { 'style': 'display: flex; gap: 10px; margin-bottom: 15px; flex-wrap: wrap; align-items: center;' }, [
			searchInput,
			categorySelect,
			enabledOnlyLabel
		]);
		
		view.appendChild(filterBar);
		
		// Quick actions
		view.appendChild(E('div', { 'style': 'margin-bottom: 15px; display: flex; gap: 10px;' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					if (isLoading) return;
					
					var visible = document.querySelectorAll('[data-service-id]:not([style*="display: none"])');
					var promises = [];
					var btns = [];
					visible.forEach(function(row) {
						var btn = row.querySelector('button[data-service]');
						if (btn && btn.getAttribute('data-enabled') !== '1') {
							promises.push(callSetService(btn.getAttribute('data-service'), true));
							btns.push(btn);
						}
					});
					if (promises.length > 0) {
							return withLoading('Включение ' + promises.length + ' сервисов...', 
								Promise.all(promises).then(function() {
									btns.forEach(function(btn) {
										btn.setAttribute('data-enabled', '1');
										btn.textContent = 'ВКЛ';
										btn.className = 'btn cbi-button cbi-button-positive';
									});
									return callApply();
								})
							).then(function() {
								self.updateStats();
								ui.addNotification(null, E('p', 'Включено ' + promises.length + ' сервисов'), 'success');
							});
					}
				})
			}, 'Включить видимые'),
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					if (isLoading) return;
					
					var visible = document.querySelectorAll('[data-service-id]:not([style*="display: none"])');
					var promises = [];
					var btns = [];
					visible.forEach(function(row) {
						var btn = row.querySelector('button[data-service]');
						if (btn && btn.getAttribute('data-enabled') === '1') {
							promises.push(callSetService(btn.getAttribute('data-service'), false));
							btns.push(btn);
						}
					});
					if (promises.length > 0) {
							return withLoading('Выключение ' + promises.length + ' сервисов...', 
								Promise.all(promises).then(function() {
									btns.forEach(function(btn) {
										btn.setAttribute('data-enabled', '0');
										btn.textContent = 'ВЫКЛ';
										btn.className = 'btn cbi-button cbi-button-neutral';
									});
									return callApply();
								})
							).then(function() {
								self.updateStats();
								ui.addNotification(null, E('p', 'Отключено ' + promises.length + ' сервисов'), 'success');
							});
					}
				})
			}, 'Выключить видимые')
		]));
		
		// Create category sections
		Object.keys(byCategory).sort().forEach(function(cat) {
			var catName = categories[cat] || cat;
			var catServices = byCategory[cat];
			var enabledInCat = catServices.filter(function(s) { return s.enabled; }).length;
			
			var section = E('div', { 'class': 'cbi-section', 'data-category': cat }, [
				E('h3', {}, catName + ' (' + enabledInCat + '/' + catServices.length + ')'),
				E('div', { 'class': 'cbi-section-node' })
			]);
			
		var table = E('div', { 'class': 'table cbi-section-table' }, [
			E('div', { 'class': 'tr table-titles' }, [
				E('div', { 'class': 'th' }, 'Сервис'),
				E('div', { 'class': 'th' }, 'Домены'),
				E('div', { 'class': 'th' }, 'IP'),
				E('div', { 'class': 'th', 'style': 'width:150px' }, 'Через'),
				E('div', { 'class': 'th', 'style': 'width:80px' }, 'Статус'),
				E('div', { 'class': 'th', 'style': 'width:100px' }, 'Действия')
			])
		]);
			
			catServices.forEach(function(service) {
				var currentRoute = routeMap[service.id] || '';
				
				// Count total domains and IPs (including custom)
				var totalDomains = (service.domains || []).length + (service.custom_domains || []).length;
				var totalIps = (service.ips || []).length + (service.custom_ips || []).length;
				
				var row = E('div', { 
					'class': 'tr',
					'data-service-id': service.id,
					'data-category': cat
				}, [
					E('div', { 'class': 'td' }, [
						E('strong', {}, service.name),
						E('br'),
						E('small', { 'style': 'color: #666' }, service.description || service.id)
					]),
					E('div', { 'class': 'td' }, [
						E('small', {}, 
							(service.domains || []).slice(0, 2).join(', ') + 
							(totalDomains > 2 ? ' +' + (totalDomains - 2) : '')
						),
						(service.custom_domains || []).length > 0 ? 
							E('span', { 'style': 'color: #10b981; font-weight: bold; margin-left: 5px;' }, 
								'+' + (service.custom_domains || []).length) : ''
					]),
					E('div', { 'class': 'td' }, [
						E('small', {}, 
							(service.ips || []).slice(0, 2).join(', ') + 
							(totalIps > 2 ? ' +' + (totalIps - 2) : '')
						),
						(service.custom_ips || []).length > 0 ? 
							E('span', { 'style': 'color: #10b981; font-weight: bold; margin-left: 5px;' }, 
								'+' + (service.custom_ips || []).length) : ''
					]),
					E('div', { 'class': 'td' }, [
						E('select', {
							'class': 'cbi-input-select',
							'style': 'width: 140px; font-size: 12px;',
							'data-service-route': service.id,
							'change': ui.createHandlerFn(self, function(ev) {
								var sel = ev.target;
								var serviceId = sel.getAttribute('data-service-route');
								var outbound = sel.value;
								
								sel.disabled = true;
								
								callSetServiceRoute(serviceId, outbound).then(function(result) {
									if (result.success) {
										// Auto-apply changes
										return callApply().then(function() {
											ui.addNotification(null, E('p', 'Маршрут обновлён и применён'), 'success');
										});
									}
								}).catch(function(e) {
									ui.addNotification(null, E('p', 'Ошибка: ' + (e.message || e)), 'danger');
								}).finally(function() {
									sel.disabled = false;
								});
							})
						}, outboundOptions.map(function(opt) {
							return E('option', { 
								'value': opt.tag, 
								'selected': opt.tag === currentRoute 
							}, opt.name);
						}))
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button ' + (service.enabled ? 'cbi-button-positive' : 'cbi-button-neutral'),
							'data-service': service.id,
							'data-enabled': service.enabled ? '1' : '0',
							'style': 'min-width: 60px',
							'click': ui.createHandlerFn(self, function(ev) {
								if (isLoading) return;
								
								var btn = ev.target;
								var serviceId = btn.getAttribute('data-service');
								var currentState = btn.getAttribute('data-enabled') === '1';
								var newState = !currentState;
								
								btn.disabled = true;
								var origText = btn.textContent;
								btn.textContent = '...';
								
								// Show progress modal
								var actionText = newState ? _('Включение сервиса') : _('Выключение сервиса');
								var progressModal = createProgressModal(actionText, _('Подготовка...'));
								ui.showModal(actionText, progressModal);
								
								var progress = 0;
								var progressInterval = null;
								
								// Step 1: Save service state (instant)
								updateProgress(5, _('Сохранение изменений...'));
								
								return callSetService(serviceId, newState).then(function(result) {
									if (result.success) {
										// Update button immediately
										btn.setAttribute('data-enabled', newState ? '1' : '0');
										btn.textContent = newState ? 'ВКЛ' : 'ВЫКЛ';
										btn.className = 'btn cbi-button ' + (newState ? 'cbi-button-positive' : 'cbi-button-neutral');
										
										updateProgress(10, _('Изменения сохранены'));
										
										// Step 2: Apply rules (takes ~9 seconds) - start in background
										progress = 10;
										progressInterval = setInterval(function() {
											progress += Math.random() * 8;
											if (progress > 75) progress = 75;
											
											var status = '';
											if (progress < 25) {
												status = _('Загрузка списков IP...');
											} else if (progress < 50) {
												status = _('Обновление nftables правил...');
											} else if (progress < 75) {
												status = _('Применение DNS конфигурации...');
											}
											updateProgress(progress, status);
										}, 400);
										
										// Start apply in background - don't wait for it (prevents timeout)
										// Rules will apply in background, we just simulate progress
										var applyCompleted = false;
										callApply().then(function() {
											applyCompleted = true;
											clearInterval(progressInterval);
											updateProgress(80, _('Правила применены'));
										}).catch(function(e) {
											// Timeout or error - rules are still applying in background
											applyCompleted = true;
											clearInterval(progressInterval);
											updateProgress(80, _('Правила применяются (фоном)...'));
										});
										
										// Simulate progress to 80% over ~9 seconds, then continue
										// This gives realistic feedback without blocking on timeout
										return new Promise(function(resolve) {
											var elapsed = 0;
											var checkInterval = setInterval(function() {
												elapsed += 500;
												if (elapsed >= 9000 || applyCompleted) {
													clearInterval(checkInterval);
													clearInterval(progressInterval);
													if (applyCompleted) {
														updateProgress(80, _('Правила применены'));
													} else {
														updateProgress(80, _('Правила применяются...'));
													}
													resolve();
												}
											}, 500);
										}).then(function() {
											
											// Step 3: If needs update - trigger background update
											if (result.needs_update && newState) {
												updateProgress(85, _('Загрузка IP и доменов с GitHub...'));
												
												// Start background update progress simulation
												var updateProgress_val = 85;
												var updateInterval = setInterval(function() {
													updateProgress_val += Math.random() * 2;
													if (updateProgress_val > 98) updateProgress_val = 98;
													updateProgress(updateProgress_val, _('Обновление списков (фоном)...'));
												}, 800);
												
												// Trigger update (don't wait, let it run in background)
												callUpdateSingleService(serviceId).then(function() {
													clearInterval(updateInterval);
													updateProgress(100, _('Готово! Обновление завершено'));
													setTimeout(function() {
														ui.hideModal();
														ui.addNotification(null, E('p', _('Сервис включён, правила применены, IP обновлены')), 'success');
													}, 800);
												}).catch(function(e) {
													clearInterval(updateInterval);
													updateProgress(100, _('Готово (обновление в фоне)'));
													setTimeout(function() {
														ui.hideModal();
														ui.addNotification(null, E('p', _('Сервис включён, правила применены. Обновление IP продолжается в фоне')), 'info');
													}, 800);
												});
											} else {
												// No update needed - just finish
												updateProgress(100, _('Готово!'));
												setTimeout(function() {
													ui.hideModal();
													if (newState) {
														ui.addNotification(null, E('p', _('Сервис включён и правила применены')), 'success');
													} else {
														ui.addNotification(null, E('p', _('Сервис выключен и правила обновлены')), 'success');
													}
												}, 500);
											}
										}).catch(function(e) {
											clearInterval(progressInterval);
											ui.hideModal();
											ui.addNotification(null, E('p', _('Ошибка применения правил: ') + (e.message || e)), 'danger');
										});
									}
								}).then(function() {
									btn.disabled = false;
									self.updateStats();
								}).catch(function(e) {
									if (progressInterval) clearInterval(progressInterval);
									ui.hideModal();
									ui.addNotification(null, E('p', _('Ошибка: ') + (e.message || e)), 'danger');
									btn.disabled = false;
									btn.textContent = origText;
								});
							})
						}, service.enabled ? 'ВКЛ' : 'ВЫКЛ')
					]),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'style': 'font-size: 11px; padding: 3px 8px;',
							'click': ui.createHandlerFn(self, function(ev) {
								showEditServiceModal(service, function(customDomains, customIps) {
									// Save custom domains and IPs
									callEditService(service.id, customDomains, customIps).then(function(result) {
										if (result.success) {
											ui.addNotification(null, E('p', 'Сервис обновлён'), 'success');
											// Reload page to reflect changes
											setTimeout(function() {
												window.location.reload();
											}, 1000);
										} else {
											ui.addNotification(null, E('p', result.error || 'Ошибка сохранения'), 'danger');
										}
									}).catch(function(e) {
										ui.addNotification(null, E('p', 'Ошибка: ' + (e.message || e)), 'danger');
									});
								});
							})
						}, '✎ Редактировать')
					])
				]);
				
				table.appendChild(row);
			});
			
			section.querySelector('.cbi-section-node').appendChild(table);
			view.appendChild(section);
		});
		
		// Hide Apply button (auto-apply on changes)
		var applyBtnContainer = E('div', { 
			'class': 'cbi-page-actions',
			'style': 'display: none !important;'
		});
		view.appendChild(applyBtnContainer);
		
		// Add CSS to hide default LuCI buttons
		if (!document.getElementById('pinpoint-services-hide-buttons')) {
			var style = document.createElement('style');
			style.id = 'pinpoint-services-hide-buttons';
			style.textContent = `
				.view-pinpoint-services .cbi-page-actions { display: none !important; }
				.view-pinpoint-services .cbi-button-save { display: none !important; }
				.view-pinpoint-services .cbi-button-apply { display: none !important; }
				.view-pinpoint-services .cbi-button-reset { display: none !important; }
			`;
			document.head.appendChild(style);
		}
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
