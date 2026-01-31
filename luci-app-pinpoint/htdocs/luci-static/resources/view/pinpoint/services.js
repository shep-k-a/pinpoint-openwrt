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
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('PinPoint Services')),
			E('p', {}, _('Select services to route through VPN tunnel.'))
		]);
		
		// Create category sections
		Object.keys(byCategory).sort().forEach(function(cat) {
			var catName = categories[cat] || cat;
			var catServices = byCategory[cat];
			
			var section = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, catName),
				E('div', { 'class': 'cbi-section-node' })
			]);
			
			var table = E('div', { 'class': 'table cbi-section-table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th', 'style': 'width:50px' }, ''),
					E('div', { 'class': 'th' }, _('Service')),
					E('div', { 'class': 'th' }, _('Domains')),
					E('div', { 'class': 'th', 'style': 'width:100px' }, _('Status'))
				])
			]);
			
			catServices.forEach(function(service) {
				var row = E('div', { 
					'class': 'tr',
					'data-service-id': service.id
				}, [
					E('div', { 'class': 'td', 'style': 'font-size: 1.5em' }, service.icon || '📦'),
					E('div', { 'class': 'td' }, [
						E('strong', {}, service.name),
						E('br'),
						E('small', { 'style': 'color: #666' }, service.id)
					]),
					E('div', { 'class': 'td' }, 
						(service.domains || []).slice(0, 3).join(', ') + 
						((service.domains || []).length > 3 ? '...' : '')
					),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button ' + (service.enabled ? 'cbi-button-positive' : 'cbi-button-neutral'),
							'data-service': service.id,
							'data-enabled': service.enabled ? '1' : '0',
							'style': 'min-width: 80px',
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
