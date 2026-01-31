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

return view.extend({
	load: function() {
		return callGetServices();
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

	render: function(data) {
		var services = data.services || [];
		var categories = data.categories || {};
		
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
			E('h2', {}, _('PinPoint Services')),
			E('p', {}, _('Select services to route through VPN tunnel. ') +
				_('Total: ') + services.length + ', ' + _('Enabled: ') + enabledCount)
		]);
		
		// Search and filter bar
		var filterBar = E('div', { 'style': 'display: flex; gap: 10px; margin-bottom: 15px; flex-wrap: wrap;' }, [
			E('input', {
				'type': 'text',
				'id': 'service-search',
				'class': 'cbi-input-text',
				'placeholder': _('Search services...'),
				'style': 'flex: 1; min-width: 200px;',
				'input': ui.createHandlerFn(self, function(ev) {
					var search = ev.target.value;
					var cat = document.getElementById('category-filter').value;
					self.filterServices(search, cat);
				})
			}),
			E('select', {
				'id': 'category-filter',
				'class': 'cbi-input-select',
				'style': 'width: 200px;',
				'change': ui.createHandlerFn(self, function(ev) {
					var cat = ev.target.value;
					var search = document.getElementById('service-search').value;
					self.filterServices(search, cat);
				})
			}, [
				E('option', { 'value': 'all' }, _('All categories'))
			].concat(Object.keys(categories).sort().map(function(c) {
				return E('option', { 'value': c }, categories[c] + ' (' + (byCategory[c] ? byCategory[c].length : 0) + ')');
			})))
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
							btn.textContent = _('ON');
							btn.className = 'btn cbi-button cbi-button-positive';
						}
					});
					if (promises.length > 0) {
						ui.addNotification(null, E('p', _('Enabled ') + promises.length + _(' services')), 'info');
					}
				})
			}, _('Enable Visible')),
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
							btn.textContent = _('OFF');
							btn.className = 'btn cbi-button cbi-button-neutral';
						}
					});
					if (promises.length > 0) {
						ui.addNotification(null, E('p', _('Disabled ') + promises.length + _(' services')), 'info');
					}
				})
			}, _('Disable Visible'))
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
					E('div', { 'class': 'th' }, _('Service')),
					E('div', { 'class': 'th' }, _('Domains')),
					E('div', { 'class': 'th', 'style': 'width:100px' }, _('Status'))
				])
			]);
			
			catServices.forEach(function(service) {
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
						E('button', {
							'class': 'btn cbi-button ' + (service.enabled ? 'cbi-button-positive' : 'cbi-button-neutral'),
							'data-service': service.id,
							'data-enabled': service.enabled ? '1' : '0',
							'style': 'min-width: 70px',
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
										btn.textContent = newState ? _('ON') : _('OFF');
										btn.className = 'btn cbi-button ' + (newState ? 'cbi-button-positive' : 'cbi-button-neutral');
									}
									btn.disabled = false;
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Error: ') + e.message), 'danger');
									btn.disabled = false;
									btn.textContent = currentState ? _('ON') : _('OFF');
								});
							})
						}, service.enabled ? _('ON') : _('OFF'))
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
					ui.showModal(_('Applying...'), [
						E('p', { 'class': 'spinning' }, _('Updating routing rules...'))
					]);
					
					return callApply().then(function() {
						ui.hideModal();
						ui.addNotification(null, E('p', _('Rules applied successfully')), 'success');
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
