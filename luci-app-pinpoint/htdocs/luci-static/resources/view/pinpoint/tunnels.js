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

var callDeleteSubscription = rpc.declare({
	object: 'luci.pinpoint',
	method: 'delete_subscription',
	params: ['id'],
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

var callImportLink = rpc.declare({
	object: 'luci.pinpoint',
	method: 'import_link',
	params: ['link'],
	expect: { }
});

var callImportBatch = rpc.declare({
	object: 'luci.pinpoint',
	method: 'import_batch',
	params: ['links'],
	expect: { }
});

var callDeleteTunnel = rpc.declare({
	object: 'luci.pinpoint',
	method: 'delete_tunnel',
	params: ['tag'],
	expect: { }
});

var callRestart = rpc.declare({
	object: 'luci.pinpoint',
	method: 'restart',
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
			E('p', {}, _('Manage VPN subscriptions, import links, and select active tunnel.'))
		]);
		
		// ===== IMPORT SECTION WITH TABS =====
		view.appendChild(E('h3', {}, _('Add VPN Configuration')));
		
		var importSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		// Tab buttons
		var tabContainer = E('div', { 'style': 'display: flex; gap: 0; margin-bottom: 15px; border-bottom: 2px solid #ddd;' }, [
			E('button', {
				'id': 'tab-link',
				'class': 'btn',
				'style': 'border: none; border-bottom: 2px solid #3b82f6; margin-bottom: -2px; padding: 10px 20px; background: transparent; cursor: pointer; font-weight: bold;',
				'click': function() {
					document.getElementById('form-link').style.display = 'block';
					document.getElementById('form-subscription').style.display = 'none';
					document.getElementById('tab-link').style.borderBottom = '2px solid #3b82f6';
					document.getElementById('tab-link').style.fontWeight = 'bold';
					document.getElementById('tab-subscription').style.borderBottom = 'none';
					document.getElementById('tab-subscription').style.fontWeight = 'normal';
				}
			}, _('Import Link')),
			E('button', {
				'id': 'tab-subscription',
				'class': 'btn',
				'style': 'border: none; border-bottom: none; padding: 10px 20px; background: transparent; cursor: pointer; font-weight: normal;',
				'click': function() {
					document.getElementById('form-link').style.display = 'none';
					document.getElementById('form-subscription').style.display = 'block';
					document.getElementById('tab-link').style.borderBottom = 'none';
					document.getElementById('tab-link').style.fontWeight = 'normal';
					document.getElementById('tab-subscription').style.borderBottom = '2px solid #3b82f6';
					document.getElementById('tab-subscription').style.fontWeight = 'bold';
				}
			}, _('Subscription'))
		]);
		
		importSection.querySelector('.cbi-section-node').appendChild(tabContainer);
		
		// Link import form
		var linkForm = E('div', { 'id': 'form-link', 'style': 'display: block;' }, [
			E('p', { 'style': 'color: #666; margin-bottom: 10px;' }, 
				_('Paste one or more VPN links (vless://, vmess://, ss://, trojan://, hysteria2://). One link per line.')),
			E('textarea', {
				'id': 'import-links',
				'class': 'cbi-input-textarea',
				'placeholder': 'vless://uuid@server:port?...\nvmess://base64...\nss://...',
				'style': 'width: 100%; height: 120px; font-family: monospace; font-size: 12px;'
			}),
			E('div', { 'style': 'margin-top: 10px; display: flex; gap: 10px;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-add',
					'click': ui.createHandlerFn(self, function() {
						var textarea = document.getElementById('import-links');
						var text = textarea.value.trim();
						
						if (!text) {
							ui.addNotification(null, E('p', _('Please paste VPN links')), 'warning');
							return;
						}
						
						var links = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { 
							return l && (l.indexOf('://') !== -1);
						});
						
						if (links.length === 0) {
							ui.addNotification(null, E('p', _('No valid links found')), 'warning');
							return;
						}
						
						ui.showModal(_('Importing...'), [
							E('p', { 'class': 'spinning' }, _('Parsing and importing ') + links.length + _(' link(s)...'))
						]);
						
						var promise;
						if (links.length === 1) {
							promise = callImportLink(links[0]);
						} else {
							promise = callImportBatch(links);
						}
						
						return promise.then(function(result) {
							ui.hideModal();
							if (result.success) {
								var msg = links.length === 1 
									? _('Imported: ') + (result.tag || '1 tunnel')
									: _('Imported: ') + result.count + _(' tunnels');
								if (result.failed && result.failed.length > 0) {
									msg += '\n' + _('Failed: ') + result.failed.length;
								}
								ui.addNotification(null, E('p', msg), 'success');
								textarea.value = '';
								
								// Restart sing-box and reload page
								return callRestart().then(function() {
									window.location.reload();
								});
							} else {
								ui.addNotification(null, E('p', result.error || _('Import failed')), 'danger');
							}
						}).catch(function(e) {
							ui.hideModal();
							ui.addNotification(null, E('p', _('Error: ') + e.message), 'danger');
						});
					})
				}, _('Import Links'))
			])
		]);
		
		importSection.querySelector('.cbi-section-node').appendChild(linkForm);
		
		// Subscription form
		var subForm = E('div', { 'id': 'form-subscription', 'style': 'display: none;' }, [
			E('p', { 'style': 'color: #666; margin-bottom: 10px;' }, 
				_('Add a subscription URL. Supports Base64, Clash YAML, and sing-box JSON formats.')),
			E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
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
					'placeholder': _('Subscription URL'),
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
		]);
		
		importSection.querySelector('.cbi-section-node').appendChild(subForm);
		view.appendChild(importSection);
		
		// ===== SUBSCRIPTIONS SECTION =====
		view.appendChild(E('h3', {}, _('Subscriptions') + ' (' + subscriptions.length + ')'));
		
		var subSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (subscriptions.length === 0) {
			subSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; color: #666; padding: 20px;' },
					_('No subscriptions configured.'))
			);
		} else {
			var subTable = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, _('Name')),
					E('div', { 'class': 'th' }, _('URL')),
					E('div', { 'class': 'th' }, _('Nodes')),
					E('div', { 'class': 'th' }, _('Updated')),
					E('div', { 'class': 'th', 'style': 'width: 80px;' }, _('Actions'))
				])
			]);
			
			subscriptions.forEach(function(sub) {
				subTable.appendChild(E('div', { 'class': 'tr', 'data-sub-id': sub.id }, [
					E('div', { 'class': 'td' }, sub.name || 'Subscription'),
					E('div', { 'class': 'td' }, [
						E('code', { 'style': 'font-size: 11px; word-break: break-all;' }, 
							(sub.url || '').substring(0, 40) + '...')
					]),
					E('div', { 'class': 'td' }, sub.nodes || 0),
					E('div', { 'class': 'td' }, sub.updated || _('Never')),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'title': _('Delete'),
							'data-id': sub.id,
							'click': ui.createHandlerFn(self, function(ev) {
								var id = ev.target.getAttribute('data-id');
								if (!confirm(_('Delete this subscription?'))) return;
								
								return callDeleteSubscription(id).then(function(result) {
									if (result.success) {
										var row = document.querySelector('[data-sub-id="' + id + '"]');
										if (row) row.remove();
										ui.addNotification(null, E('p', _('Subscription deleted')), 'success');
									} else {
										ui.addNotification(null, E('p', result.error || _('Delete failed')), 'danger');
									}
								});
							})
						}, '✕')
					])
				]));
			});
			
			subSection.querySelector('.cbi-section-node').appendChild(subTable);
		}
		
		view.appendChild(subSection);
		
		// ===== TUNNELS SECTION =====
		view.appendChild(E('h3', {}, _('Available Tunnels') + ' (' + tunnels.length + ')'));
		
		var tunnelSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (tunnels.length === 0) {
			tunnelSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; color: #666; padding: 20px;' },
					_('No tunnels configured. Import a link or add a subscription above.'))
			);
		} else {
			var tunnelTable = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th', 'style': 'width: 50px;' }, ''),
					E('div', { 'class': 'th' }, _('Name')),
					E('div', { 'class': 'th' }, _('Type')),
					E('div', { 'class': 'th' }, _('Server')),
					E('div', { 'class': 'th' }, _('Latency')),
					E('div', { 'class': 'th', 'style': 'width: 80px;' }, _('Actions'))
				])
			]);
			
			tunnels.forEach(function(tunnel) {
				var isActive = tunnel.tag === activeTunnel;
				tunnelTable.appendChild(E('div', { 
					'class': 'tr' + (isActive ? ' active' : ''),
					'style': isActive ? 'background: rgba(59, 130, 246, 0.1);' : '',
					'data-tunnel-tag': tunnel.tag
				}, [
					E('div', { 'class': 'td' }, [
						E('input', {
							'type': 'radio',
							'name': 'active-tunnel',
							'value': tunnel.tag,
							'checked': isActive,
							'change': ui.createHandlerFn(self, function(ev) {
								var tag = ev.target.value;
								
								ui.showModal(_('Switching...'), [
									E('p', { 'class': 'spinning' }, _('Activating tunnel...'))
								]);
								
								return callSetActiveTunnel(tag).then(function(result) {
									if (result.success) {
										return callRestart().then(function() {
											ui.hideModal();
											ui.addNotification(null, E('p', _('Active tunnel changed to: ') + tag), 'success');
											window.location.reload();
										});
									} else {
										ui.hideModal();
										ui.addNotification(null, E('p', result.error || _('Failed')), 'danger');
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
						tunnel.latency ? tunnel.latency + ' ms' : '-'),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'title': _('Delete'),
							'data-tag': tunnel.tag,
							'click': ui.createHandlerFn(self, function(ev) {
								var tag = ev.target.getAttribute('data-tag');
								if (!confirm(_('Delete tunnel "') + tag + '"?')) return;
								
								ui.showModal(_('Deleting...'), [
									E('p', { 'class': 'spinning' }, _('Removing tunnel...'))
								]);
								
								return callDeleteTunnel(tag).then(function(result) {
									ui.hideModal();
									if (result.success) {
										var row = document.querySelector('[data-tunnel-tag="' + tag + '"]');
										if (row) row.remove();
										ui.addNotification(null, E('p', _('Tunnel deleted')), 'success');
										
										// Restart sing-box
										return callRestart();
									} else {
										ui.addNotification(null, E('p', result.error || _('Delete failed')), 'danger');
									}
								});
							})
						}, '✕')
					])
				]));
			});
			
			tunnelSection.querySelector('.cbi-section-node').appendChild(tunnelTable);
		}
		
		view.appendChild(tunnelSection);
		
		// ===== ACTIONS =====
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
			}, _('Health Check')),
			
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'style': 'margin-left: 10px;',
				'click': ui.createHandlerFn(self, function() {
					return callRestart().then(function() {
						ui.addNotification(null, E('p', _('VPN restarted')), 'success');
					});
				})
			}, _('Restart VPN'))
		]));
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
