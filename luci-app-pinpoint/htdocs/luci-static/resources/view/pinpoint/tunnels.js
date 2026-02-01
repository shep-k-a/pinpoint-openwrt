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

var callGetGroups = rpc.declare({
	object: 'luci.pinpoint',
	method: 'groups',
	expect: { }
});

var callAddGroup = rpc.declare({
	object: 'luci.pinpoint',
	method: 'add_group',
	params: ['name', 'type', 'outbounds', 'interval'],
	expect: { }
});

var callDeleteGroup = rpc.declare({
	object: 'luci.pinpoint',
	method: 'delete_group',
	params: ['id'],
	expect: { }
});

return view.extend({
	load: function() {
		return Promise.all([
			callGetTunnels(),
			callGetGroups()
		]);
	},

	render: function(results) {
		var data = results[0] || {};
		var groupsData = results[1] || {};
		
		var tunnels = data.tunnels || [];
		var subscriptions = data.subscriptions || [];
		var activeTunnel = data.active || '';
		var groups = groupsData.groups || [];
		var self = this;
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'VPN Туннели'),
			E('p', {}, 'Управление подписками, импорт ссылок, выбор активного туннеля и настройка групп серверов.')
		]);
		
		// ===== IMPORT SECTION WITH TABS =====
		view.appendChild(E('h3', {}, 'Добавить VPN конфигурацию'));
		
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
			}, 'Импорт ссылки'),
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
			}, 'Подписка')
		]);
		
		importSection.querySelector('.cbi-section-node').appendChild(tabContainer);
		
		// Link import form
		var linkForm = E('div', { 'id': 'form-link', 'style': 'display: block;' }, [
			E('p', { 'style': 'color: #666; margin-bottom: 10px;' }, 
				'Вставьте одну или несколько VPN ссылок (vless://, vmess://, ss://, trojan://, hysteria2://). По одной ссылке на строку.'),
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
							ui.addNotification(null, E('p', 'Вставьте VPN ссылки'), 'warning');
							return;
						}
						
						var links = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { 
							return l && (l.indexOf('://') !== -1);
						});
						
						if (links.length === 0) {
							ui.addNotification(null, E('p', 'Не найдено валидных ссылок'), 'warning');
							return;
						}
						
						ui.showModal('Импорт...', [
							E('p', { 'class': 'spinning' }, 'Парсинг и импорт ' + links.length + ' ссылок...')
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
									? 'Импортировано: ' + (result.tag || '1 туннель')
									: 'Импортировано: ' + result.count + ' туннелей';
								if (result.failed && result.failed.length > 0) {
									msg += '\nОшибок: ' + result.failed.length;
								}
								ui.addNotification(null, E('p', msg), 'success');
								textarea.value = '';
								
								// Restart sing-box and reload page
								return callRestart().then(function() {
									window.location.reload();
								});
							} else {
								ui.addNotification(null, E('p', result.error || 'Ошибка импорта'), 'danger');
							}
						}).catch(function(e) {
							ui.hideModal();
							ui.addNotification(null, E('p', 'Ошибка: ' + e.message), 'danger');
						});
					})
				}, 'Импортировать')
			])
		]);
		
		importSection.querySelector('.cbi-section-node').appendChild(linkForm);
		
		// Subscription form
		var subForm = E('div', { 'id': 'form-subscription', 'style': 'display: none;' }, [
			E('p', { 'style': 'color: #666; margin-bottom: 10px;' }, 
				'Добавьте URL подписки. Поддерживаются форматы Base64, Clash YAML и sing-box JSON.'),
			E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
				E('input', {
					'type': 'text',
					'id': 'sub-name',
					'class': 'cbi-input-text',
					'placeholder': 'Название (опционально)',
					'style': 'width: 150px;'
				}),
				E('input', {
					'type': 'text',
					'id': 'sub-url',
					'class': 'cbi-input-text',
					'placeholder': 'URL подписки',
					'style': 'flex: 1; min-width: 300px;'
				}),
				E('button', {
					'class': 'btn cbi-button cbi-button-add',
					'click': ui.createHandlerFn(self, function() {
						var name = document.getElementById('sub-name').value;
						var url = document.getElementById('sub-url').value;
						
						if (!url) {
							ui.addNotification(null, E('p', 'Введите URL подписки'), 'warning');
							return;
						}
						
						ui.showModal('Добавление...', [
							E('p', { 'class': 'spinning' }, 'Добавление подписки...')
						]);
						
						return callAddSubscription(url, name).then(function(result) {
							ui.hideModal();
							if (result.success) {
								ui.addNotification(null, E('p', 'Подписка добавлена'), 'success');
								window.location.reload();
							} else {
								ui.addNotification(null, E('p', result.error || 'Ошибка добавления'), 'danger');
							}
						});
					})
				}, 'Добавить')
			])
		]);
		
		importSection.querySelector('.cbi-section-node').appendChild(subForm);
		view.appendChild(importSection);
		
		// ===== SUBSCRIPTIONS SECTION =====
		view.appendChild(E('h3', {}, 'Подписки (' + subscriptions.length + ')'));
		
		var subSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (subscriptions.length === 0) {
			subSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; color: #666; padding: 20px;' },
					'Подписки не настроены.')
			);
		} else {
			var subTable = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, 'Название'),
					E('div', { 'class': 'th' }, 'URL'),
					E('div', { 'class': 'th' }, 'Ноды'),
					E('div', { 'class': 'th' }, 'Обновлено'),
					E('div', { 'class': 'th', 'style': 'width: 80px;' }, 'Действия')
				])
			]);
			
			subscriptions.forEach(function(sub) {
				subTable.appendChild(E('div', { 'class': 'tr', 'data-sub-id': sub.id }, [
					E('div', { 'class': 'td' }, sub.name || 'Подписка'),
					E('div', { 'class': 'td' }, [
						E('code', { 'style': 'font-size: 11px; word-break: break-all;' }, 
							(sub.url || '').substring(0, 40) + '...')
					]),
					E('div', { 'class': 'td' }, sub.nodes || 0),
					E('div', { 'class': 'td' }, sub.updated || 'Никогда'),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'title': 'Удалить',
							'data-id': sub.id,
							'click': ui.createHandlerFn(self, function(ev) {
								var id = ev.target.getAttribute('data-id');
								if (!confirm('Удалить эту подписку?')) return;
								
								return callDeleteSubscription(id).then(function(result) {
									if (result.success) {
										var row = document.querySelector('[data-sub-id="' + id + '"]');
										if (row) row.remove();
										ui.addNotification(null, E('p', 'Подписка удалена'), 'success');
									} else {
										ui.addNotification(null, E('p', result.error || 'Ошибка удаления'), 'danger');
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
		view.appendChild(E('h3', {}, 'Доступные туннели (' + tunnels.length + ')'));
		
		var tunnelSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		if (tunnels.length === 0) {
			tunnelSection.querySelector('.cbi-section-node').appendChild(
				E('p', { 'style': 'text-align: center; color: #666; padding: 20px;' },
					'Туннели не настроены. Импортируйте ссылку или добавьте подписку выше.')
			);
		} else {
			var tunnelTable = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th', 'style': 'width: 50px;' }, ''),
					E('div', { 'class': 'th' }, 'Название'),
					E('div', { 'class': 'th' }, 'Тип'),
					E('div', { 'class': 'th' }, 'Сервер'),
					E('div', { 'class': 'th' }, 'Задержка'),
					E('div', { 'class': 'th', 'style': 'width: 80px;' }, 'Действия')
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
								
								ui.showModal('Переключение...', [
									E('p', { 'class': 'spinning' }, 'Активация туннеля...')
								]);
								
								return callSetActiveTunnel(tag).then(function(result) {
									if (result.success) {
										return callRestart().then(function() {
											ui.hideModal();
											ui.addNotification(null, E('p', 'Активный туннель изменён на: ' + tag), 'success');
											window.location.reload();
										});
									} else {
										ui.hideModal();
										ui.addNotification(null, E('p', result.error || 'Ошибка'), 'danger');
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
							'title': 'Удалить',
							'data-tag': tunnel.tag,
							'click': ui.createHandlerFn(self, function(ev) {
								var tag = ev.target.getAttribute('data-tag');
								if (!confirm('Удалить туннель "' + tag + '"?')) return;
								
								ui.showModal('Удаление...', [
									E('p', { 'class': 'spinning' }, 'Удаление туннеля...')
								]);
								
								return callDeleteTunnel(tag).then(function(result) {
									ui.hideModal();
									if (result.success) {
										var row = document.querySelector('[data-tunnel-tag="' + tag + '"]');
										if (row) row.remove();
										ui.addNotification(null, E('p', 'Туннель удалён'), 'success');
										
										// Restart sing-box
										return callRestart();
									} else {
										ui.addNotification(null, E('p', result.error || 'Ошибка удаления'), 'danger');
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
		
		// ===== GROUPS SECTION =====
		view.appendChild(E('h3', {}, 'Группы серверов (' + groups.length + ')'));
		
		var groupSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		// Add group form
		var addGroupForm = E('div', { 'style': 'margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-radius: 4px;' }, [
			E('strong', { 'style': 'display: block; margin-bottom: 10px;' }, 'Создать новую группу'),
			E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;' }, [
				E('div', {}, [
					E('label', { 'style': 'display: block; font-size: 12px; margin-bottom: 2px;' }, 'Название'),
					E('input', {
						'type': 'text',
						'id': 'group-name',
						'class': 'cbi-input-text',
						'placeholder': 'Моя группа',
						'style': 'width: 150px;'
					})
				]),
				E('div', {}, [
					E('label', { 'style': 'display: block; font-size: 12px; margin-bottom: 2px;' }, 'Тип'),
					E('select', { 'id': 'group-type', 'class': 'cbi-input-select', 'style': 'width: 150px;' }, [
						E('option', { 'value': 'urltest' }, 'Авто (urltest)'),
						E('option', { 'value': 'selector' }, 'Ручной (selector)')
					])
				]),
				E('div', {}, [
					E('label', { 'style': 'display: block; font-size: 12px; margin-bottom: 2px;' }, 'Интервал'),
					E('select', { 'id': 'group-interval', 'class': 'cbi-input-select', 'style': 'width: 100px;' }, [
						E('option', { 'value': '1m' }, '1 мин'),
						E('option', { 'value': '5m', 'selected': true }, '5 мин'),
						E('option', { 'value': '10m' }, '10 мин'),
						E('option', { 'value': '30m' }, '30 мин')
					])
				]),
				E('button', {
					'class': 'btn cbi-button cbi-button-add',
					'click': ui.createHandlerFn(self, function() {
						var name = document.getElementById('group-name').value;
						var type = document.getElementById('group-type').value;
						var interval = document.getElementById('group-interval').value;
						
						if (!name) {
							ui.addNotification(null, E('p', 'Введите название группы'), 'warning');
							return;
						}
						
						// Get selected tunnels
						var checkboxes = document.querySelectorAll('.group-tunnel-checkbox:checked');
						var outbounds = [];
						checkboxes.forEach(function(cb) {
							outbounds.push(cb.value);
						});
						
						if (outbounds.length < 2) {
							ui.addNotification(null, E('p', 'Выберите минимум 2 туннеля'), 'warning');
							return;
						}
						
						ui.showModal('Создание...', [
							E('p', { 'class': 'spinning' }, 'Создание группы...')
						]);
						
						return callAddGroup(name, type, outbounds, interval).then(function(result) {
							ui.hideModal();
							if (result.success) {
								ui.addNotification(null, E('p', 'Группа создана'), 'success');
								return callRestart().then(function() {
									window.location.reload();
								});
							} else {
								ui.addNotification(null, E('p', result.error || 'Ошибка'), 'danger');
							}
						});
					})
				}, 'Создать группу')
			]),
			E('div', { 'style': 'margin-top: 10px;' }, [
				E('label', { 'style': 'display: block; font-size: 12px; margin-bottom: 5px;' }, 'Выберите туннели для группы:'),
				E('div', { 'id': 'group-tunnels-select', 'style': 'display: flex; flex-wrap: wrap; gap: 10px;' },
					tunnels.map(function(t) {
						return E('label', { 'style': 'display: flex; align-items: center; gap: 4px; cursor: pointer;' }, [
							E('input', {
								'type': 'checkbox',
								'class': 'group-tunnel-checkbox',
								'value': t.tag
							}),
							t.tag
						]);
					})
				)
			])
		]);
		
		groupSection.querySelector('.cbi-section-node').appendChild(addGroupForm);
		
		// Existing groups
		if (groups.length > 0) {
			var groupTable = E('div', { 'class': 'table', 'style': 'margin-top: 15px;' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, 'Название'),
					E('div', { 'class': 'th' }, 'Тип'),
					E('div', { 'class': 'th' }, 'Серверы'),
					E('div', { 'class': 'th' }, 'Интервал'),
					E('div', { 'class': 'th', 'style': 'width: 80px;' }, 'Действия')
				])
			]);
			
			groups.forEach(function(g) {
				groupTable.appendChild(E('div', { 'class': 'tr', 'data-group-id': g.id }, [
					E('div', { 'class': 'td' }, [
						E('strong', {}, g.name || g.tag)
					]),
					E('div', { 'class': 'td' }, g.type === 'urltest' ? 'Авто' : 'Ручной'),
					E('div', { 'class': 'td' }, (g.outbounds || []).length + ' серверов'),
					E('div', { 'class': 'td' }, g.interval || '-'),
					E('div', { 'class': 'td' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'title': 'Удалить',
							'data-id': g.id,
							'click': ui.createHandlerFn(self, function(ev) {
								var id = ev.target.getAttribute('data-id');
								if (!confirm('Удалить эту группу?')) return;
								
								return callDeleteGroup(id).then(function(result) {
									if (result.success) {
										var row = document.querySelector('[data-group-id="' + id + '"]');
										if (row) row.remove();
										ui.addNotification(null, E('p', 'Группа удалена'), 'success');
										return callRestart();
									} else {
										ui.addNotification(null, E('p', result.error || 'Ошибка удаления'), 'danger');
									}
								});
							})
						}, '✕')
					])
				]));
			});
			
			groupSection.querySelector('.cbi-section-node').appendChild(groupTable);
		}
		
		view.appendChild(groupSection);
		
		// ===== ACTIONS =====
		view.appendChild(E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					ui.showModal('Обновление...', [
						E('p', { 'class': 'spinning' }, 'Обновление подписок...')
					]);
					
					return callUpdateSubscriptions().then(function(result) {
						ui.hideModal();
						if (result.success) {
							ui.addNotification(null, E('p', 'Подписки обновлены'), 'success');
							window.location.reload();
						} else {
							ui.addNotification(null, E('p', result.error || 'Ошибка обновления'), 'danger');
						}
					});
				})
			}, 'Обновить подписки'),
			
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'style': 'margin-left: 10px;',
				'click': ui.createHandlerFn(self, function() {
					ui.showModal('Тестирование...', [
						E('p', { 'class': 'spinning' }, 'Проверка доступности...')
					]);
					
					return callHealthCheck().then(function(result) {
						ui.hideModal();
						if (result.results) {
							result.results.forEach(function(r) {
								var el = document.querySelector('[data-tunnel="' + r.tag + '"]');
								if (el) {
									el.textContent = r.latency ? r.latency + ' мс' : 'таймаут';
									el.style.color = r.latency && r.latency < 200 ? '#22c55e' : '#ef4444';
								}
							});
							ui.addNotification(null, E('p', 'Проверка завершена'), 'success');
						}
					});
				})
			}, 'Проверить'),
			
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'style': 'margin-left: 10px;',
				'click': ui.createHandlerFn(self, function() {
					return callRestart().then(function() {
						ui.addNotification(null, E('p', 'VPN перезапущен'), 'success');
					});
				})
			}, 'Перезапустить VPN')
		]));
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
