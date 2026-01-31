'use strict';
'require view';
'require rpc';
'require ui';
'require form';

var callGetTunnels = rpc.declare({
	object: 'luci.pinpoint',
	method: 'tunnels',
	expect: { }
});

var callAddSubscription = rpc.declare({
	object: 'luci.pinpoint',
	method: 'add_subscription',
	params: ['url', 'name'],
	expect: { }
});

var callUpdateSubscriptions = rpc.declare({
	object: 'luci.pinpoint',
	method: 'update_subscriptions',
	expect: { }
});

var callHealthCheck = rpc.declare({
	object: 'luci.pinpoint',
	method: 'health_check',
	expect: { }
});

var callSetActiveTunnel = rpc.declare({
	object: 'luci.pinpoint',
	method: 'set_active_tunnel',
	params: ['tag'],
	expect: { }
});

return view.extend({
	load: function() {
		return callGetTunnels();
	},

	render: function(data) {
		var tunnels = data.tunnels || [];
		var subscriptions = data.subscriptions || [];
		var activeTunnel = data.active || '';
		var self = this;
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('VPN Tunnels')),
			E('p', {}, _('Manage VPN subscriptions and tunnels.'))
		]);
		
		// Subscriptions section
		view.appendChild(E('h3', {}, _('Subscriptions')));
		
		var subSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (subscriptions.length === 0) {
			subSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; color: #666; padding: 20px;' },
					_('No subscriptions configured. Add a subscription URL below.'))
			);
		} else {
			var subTable = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, _('Name')),
					E('div', { 'class': 'th' }, _('URL')),
					E('div', { 'class': 'th' }, _('Nodes')),
					E('div', { 'class': 'th' }, _('Updated'))
				])
			]);
			
			subscriptions.forEach(function(sub) {
				subTable.appendChild(E('div', { 'class': 'tr' }, [
					E('div', { 'class': 'td' }, sub.name || 'Subscription'),
					E('div', { 'class': 'td' }, [
						E('code', { 'style': 'font-size: 11px; word-break: break-all;' }, 
							(sub.url || '').substring(0, 50) + '...')
					]),
					E('div', { 'class': 'td' }, sub.nodes || 0),
					E('div', { 'class': 'td' }, sub.updated || _('Never'))
				]));
			});
			
			subSection.querySelector('.cbi-section-node').appendChild(subTable);
		}
		
		// Add subscription form
		subSection.querySelector('.cbi-section-node').appendChild(
			E('div', { 'style': 'margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap;' }, [
				E('input', {
					'type': 'text',
					'id': 'sub-name',
					'class': 'cbi-input-text',
					'placeholder': _('Name (optional)'),
					'style': 'width: 150px;'
				}),
				E('input', {
					'type': 'text',
					'id': 'sub-url',
					'class': 'cbi-input-text',
					'placeholder': _('Subscription URL (VLESS/Trojan/SS)'),
					'style': 'flex: 1; min-width: 300px;'
				}),
				E('button', {
					'class': 'btn cbi-button cbi-button-add',
					'click': ui.createHandlerFn(self, function() {
						var name = document.getElementById('sub-name').value;
						var url = document.getElementById('sub-url').value;
						
						if (!url) {
							ui.addNotification(null, E('p', _('Please enter subscription URL')), 'warning');
							return;
						}
						
						ui.showModal(_('Adding...'), [
							E('p', { 'class': 'spinning' }, _('Adding subscription...'))
						]);
						
						return callAddSubscription(url, name).then(function(result) {
							ui.hideModal();
							if (result.success) {
								ui.addNotification(null, E('p', _('Subscription added')), 'success');
								window.location.reload();
							} else {
								ui.addNotification(null, E('p', result.error || _('Failed to add')), 'danger');
							}
						});
					})
				}, _('Add'))
			])
		);
		
		view.appendChild(subSection);
		
		// Active tunnels section
		view.appendChild(E('h3', {}, _('Available Tunnels')));
		
		var tunnelSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (tunnels.length === 0) {
			tunnelSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; color: #666; padding: 20px;' },
					_('No tunnels configured. Add a subscription or configure sing-box manually.'))
			);
		} else {
			var tunnelTable = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th', 'style': 'width: 50px;' }, ''),
					E('div', { 'class': 'th' }, _('Name')),
					E('div', { 'class': 'th' }, _('Type')),
					E('div', { 'class': 'th' }, _('Server')),
					E('div', { 'class': 'th' }, _('Latency'))
				])
			]);
			
			tunnels.forEach(function(tunnel) {
				var isActive = tunnel.tag === activeTunnel;
				tunnelTable.appendChild(E('div', { 
					'class': 'tr' + (isActive ? ' active' : ''),
					'style': isActive ? 'background: rgba(59, 130, 246, 0.1);' : ''
				}, [
					E('div', { 'class': 'td' }, [
						E('input', {
							'type': 'radio',
							'name': 'active-tunnel',
							'value': tunnel.tag,
							'checked': isActive,
							'change': ui.createHandlerFn(self, function(ev) {
								var tag = ev.target.value;
								return callSetActiveTunnel(tag).then(function(result) {
									if (result.success) {
										ui.addNotification(null, E('p', _('Active tunnel changed')), 'success');
									}
								});
							})
						})
					]),
					E('div', { 'class': 'td' }, [
						E('strong', {}, tunnel.tag),
						isActive ? E('span', { 'style': 'margin-left: 8px; color: #22c55e;' }, '●') : null
					]),
					E('div', { 'class': 'td' }, tunnel.type || '-'),
					E('div', { 'class': 'td' }, tunnel.server || '-'),
					E('div', { 'class': 'td', 'data-tunnel': tunnel.tag }, 
						tunnel.latency ? tunnel.latency + ' ms' : '-')
				]));
			});
			
			tunnelSection.querySelector('.cbi-section-node').appendChild(tunnelTable);
		}
		
		view.appendChild(tunnelSection);
		
		// Actions
		view.appendChild(E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					ui.showModal(_('Updating...'), [
						E('p', { 'class': 'spinning' }, _('Updating subscriptions...'))
					]);
					
					return callUpdateSubscriptions().then(function(result) {
						ui.hideModal();
						if (result.success) {
							ui.addNotification(null, E('p', _('Subscriptions updated')), 'success');
							window.location.reload();
						} else {
							ui.addNotification(null, E('p', result.error || _('Update failed')), 'danger');
						}
					});
				})
			}, _('Update Subscriptions')),
			
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'style': 'margin-left: 10px;',
				'click': ui.createHandlerFn(self, function() {
					ui.showModal(_('Testing...'), [
						E('p', { 'class': 'spinning' }, _('Running health check...'))
					]);
					
					return callHealthCheck().then(function(result) {
						ui.hideModal();
						if (result.results) {
							result.results.forEach(function(r) {
								var el = document.querySelector('[data-tunnel="' + r.tag + '"]');
								if (el) {
									el.textContent = r.latency ? r.latency + ' ms' : 'timeout';
									el.style.color = r.latency && r.latency < 200 ? '#22c55e' : '#ef4444';
								}
							});
							ui.addNotification(null, E('p', _('Health check completed')), 'success');
						}
					});
				})
			}, _('Health Check'))
		]));
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
