'use strict';
'require view';
'require rpc';
'require ui';

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

return view.extend({
	load: function() {
		return callGetCustomServices();
	},

	render: function(data) {
		// Нормализуем ответ:
		//  - ожидаемый формат: { services: [...] }
		//  - на всякий случай поддерживаем: [...] или { data: { services: [...] } }
		var services = [];
		if (Array.isArray(data)) {
			services = data;
		} else if (data && Array.isArray(data.services)) {
			services = data.services;
		} else if (data && data.data && Array.isArray(data.data.services)) {
			services = data.data.services;
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
									btn.disabled = false;
									if (result.success) {
										btn.setAttribute('data-enabled', newState ? '1' : '0');
										btn.textContent = newState ? _('ON') : _('OFF');
										btn.className = 'btn cbi-button ' + (newState ? 'cbi-button-positive' : 'cbi-button-neutral');
									}
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
									if (result.success) {
										var row = document.querySelector('[data-id="' + id + '"]');
										if (row) row.remove();
									}
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
								// Операция считаем успешной, если нет явного error
								if (result && !result.error) {
									ui.addNotification(null, E('p', _('Custom service added')), 'success');
									window.location.reload();
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
		
		// Apply button
		view.appendChild(E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(self, function() {
					ui.showModal(_('Applying...'), [
						E('p', { 'class': 'spinning' }, _('Updating rules...'))
					]);
					
					return callApply().then(function() {
						ui.hideModal();
						ui.addNotification(null, E('p', _('Rules applied')), 'success');
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
