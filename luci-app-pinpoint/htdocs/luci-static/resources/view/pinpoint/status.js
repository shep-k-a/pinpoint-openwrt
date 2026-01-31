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
		var statusClass = status.vpn_active ? 'success' : 'danger';
		var statusText = status.vpn_active ? _('VPN Active') : _('VPN Inactive');
		
		var view = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('PinPoint Status')),
			
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
										(status.vpn_active ? '#28a745' : '#dc3545') + '; color: white;'
								}, statusText)
							])
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Tunnel Interface')),
							E('div', { 'class': 'td left' }, status.tunnel_up ? 'tun1 ✓' : 'tun1 ✗')
						]),
						E('div', { 'class': 'tr' }, [
							E('div', { 'class': 'td left' }, _('Sing-box')),
							E('div', { 'class': 'td left' }, status.singbox_running ? _('Running') : _('Stopped'))
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
						
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'click': ui.createHandlerFn(this, function() {
								return callPinpointRestart().then(function(result) {
									ui.addNotification(null, E('p', _('Sing-box restarted')), 'success');
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Failed to restart: ') + e.message), 'danger');
								});
							})
						}, _('Restart VPN'))
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
