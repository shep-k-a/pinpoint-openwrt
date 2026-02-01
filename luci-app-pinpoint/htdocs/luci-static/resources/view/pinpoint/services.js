'use strict';
'require view';
'require rpc';
'require ui';
'require dom';

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

return view.extend({
	load: function() {
		return Promise.all([
			callGetServices(),
			callGetTunnels().catch(function() { return { tunnels: [] }; }),
			callGetGroups().catch(function() { return { groups: [] }; }),
			callGetServiceRoutes().catch(function() { return { routes: [] }; })
		]);
	},

	filterServices: function(searchText, category) {
		var rows = document.querySelectorAll('[data-service-id]');
		var sections = document.querySelectorAll('.cbi-section[data-category]');
		
		rows.forEach(function(row) {
			var serviceId = row.getAttribute('data-service-id');
			var serviceName = row.querySelector('strong') ? row.querySelector('strong').textContent.toLowerCase() : '';
			var serviceCat = row.getAttribute('data-category');
			
			var matchesSearch = !searchText || 
				serviceName.indexOf(searchText.toLowerCase()) !== -1 ||
				serviceId.indexOf(searchText.toLowerCase()) !== -1;
			
			var matchesCat = !category || category === 'all' || serviceCat === category;
			
			row.style.display = (matchesSearch && matchesCat) ? '' : 'none';
		});
		
		// Hide empty sections
		sections.forEach(function(section) {
			var cat = section.getAttribute('data-category');
			var visibleRows = section.querySelectorAll('[data-service-id]:not([style*="display: none"])');
			section.style.display = visibleRows.length > 0 ? '' : 'none';
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
			E('p', {}, 'Выберите сервисы для маршрутизации через VPN туннель. ' +
				'Всего: ' + services.length + ', Включено: ' + enabledCount)
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
		
		// Add event listeners after elements are created
		var filterTimeout = null;
		searchInput.addEventListener('input', function(ev) {
			clearTimeout(filterTimeout);
			filterTimeout = setTimeout(function() {
				var search = ev.target.value;
				var cat = document.getElementById('category-filter').value;
				self.filterServices(search, cat);
			}, 150);
		});
		
		categorySelect.addEventListener('change', function(ev) {
			var cat = ev.target.value;
			var search = document.getElementById('service-search').value;
			self.filterServices(search, cat);
		});
		
		var filterBar = E('div', { 'style': 'display: flex; gap: 10px; margin-bottom: 15px; flex-wrap: wrap;' }, [
			searchInput,
			categorySelect
		]);
		
		view.appendChild(filterBar);
		
		// Quick actions
		view.appendChild(E('div', { 'style': 'margin-bottom: 15px; display: flex; gap: 10px;' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					var visible = document.querySelectorAll('[data-service-id]:not([style*="display: none"])');
					var promises = [];
					visible.forEach(function(row) {
						var btn = row.querySelector('button[data-service]');
						if (btn && btn.getAttribute('data-enabled') !== '1') {
							promises.push(callSetService(btn.getAttribute('data-service'), true));
							btn.setAttribute('data-enabled', '1');
							btn.textContent = 'ВКЛ';
							btn.className = 'btn cbi-button cbi-button-positive';
						}
					});
					if (promises.length > 0) {
						Promise.all(promises).then(function() {
							return callApply();
						}).then(function() {
							ui.addNotification(null, E('p', 'Включено ' + promises.length + ' сервисов'), 'info');
						});
					}
				})
			}, 'Включить видимые'),
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					var visible = document.querySelectorAll('[data-service-id]:not([style*="display: none"])');
					var promises = [];
					visible.forEach(function(row) {
						var btn = row.querySelector('button[data-service]');
						if (btn && btn.getAttribute('data-enabled') === '1') {
							promises.push(callSetService(btn.getAttribute('data-service'), false));
							btn.setAttribute('data-enabled', '0');
							btn.textContent = 'ВЫКЛ';
							btn.className = 'btn cbi-button cbi-button-neutral';
						}
					});
					if (promises.length > 0) {
						Promise.all(promises).then(function() {
							return callApply();
						}).then(function() {
							ui.addNotification(null, E('p', 'Отключено ' + promises.length + ' сервисов'), 'info');
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
					E('div', { 'class': 'th', 'style': 'width:150px' }, 'Через'),
					E('div', { 'class': 'th', 'style': 'width:80px' }, 'Статус')
				])
			]);
			
			catServices.forEach(function(service) {
				var currentRoute = routeMap[service.id] || '';
				
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
							(service.domains || []).slice(0, 3).join(', ') + 
							((service.domains || []).length > 3 ? ' +' + ((service.domains || []).length - 3) : '')
						)
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
								
								callSetServiceRoute(serviceId, outbound).then(function(result) {
									if (result.success) {
										ui.addNotification(null, E('p', 'Маршрут обновлён'), 'success');
									}
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
								var btn = ev.target;
								var serviceId = btn.getAttribute('data-service');
								var currentState = btn.getAttribute('data-enabled') === '1';
								var newState = !currentState;
								
								btn.disabled = true;
								btn.textContent = '...';
								
								return callSetService(serviceId, newState).then(function(result) {
									if (result.success) {
										btn.setAttribute('data-enabled', newState ? '1' : '0');
										btn.textContent = newState ? 'ВКЛ' : 'ВЫКЛ';
										btn.className = 'btn cbi-button ' + (newState ? 'cbi-button-positive' : 'cbi-button-neutral');
										// Apply changes to update dnsmasq config
										return callApply();
									}
								}).then(function() {
									btn.disabled = false;
								}).catch(function(e) {
									ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
									btn.disabled = false;
									btn.textContent = currentState ? 'ВКЛ' : 'ВЫКЛ';
								});
							})
						}, service.enabled ? 'ВКЛ' : 'ВЫКЛ')
					])
				]);
				
				table.appendChild(row);
			});
			
			section.querySelector('.cbi-section-node').appendChild(table);
			view.appendChild(section);
		});
		
		// Apply button
		view.appendChild(E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, function() {
					ui.showModal('Применение...', [
						E('p', { 'class': 'spinning' }, 'Обновление правил маршрутизации...')
					]);
					
					return callApply().then(function() {
						ui.hideModal();
						ui.addNotification(null, E('p', 'Правила применены успешно'), 'success');
					}).catch(function(e) {
						ui.hideModal();
						ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
					});
				})
			}, 'Применить изменения')
		]));
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
