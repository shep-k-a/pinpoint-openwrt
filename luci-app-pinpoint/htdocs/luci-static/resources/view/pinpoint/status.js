'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var callPinpointStatus = rpc.declare({
	object: 'luci.pinpoint',
	method: 'status',
	expect: { }
});

var callPinpointApply = rpc.declare({
	object: 'luci.pinpoint',
	method: 'apply',
	expect: { }
});

var callPinpointRestart = rpc.declare({
	object: 'luci.pinpoint',
	method: 'restart',
	expect: { }
});

var callPinpointStopRouting = rpc.declare({
	object: 'luci.pinpoint',
	method: 'stop_routing',
	expect: { }
});

var callPinpointStartRouting = rpc.declare({
	object: 'luci.pinpoint',
	method: 'start_routing',
	expect: { }
});

function formatBytes(bytes) {
	if (bytes === 0) return '0 B';
	var k = 1024;
	var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatNumber(num) {
	if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
	if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
	return num.toString();
}

return view.extend({
	load: function() {
		return callPinpointStatus();
	},

	render: function(status) {
		// Both modes use VPN! Difference is only in management (Python vs shell)
		var isLiteMode = status.is_lite_mode || false;
		
		// Both modes: check if VPN is active
		var statusClass = status.vpn_active ? 'success' : 'danger';
		var statusText = status.vpn_active ? _('VPN Active') : _('VPN Inactive');
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('PinPoint Status')),
			
			// Mode indicator
			isLiteMode ? E('p', { 'style': 'color: #666; font-size: 14px; margin-bottom: 10px;' }, [
				E('strong', {}, _('Mode: ')),
				_('Lite (VPN + shell scripts - no Python)')
			]) : E('p', { 'style': 'color: #666; font-size: 14px; margin-bottom: 10px;' }, [
				E('strong', {}, _('Mode: ')),
				_('Full (VPN + Python backend)')
			]),
			
			// Status card
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'table' }, [
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left', 'style': 'width:200px' }, _('VPN Status')),
							E('div', { 'class': 'td left' }, [
								E('span', { 
									'class': 'badge ' + statusClass,
									'style': 'padding: 5px 10px; border-radius: 4px; background: ' + 
										(statusClass === 'success' ? '#28a745' : statusClass === 'warning' ? '#ffc107' : '#dc3545') + '; color: white;'
								}, statusText)
							])
						]),
						// Show tunnel and sing-box status in both modes
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Tunnel Interface')),
							E('div', { 'class': 'td left' }, status.tunnel_up ? 'tun1 ✓' : 'tun1 ✗')
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Sing-box')),
							E('div', { 'class': 'td left' }, status.singbox_running ? _('Running') : _('Stopped'))
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('DNS over HTTPS')),
							E('div', { 'class': 'td left' }, [
								E('span', {
									'style': 'color: ' + (status.doh_running ? '#28a745' : '#888')
								}, status.doh_running ? _('Active') : _('Not installed'))
							])
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Enabled Services')),
							E('div', { 'class': 'td left' }, status.enabled_services || 0)
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Last Update')),
							E('div', { 'class': 'td left' }, status.last_update || _('Never'))
						])
					])
				])
			]),
			
			// Statistics card
			E('h3', {}, _('Traffic Statistics')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'table' }, [
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left', 'style': 'width:200px' }, _('Packets Tunneled')),
							E('div', { 'class': 'td left', 'id': 'stat-packets' }, 
								formatNumber(status.stats?.packets || 0))
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Data Tunneled')),
							E('div', { 'class': 'td left', 'id': 'stat-bytes' }, 
								formatBytes(status.stats?.bytes || 0))
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Networks in Set')),
							E('div', { 'class': 'td left' }, status.stats?.networks || 0)
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('IPs in Set')),
							E('div', { 'class': 'td left' }, status.stats?.ips || 0)
						])
					])
				])
			]),
			
			// Actions
			E('h3', {}, _('Actions')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'style': 'display: flex; gap: 10px;' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-apply',
							'click': ui.createHandlerFn(this, function() {
								return callPinpointApply().then(function(result) {
									ui.addNotification(null, E('p', _('Rules applied successfully')), 'success');
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Failed to apply: ') + e.message), 'danger');
								});
							})
						}, _('Apply Rules')),
						
						// Restart VPN button (both modes use VPN)
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'click': ui.createHandlerFn(this, function() {
								return callPinpointRestart().then(function(result) {
									ui.addNotification(null, E('p', _('Sing-box restarted')), 'success');
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Failed to restart: ') + e.message), 'danger');
								});
							})
						}, _('Restart VPN')),
						
						// Stop routing button (removes all rules, traffic goes through normal internet)
						E('button', {
							'class': 'btn cbi-button cbi-button-negative',
							'click': ui.createHandlerFn(this, function() {
								return callPinpointStopRouting().then(function(result) {
									ui.addNotification(null, E('p', _('Routing stopped - all rules removed, traffic goes through normal internet')), 'success');
									// Refresh status to show updated state
									return callPinpointStatus();
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Failed to stop routing: ') + e.message), 'danger');
								});
							})
						}, _('Stop Routing')),
						
						// Start routing button (re-applies rules)
						E('button', {
							'class': 'btn cbi-button cbi-button-positive',
							'click': ui.createHandlerFn(this, function() {
								return callPinpointStartRouting().then(function(result) {
									ui.addNotification(null, E('p', _('Routing started - rules applied')), 'success');
									// Refresh status to show updated state
									return callPinpointStatus();
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Failed to start routing: ') + e.message), 'danger');
								});
							})
						}, _('Start Routing'))
					])
				])
			])
		]);
		
		// Start polling for status updates
		poll.add(L.bind(function() {
			return callPinpointStatus().then(L.bind(function(status) {
				var packetsEl = document.getElementById('stat-packets');
				var bytesEl = document.getElementById('stat-bytes');
				if (packetsEl) packetsEl.textContent = formatNumber(status.stats?.packets || 0);
				if (bytesEl) bytesEl.textContent = formatBytes(status.stats?.bytes || 0);
			}, this));
		}, this), 5);
		
		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
