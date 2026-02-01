'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

var callGetLogs = rpc.declare({
	object: 'luci.pinpoint',
	method: 'get_logs',
	params: ['type', 'lines'],
	expect: { }
});

var callTestDomain = rpc.declare({
	object: 'luci.pinpoint',
	method: 'test_domain',
	params: ['domain'],
	expect: { }
});

return view.extend({
	currentLogType: 'singbox',
	autoRefresh: false,

	load: function() {
		return callGetLogs('singbox', 100);
	},

	render: function(data) {
		var self = this;
		var logs = data.logs || [];
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('PinPoint Logs & Tools'))
		]);
		
		// ===== LOG VIEWER =====
		view.appendChild(E('h3', {}, _('System Logs')));
		
		var logSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' })
		]);
		
		// Log type selector and controls
		var controls = E('div', { 'style': 'display: flex; gap: 10px; margin-bottom: 15px; flex-wrap: wrap; align-items: center;' }, [
			E('select', {
				'id': 'log-type',
				'class': 'cbi-input-select',
				'style': 'width: 150px;',
				'change': ui.createHandlerFn(self, function(ev) {
					self.currentLogType = ev.target.value;
					self.refreshLogs();
				})
			}, [
				E('option', { 'value': 'singbox', 'selected': true }, 'Sing-box'),
				E('option', { 'value': 'pinpoint' }, 'PinPoint'),
				E('option', { 'value': 'all' }, _('All Logs'))
			]),
			E('select', {
				'id': 'log-lines',
				'class': 'cbi-input-select',
				'style': 'width: 100px;',
				'change': ui.createHandlerFn(self, function() {
					self.refreshLogs();
				})
			}, [
				E('option', { 'value': '50' }, '50 ' + _('lines')),
				E('option', { 'value': '100', 'selected': true }, '100 ' + _('lines')),
				E('option', { 'value': '200' }, '200 ' + _('lines')),
				E('option', { 'value': '500' }, '500 ' + _('lines'))
			]),
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					self.refreshLogs();
				})
			}, _('Refresh')),
			E('label', { 'style': 'display: flex; align-items: center; gap: 5px;' }, [
				E('input', {
					'type': 'checkbox',
					'id': 'auto-refresh',
					'change': function(ev) {
						self.autoRefresh = ev.target.checked;
						if (self.autoRefresh) {
							self.startAutoRefresh();
						} else {
							self.stopAutoRefresh();
						}
					}
				}),
				_('Auto-refresh')
			]),
			E('button', {
				'class': 'btn cbi-button',
				'click': function() {
					var logContent = document.getElementById('log-content');
					if (logContent) {
						logContent.scrollTop = logContent.scrollHeight;
					}
				}
			}, _('Scroll to Bottom'))
		]);
		
		logSection.querySelector('.cbi-section-node').appendChild(controls);
		
		// Log content area
		var logContent = E('pre', {
			'id': 'log-content',
			'style': 'background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 4px; ' +
				'height: 400px; overflow-y: auto; font-family: "Consolas", "Monaco", monospace; ' +
				'font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word;'
		});
		
		self.renderLogs(logContent, logs);
		logSection.querySelector('.cbi-section-node').appendChild(logContent);
		
		view.appendChild(logSection);
		
		// ===== DOMAIN TEST TOOL =====
		view.appendChild(E('h3', {}, _('Domain Test')));
		
		var testSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('p', { 'style': 'color: #666; margin-bottom: 10px;' }, 
					_('Check if a domain is routed through VPN tunnel.')),
				E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
					E('input', {
						'type': 'text',
						'id': 'test-domain',
						'class': 'cbi-input-text',
						'placeholder': 'example.com',
						'style': 'width: 300px;'
					}),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							var domain = document.getElementById('test-domain').value.trim();
							if (!domain) {
								ui.addNotification(null, E('p', _('Enter a domain to test')), 'warning');
								return;
							}
							
							var resultDiv = document.getElementById('test-result');
							resultDiv.innerHTML = '<span class="spinning">Testing...</span>';
							
							return callTestDomain(domain).then(function(result) {
								var html = '';
								html += '<strong>' + _('Domain:') + '</strong> ' + result.domain + '<br>';
								
								if (result.ips && result.ips.length > 0) {
									html += '<strong>' + _('Resolved IPs:') + '</strong> ' + result.ips.join(', ') + '<br>';
								} else {
									html += '<strong>' + _('Resolved IPs:') + '</strong> <span style="color:#ef4444">' + _('Could not resolve') + '</span><br>';
								}
								
								html += '<strong>' + _('Routed through VPN:') + '</strong> ';
								if (result.routed) {
									html += '<span style="color:#22c55e; font-weight: bold;">✓ ' + _('YES') + '</span>';
								} else {
									html += '<span style="color:#ef4444; font-weight: bold;">✗ ' + _('NO') + '</span>';
								}
								
								resultDiv.innerHTML = html;
							}).catch(function(e) {
								resultDiv.innerHTML = '<span style="color:#ef4444">' + _('Error:') + ' ' + e.message + '</span>';
							});
						})
					}, _('Test'))
				]),
				E('div', { 
					'id': 'test-result',
					'style': 'margin-top: 15px; padding: 15px; background: #f8f9fa; border-radius: 4px; min-height: 60px;'
				}, _('Enter a domain and click Test to check routing.'))
			])
		]);
		
		view.appendChild(testSection);
		
		// ===== QUICK ACTIONS =====
		view.appendChild(E('h3', {}, _('Quick Tests')));
		
		var quickSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(self, function() {
							document.getElementById('test-domain').value = 'youtube.com';
						})
					}, 'YouTube'),
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(self, function() {
							document.getElementById('test-domain').value = 'instagram.com';
						})
					}, 'Instagram'),
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(self, function() {
							document.getElementById('test-domain').value = 'twitter.com';
						})
					}, 'Twitter/X'),
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(self, function() {
							document.getElementById('test-domain').value = 'openai.com';
						})
					}, 'OpenAI'),
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(self, function() {
							document.getElementById('test-domain').value = 'google.com';
						})
					}, 'Google'),
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(self, function() {
							document.getElementById('test-domain').value = 'yandex.ru';
						})
					}, 'Yandex')
				])
			])
		]);
		
		view.appendChild(quickSection);
		
		return view;
	},

	renderLogs: function(container, logs) {
		if (!logs || logs.length === 0) {
			container.textContent = _('No logs available');
			return;
		}
		
		// Color-code log lines
		var html = '';
		logs.forEach(function(line) {
			var color = '#d4d4d4'; // default
			
			if (line.indexOf('error') !== -1 || line.indexOf('Error') !== -1 || line.indexOf('ERROR') !== -1) {
				color = '#f87171'; // red
			} else if (line.indexOf('warn') !== -1 || line.indexOf('Warn') !== -1 || line.indexOf('WARN') !== -1) {
				color = '#fbbf24'; // yellow
			} else if (line.indexOf('info') !== -1 || line.indexOf('Info') !== -1 || line.indexOf('INFO') !== -1) {
				color = '#60a5fa'; // blue
			} else if (line.indexOf('debug') !== -1 || line.indexOf('Debug') !== -1 || line.indexOf('DEBUG') !== -1) {
				color = '#9ca3af'; // gray
			} else if (line.indexOf('started') !== -1 || line.indexOf('connected') !== -1 || line.indexOf('success') !== -1) {
				color = '#4ade80'; // green
			}
			
			html += '<span style="color:' + color + '">' + line.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>\n';
		});
		
		container.innerHTML = html;
	},

	refreshLogs: function() {
		var self = this;
		var logType = document.getElementById('log-type').value;
		var lines = parseInt(document.getElementById('log-lines').value);
		var logContent = document.getElementById('log-content');
		
		self.currentLogType = logType;
		
		return callGetLogs(logType, lines).then(function(result) {
			self.renderLogs(logContent, result.logs || []);
		});
	},

	startAutoRefresh: function() {
		var self = this;
		poll.add(L.bind(function() {
			return self.refreshLogs();
		}, this), 3);
	},

	stopAutoRefresh: function() {
		poll.remove(L.bind(this.refreshLogs, this));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
