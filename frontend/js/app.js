// PinPoint - Frontend JavaScript

const API_BASE = '/api';

// Authentication state
let currentUser = null;

// Check authentication and initialize app
async function initApp() {
    try {
        const res = await fetch('/api/auth/status', { credentials: 'include' });
        const data = await res.json();
        
        if (!data.authenticated && data.auth_enabled) {
            // Redirect immediately without showing content
            window.location.replace('/login.html');
            return;
        }
        
        currentUser = data.username;
        
        // Auth passed - show content
        document.body.classList.remove('auth-pending');
        
        // Update UI with username if logged in
        const userNameEl = document.getElementById('current-user-name');
        if (userNameEl && data.username) {
            userNameEl.textContent = data.username;
        }
        
        // Now safe to load initial tab
        restoreTabFromHash();
        
    } catch (e) {
        console.error('Auth check failed:', e);
        // Show content even if auth check fails (network error, etc.)
        document.body.classList.remove('auth-pending');
        restoreTabFromHash();
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Logout function
async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        localStorage.removeItem('pinpoint_token');
        window.location.href = '/login.html';
    } catch (e) {
        console.error('Logout failed:', e);
        window.location.href = '/login.html';
    }
}

// Global state variables
let trafficChart = null;
let currentTrafficPeriod = '24h';
let currentSystemPeriod = '24h';
let systemChart = null;
let systemChartMode = 'router'; // 'router' or 'pinpoint'
let dashboardIntervals = [];
let allNetworkDevices = [];
let currentDeviceId = null;
let deviceModes = {};
let configuredDevices = {};
let devicesRefreshInterval = null;

// Локализация
const i18n = {
    status: {
        running: 'Туннель активен, трафик маршрутизируется',
        vpn_disabled: 'VPN выключен, трафик идёт напрямую',
        tunnel_down: 'Туннель недоступен',
        error: 'Ошибка подключения к API'
    },
    messages: {
        updating: 'Обновление списков...',
        updateSuccess: 'Списки успешно обновлены!',
        updateFailed: 'Ошибка обновления',
        enabled: 'включен',
        disabled: 'отключен',
        toggleFailed: 'Ошибка переключения сервиса',
        domainAdded: 'Домен добавлен',
        domainDeleted: 'Домен удалён',
        domainExists: 'Домен уже существует',
        enterDomain: 'Введите домен',
        deleteFailed: 'Ошибка удаления',
        addFailed: 'Ошибка добавления',
        testing: 'Проверка...',
        testFailed: 'Ошибка проверки',
        notResolved: 'Не удалось разрешить домен',
        routedYes: 'ДА',
        routedNo: 'НЕТ',
        routedThrough: 'Через туннель:',
        resolvedIps: 'IP адреса:',
        noLogs: 'Нет доступных логов',
        loadError: 'Ошибка загрузки',
        noDomains: 'Пользовательские домены не добавлены',
        domains: 'доменов',
        sources: 'источников'
    }
};

// Utility functions
function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '0 Б';
    if (bytes === 0) return '0 Б';
    if (bytes < 0) bytes = Math.abs(bytes);
    if (bytes < 1) return bytes.toFixed(2) + ' Б';
    
    const k = 1024;
    const sizes = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatNumber(num) {
    return new Intl.NumberFormat('ru-RU').format(num);
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast show ' + type;
    
    setTimeout(() => {
        toast.className = 'toast';
    }, 3000);
}

// Loading overlay functions
function showLoading(text = 'Обновление...', subtext = 'Пожалуйста, подождите') {
    const overlay = document.getElementById('loading-overlay');
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-subtext').textContent = subtext;
    overlay.classList.add('active');
    document.body.classList.add('loading');
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('active');
    document.body.classList.remove('loading');
}

async function api(endpoint, options = {}) {
    try {
        // Add auth token from localStorage if available
        const token = localStorage.getItem('pinpoint_token');
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };
        
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        
        const response = await fetch(API_BASE + endpoint, {
            headers,
            credentials: 'include', // Include cookies
            ...options
        });
        
        // Handle unauthorized - redirect to login
        if (response.status === 401) {
            localStorage.removeItem('pinpoint_token');
            window.location.href = '/login.html';
            throw new Error('Unauthorized');
        }
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        if (error.message !== 'Unauthorized') {
            showToast('Ошибка API: ' + error.message, 'error');
        }
        throw error;
    }
}

// Sidebar toggle for mobile
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const burger = document.getElementById('burger-menu');
    
    if (sidebar) sidebar.classList.toggle('active');
    if (overlay) overlay.classList.toggle('active');
    if (burger) burger.classList.toggle('active');
}

// Tab switching
function switchToTab(tabName) {
    // Update nav items (sidebar)
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.tab === tabName);
    });
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabContent = document.getElementById(tabName);
    if (tabContent) tabContent.classList.add('active');
    
    // Save to URL hash
    window.location.hash = tabName;
    
    // Close sidebar on mobile after navigation
    if (window.innerWidth <= 1024) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const burger = document.getElementById('burger-menu');
        
        if (sidebar) sidebar.classList.remove('active');
        if (overlay) overlay.classList.remove('active');
        if (burger) burger.classList.remove('active');
    }
    
    // Load tab-specific data
    switch(tabName) {
        case 'dashboard':
            refreshStatus();
            loadDashboardMonitoring();
            break;
        case 'services':
            loadServices();
            break;
        case 'devices':
            loadAllDevices();
            break;
        case 'domains':
            loadCustomServices();
            break;
        case 'tunnels':
            loadTunnelsTab();
            break;
        case 'settings':
            loadSettingsTab();
            break;
    }
}

// Setup navigation event listeners
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        switchToTab(item.dataset.tab);
    });
});

// Restore tab from URL hash on page load
function restoreTabFromHash() {
    const hash = window.location.hash.slice(1); // Remove #
    const validTabs = ['dashboard', 'services', 'devices', 'domains', 'tunnels', 'settings', 'help'];
    
    if (hash && validTabs.includes(hash)) {
        switchToTab(hash);
    } else {
        // Default to dashboard if no hash
        switchToTab('dashboard');
    }
}

// Handle browser back/forward
window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1);
    if (hash) switchToTab(hash);
});

// Tab is now restored from initApp() after auth check

// Dashboard
async function refreshStatus() {
    try {
        const status = await api('/status');
        
        // Update status indicator
        const indicator = document.getElementById('status-indicator');
        const message = document.getElementById('status-message');
        
        if (status.vpn_active) {
            // VPN fully active
            indicator.className = 'status-indicator running';
            message.textContent = i18n.status.running;
        } else if (status.tunnel_up && !status.vpn_configured) {
            // tun1 up but VPN disabled
            indicator.className = 'status-indicator disabled';
            message.textContent = i18n.status.vpn_disabled;
        } else {
            // Tunnel down
            indicator.className = 'status-indicator error';
            message.textContent = i18n.status.tunnel_down;
        }
        
        // Update stats
        document.getElementById('stat-packets').textContent = 
            formatNumber(status.stats.packets_tunneled);
        document.getElementById('stat-bytes').textContent = 
            formatBytes(status.stats.bytes_tunneled);
        document.getElementById('stat-networks').textContent = 
            formatNumber(status.stats.static_networks);
        document.getElementById('stat-ips').textContent = 
            formatNumber(status.stats.dynamic_ips);
        
        // Update info
        const servicesEl = document.getElementById('stat-services');
        const cidrsEl = document.getElementById('stat-cidrs');
        const domainsEl = document.getElementById('stat-domains');
        const lastUpdateEl = document.getElementById('last-update-time');
        
        if (servicesEl) servicesEl.textContent = status.enabled_services || 0;
        if (cidrsEl) cidrsEl.textContent = formatNumber(status.total_cidrs || 0);
        if (domainsEl) domainsEl.textContent = formatNumber(status.total_domains || 0);
        if (lastUpdateEl) {
            if (status.last_update) {
                lastUpdateEl.textContent = formatLastUpdate(status.last_update);
            } else {
                lastUpdateEl.textContent = 'Нет данных';
            }
        }
            
    } catch (error) {
        document.getElementById('status-indicator').className = 'status-indicator error';
        document.getElementById('status-message').textContent = i18n.status.error;
    }
}

function formatLastUpdate(dateStr) {
    // dateStr format: "2025-01-30 05:00:00"
    const date = new Date(dateStr.replace(' ', 'T'));
    const now = new Date();
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);
    
    const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const dateFormatted = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    
    if (diffDays === 0) {
        if (diffHours === 0) {
            return `Только что`;
        }
        return `Сегодня в ${timeStr}`;
    } else if (diffDays === 1) {
        return `Вчера в ${timeStr}`;
    } else {
        return `${dateFormatted} в ${timeStr}`;
    }
}

async function updateAllLists() {
    showLoading('Обновление списков...', 'Загрузка данных из всех источников');
    
    try {
        const result = await api('/update', { method: 'POST' });
        
        if (result.status === 'ok') {
            showToast('Списки успешно обновлены', 'success');
        } else {
            showToast('Ошибка обновления', 'error');
        }
        
        await refreshStatus();
        
    } catch (error) {
        showToast('Ошибка обновления списков', 'error');
    } finally {
        hideLoading();
    }
}

async function updateLists() {
    showLoading('Обновление списков...', 'Загрузка данных из источников');
    
    try {
        const result = await api('/update', { method: 'POST' });
        
        if (result.status === 'ok') {
            showToast(i18n.messages.updateSuccess, 'success');
            await refreshStatus();
        } else {
            showToast(i18n.messages.updateFailed + ': ' + result.output, 'error');
        }
    } catch (error) {
        showToast(i18n.messages.updateFailed, 'error');
    } finally {
        hideLoading();
    }
}

// Services
let currentServiceId = null;
let allServices = [];
let categories = {};
let currentPage = 1;
const servicesPerPage = 12;

async function loadServices() {
    try {
        const data = await api('/services');
        
        // Handle both array and object with services/categories
        if (Array.isArray(data)) {
            allServices = data;
        } else {
            allServices = data.services || data;
            categories = data.categories || {};
        }
        
        // Populate category filter
        const categoryFilter = document.getElementById('category-filter');
        if (categoryFilter && Object.keys(categories).length > 0) {
            categoryFilter.innerHTML = '<option value="">Все категории</option>' +
                Object.entries(categories).map(([id, name]) => 
                    `<option value="${id}">${name}</option>`
                ).join('');
        }
        
        filterServices();
        
    } catch (error) {
        document.getElementById('services-grid').innerHTML = 
            '<p>' + i18n.messages.loadError + '</p>';
    }
}

function filterServices() {
    const searchQuery = document.getElementById('service-search')?.value.toLowerCase() || '';
    const categoryFilter = document.getElementById('category-filter')?.value || '';
    const enabledOnly = document.getElementById('enabled-only')?.checked || false;
    
    let filtered = allServices.filter(service => {
        // Search filter
        const matchesSearch = !searchQuery || 
            service.name.toLowerCase().includes(searchQuery) ||
            service.description?.toLowerCase().includes(searchQuery) ||
            service.domains?.some(d => d.toLowerCase().includes(searchQuery));
        
        // Category filter
        const matchesCategory = !categoryFilter || service.category === categoryFilter;
        
        // Enabled filter
        const matchesEnabled = !enabledOnly || service.enabled;
        
        return matchesSearch && matchesCategory && matchesEnabled;
    });
    
    renderServices(filtered);
}

function renderServices(services) {
    const grid = document.getElementById('services-grid');
    const pagination = document.getElementById('services-pagination');
    
    // Calculate pagination
    const totalPages = Math.ceil(services.length / servicesPerPage);
    currentPage = Math.min(currentPage, totalPages) || 1;
    
    const startIndex = (currentPage - 1) * servicesPerPage;
    const endIndex = startIndex + servicesPerPage;
    const pageServices = services.slice(startIndex, endIndex);
    
    // Render services
    if (pageServices.length === 0) {
        grid.innerHTML = '<p class="no-results">Сервисы не найдены</p>';
    } else {
        grid.innerHTML = pageServices.map(service => {
            const totalDomains = (service.domains?.length || 0) + (service.custom_domains?.length || 0);
            const totalIps = (service.custom_ips?.length || 0);
            const categoryName = categories[service.category] || service.category || '';
            
            return `
            <div class="service-card ${service.enabled ? 'enabled' : ''}" onclick="openServiceModal('${service.id}')">
                ${categoryName ? `<span class="service-category">${categoryName}</span>` : ''}
                <div class="service-header">
                    <span class="service-name">${service.name}</span>
                    <label class="toggle" onclick="event.stopPropagation()">
                        <input type="checkbox" 
                               ${service.enabled ? 'checked' : ''} 
                               onchange="toggleService('${service.id}', this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="service-desc">${service.description || ''}</div>
                <div class="service-domains">
                    ${totalDomains} ${i18n.messages.domains}
                    ${service.sources?.length ? ' | ' + service.sources.length + ' ' + i18n.messages.sources : ''}
                    ${totalIps ? ' | ' + totalIps + ' IP' : ''}
                </div>
            </div>
            `;
        }).join('');
    }
    
    // Render pagination
    if (totalPages > 1) {
        let paginationHtml = '';
        
        // Previous button
        paginationHtml += `<button ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">←</button>`;
        
        // Page buttons
        const maxVisiblePages = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
        
        if (endPage - startPage < maxVisiblePages - 1) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }
        
        if (startPage > 1) {
            paginationHtml += `<button onclick="goToPage(1)">1</button>`;
            if (startPage > 2) paginationHtml += `<span class="page-info">...</span>`;
        }
        
        for (let i = startPage; i <= endPage; i++) {
            paginationHtml += `<button class="${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
        }
        
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) paginationHtml += `<span class="page-info">...</span>`;
            paginationHtml += `<button onclick="goToPage(${totalPages})">${totalPages}</button>`;
        }
        
        // Next button
        paginationHtml += `<button ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">→</button>`;
        
        // Page info
        paginationHtml += `<span class="page-info">${services.length} сервисов</span>`;
        
        pagination.innerHTML = paginationHtml;
    } else {
        pagination.innerHTML = services.length > 0 ? `<span class="page-info">${services.length} сервисов</span>` : '';
    }
}

function goToPage(page) {
    currentPage = page;
    filterServices();
    document.getElementById('services').scrollIntoView({ behavior: 'smooth' });
}

async function toggleService(serviceId, enabled) {
    const actionText = enabled ? 'Включение' : 'Отключение';
    showLoading(`${actionText} ${serviceId}...`, 'Обновление списков маршрутизации');
    
    try {
        // Toggle the service
        await api(`/services/${serviceId}/toggle`, {
            method: 'POST',
            body: JSON.stringify({ enabled })
        });
        
        showToast(`${serviceId} ${enabled ? i18n.messages.enabled : i18n.messages.disabled}`, 'success');
        await refreshStatus();
        await loadServices();
    } catch (error) {
        showToast(i18n.messages.toggleFailed, 'error');
        await loadServices(); // Reload to reset toggle state
    } finally {
        hideLoading();
    }
}

// ============ Custom Services ============

let customServicesData = [];
let currentCustomService = null;
let customServiceEditDomains = [];
let customServiceEditIps = [];

async function loadCustomServices() {
    const grid = document.getElementById('custom-services-grid');
    if (!grid) return;
    
    try {
        customServicesData = await api('/custom-services');
        
        if (!customServicesData || customServicesData.length === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 40px;">
                    <div style="font-size: 48px; margin-bottom: 16px;">📦</div>
                    <div style="margin-bottom: 8px;">Нет пользовательских сервисов</div>
                    <div style="color: var(--text-muted); font-size: 13px;">Нажмите "Создать сервис" чтобы добавить свой</div>
                </div>
            `;
            return;
        }
        
        grid.innerHTML = customServicesData.map(service => {
            const domainsCount = service.domains?.length || 0;
            const ipsCount = service.ips?.length || 0;
            
            return `
            <div class="custom-service-card ${service.enabled ? 'enabled' : ''}" onclick="openEditCustomServiceModal('${service.id}')">
                <div class="custom-service-header">
                    <span class="custom-service-name">${service.name}</span>
                    <label class="toggle" onclick="event.stopPropagation()">
                        <input type="checkbox" 
                               ${service.enabled ? 'checked' : ''} 
                               onchange="toggleCustomService('${service.id}')">
                        <span class="slider"></span>
                    </label>
                </div>
                ${service.description ? `<div class="custom-service-desc">${service.description}</div>` : ''}
                <div class="custom-service-stats">
                    <span class="custom-service-stat">🌐 ${domainsCount} домен${getDomainsEnding(domainsCount)}</span>
                    <span class="custom-service-stat">📍 ${ipsCount} IP</span>
                </div>
            </div>
            `;
        }).join('');
        
    } catch (error) {
        grid.innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

function getDomainsEnding(count) {
    if (count === 1) return '';
    if (count >= 2 && count <= 4) return 'а';
    return 'ов';
}

function openCreateCustomServiceModal() {
    currentCustomService = null;
    customServiceEditDomains = [];
    customServiceEditIps = [];
    
    document.getElementById('custom-service-modal-title').textContent = 'Новый сервис';
    document.getElementById('custom-service-name').value = '';
    document.getElementById('custom-service-description').value = '';
    document.getElementById('delete-custom-service-btn').style.display = 'none';
    
    renderCustomServiceDomains();
    renderCustomServiceIps();
    
    document.getElementById('custom-service-modal').classList.add('active');
}

function openEditCustomServiceModal(serviceId) {
    const service = customServicesData.find(s => s.id === serviceId);
    if (!service) return;
    
    currentCustomService = service;
    customServiceEditDomains = [...(service.domains || [])];
    customServiceEditIps = [...(service.ips || [])];
    
    document.getElementById('custom-service-modal-title').textContent = 'Редактировать сервис';
    document.getElementById('custom-service-name').value = service.name;
    document.getElementById('custom-service-description').value = service.description || '';
    document.getElementById('delete-custom-service-btn').style.display = 'block';
    
    renderCustomServiceDomains();
    renderCustomServiceIps();
    
    document.getElementById('custom-service-modal').classList.add('active');
}

function closeCustomServiceModal() {
    document.getElementById('custom-service-modal').classList.remove('active');
    currentCustomService = null;
}

function renderCustomServiceDomains() {
    const container = document.getElementById('custom-service-domains');
    if (!container) return;
    
    if (customServiceEditDomains.length === 0) {
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">Нет доменов</span>';
    } else {
        container.innerHTML = customServiceEditDomains.map(d => `
            <span class="tag custom">${d}<button onclick="removeCustomServiceDomain('${d}')">&times;</button></span>
        `).join('');
    }
}

function renderCustomServiceIps() {
    const container = document.getElementById('custom-service-ips');
    if (!container) return;
    
    if (customServiceEditIps.length === 0) {
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">Нет IP адресов</span>';
    } else {
        container.innerHTML = customServiceEditIps.map(ip => `
            <span class="tag custom">${ip}<button onclick="removeCustomServiceIp('${ip.replace(/\//g, '_')}')">&times;</button></span>
        `).join('');
    }
}

function addCustomServiceDomain() {
    const input = document.getElementById('new-custom-service-domain');
    const domain = input.value.trim().toLowerCase();
    
    if (!domain) return;
    if (customServiceEditDomains.includes(domain)) {
        showToast('Домен уже добавлен', 'error');
        return;
    }
    
    customServiceEditDomains.push(domain);
    renderCustomServiceDomains();
    input.value = '';
}

function removeCustomServiceDomain(domain) {
    customServiceEditDomains = customServiceEditDomains.filter(d => d !== domain);
    renderCustomServiceDomains();
}

function addCustomServiceIp() {
    const input = document.getElementById('new-custom-service-ip');
    const ip = input.value.trim();
    
    if (!ip) return;
    if (customServiceEditIps.includes(ip)) {
        showToast('IP уже добавлен', 'error');
        return;
    }
    
    customServiceEditIps.push(ip);
    renderCustomServiceIps();
    input.value = '';
}

function removeCustomServiceIp(ipEncoded) {
    const ip = ipEncoded.replace(/_/g, '/');
    customServiceEditIps = customServiceEditIps.filter(i => i !== ip);
    renderCustomServiceIps();
}

async function saveCustomService() {
    const name = document.getElementById('custom-service-name').value.trim();
    const description = document.getElementById('custom-service-description').value.trim();
    
    if (!name) {
        showToast('Введите название сервиса', 'error');
        return;
    }
    
    if (customServiceEditDomains.length === 0 && customServiceEditIps.length === 0) {
        showToast('Добавьте хотя бы один домен или IP', 'error');
        return;
    }
    
    showLoading('Сохранение...', 'Обновление конфигурации');
    
    try {
        if (currentCustomService) {
            // Update existing
            await api(`/custom-services/${currentCustomService.id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    name,
                    description,
                    domains: customServiceEditDomains,
                    ips: customServiceEditIps
                })
            });
            showToast('Сервис обновлён', 'success');
        } else {
            // Create new
            await api('/custom-services', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    description,
                    domains: customServiceEditDomains,
                    ips: customServiceEditIps
                })
            });
            showToast('Сервис создан', 'success');
        }
        
        closeCustomServiceModal();
        await loadCustomServices();
        await refreshStatus();
        
    } catch (error) {
        showToast('Ошибка сохранения', 'error');
    } finally {
        hideLoading();
    }
}

async function deleteCurrentCustomService() {
    if (!currentCustomService) return;
    if (!confirm(`Удалить сервис "${currentCustomService.name}"?`)) return;
    
    showLoading('Удаление...', 'Обновление конфигурации');
    
    try {
        await api(`/custom-services/${currentCustomService.id}`, { method: 'DELETE' });
        showToast('Сервис удалён', 'success');
        closeCustomServiceModal();
        await loadCustomServices();
        await refreshStatus();
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    } finally {
        hideLoading();
    }
}

async function toggleCustomService(serviceId) {
    try {
        await api(`/custom-services/${serviceId}/toggle`, { method: 'POST' });
        await loadCustomServices();
        await refreshStatus();
    } catch (error) {
        showToast('Ошибка переключения', 'error');
    }
}

// Legacy functions for backward compatibility (redirect to custom services)
async function loadDomains() {
    await loadCustomServices();
}

async function loadCustomIps() {
    // No longer needed - handled by custom services
}

// Test
async function testDomain() {
    const input = document.getElementById('test-domain');
    const result = document.getElementById('test-result');
    
    const domain = input.value.trim();
    if (!domain) {
        showToast(i18n.messages.enterDomain, 'error');
        return;
    }
    
    result.innerHTML = '<div class="empty-state">⏳ Проверка...</div>';
    
    try {
        const data = await api('/test', {
            method: 'POST',
            body: JSON.stringify({ domain })
        });
        
        if (!data.resolved) {
            result.innerHTML = `
                <div class="result-line">
                    <span class="result-label">Домен</span>
                    <span class="result-value">${domain}</span>
                </div>
                <div class="result-line">
                    <span class="result-label">Статус</span>
                    <span class="result-value not-routed">Не найден</span>
                </div>
            `;
            return;
        }
        
        const routed = data.routed_through_tunnel;
        result.innerHTML = `
            <div class="result-line">
                <span class="result-label">Домен</span>
                <span class="result-value">${domain}</span>
            </div>
            <div class="result-line">
                <span class="result-label">Через VPN</span>
                <span class="result-value ${routed ? 'routed' : 'not-routed'}">${routed ? '✓ Да' : '✗ Нет'}</span>
            </div>
            <div class="result-line">
                <span class="result-label">IP</span>
                <span class="result-value" style="font-family: monospace; font-size: 12px;">${data.ips.slice(0, 2).join(', ')}</span>
            </div>
        `;
        
    } catch (error) {
        result.innerHTML = '<div class="empty-state" style="color: var(--danger);">Ошибка проверки</div>';
    }
}

// ============ Service Control ============
let currentLogTab = 'pinpoint';

async function loadServiceStatus() {
    try {
        const data = await api('/service/status');
        
        // Update PinPoint status
        const ppStatus = document.getElementById('pinpoint-service-status');
        if (ppStatus) {
            const indicator = ppStatus.querySelector('.status-indicator');
            const text = ppStatus.querySelector('.status-text');
            if (data.pinpoint?.running) {
                indicator.className = 'status-indicator running';
                text.textContent = 'Работает';
            } else {
                indicator.className = 'status-indicator stopped';
                text.textContent = 'Остановлен';
            }
        }
        
        // Update sing-box status
        const sbStatus = document.getElementById('singbox-service-status');
        if (sbStatus) {
            const indicator = sbStatus.querySelector('.status-indicator');
            const text = sbStatus.querySelector('.status-text');
            if (data.singbox?.running) {
                indicator.className = 'status-indicator running';
                text.textContent = 'Работает';
            } else {
                indicator.className = 'status-indicator stopped';
                text.textContent = 'Остановлен';
            }
        }
    } catch (error) {
        console.error('Failed to load service status:', error);
    }
}

async function startAllServices() {
    try {
        showLoading('Запуск сервисов...');
        await api('/service/start', { method: 'POST' });
        showToast('Сервисы запущены', 'success');
        await loadServiceStatus();
        await refreshStatus();
    } catch (error) {
        showToast('Ошибка запуска: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function stopAllServices() {
    try {
        showLoading('Остановка сервисов...');
        await api('/service/stop', { method: 'POST' });
        showToast('Сервисы остановлены', 'success');
        await loadServiceStatus();
        await refreshStatus();
    } catch (error) {
        showToast('Ошибка остановки: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function restartAllServices() {
    try {
        showLoading('Перезапуск сервисов...');
        await api('/service/restart', { method: 'POST' });
        showToast('Сервисы перезапущены', 'success');
        await loadServiceStatus();
        await refreshStatus();
    } catch (error) {
        showToast('Ошибка перезапуска: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

function switchLogTab(tab) {
    currentLogTab = tab;
    document.querySelectorAll('.log-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.log === tab);
    });
    loadServiceLogs();
}

async function loadServiceLogs() {
    // Try both outputs (settings page and modal)
    const outputs = [
        document.getElementById('service-logs-output'),
        document.getElementById('modal-logs-output')
    ].filter(el => el);
    
    outputs.forEach(el => el.textContent = 'Загрузка логов...');
    
    try {
        const data = await api(`/service/logs?type=${currentLogTab}&lines=200`);
        const logsText = data.logs || 'Логи пусты';
        outputs.forEach(el => {
            el.textContent = logsText;
            el.scrollTop = el.scrollHeight;
        });
    } catch (error) {
        outputs.forEach(el => el.textContent = 'Ошибка загрузки логов: ' + error.message);
    }
}

function showLogsModal() {
    document.getElementById('logs-modal').classList.add('active');
    loadServiceLogs();
}

function closeLogsModal() {
    document.getElementById('logs-modal').classList.remove('active');
}

// Logs
async function loadLogs() {
    try {
        const data = await api('/logs?limit=100');
        const content = document.getElementById('logs-content');
        
        if (data.logs.length === 0) {
            content.textContent = i18n.messages.noLogs;
        } else {
            content.textContent = data.logs.join('\n');
        }
        
    } catch (error) {
        document.getElementById('logs-content').textContent = i18n.messages.loadError;
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    refreshStatus();
    loadAutoUpdateTime();
    loadServiceStatus();
    
    // Auto-refresh status every 10 seconds on dashboard
    setInterval(() => {
        const dashboard = document.getElementById('dashboard');
        if (dashboard && dashboard.classList.contains('active')) {
            refreshStatus();
        }
    }, 10000);
});

async function loadAutoUpdateTime() {
    try {
        const data = await api('/settings/auto-update');
        const timeInput = document.getElementById('auto-update-time');
        if (timeInput && data.time) {
            timeInput.value = data.time;
        }
    } catch (error) {
        console.log('Could not load auto-update time');
    }
}

async function saveAutoUpdateTime() {
    const timeInput = document.getElementById('auto-update-time');
    if (!timeInput) return;
    
    let time = timeInput.value.trim();
    
    // Validate time format HH:MM
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
    if (!timeRegex.test(time)) {
        showToast('Неверный формат времени (ЧЧ:ММ)', 'error');
        loadAutoUpdateTime(); // Reset to saved value
        return;
    }
    
    // Normalize format
    const [h, m] = time.split(':');
    time = `${h.padStart(2, '0')}:${m}`;
    timeInput.value = time;
    
    try {
        await api('/settings/auto-update', {
            method: 'POST',
            body: JSON.stringify({ time })
        });
        showToast(`Автообновление: ${time}`, 'success');
    } catch (error) {
        showToast('Ошибка сохранения', 'error');
    }
}

// Enter key handlers (with null checks)
const testDomainInput = document.getElementById('test-domain');
if (testDomainInput) {
    testDomainInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') testDomain();
    });
}

// Service Modal Functions
async function openServiceModal(serviceId) {
    currentServiceId = serviceId;
    
    try {
        const service = await api(`/services/${serviceId}`);
        
        document.getElementById('modal-service-name').textContent = service.name;
        
        // Render sources
        const sourcesHtml = (service.sources || []).map(src => `
            <div class="source-item">
                <span class="source-type">${src.type}</span>
                <span class="source-url">${src.url}</span>
                <button class="btn-icon" onclick="removeSource('${encodeURIComponent(src.url)}')">&times;</button>
            </div>
        `).join('') || '<p style="color: var(--text-muted)">Нет источников</p>';
        document.getElementById('modal-sources').innerHTML = sourcesHtml;
        
        // Render domains
        const baseDomains = (service.domains || []).map(d => 
            `<span class="tag">${d}</span>`
        );
        const customDomains = (service.custom_domains || []).map(d => 
            `<span class="tag custom">${d} <button class="remove-tag" onclick="removeServiceDomain('${d}')">&times;</button></span>`
        );
        document.getElementById('modal-domains').innerHTML = 
            [...baseDomains, ...customDomains].join('') || '<p style="color: var(--text-muted)">Нет доменов</p>';
        
        // Render IPs
        const customIps = (service.custom_ips || []).map(ip => 
            `<span class="tag custom">${ip} <button class="remove-tag" onclick="removeServiceIp('${ip.replace('/', '_')}')">&times;</button></span>`
        );
        document.getElementById('modal-ips').innerHTML = 
            customIps.join('') || '<p style="color: var(--text-muted)">Нет пользовательских IP (IP загружаются из источников)</p>';
        
        document.getElementById('service-modal').classList.add('active');
        
    } catch (error) {
        showToast('Ошибка загрузки сервиса', 'error');
    }
}

function closeServiceModal() {
    document.getElementById('service-modal').classList.remove('active');
    currentServiceId = null;
}

async function addServiceDomain() {
    if (!currentServiceId) return;
    
    const input = document.getElementById('new-service-domain');
    const domain = input.value.trim();
    
    if (!domain) {
        showToast(i18n.messages.enterDomain, 'error');
        return;
    }
    
    showLoading('Добавление домена...', 'Обновление конфигурации');
    
    try {
        await api(`/services/${currentServiceId}/domain`, {
            method: 'POST',
            body: JSON.stringify({ domain })
        });
        
        input.value = '';
        await openServiceModal(currentServiceId);
        await loadServices();
        showToast('Домен добавлен', 'success');
    } catch (error) {
        showToast('Ошибка добавления', 'error');
    } finally {
        hideLoading();
    }
}

async function removeServiceDomain(domain) {
    if (!currentServiceId) return;
    
    showLoading('Удаление домена...', 'Обновление конфигурации');
    
    try {
        await api(`/services/${currentServiceId}/domain/${encodeURIComponent(domain)}`, {
            method: 'DELETE'
        });
        
        await openServiceModal(currentServiceId);
        await loadServices();
        showToast('Домен удалён', 'success');
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    } finally {
        hideLoading();
    }
}

async function addServiceIp() {
    if (!currentServiceId) return;
    
    const input = document.getElementById('new-service-ip');
    const ip = input.value.trim();
    
    if (!ip) {
        showToast('Введите IP или CIDR', 'error');
        return;
    }
    
    showLoading('Добавление IP...', 'Обновление конфигурации');
    
    try {
        await api(`/services/${currentServiceId}/ip`, {
            method: 'POST',
            body: JSON.stringify({ ip })
        });
        
        input.value = '';
        await openServiceModal(currentServiceId);
        await loadServices();
        showToast('IP добавлен', 'success');
    } catch (error) {
        showToast('Ошибка добавления', 'error');
    } finally {
        hideLoading();
    }
}

async function removeServiceIp(ip) {
    if (!currentServiceId) return;
    
    showLoading('Удаление IP...', 'Обновление конфигурации');
    
    try {
        await api(`/services/${currentServiceId}/ip/${ip}`, {
            method: 'DELETE'
        });
        
        await openServiceModal(currentServiceId);
        await loadServices();
        showToast('IP удалён', 'success');
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    } finally {
        hideLoading();
    }
}

async function addSource() {
    if (!currentServiceId) return;
    
    const input = document.getElementById('new-source-url');
    const url = input.value.trim();
    
    if (!url) {
        showToast('Введите URL источника', 'error');
        return;
    }
    
    showLoading('Добавление источника...', 'Обновление конфигурации');
    
    try {
        await api(`/services/${currentServiceId}/source`, {
            method: 'POST',
            body: JSON.stringify({ url, type: 'keenetic' })
        });
        
        input.value = '';
        await openServiceModal(currentServiceId);
        await loadServices();
        showToast('Источник добавлен', 'success');
    } catch (error) {
        showToast('Ошибка добавления', 'error');
    } finally {
        hideLoading();
    }
}

async function removeSource(encodedUrl) {
    if (!currentServiceId) return;
    
    const url = decodeURIComponent(encodedUrl);
    
    showLoading('Удаление источника...', 'Обновление конфигурации');
    
    try {
        await api(`/services/${currentServiceId}/source?url=${encodedUrl}`, {
            method: 'DELETE'
        });
        
        await openServiceModal(currentServiceId);
        await loadServices();
        showToast('Источник удалён', 'success');
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    } finally {
        hideLoading();
    }
}

async function refreshCurrentService() {
    if (!currentServiceId) return;
    
    showLoading('Обновление из источников...', 'Загрузка данных');
    
    try {
        await api(`/services/${currentServiceId}/refresh`, { method: 'POST' });
        showToast('Списки обновлены', 'success');
        await refreshStatus();
    } catch (error) {
        showToast('Ошибка обновления', 'error');
    } finally {
        hideLoading();
    }
}

// Close modal on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeServiceModal();
        closeDeviceModal();
    }
});

// Close modal on backdrop click
document.getElementById('service-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'service-modal') {
        closeServiceModal();
    }
});

document.getElementById('device-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'device-modal') {
        closeDeviceModal();
    }
});

document.getElementById('custom-service-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'custom-service-modal') {
        closeCustomServiceModal();
    }
});

document.getElementById('logs-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'logs-modal') {
        closeLogsModal();
    }
});

// ============ Device Management ============

// Device variables moved to top of file

async function loadDevices() {
    await loadAllDevices();
}

async function loadAllDevices() {
    const grid = document.getElementById('devices-grid');
    if (!grid) return;
    
    try {
        // Load both network hosts and configured devices
        const [hostsData, devicesData] = await Promise.all([
            api('/network/hosts'),
            api('/devices')
        ]);
        
        allNetworkDevices = hostsData.hosts || [];
        const devices = devicesData.devices || [];
        deviceModes = devicesData.modes || {};
        
        // Create lookup for configured devices by IP
        configuredDevices = {};
        devices.forEach(d => {
            configuredDevices[d.ip] = d;
        });
        
        filterDevicesList();
        
    } catch (error) {
        console.error('Failed to load devices:', error);
        grid.innerHTML = '<div class="no-devices">Ошибка загрузки устройств</div>';
    }
}

function filterDevicesList() {
    const grid = document.getElementById('devices-grid');
    if (!grid) return;
    
    const searchQuery = document.getElementById('device-search')?.value.toLowerCase() || '';
    const customOnly = document.getElementById('show-custom-only')?.checked || false;
    
    // Merge network devices with configured devices
    let displayDevices = allNetworkDevices.map(host => {
        const config = configuredDevices[host.ip];
        return {
            ...host,
            config: config || null,
            hasCustomRules: config && config.mode !== 'default'
        };
    });
    
    // Add configured devices that might not be in network scan (offline)
    Object.values(configuredDevices).forEach(device => {
        if (!displayDevices.find(d => d.ip === device.ip)) {
            displayDevices.push({
                ip: device.ip,
                mac: device.mac || '',
                hostname: device.name,
                source: 'config',
                config: device,
                hasCustomRules: device.mode !== 'default',
                offline: true
            });
        }
    });
    
    // Sort: custom rules first, then by IP
    displayDevices.sort((a, b) => {
        if (a.hasCustomRules !== b.hasCustomRules) return b.hasCustomRules - a.hasCustomRules;
        return a.ip.split('.').map(n => n.padStart(3, '0')).join('').localeCompare(
            b.ip.split('.').map(n => n.padStart(3, '0')).join('')
        );
    });
    
    // Apply filters
    displayDevices = displayDevices.filter(device => {
        if (customOnly && !device.hasCustomRules) return false;
        if (searchQuery) {
            const name = (device.config?.name || device.hostname || '').toLowerCase();
            const ip = device.ip.toLowerCase();
            if (!name.includes(searchQuery) && !ip.includes(searchQuery)) {
                return false;
            }
        }
        return true;
    });
    
    if (displayDevices.length === 0) {
        grid.innerHTML = '<div class="no-devices">Устройства не найдены</div>';
        return;
    }
    
    const ruleInfo = {
        'default': { icon: '◉', text: 'Глобальные настройки', desc: 'Использует общие правила сервисов' },
        'vpn_all': { icon: '◎', text: 'Всё через VPN', desc: 'Весь трафик идёт через туннель' },
        'direct_all': { icon: '🚀', text: 'Всё напрямую', desc: 'VPN не используется' },
        'custom': { icon: '⚙️', text: 'Свои сервисы', desc: 'Индивидуальный набор сервисов' }
    };
    
    grid.innerHTML = displayDevices.map(device => {
        const name = device.config?.name || device.hostname || 'Устройство';
        const config = device.config;
        const mode = config?.mode || 'default';
        const rule = ruleInfo[mode] || ruleInfo['default'];
        const servicesCount = config?.services?.length || 0;
        
        return `
        <div class="device-card ${device.hasCustomRules ? 'has-custom-rules' : ''}" 
             onclick="openDeviceSettings('${device.ip}', '${name.replace(/'/g, "\\'")}', '${device.mac || ''}', ${config ? `'${config.id}'` : 'null'})">
            <div class="device-header">
                <span class="device-name">${name}</span>
                <span class="online-dot ${device.offline ? 'offline' : ''}" title="${device.offline ? 'Не в сети' : 'В сети'}"></span>
            </div>
            <div class="device-ip">${device.ip}</div>
            <div class="device-rule ${mode}">
                <span class="rule-icon">${rule.icon}</span>
                <span>${rule.text}</span>
            </div>
            ${mode === 'custom' && servicesCount > 0 ? 
                `<div class="device-services-count">${servicesCount} сервисов выбрано</div>` : ''}
        </div>
        `;
    }).join('');
}

async function openDeviceSettings(ip, name, mac, configId) {
    if (configId) {
        // Already configured - open modal
        openDeviceModal(configId);
    } else {
        // Create new config and open modal
        showLoading('Загрузка...', '');
        try {
            const device = await api('/devices', {
                method: 'POST',
                body: JSON.stringify({ 
                    name: name,
                    ip: ip, 
                    mac: mac,
                    mode: 'default', 
                    services: [] 
                })
            });
            hideLoading();
            openDeviceModal(device.id);
        } catch (error) {
            hideLoading();
            showToast('Ошибка', 'error');
        }
    }
}


async function refreshAllDevices() {
    const btn = event?.target;
    if (btn) btn.disabled = true;
    
    await loadAllDevices();
    showToast('Список обновлён', 'success');
    
    if (btn) btn.disabled = false;
}

// Auto-refresh devices every 30 seconds when tab is active
function startDevicesAutoRefresh() {
    if (devicesRefreshInterval) return;
    devicesRefreshInterval = setInterval(() => {
        if (document.getElementById('devices')?.classList.contains('active')) {
            loadAllDevices();
        }
    }, 30000);
}

function stopDevicesAutoRefresh() {
    if (devicesRefreshInterval) {
        clearInterval(devicesRefreshInterval);
        devicesRefreshInterval = null;
    }
}

async function toggleDevice(deviceId, enabled) {
    showLoading(enabled ? 'Включение...' : 'Отключение...', 'Применение правил');
    
    try {
        await api(`/devices/${deviceId}`, {
            method: 'PUT',
            body: JSON.stringify({ enabled })
        });
        
        await loadAllDevices();
        showToast(`Устройство ${enabled ? 'включено' : 'отключено'}`, 'success');
    } catch (error) {
        showToast('Ошибка', 'error');
        await loadAllDevices();
    } finally {
        hideLoading();
    }
}

async function openDeviceModal(deviceId) {
    currentDeviceId = deviceId;
    
    try {
        const device = await api(`/devices/${deviceId}`);
        
        document.getElementById('modal-device-name').textContent = device.name;
        document.getElementById('edit-device-name').value = device.name;
        document.getElementById('edit-device-ip').value = device.ip;
        
        // Set mode radio
        const modeRadio = document.querySelector(`input[name="device-mode"][value="${device.mode}"]`);
        if (modeRadio) modeRadio.checked = true;
        
        // Load services for custom mode
        await loadDeviceServicesGrid(device.services || []);
        
        // Load custom domains/ips
        deviceCustomData.domains = device.custom_domains || [];
        deviceCustomData.ips = device.custom_ips || [];
        renderDeviceCustomRules();
        
        toggleDeviceServices();
        
        document.getElementById('device-modal').classList.add('active');
        
    } catch (error) {
        showToast('Ошибка загрузки устройства', 'error');
    }
}

function renderDeviceCustomRules() {
    // Render domains
    const domainsContainer = document.getElementById('device-custom-domains');
    if (domainsContainer) {
        domainsContainer.innerHTML = deviceCustomData.domains.map(d => `
            <span class="tag custom">${d}<button onclick="removeDeviceCustomDomain('${d}')">&times;</button></span>
        `).join('') || '<span style="color: var(--text-muted); font-size: 12px;">Нет</span>';
    }
    
    // Render IPs
    const ipsContainer = document.getElementById('device-custom-ips');
    if (ipsContainer) {
        ipsContainer.innerHTML = deviceCustomData.ips.map(ip => `
            <span class="tag custom">${ip}<button onclick="removeDeviceCustomIp('${ip}')">&times;</button></span>
        `).join('') || '<span style="color: var(--text-muted); font-size: 12px;">Нет</span>';
    }
}

function addDeviceCustomDomain() {
    const input = document.getElementById('new-device-domain');
    const domain = input.value.trim();
    if (!domain) return;
    
    if (!deviceCustomData.domains.includes(domain)) {
        deviceCustomData.domains.push(domain);
        renderDeviceCustomRules();
    }
    input.value = '';
}

function removeDeviceCustomDomain(domain) {
    deviceCustomData.domains = deviceCustomData.domains.filter(d => d !== domain);
    renderDeviceCustomRules();
}

function addDeviceCustomIp() {
    const input = document.getElementById('new-device-ip');
    const ip = input.value.trim();
    if (!ip) return;
    
    if (!deviceCustomData.ips.includes(ip)) {
        deviceCustomData.ips.push(ip);
        renderDeviceCustomRules();
    }
    input.value = '';
}

function removeDeviceCustomIp(ip) {
    deviceCustomData.ips = deviceCustomData.ips.filter(i => i !== ip);
    renderDeviceCustomRules();
}

function closeDeviceModal() {
    document.getElementById('device-modal').classList.remove('active');
    currentDeviceId = null;
}

let deviceServicesData = { services: [], categories: {}, selected: [] };
let deviceCustomData = { domains: [], ips: [] };

async function loadDeviceServicesGrid(selectedServices) {
    const grid = document.getElementById('device-services-grid');
    const categorySelect = document.getElementById('device-service-category');
    if (!grid) return;
    
    // Clear search
    const searchInput = document.getElementById('device-service-search');
    if (searchInput) searchInput.value = '';
    
    try {
        const data = await api('/services');
        deviceServicesData.services = data.services || data;
        deviceServicesData.categories = data.categories || {};
        deviceServicesData.selected = selectedServices || [];
        
        // Populate category filter
        if (categorySelect) {
            categorySelect.innerHTML = '<option value="">Все категории</option>' +
                Object.entries(deviceServicesData.categories).map(([id, name]) => 
                    `<option value="${id}">${name}</option>`
                ).join('');
        }
        
        renderDeviceServicesGrid();
    } catch (error) {
        grid.innerHTML = '<p>Ошибка загрузки сервисов</p>';
    }
}

function renderDeviceServicesGrid() {
    const grid = document.getElementById('device-services-grid');
    if (!grid) return;
    
    const searchQuery = (document.getElementById('device-service-search')?.value || '').toLowerCase();
    const categoryFilter = document.getElementById('device-service-category')?.value || '';
    
    // Filter services
    let filteredServices = deviceServicesData.services.filter(svc => {
        const matchesSearch = !searchQuery || 
            svc.name.toLowerCase().includes(searchQuery) ||
            (svc.description && svc.description.toLowerCase().includes(searchQuery));
        const matchesCategory = !categoryFilter || svc.category === categoryFilter;
        return matchesSearch && matchesCategory;
    });
    
    // Group by category
    const byCategory = {};
    filteredServices.forEach(svc => {
        const cat = svc.category || 'other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(svc);
    });
    
    // Render grouped
    let html = '';
    const categoryOrder = ['social', 'messenger', 'video', 'music', 'gaming', 'ai', 'work', 'education', 'shopping', 'crypto', 'infra', 'other'];
    
    categoryOrder.forEach(catId => {
        const services = byCategory[catId];
        if (!services || services.length === 0) return;
        
        const catName = deviceServicesData.categories[catId] || catId;
        html += `
            <div class="device-services-category">
                <div class="device-services-category-header">${catName} (${services.length})</div>
                <div class="device-services-list">
                    ${services.map(svc => `
                        <div class="device-service-item">
                            <input type="checkbox" 
                                   id="dev-svc-${svc.id}" 
                                   value="${svc.id}"
                                   ${deviceServicesData.selected.includes(svc.id) ? 'checked' : ''}
                                   onchange="updateDeviceServiceSelection('${svc.id}', this.checked)">
                            <label for="dev-svc-${svc.id}">${svc.name}</label>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    });
    
    if (!html) {
        html = '<p class="no-results">Сервисы не найдены</p>';
    }
    
    grid.innerHTML = html;
}

function updateDeviceServiceSelection(serviceId, checked) {
    if (checked) {
        if (!deviceServicesData.selected.includes(serviceId)) {
            deviceServicesData.selected.push(serviceId);
        }
    } else {
        deviceServicesData.selected = deviceServicesData.selected.filter(id => id !== serviceId);
    }
}

function filterDeviceServicesGrid() {
    renderDeviceServicesGrid();
}

function toggleDeviceServices() {
    const modeRadio = document.querySelector('input[name="device-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'default';
    const servicesSection = document.getElementById('device-services-section');
    const customSection = document.getElementById('device-custom-section');
    
    if (servicesSection) {
        servicesSection.style.display = mode === 'custom' ? 'block' : 'none';
    }
    if (customSection) {
        customSection.style.display = mode === 'custom' ? 'block' : 'none';
    }
}

async function saveDevice() {
    if (!currentDeviceId) return;
    
    const name = document.getElementById('edit-device-name').value.trim();
    const ip = document.getElementById('edit-device-ip').value.trim();
    const modeRadio = document.querySelector('input[name="device-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'default';
    
    // Get selected services from our tracked state
    const services = deviceServicesData.selected || [];
    
    // Get custom domains and IPs
    const custom_domains = deviceCustomData.domains || [];
    const custom_ips = deviceCustomData.ips || [];
    
    showLoading('Сохранение...', 'Применение правил маршрутизации');
    
    try {
        await api(`/devices/${currentDeviceId}`, {
            method: 'PUT',
            body: JSON.stringify({ name, ip, mode, services, custom_domains, custom_ips, enabled: mode !== 'default' })
        });
        
        closeDeviceModal();
        await loadAllDevices();
        showToast('Настройки сохранены', 'success');
    } catch (error) {
        showToast('Ошибка сохранения', 'error');
    } finally {
        hideLoading();
    }
}

async function resetDeviceToDefault() {
    if (!currentDeviceId) return;
    
    // Just set mode to default
    const modeRadio = document.querySelector('input[name="device-mode"][value="default"]');
    if (modeRadio) modeRadio.checked = true;
    toggleDeviceServices();
    
    showToast('Выбраны глобальные настройки. Нажмите "Сохранить"', 'info');
}

async function deleteCurrentDevice() {
    if (!currentDeviceId) return;
    
    if (!confirm('Удалить настройки для этого устройства?')) return;
    
    showLoading('Удаление...', '');
    
    try {
        await api(`/devices/${currentDeviceId}`, { method: 'DELETE' });
        
        closeDeviceModal();
        await loadAllDevices();
        showToast('Настройки сброшены', 'success');
    } catch (error) {
        showToast('Ошибка', 'error');
    } finally {
        hideLoading();
    }
}

// Start auto-refresh when page loads
startDevicesAutoRefresh();

// ============ Monitor Tab Functions ============

function changeTrafficPeriod(period) {
    currentTrafficPeriod = period;
    
    // Update only traffic chart buttons
    const trafficCard = document.getElementById('traffic-chart')?.closest('.chart-card');
    if (trafficCard) {
        trafficCard.querySelectorAll('.period-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.period === period);
        });
    }
    
    loadTrafficChart(period);
}

function changeSystemPeriod(period) {
    currentSystemPeriod = period;
    
    // Update only system chart buttons
    const systemCard = document.getElementById('system-chart')?.closest('.chart-card');
    if (systemCard) {
        systemCard.querySelectorAll('.period-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.period === period);
        });
    }
    
    loadSystemChart(period);
}

function toggleSystemChartMode(mode) {
    systemChartMode = mode;
    
    // Update toggle buttons
    document.querySelectorAll('.chart-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    
    // Update chart title
    const titleEl = document.getElementById('system-chart-title');
    if (titleEl) {
        titleEl.textContent = mode === 'router' ? '▢ Роутер' : '◆ PinPoint';
    }
    
    loadSystemChart(currentSystemPeriod);
}

async function loadSystemChart(period = '24h') {
    const canvas = document.getElementById('system-chart');
    if (!canvas) return;
    
    try {
        // Determine API parameters based on period
        let minutes = 1440; // 24h
        if (period === '7d') minutes = 7 * 24 * 60;
        if (period === '30d') minutes = 30 * 24 * 60;
        
        const data = await api(`/system/history?minutes=${minutes}`);
        
        let labels = [];
        let cpuData = [];
        let ramData = [];
        
        if (data.history && data.history.length > 0) {
            for (const item of data.history) {
                const d = new Date(item.timestamp * 1000);
                
                if (period === '24h') {
                    labels.push(d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
                } else if (period === '7d') {
                    labels.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + 
                               d.toLocaleTimeString('ru-RU', { hour: '2-digit' }) + 'ч');
                } else {
                    labels.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
                }
                
                // Choose data based on mode
                if (systemChartMode === 'pinpoint') {
                    cpuData.push(item.pinpoint_cpu || 0);
                    ramData.push(item.pinpoint_ram || 0);
                } else {
                    cpuData.push(item.cpu || 0);
                    ramData.push(item.ram || 0);
                }
            }
        }
        
        if (systemChart) {
            systemChart.destroy();
            systemChart = null;
        }
        
        if (labels.length === 0) {
            canvas.parentElement.innerHTML = '<div class="empty-state">Нет данных (сбор начнётся через минуту)</div>';
            return;
        }
        
        const ctx = canvas.getContext('2d');
        systemChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'CPU %',
                        data: cpuData,
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245, 158, 11, 0.1)',
                        fill: true,
                        tension: 0.3,
                        borderWidth: 2,
                        pointRadius: cpuData.length < 30 ? 3 : 0,
                        pointHoverRadius: 5
                    },
                    {
                        label: 'RAM %',
                        data: ramData,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        fill: true,
                        tension: 0.3,
                        borderWidth: 2,
                        pointRadius: ramData.length < 30 ? 3 : 0,
                        pointHoverRadius: 5
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#94a3b8',
                            boxWidth: 12,
                            padding: 10
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`
                        }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        grid: { display: false },
                        ticks: {
                            color: '#64748b',
                            maxTicksLimit: 8,
                            maxRotation: 0
                        }
                    },
                    y: {
                        display: true,
                        min: 0,
                        max: 100,
                        grid: { color: 'rgba(100, 116, 139, 0.1)' },
                        ticks: {
                            color: '#64748b',
                            callback: (v) => v + '%'
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Failed to load system chart:', error);
        canvas.parentElement.innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

async function loadHealth() {
    const grid = document.getElementById('health-grid');
    if (!grid) return;
    
    try {
        const data = await api('/health');
        
        let html = '';
        const icons = {
            sing_box: '🔧',
            tunnel: '🔒',
            dnsmasq: '🌐',
            nftables: '▢',
            dns: '◎',
            internet_via_tunnel: '↗'
        };
        
        const names = {
            sing_box: 'VPN',
            tunnel: 'Сеть',
            dnsmasq: 'DNS',
            nftables: 'Firewall',
            dns: 'Резолв',
            internet_via_tunnel: 'Выход'
        };
        
        const descriptions = {
            sing_box: 'sing-box процесс',
            tunnel: 'tun1 интерфейс',
            dnsmasq: 'DNS сервер',
            nftables: 'Правила',
            dns: 'Резолв доменов',
            internet_via_tunnel: 'Доступ через VPN'
        };
        
        for (const [key, comp] of Object.entries(data.components)) {
            const isOk = ['running', 'up', 'ok'].includes(comp.status);
            const isDisabled = comp.status === 'disabled';
            let statusClass = isOk ? 'ok' : (isDisabled ? 'disabled' : 'error');
            let statusText = isOk ? 'OK' : (isDisabled ? 'ВЫКЛ' : 'Ошибка');
            
            html += `
                <div class="health-item">
                    <div class="health-icon">${icons[key] || '⚙️'}</div>
                    <div class="health-name">${names[key] || key}</div>
                    <div class="health-desc">${descriptions[key] || ''}</div>
                    <div class="health-status ${statusClass}">${statusText}</div>
                </div>
            `;
        }
        
        grid.innerHTML = html;
    } catch (error) {
        grid.innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

async function loadTrafficChart(period = '24h') {
    const canvas = document.getElementById('traffic-chart');
    if (!canvas) {
        console.error('Traffic chart canvas not found');
        return;
    }
    
    // Store period for tooltip callback
    const chartPeriod = period;
    
    try {
        // Determine API parameters based on period
        let apiUrl = '/traffic/history?';
        let timeFormat = { hour: '2-digit', minute: '2-digit' };
        
        switch(period) {
            case '24h':
                apiUrl += 'minutes=1440'; // 24 hours
                timeFormat = { hour: '2-digit', minute: '2-digit' };
                break;
            case '7d':
                apiUrl += 'minutes=' + (7 * 24 * 60); // 7 days
                timeFormat = { day: '2-digit', month: '2-digit', hour: '2-digit' };
                break;
            case '30d':
                apiUrl += 'minutes=' + (30 * 24 * 60); // 30 days
                timeFormat = { day: '2-digit', month: '2-digit' };
                break;
        }
        
        const data = await api(apiUrl);
        
        console.log('Traffic chart data:', data);
        
        let labels = [];
        let bytes = [];
        
        if (data.history && data.history.length > 0) {
            for (let i = 0; i < data.history.length; i++) {
                const item = data.history[i];
                const d = new Date(item.timestamp * 1000);
                
                // Format label based on period
                if (period === '24h') {
                    labels.push(d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
                } else if (period === '7d') {
                    labels.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + 
                               d.toLocaleTimeString('ru-RU', { hour: '2-digit' }) + 'ч');
                } else {
                    labels.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
                }
                
                // Always use delta_bytes (traffic per period), fallback to calculating delta
                let value = item.delta_bytes;
                if (value === undefined && i > 0) {
                    // Calculate delta from total_bytes if delta_bytes not available
                    const prev = data.history[i - 1];
                    value = Math.max(0, item.total_bytes - prev.total_bytes);
                }
                bytes.push(value || 0);
            }
        } else {
            // Show current data point if no history
            try {
                const current = await api('/traffic/current');
                labels = ['Сейчас'];
                bytes = [current.total_bytes || 0];
            } catch {
                labels = ['Нет данных'];
                bytes = [0];
            }
        }
        
        console.log('Chart labels:', labels.length, 'bytes:', bytes.length);
        
        if (trafficChart) {
            trafficChart.destroy();
            trafficChart = null;
        }
        
        // Ensure we have data to display
        if (labels.length === 0 || bytes.length === 0) {
            canvas.parentElement.innerHTML = '<div class="empty-state">Нет данных для отображения</div>';
            return;
        }
        
        const ctx = canvas.getContext('2d');
        trafficChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Трафик',
                    data: bytes,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.15)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: bytes.length < 30 ? 4 : (chartPeriod === '24h' ? 1 : 2),
                    pointHoverRadius: 6,
                    pointBackgroundColor: '#3b82f6',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            title: function(items) {
                                return items[0].label;
                            },
                            label: function(context) {
                                const label = chartPeriod === '24h' ? 'Всего: ' : 'За период: ';
                                return label + formatBytes(context.parsed.y);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(148, 163, 184, 0.1)'
                        },
                        ticks: {
                            color: '#94a3b8',
                            maxTicksLimit: chartPeriod === '24h' ? 12 : chartPeriod === '7d' ? 14 : 10,
                            font: {
                                size: 11
                            }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(148, 163, 184, 0.1)'
                        },
                        ticks: {
                            color: '#94a3b8',
                            callback: function(value) {
                                return formatBytes(value);
                            },
                            font: {
                                size: 11
                            }
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Failed to load traffic chart:', error);
    }
}

async function loadTopDevices() {
    const list = document.getElementById('top-devices-list');
    if (!list) return;
    
    try {
        const data = await api('/traffic/by-device');
        
        if (!data.devices || data.devices.length === 0) {
            list.innerHTML = '<div class="empty-state">Нет данных о трафике устройств</div>';
            return;
        }
        
        let html = '';
        data.devices.slice(0, 8).forEach((device, index) => {
            html += `
                <div class="top-device-item">
                    <div class="rank">${index + 1}</div>
                    <div class="device-info">
                        <div class="device-name">${device.name || 'Устройство'}</div>
                        <div class="device-ip">${device.ip}</div>
                    </div>
                    <div class="traffic">${formatBytes(device.bytes || 0)}</div>
                </div>
            `;
        });
        
        list.innerHTML = html;
    } catch (error) {
        list.innerHTML = '<div class="empty-state">Нет данных о трафике устройств</div>';
    }
}

async function loadLatency() {
    const list = document.getElementById('latency-list');
    if (!list) return;
    
    list.innerHTML = '<div class="empty-state">⏳ Измерение задержки...</div>';
    
    try {
        const data = await api('/latency/services');
        
        if (!data.services || data.services.length === 0) {
            list.innerHTML = '<div class="empty-state">Нет активных сервисов</div>';
            return;
        }
        
        let html = '';
        for (const service of data.services) {
            let latencyClass = 'good';
            let latencyText = 'timeout';
            
            if (service.latency_ms !== null && service.latency_ms !== undefined) {
                // Show proper formatting for ms
                if (service.latency_ms < 1) {
                    latencyText = '<1 ms';
                } else {
                    latencyText = `${Math.round(service.latency_ms)} ms`;
                }
                
                if (service.latency_ms > 200) {
                    latencyClass = 'bad';
                } else if (service.latency_ms > 100) {
                    latencyClass = 'medium';
                }
            } else {
                latencyClass = 'bad';
            }
            
            html += `
                <div class="latency-item">
                    <div class="service-name">${service.name}</div>
                    <div class="latency-value ${latencyClass}">${latencyText}</div>
                </div>
            `;
        }
        
        list.innerHTML = html;
    } catch (error) {
        list.innerHTML = '<div class="empty-state">Ошибка измерения</div>';
    }
}

async function loadConnections() {
    const list = document.getElementById('connections-list');
    if (!list) return;
    
    try {
        const data = await api('/connections?limit=20');
        
        if (!data.connections || data.connections.length === 0) {
            list.innerHTML = '<div class="empty-state">Нет активных соединений</div>';
            return;
        }
        
        let html = '';
        for (const conn of data.connections) {
            html += `
                <div class="connection-item">
                    <span class="proto">${conn.proto}</span>
                    <span class="ips">${conn.src} → ${conn.dst}</span>
                    <span class="port">${conn.dport || '-'}</span>
                </div>
            `;
        }
        
        list.innerHTML = html;
    } catch (error) {
        list.innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

async function loadAlerts() {
    const list = document.getElementById('alerts-list');
    if (!list) return;
    
    try {
        const data = await api('/alerts?unacknowledged=true');
        
        if (!data.alerts || data.alerts.length === 0) {
            list.innerHTML = '<div class="empty-state">Нет уведомлений</div>';
            return;
        }
        
        let html = '';
        const icons = { critical: '🔴', warning: '🟡', info: '🔵' };
        
        for (const alert of data.alerts) {
            const time = new Date(alert.timestamp * 1000).toLocaleString('ru-RU');
            html += `
                <div class="alert-item ${alert.level}">
                    <div class="alert-icon">${icons[alert.level] || '⚪'}</div>
                    <div class="alert-content">
                        <div class="alert-message">${alert.message}</div>
                        <div class="alert-time">${time}</div>
                    </div>
                </div>
            `;
        }
        
        list.innerHTML = html;
    } catch (error) {
        list.innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

async function loadGeoIP() {
    const grid = document.getElementById('geoip-grid');
    if (!grid) return;
    
    grid.innerHTML = '<div class="empty-state">Загрузка географии...</div>';
    
    try {
        const data = await api('/geoip/connections');
        
        if (!data.destinations || data.destinations.length === 0) {
            grid.innerHTML = '<div class="empty-state">Нет внешних подключений</div>';
            return;
        }
        
        // Get GeoIP for top destinations
        const countries = {};
        const maxCount = Math.max(...data.destinations.map(d => d.count));
        
        for (const dest of data.destinations.slice(0, 10)) {
            try {
                const geo = await api(`/geoip/lookup/${dest.ip}`);
                const country = geo.country || 'Unknown';
                const code = geo.country_code || 'XX';
                
                if (!countries[country]) {
                    countries[country] = { count: 0, code: code };
                }
                countries[country].count += dest.count;
            } catch {
                // Skip on error
            }
        }
        
        if (Object.keys(countries).length === 0) {
            grid.innerHTML = '<div class="empty-state">Не удалось определить географию</div>';
            return;
        }
        
        // Country code to flag emoji
        const getFlag = (code) => {
            if (!code || code === 'XX') return '🌐';
            return code.toUpperCase().replace(/./g, char => 
                String.fromCodePoint(127397 + char.charCodeAt(0))
            );
        };
        
        const totalCount = Object.values(countries).reduce((sum, c) => sum + c.count, 0);
        
        let html = '';
        const sorted = Object.entries(countries).sort((a, b) => b[1].count - a[1].count);
        
        for (const [country, data] of sorted) {
            const pct = Math.round((data.count / totalCount) * 100);
            html += `
                <div class="geoip-item">
                    <div class="country-flag">${getFlag(data.code)}</div>
                    <div class="country-info">
                        <div class="country-name">${country}</div>
                        <div class="country-count">${data.count} подключений (${pct}%)</div>
                        <div class="country-bar">
                            <div class="country-bar-fill" style="width: ${pct}%"></div>
                        </div>
                    </div>
                </div>
            `;
        }
        
        grid.innerHTML = html;
    } catch (error) {
        grid.innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

// ============ Dashboard Monitoring ============

async function loadSystemResources() {
    try {
        const data = await api('/system/resources');
        console.log('System resources data:', data);
        
        // Router CPU
        const cpuEl = document.getElementById('cpu-value');
        const cpuBar = document.getElementById('cpu-bar');
        if (cpuEl) cpuEl.textContent = data.cpu_percent + '%';
        if (cpuBar) cpuBar.style.width = Math.min(data.cpu_percent, 100) + '%';
        
        // Router RAM
        const ramUsedMB = Math.round(data.ram_used / 1024 / 1024);
        const ramTotalMB = Math.round(data.ram_total / 1024 / 1024);
        const ramEl = document.getElementById('ram-value');
        const ramBar = document.getElementById('ram-bar');
        if (ramEl) ramEl.textContent = `${ramUsedMB} / ${ramTotalMB} MB`;
        if (ramBar) ramBar.style.width = Math.min(data.ram_percent, 100) + '%';
        
        // Router Disk
        const diskUsedMB = Math.round(data.disk_used / 1024 / 1024);
        const diskTotalMB = Math.round(data.disk_total / 1024 / 1024);
        const diskEl = document.getElementById('disk-value');
        const diskBar = document.getElementById('disk-bar');
        if (diskEl) diskEl.textContent = `${diskUsedMB} / ${diskTotalMB} MB`;
        if (diskBar) diskBar.style.width = Math.min(data.disk_percent, 100) + '%';
        
        // Uptime
        const uptimeEl = document.getElementById('uptime-value');
        if (uptimeEl) uptimeEl.textContent = data.uptime;
        
        // Pinpoint stats
        const pinpointCpuEl = document.getElementById('pinpoint-cpu-value');
        const pinpointCpuBar = document.getElementById('pinpoint-cpu-bar');
        if (pinpointCpuEl) pinpointCpuEl.textContent = (data.pinpoint_cpu || 0) + '%';
        if (pinpointCpuBar) pinpointCpuBar.style.width = Math.min(data.pinpoint_cpu || 0, 100) + '%';
        
        const pinpointRamEl = document.getElementById('pinpoint-ram-value');
        const pinpointRamBar = document.getElementById('pinpoint-ram-bar');
        if (pinpointRamEl) pinpointRamEl.textContent = (data.pinpoint_ram_mb || 0) + ' MB';
        if (pinpointRamBar) pinpointRamBar.style.width = Math.min(data.pinpoint_ram || 0, 100) + '%';
        
        const pinpointConnsEl = document.getElementById('pinpoint-connections');
        if (pinpointConnsEl) pinpointConnsEl.textContent = data.pinpoint_connections || 0;
        
        const pinpointStatusEl = document.getElementById('pinpoint-status');
        if (pinpointStatusEl) {
            pinpointStatusEl.textContent = data.pinpoint_status === 'active' ? 'активен' : 'остановлен';
            pinpointStatusEl.style.color = data.pinpoint_status === 'active' ? 'var(--success)' : 'var(--danger)';
        }
    } catch (error) {
        console.error('Failed to load system resources:', error);
    }
}

function loadDashboardMonitoring() {
    loadHealth();
    loadTrafficChart(currentTrafficPeriod);
    loadSystemChart(currentSystemPeriod);
    loadTopDevices();
    loadConnections();
    loadSystemResources();
    startDashboardAutoRefresh();
}

function updateLastRefreshTime() {
    const el = document.getElementById('dashboard-last-update');
    if (el) {
        const now = new Date();
        el.textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
}

// dashboardIntervals moved to top of file

function startDashboardAutoRefresh() {
    if (dashboardIntervals.length > 0) return;
    
    updateLastRefreshTime();
    
    // Fast refresh (5s): system resources - lightweight
    dashboardIntervals.push(setInterval(() => {
        const dashboard = document.getElementById('dashboard');
        if (dashboard && dashboard.classList.contains('active')) {
            loadSystemResources();
            updateLastRefreshTime();
        }
    }, 5000));
    
    // Medium refresh (15s): health, connections, devices
    dashboardIntervals.push(setInterval(() => {
        const dashboard = document.getElementById('dashboard');
        if (dashboard && dashboard.classList.contains('active')) {
            loadHealth();
            loadConnections();
            loadTopDevices();
        }
    }, 15000));
    
    // Slow refresh (60s): chart
    dashboardIntervals.push(setInterval(() => {
        const dashboard = document.getElementById('dashboard');
        if (dashboard && dashboard.classList.contains('active')) {
            loadTrafficChart(currentTrafficPeriod);
            loadSystemChart(currentSystemPeriod);
        }
    }, 60000));
}

function stopDashboardAutoRefresh() {
    dashboardIntervals.forEach(id => clearInterval(id));
    dashboardIntervals = [];
}

// ============ Settings Tab Functions ============

async function loadTheme() {
    // Check localStorage first
    let theme = localStorage.getItem('pinpoint-theme');
    
    if (!theme) {
        try {
            const data = await api('/settings/theme');
            theme = data.theme || 'dark';
        } catch {
            theme = 'dark';
        }
    }
    
    applyTheme(theme);
    
    // Update radio buttons
    const radio = document.querySelector(`input[name="theme"][value="${theme}"]`);
    if (radio) radio.checked = true;
}

function applyTheme(theme) {
    if (theme === 'light') {
        document.body.classList.add('light-theme');
    } else {
        document.body.classList.remove('light-theme');
    }
    localStorage.setItem('pinpoint-theme', theme);
    
    // Update all toggle button icons
    const icon = theme === 'light' ? '◑' : '◐';
    
    const toggleMobile = document.querySelector('.theme-toggle-mobile');
    if (toggleMobile) toggleMobile.textContent = icon;
    
    const iconSidebar = document.getElementById('theme-icon-sidebar');
    if (iconSidebar) iconSidebar.textContent = icon;
}

function toggleThemeQuick() {
    const current = localStorage.getItem('pinpoint-theme') || 'dark';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
}

async function setTheme(theme) {
    applyTheme(theme);
    
    try {
        await api('/settings/theme', {
            method: 'POST',
            body: JSON.stringify({ theme })
        });
    } catch (error) {
        // Theme still works locally
    }
}

async function loadTelegramSettings() {
    try {
        const data = await api('/telegram/status');
        
        document.getElementById('telegram-enabled').checked = data.enabled;
        if (data.chat_id) {
            document.getElementById('telegram-chat-id').value = data.chat_id;
        }
    } catch (error) {
        console.error('Failed to load Telegram settings');
    }
}

async function saveTelegram() {
    const token = document.getElementById('telegram-token').value.trim();
    const chatId = document.getElementById('telegram-chat-id').value.trim();
    const enabled = document.getElementById('telegram-enabled').checked;
    
    try {
        await api('/telegram/configure', {
            method: 'POST',
            body: JSON.stringify({
                bot_token: token || undefined,
                chat_id: chatId || undefined,
                enabled
            })
        });
        
        showToast('Настройки Telegram сохранены', 'success');
    } catch (error) {
        showToast('Ошибка сохранения', 'error');
    }
}

async function testTelegram() {
    try {
        await api('/telegram/test', { method: 'POST' });
        showToast('Тестовое сообщение отправлено', 'success');
    } catch (error) {
        showToast('Ошибка отправки', 'error');
    }
}

async function loadAdblockStatus() {
    try {
        const data = await api('/adblock/status');
        
        document.getElementById('adblock-enabled').checked = data.enabled;
        document.getElementById('adblock-count').textContent = formatNumber(data.blocked_domains) || '—';
        
        // Format date nicely
        let updateText = '—';
        if (data.last_update) {
            try {
                const date = new Date(data.last_update);
                updateText = date.toLocaleString('ru-RU', {
                    day: '2-digit',
                    month: '2-digit', 
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } catch {
                updateText = data.last_update;
            }
        }
        document.getElementById('adblock-update').textContent = updateText;
    } catch (error) {
        console.error('Failed to load adblock status');
    }
}

async function toggleAdblock() {
    const enabled = document.getElementById('adblock-enabled').checked;
    
    showLoading('Обновление...', enabled ? 'Включение блокировки' : 'Отключение блокировки');
    
    try {
        await api(`/adblock/toggle?enabled=${enabled}`, { method: 'POST' });
        await loadAdblockStatus();
        showToast(enabled ? 'Блокировка включена' : 'Блокировка отключена', 'success');
    } catch (error) {
        showToast('Ошибка', 'error');
    } finally {
        hideLoading();
    }
}

async function updateAdblock() {
    showLoading('Обновление списков...', 'Это может занять несколько минут');
    
    try {
        const data = await api('/adblock/update', { method: 'POST' });
        await loadAdblockStatus();
        const count = data.blocked_domains || data.count || 0;
        showToast(`Загружено ${formatNumber(count)} доменов`, 'success');
    } catch (error) {
        showToast('Ошибка обновления', 'error');
    } finally {
        hideLoading();
    }
}

async function testRandomAdblock() {
    const resultEl = document.getElementById('adblock-test-result');
    
    resultEl.className = 'test-result';
    resultEl.style.display = 'block';
    resultEl.innerHTML = '🔄 Проверка случайного домена...';
    
    try {
        const data = await api('/adblock/test-random');
        
        if (data.error) {
            resultEl.className = 'test-result error';
            resultEl.innerHTML = `⚠️ ${data.message}`;
            return;
        }
        
        if (data.blocked) {
            resultEl.className = 'test-result blocked';
            resultEl.innerHTML = `✓ <strong>${data.domain}</strong> → ${data.resolved_ip || 'заблокирован'}`;
        } else {
            resultEl.className = 'test-result not-blocked';
            resultEl.innerHTML = `✗ <strong>${data.domain}</strong> → ${data.resolved_ip} (не заблокирован!)`;
        }
    } catch (error) {
        resultEl.className = 'test-result error';
        resultEl.textContent = 'Ошибка проверки';
    }
}

async function loadSplitDns() {
    const list = document.getElementById('split-dns-list');
    if (!list) return;
    
    try {
        const data = await api('/split-dns');
        
        if (!data.rules || data.rules.length === 0) {
            list.innerHTML = '<div class="empty-state">Нет правил</div>';
            return;
        }
        
        let html = '';
        for (const rule of data.rules) {
            html += `
                <div class="split-dns-item">
                    <div class="domain">${rule.domain}</div>
                    <div class="server">→ ${rule.server}</div>
                    <button class="btn btn-sm btn-danger" onclick="removeSplitDns('${rule.domain}')">×</button>
                </div>
            `;
        }
        
        list.innerHTML = html;
    } catch (error) {
        list.innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

async function addSplitDns() {
    const domain = document.getElementById('split-dns-domain').value.trim();
    const server = document.getElementById('split-dns-server').value.trim();
    
    if (!domain || !server) {
        showToast('Заполните все поля', 'error');
        return;
    }
    
    try {
        const currentData = await api('/split-dns');
        const rules = currentData.rules || [];
        rules.push({ domain, server });
        
        await api('/split-dns', {
            method: 'POST',
            body: JSON.stringify({ enabled: true, rules })
        });
        
        document.getElementById('split-dns-domain').value = '';
        document.getElementById('split-dns-server').value = '';
        
        await loadSplitDns();
        showToast('Правило добавлено', 'success');
    } catch (error) {
        showToast('Ошибка добавления', 'error');
    }
}

async function removeSplitDns(domain) {
    try {
        const currentData = await api('/split-dns');
        const rules = (currentData.rules || []).filter(r => r.domain !== domain);
        
        await api('/split-dns', {
            method: 'POST',
            body: JSON.stringify({ enabled: rules.length > 0, rules })
        });
        
        await loadSplitDns();
        showToast('Правило удалено', 'success');
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    }
}

// Old loadTunnels function removed - tunnels are now managed in the Tunnels tab

async function exportConfig() {
    try {
        const response = await fetch('/api/config/export');
        const blob = await response.blob();
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pinpoint_config_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast('Конфигурация экспортирована', 'success');
    } catch (error) {
        showToast('Ошибка экспорта', 'error');
    }
}

async function importConfig(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!confirm('Импорт заменит текущую конфигурацию. Продолжить?')) {
        event.target.value = '';
        return;
    }
    
    showLoading('Импорт...', 'Применение конфигурации');
    
    try {
        const text = await file.text();
        const config = JSON.parse(text);
        
        await api('/config/import', {
            method: 'POST',
            body: JSON.stringify(config)
        });
        
        showToast('Конфигурация импортирована', 'success');
        location.reload();
    } catch (error) {
        showToast('Ошибка импорта: ' + error.message, 'error');
    } finally {
        hideLoading();
        event.target.value = '';
    }
}

function saveAutoUpdateTimeSetting() {
    const time = document.getElementById('settings-auto-update-time').value.trim();
    
    if (!/^\d{2}:\d{2}$/.test(time)) {
        showToast('Неверный формат времени', 'error');
        return;
    }
    
    api('/settings/auto-update', {
        method: 'POST',
        body: JSON.stringify({ time })
    }).then(() => {
        showToast('Время обновления сохранено', 'success');
        document.getElementById('auto-update-time').value = time;
    }).catch(() => {
        showToast('Ошибка сохранения', 'error');
    });
}

function loadSettingsTab() {
    loadTheme();
    loadTelegramSettings();
    loadAdblockStatus();
    loadSplitDns();
    loadDependencies();
    loadAuthSettings();
    
    // Load auto-update time
    api('/settings/auto-update').then(data => {
        if (data.time) {
            const el = document.getElementById('settings-auto-update-time');
            if (el) el.value = data.time;
        }
    }).catch(() => {});
}

// ============ Auth Settings Functions ============

async function loadAuthSettings() {
    try {
        const data = await api('/auth/settings');
        
        const enabledEl = document.getElementById('auth-enabled');
        const usernameEl = document.getElementById('auth-username');
        const sessionEl = document.getElementById('auth-session-hours');
        
        if (enabledEl) enabledEl.checked = data.enabled;
        if (usernameEl) usernameEl.textContent = data.username || 'admin';
        if (sessionEl) sessionEl.value = data.session_hours || 24;
        
    } catch (error) {
        console.error('Failed to load auth settings:', error);
    }
}

async function toggleAuthEnabled() {
    const enabledEl = document.getElementById('auth-enabled');
    const enabled = enabledEl?.checked;
    
    if (!enabled) {
        if (!confirm('Отключить авторизацию? Панель будет доступна всем в сети.')) {
            enabledEl.checked = true;
            return;
        }
    }
    
    try {
        await api('/auth/settings', {
            method: 'PUT',
            body: JSON.stringify({ enabled })
        });
        showToast(enabled ? 'Авторизация включена' : 'Авторизация отключена', 'success');
    } catch (error) {
        enabledEl.checked = !enabled;
        showToast('Ошибка', 'error');
    }
}

async function updateSessionHours() {
    const sessionEl = document.getElementById('auth-session-hours');
    const hours = parseInt(sessionEl?.value || '24');
    
    try {
        await api('/auth/settings', {
            method: 'PUT',
            body: JSON.stringify({ session_hours: hours })
        });
        showToast('Время сессии обновлено', 'success');
    } catch (error) {
        showToast('Ошибка', 'error');
    }
}

function openChangePasswordModal() {
    document.getElementById('current-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    document.getElementById('change-password-modal').classList.add('active');
}

function closeChangePasswordModal() {
    document.getElementById('change-password-modal').classList.remove('active');
}

async function changePassword() {
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    
    if (!currentPassword || !newPassword) {
        showToast('Заполните все поля', 'error');
        return;
    }
    
    if (newPassword.length < 4) {
        showToast('Пароль слишком короткий (мин. 4 символа)', 'error');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showToast('Пароли не совпадают', 'error');
        return;
    }
    
    try {
        await api('/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword
            })
        });
        
        showToast('Пароль успешно изменён', 'success');
        closeChangePasswordModal();
    } catch (error) {
        showToast('Неверный текущий пароль', 'error');
    }
}

function showAbout() {
    alert('PinPoint v1.1\\n\\nТочечная маршрутизация для OpenWRT\\n\\nGitHub: github.com/your-repo/pinpoint');
}

// ============ Tunnel Management ============

let tunnelsData = [];
let subscriptionsData = [];
let groupsData = [];
let currentTunnelId = null;
let currentGroupId = null;

async function loadTunnelsTab() {
    await Promise.all([
        loadTunnelsList(),
        loadSubscriptions(),
        loadTunnelGroups(),
        loadOutbounds()
    ]);
    // Load service routes after tunnels/groups are loaded
    await loadServiceRoutes();
}

async function loadTunnelsList() {
    try {
        const data = await api('/tunnels');
        tunnelsData = data.tunnels || [];
        renderTunnels();
    } catch (error) {
        console.error('Failed to load tunnels:', error);
    }
}

function renderTunnels() {
    const container = document.getElementById('tunnels-list');
    if (!container) return;
    
    // Update count
    const countEl = document.getElementById('servers-count');
    if (countEl) countEl.textContent = tunnelsData.length;
    
    // Update VPN status badge
    updateVpnStatusBadge();
    
    if (tunnelsData.length === 0) {
        container.innerHTML = `
            <div class="servers-empty">
                <div class="servers-empty-icon">📡</div>
                <div class="servers-empty-text">Нет серверов</div>
                <button class="btn btn-primary btn-sm" onclick="toggleImportPanel()">+ Добавить сервер</button>
            </div>
        `;
        return;
    }
    
    container.innerHTML = tunnelsData.map(t => {
        // Determine latency class
        let latencyClass = 'unknown';
        let latencyText = '—';
        if (t.latency) {
            latencyText = `${t.latency} ms`;
            if (t.latency < 100) latencyClass = 'good';
            else if (t.latency < 300) latencyClass = 'medium';
            else latencyClass = 'bad';
        }
        
        return `
            <div class="server-item ${t.enabled ? '' : 'disabled'}" data-id="${t.id}">
                <span class="server-type-badge ${t.type}">${t.type}</span>
                <div class="server-info">
                    <div class="server-name">${t.name}</div>
                    <div class="server-address">${t.server}:${t.port}</div>
                </div>
                <span class="server-latency ${latencyClass}">${latencyText}</span>
                <div class="server-actions">
                    <button class="server-toggle ${t.enabled ? 'on' : 'off'}" onclick="toggleTunnel('${t.id}')">
                        ${t.enabled ? 'Вкл' : 'Выкл'}
                    </button>
                    <button class="server-menu-btn" onclick="openEditTunnelModal('${t.id}')" title="Настройки">⚙</button>
                </div>
            </div>
        `;
    }).join('');
}

function updateVpnStatusBadge() {
    const badge = document.getElementById('vpn-status-badge');
    const text = document.getElementById('vpn-status-text');
    if (!badge || !text) return;
    
    const enabledTunnels = tunnelsData.filter(t => t.enabled).length;
    
    if (enabledTunnels > 0) {
        badge.className = 'vpn-status-badge active';
        text.textContent = `${enabledTunnels} активных`;
    } else {
        badge.className = 'vpn-status-badge inactive';
        text.textContent = 'Выключен';
    }
}

async function loadSubscriptions() {
    try {
        const data = await api('/subscriptions');
        subscriptionsData = data.subscriptions || [];
        renderSubscriptions();
    } catch (error) {
        console.error('Failed to load subscriptions:', error);
    }
}

function renderSubscriptions() {
    const container = document.getElementById('subscriptions-list');
    const section = document.getElementById('subscriptions-section');
    if (!container) return;
    
    if (subscriptionsData.length === 0) {
        if (section) section.style.display = 'none';
        return;
    }
    
    if (section) section.style.display = 'block';
    
    container.innerHTML = subscriptionsData.map(s => {
        const autoUpdate = s.auto_update !== false;
        const interval = s.update_interval || 24;
        const intervalText = interval < 24 ? `${interval}ч` : (interval === 24 ? '24ч' : `${Math.floor(interval/24)}д`);
        const autoBadge = autoUpdate 
            ? `<span class="sub-auto-badge">↻ ${intervalText}</span>`
            : `<span class="sub-auto-badge disabled">выкл</span>`;
        
        return `
            <div class="sub-item">
                <div class="sub-item-info">
                    <span class="sub-item-name">${s.name}</span>
                    <span class="sub-item-meta">
                        ${s.tunnels_count} серверов · ${s.last_update ? formatTimeAgo(s.last_update) : '—'}
                        ${autoBadge}
                    </span>
                </div>
                <div class="sub-item-actions">
                    <button class="btn btn-sm" onclick="toggleSubscriptionAutoUpdate('${s.id}')" title="${autoUpdate ? 'Отключить автообновление' : 'Включить автообновление'}">
                        ${autoUpdate ? '⏸' : '▶'}
                    </button>
                    <button class="btn btn-sm" onclick="updateSubscription('${s.id}')" title="Обновить">↻</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteSubscription('${s.id}')" title="Удалить">×</button>
                </div>
            </div>
        `;
    }).join('');
}

function formatTimeAgo(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    
    if (diff < 60) return 'только что';
    if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} дн назад`;
    return new Date(timestamp * 1000).toLocaleDateString();
}

async function toggleSubscriptionAutoUpdate(id) {
    const sub = subscriptionsData.find(s => s.id === id);
    if (!sub) return;
    
    const newAutoUpdate = !sub.auto_update;
    
    try {
        await api(`/subscriptions/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ auto_update: newAutoUpdate })
        });
        
        showToast(newAutoUpdate ? 'Автообновление включено' : 'Автообновление выключено', 'success');
        await loadSubscriptions();
    } catch (error) {
        showToast('Ошибка: ' + error.message, 'error');
    }
}

async function loadTunnelGroups() {
    try {
        const data = await api('/tunnel-groups');
        groupsData = data.groups || [];
        renderGroups();
    } catch (error) {
        console.error('Failed to load groups:', error);
    }
}

function renderGroups() {
    const container = document.getElementById('tunnel-groups-list');
    const section = document.getElementById('tunnel-groups-section');
    if (!container) return;
    
    if (groupsData.length === 0) {
        if (section) section.style.display = 'none';
        return;
    }
    
    if (section) section.style.display = 'block';
    
    container.innerHTML = groupsData.map(g => `
        <div class="group-item" onclick="openEditGroupModal('${g.id}')">
            <span class="group-icon">${g.type === 'urltest' ? '⚡' : '🔄'}</span>
            <span class="group-name">${g.name}</span>
            <span class="group-type">${g.type === 'urltest' ? 'Auto' : 'Fallback'}</span>
            <span class="group-count">${g.tunnels?.length || 0}</span>
        </div>
    `).join('');
}

async function loadOutbounds() {
    try {
        const data = await api('/singbox/outbounds');
        const select = document.getElementById('active-outbound-select');
        if (!select) return;
        
        const outbounds = data.outbounds || [];
        select.innerHTML = outbounds.map(o => `
            <option value="${o.tag}" ${data.active === o.tag ? 'selected' : ''}>
                ${o.type === 'group' ? '📦 ' : '🔐 '}${o.name} (${o.type === 'group' ? o.group_type : o.tunnel_type})
                ${o.latency ? ` • ${o.latency}ms` : ''}
            </option>
        `).join('');
        
        if (outbounds.length === 0) {
            select.innerHTML = '<option value="">Нет доступных туннелей</option>';
        }
        
        const status = document.getElementById('active-tunnel-status');
        if (status) {
            if (data.active) {
                const activeOb = outbounds.find(o => o.tag === data.active);
                status.textContent = activeOb ? `✓ ${activeOb.name}` : '✓ Подключён';
                status.className = 'active-tunnel-status connected';
            } else {
                status.textContent = 'Не выбран';
                status.className = 'active-tunnel-status';
            }
        }
    } catch (error) {
        console.error('Failed to load outbounds:', error);
    }
}

// Import functions
function toggleImportPanel() {
    const panel = document.getElementById('import-panel');
    const btn = document.getElementById('btn-toggle-import');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        btn.textContent = '− Скрыть';
    } else {
        panel.style.display = 'none';
        btn.textContent = '+ Добавить';
    }
}

function switchImportTab(tab) {
    document.querySelectorAll('.import-panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.import-panel-tab[data-tab="${tab}"]`)?.classList.add('active');
    
    document.getElementById('import-link-form').style.display = tab === 'link' ? 'flex' : 'none';
    document.getElementById('import-subscription-form').style.display = tab === 'subscription' ? 'flex' : 'none';
}

async function importTunnelLinks() {
    const input = document.getElementById('import-link-input');
    const links = input.value.trim().split('\n').filter(l => l.trim());
    
    if (links.length === 0) {
        showToast('Вставьте ссылку', 'error');
        return;
    }
    
    showLoading('Импорт...', 'Добавление серверов');
    
    try {
        if (links.length === 1) {
            await api('/tunnels/import', {
                method: 'POST',
                body: JSON.stringify({ link: links[0] })
            });
        } else {
            await api('/tunnels/import-batch', {
                method: 'POST',
                body: JSON.stringify(links)
            });
        }
        
        showToast(`Импортировано ${links.length} сервер(ов)`, 'success');
        input.value = '';
        await loadTunnelsList();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка импорта: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function addSubscription() {
    const name = document.getElementById('sub-name').value.trim();
    const url = document.getElementById('sub-url').value.trim();
    const format = document.getElementById('sub-format').value;
    const autoUpdate = document.getElementById('sub-auto-update')?.checked ?? true;
    const updateInterval = parseInt(document.getElementById('sub-interval')?.value || '24');
    
    if (!name || !url) {
        showToast('Заполните название и URL', 'error');
        return;
    }
    
    showLoading('Добавление подписки...', 'Загрузка серверов');
    
    try {
        const data = await api('/subscriptions', {
            method: 'POST',
            body: JSON.stringify({ 
                name, 
                url, 
                format, 
                auto_update: autoUpdate, 
                update_interval: updateInterval 
            })
        });
        
        showToast(`Добавлено ${data.tunnels_added} серверов`, 'success');
        document.getElementById('sub-name').value = '';
        document.getElementById('sub-url').value = '';
        
        await loadSubscriptions();
        await loadTunnelsList();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function updateSubscription(id) {
    showLoading('Обновление...', 'Загрузка серверов');
    
    try {
        await api(`/subscriptions/${id}/update`, { method: 'POST' });
        showToast('Подписка обновлена', 'success');
        await loadSubscriptions();
        await loadTunnelsList();
    } catch (error) {
        showToast('Ошибка обновления', 'error');
    } finally {
        hideLoading();
    }
}

async function deleteSubscription(id) {
    if (!confirm('Удалить подписку и все её серверы?')) return;
    
    try {
        await api(`/subscriptions/${id}`, { method: 'DELETE' });
        showToast('Подписка удалена', 'success');
        await loadSubscriptions();
        await loadTunnelsList();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    }
}

async function toggleTunnel(id) {
    try {
        await api(`/tunnels/${id}/toggle`, { method: 'POST' });
        await loadTunnelsList();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка', 'error');
    }
}

async function testTunnel(id) {
    const card = document.querySelector(`.tunnel-card[onclick*="${id}"]`);
    if (card) {
        card.classList.add('testing');
    }
    
    try {
        const data = await api(`/tunnels/${id}/test`, { method: 'POST' });
        if (data.reachable) {
            showToast(`Сервер доступен: ${data.latency}ms`, 'success');
        } else {
            showToast('Сервер недоступен', 'error');
        }
        await loadTunnelsList();
    } catch (error) {
        showToast('Ошибка проверки', 'error');
    } finally {
        if (card) {
            card.classList.remove('testing');
        }
    }
}

async function testAllTunnels() {
    showLoading('Проверка серверов...', 'Это может занять время');
    
    try {
        for (const t of tunnelsData) {
            if (t.enabled) {
                await api(`/tunnels/${t.id}/test`, { method: 'POST' });
            }
        }
        showToast('Проверка завершена', 'success');
        await loadTunnelsList();
    } catch (error) {
        showToast('Ошибка проверки', 'error');
    } finally {
        hideLoading();
    }
}

async function applyTunnelConfig() {
    const select = document.getElementById('active-outbound-select');
    const outbound = select?.value;
    
    if (!outbound) {
        showToast('Выберите туннель', 'error');
        return;
    }
    
    showLoading('Применение конфигурации...', 'Перезапуск sing-box');
    
    try {
        await api('/singbox/set-active', {
            method: 'POST',
            body: JSON.stringify({ outbound_tag: outbound })
        });
        
        await api('/singbox/apply', { method: 'POST' });
        
        showToast('Конфигурация применена', 'success');
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка применения: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// Tunnel Modal
function openCreateTunnelModal() {
    currentTunnelId = null;
    document.getElementById('tunnel-modal-title').textContent = 'Добавить туннель';
    document.getElementById('delete-tunnel-btn').style.display = 'none';
    
    // Reset form
    document.getElementById('tunnel-name').value = '';
    document.getElementById('tunnel-type').value = 'vless';
    document.getElementById('tunnel-server').value = '';
    document.getElementById('tunnel-port').value = '443';
    document.getElementById('tunnel-uuid').value = '';
    
    updateTunnelForm();
    document.getElementById('tunnel-modal').classList.add('active');
}

function openEditTunnelModal(id) {
    const tunnel = tunnelsData.find(t => t.id === id);
    if (!tunnel) return;
    
    currentTunnelId = id;
    document.getElementById('tunnel-modal-title').textContent = 'Редактировать туннель';
    document.getElementById('delete-tunnel-btn').style.display = 'block';
    
    // Fill form
    document.getElementById('tunnel-name').value = tunnel.name;
    document.getElementById('tunnel-type').value = tunnel.type;
    document.getElementById('tunnel-server').value = tunnel.server;
    document.getElementById('tunnel-port').value = tunnel.port;
    
    updateTunnelForm();
    
    // Fill protocol-specific fields
    const settings = tunnel.settings || {};
    if (tunnel.type === 'vless') {
        document.getElementById('tunnel-uuid').value = settings.uuid || '';
        document.getElementById('tunnel-flow').value = settings.flow || '';
    } else if (tunnel.type === 'vmess') {
        document.getElementById('tunnel-vmess-uuid').value = settings.uuid || '';
        document.getElementById('tunnel-alterid').value = settings.alter_id || 0;
    } else if (tunnel.type === 'shadowsocks') {
        document.getElementById('tunnel-ss-method').value = settings.method || '';
        document.getElementById('tunnel-ss-password').value = settings.password || '';
    } else if (tunnel.type === 'trojan') {
        document.getElementById('tunnel-trojan-password').value = settings.password || '';
    } else if (tunnel.type === 'hysteria2') {
        document.getElementById('tunnel-hy2-password').value = settings.password || '';
    }
    
    // TLS
    const tls = tunnel.tls || {};
    if (tls.enabled) {
        document.getElementById('tunnel-security').value = tls.type || 'tls';
        document.getElementById('tunnel-sni').value = tls.server_name || '';
        document.getElementById('tunnel-fingerprint').value = tls.fingerprint || 'chrome';
        if (tls.type === 'reality') {
            document.getElementById('tunnel-pbk').value = tls.public_key || '';
            document.getElementById('tunnel-sid').value = tls.short_id || '';
        }
        updateTlsForm();
    }
    
    // Transport
    const transport = tunnel.transport || {};
    document.getElementById('tunnel-transport').value = transport.type || 'tcp';
    if (transport.type === 'ws') {
        document.getElementById('tunnel-ws-path').value = transport.path || '/';
        document.getElementById('tunnel-ws-host').value = transport.host || '';
    } else if (transport.type === 'grpc') {
        document.getElementById('tunnel-grpc-service').value = transport.service_name || '';
    }
    updateTransportForm();
    
    document.getElementById('tunnel-modal').classList.add('active');
}

function closeTunnelModal() {
    document.getElementById('tunnel-modal').classList.remove('active');
    currentTunnelId = null;
}

function updateTunnelForm() {
    const type = document.getElementById('tunnel-type').value;
    
    document.querySelectorAll('.protocol-settings').forEach(el => el.style.display = 'none');
    
    const settingsId = {
        vless: 'tunnel-vless-settings',
        vmess: 'tunnel-vmess-settings',
        shadowsocks: 'tunnel-ss-settings',
        trojan: 'tunnel-trojan-settings',
        hysteria2: 'tunnel-hysteria2-settings'
    }[type];
    
    if (settingsId) {
        document.getElementById(settingsId).style.display = 'block';
    }
    
    // Show/hide TLS section based on protocol
    if (type === 'vless' || type === 'vmess') {
        document.getElementById('tunnel-security').closest('.form-row').style.display = 'flex';
    }
}

function updateTlsForm() {
    const security = document.getElementById('tunnel-security').value;
    const tlsSection = document.getElementById('tls-settings');
    const realitySection = document.getElementById('reality-settings');
    
    if (security === 'none') {
        tlsSection.style.display = 'none';
    } else {
        tlsSection.style.display = 'block';
        realitySection.style.display = security === 'reality' ? 'block' : 'none';
    }
}

function updateTransportForm() {
    const transport = document.getElementById('tunnel-transport').value;
    
    document.getElementById('ws-settings').style.display = transport === 'ws' ? 'block' : 'none';
    document.getElementById('grpc-settings').style.display = transport === 'grpc' ? 'block' : 'none';
}

async function saveTunnel() {
    const type = document.getElementById('tunnel-type').value;
    const name = document.getElementById('tunnel-name').value.trim();
    const server = document.getElementById('tunnel-server').value.trim();
    const port = parseInt(document.getElementById('tunnel-port').value);
    
    if (!name || !server || !port) {
        showToast('Заполните обязательные поля', 'error');
        return;
    }
    
    // Build settings
    let settings = {};
    if (type === 'vless') {
        settings = {
            uuid: document.getElementById('tunnel-uuid').value,
            flow: document.getElementById('tunnel-flow').value,
            encryption: 'none'
        };
    } else if (type === 'vmess') {
        settings = {
            uuid: document.getElementById('tunnel-vmess-uuid').value,
            alter_id: parseInt(document.getElementById('tunnel-alterid').value) || 0,
            security: document.getElementById('tunnel-vmess-security').value
        };
    } else if (type === 'shadowsocks') {
        settings = {
            method: document.getElementById('tunnel-ss-method').value,
            password: document.getElementById('tunnel-ss-password').value
        };
    } else if (type === 'trojan') {
        settings = { password: document.getElementById('tunnel-trojan-password').value };
    } else if (type === 'hysteria2') {
        settings = {
            password: document.getElementById('tunnel-hy2-password').value,
            obfs_type: document.getElementById('tunnel-hy2-obfs').value,
            obfs_password: document.getElementById('tunnel-hy2-obfs-password').value
        };
    }
    
    // Build TLS
    const security = document.getElementById('tunnel-security')?.value || 'none';
    let tls = {};
    if (security !== 'none') {
        tls = {
            enabled: true,
            type: security,
            server_name: document.getElementById('tunnel-sni').value,
            fingerprint: document.getElementById('tunnel-fingerprint').value
        };
        if (security === 'reality') {
            tls.public_key = document.getElementById('tunnel-pbk').value;
            tls.short_id = document.getElementById('tunnel-sid').value;
        }
    }
    
    // Build transport
    const transportType = document.getElementById('tunnel-transport').value;
    let transport = { type: transportType };
    if (transportType === 'ws') {
        transport.path = document.getElementById('tunnel-ws-path').value || '/';
        transport.host = document.getElementById('tunnel-ws-host').value;
    } else if (transportType === 'grpc') {
        transport.service_name = document.getElementById('tunnel-grpc-service').value;
    }
    
    const tunnelData = { name, type, server, port, settings, tls, transport };
    
    showLoading('Сохранение...', '');
    
    try {
        if (currentTunnelId) {
            await api(`/tunnels/${currentTunnelId}`, {
                method: 'PUT',
                body: JSON.stringify(tunnelData)
            });
        } else {
            await api('/tunnels', {
                method: 'POST',
                body: JSON.stringify(tunnelData)
            });
        }
        
        showToast('Туннель сохранён', 'success');
        closeTunnelModal();
        await loadTunnelsList();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка сохранения', 'error');
    } finally {
        hideLoading();
    }
}

async function deleteCurrentTunnel() {
    if (!currentTunnelId) return;
    if (!confirm('Удалить этот туннель?')) return;
    
    try {
        await api(`/tunnels/${currentTunnelId}`, { method: 'DELETE' });
        showToast('Туннель удалён', 'success');
        closeTunnelModal();
        await loadTunnelsList();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    }
}

// Group Modal
function openCreateGroupModal() {
    currentGroupId = null;
    document.getElementById('group-modal-title').textContent = 'Создать группу';
    document.getElementById('delete-group-btn').style.display = 'none';
    
    document.getElementById('group-name').value = '';
    document.getElementById('group-type').value = 'urltest';
    document.getElementById('group-interval').value = '5m';
    document.getElementById('group-tolerance').value = '50';
    
    renderGroupTunnelSelector([]);
    document.getElementById('group-modal').classList.add('active');
}

function openEditGroupModal(id) {
    const group = groupsData.find(g => g.id === id);
    if (!group) return;
    
    currentGroupId = id;
    document.getElementById('group-modal-title').textContent = 'Редактировать группу';
    document.getElementById('delete-group-btn').style.display = 'block';
    
    document.getElementById('group-name').value = group.name;
    document.getElementById('group-type').value = group.type;
    document.getElementById('group-interval').value = group.interval || '5m';
    document.getElementById('group-tolerance').value = group.tolerance || 50;
    
    renderGroupTunnelSelector(group.tunnels || []);
    document.getElementById('group-modal').classList.add('active');
}

function closeGroupModal() {
    document.getElementById('group-modal').classList.remove('active');
    currentGroupId = null;
}

function renderGroupTunnelSelector(selected) {
    const container = document.getElementById('group-tunnels-selector');
    if (!container) return;
    
    const enabledTunnels = tunnelsData.filter(t => t.enabled);
    
    if (enabledTunnels.length === 0) {
        container.innerHTML = '<div class="empty-hint">Нет включённых туннелей</div>';
        return;
    }
    
    container.innerHTML = enabledTunnels.map(t => `
        <label class="checkbox-item">
            <input type="checkbox" value="${t.id}" ${selected.includes(t.id) ? 'checked' : ''}>
            <span>${t.name} (${t.type})</span>
        </label>
    `).join('');
}

async function saveGroup() {
    const name = document.getElementById('group-name').value.trim();
    const type = document.getElementById('group-type').value;
    const interval = document.getElementById('group-interval').value;
    const tolerance = parseInt(document.getElementById('group-tolerance').value);
    
    if (!name) {
        showToast('Введите название', 'error');
        return;
    }
    
    const tunnels = [];
    document.querySelectorAll('#group-tunnels-selector input:checked').forEach(cb => {
        tunnels.push(cb.value);
    });
    
    if (tunnels.length < 2) {
        showToast('Выберите минимум 2 сервера', 'error');
        return;
    }
    
    const groupData = { name, type, tunnels, interval, tolerance };
    
    try {
        if (currentGroupId) {
            await api(`/tunnel-groups/${currentGroupId}`, {
                method: 'PUT',
                body: JSON.stringify(groupData)
            });
        } else {
            await api('/tunnel-groups', {
                method: 'POST',
                body: JSON.stringify(groupData)
            });
        }
        
        showToast('Группа сохранена', 'success');
        closeGroupModal();
        await loadTunnelGroups();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка сохранения', 'error');
    }
}

async function deleteCurrentGroup() {
    if (!currentGroupId) return;
    if (!confirm('Удалить эту группу?')) return;
    
    try {
        await api(`/tunnel-groups/${currentGroupId}`, { method: 'DELETE' });
        showToast('Группа удалена', 'success');
        closeGroupModal();
        await loadTunnelGroups();
        await loadOutbounds();
    } catch (error) {
        showToast('Ошибка удаления', 'error');
    }
}

// ============ Routing Rules Functions ============

let routingRulesData = [];
// Service-based routing data
let serviceRoutesData = {};
let allServicesData = [];

async function loadServiceRoutes() {
    const container = document.getElementById('service-routes-list');
    const warning = document.getElementById('routing-warning');
    
    if (!container) return;
    
    // Get enabled tunnels count
    const enabledTunnels = tunnelsData.filter(t => t.enabled);
    
    // Show warning if only 1 or no tunnels
    if (warning) {
        warning.style.display = enabledTunnels.length < 2 ? 'flex' : 'none';
    }
    
    // Populate default selector
    populateRoutingDefaultSelector();
    
    // Load services
    try {
        const [servicesResponse, customServicesResponse, routingData] = await Promise.all([
            api('/services'),
            api('/custom-services').catch(() => ({ services: [] })),
            api('/routing-rules').catch(() => ({ rules: [], default_outbound: null }))
        ]);
        
        // Collect all enabled services
        allServicesData = [];
        
        // Category icons and names
        const categoryIcons = {
            'streaming': '📺',
            'social': '💬',
            'gaming': '🎮',
            'ai': '🤖',
            'other': '🌐',
            'custom': '⭐'
        };
        
        const categoryNames = servicesResponse.categories || {};
        
        // Add preset services
        for (const service of (servicesResponse.services || [])) {
            if (service.enabled) {
                const catId = service.category || 'other';
                allServicesData.push({
                    id: service.id,
                    name: service.name,
                    icon: categoryIcons[catId] || '📦',
                    domains: service.domains || [],
                    category: categoryNames[catId] || catId,
                    type: 'preset'
                });
            }
        }
        
        // Add custom services
        for (const service of (customServicesResponse.services || [])) {
            if (service.enabled) {
                allServicesData.push({
                    id: `custom-${service.id}`,
                    name: service.name,
                    icon: '⭐',
                    domains: service.domains || [],
                    category: 'Мои сервисы',
                    type: 'custom'
                });
            }
        }
        
        // Build service routes from existing rules
        serviceRoutesData = {};
        for (const rule of (routingData.rules || [])) {
            if (rule.service_id && rule.enabled) {
                serviceRoutesData[rule.service_id] = rule.outbound;
            }
        }
        
        // Set default outbound
        const defaultSelect = document.getElementById('routing-default-outbound');
        if (defaultSelect && routingData.default_outbound) {
            defaultSelect.value = routingData.default_outbound;
        }
        
        renderServiceRoutes(enabledTunnels);
        
    } catch (error) {
        console.error('Failed to load service routes:', error);
        container.innerHTML = '<div class="loading-state">Ошибка загрузки</div>';
    }
}

function renderServiceRoutes(enabledTunnels) {
    const container = document.getElementById('service-routes-list');
    if (!container) return;
    
    if (allServicesData.length === 0) {
        container.innerHTML = '<div class="loading-state">Нет включённых сервисов. Включите сервисы во вкладке "Домены".</div>';
        return;
    }
    
    const canRoute = enabledTunnels.length >= 2;
    
    // Build tunnel options
    let tunnelOptions = '<option value="" class="default-option">По умолчанию</option>';
    for (const t of enabledTunnels) {
        const tag = `${t.type}-${t.id}`;
        tunnelOptions += `<option value="${tag}">${t.name}</option>`;
    }
    
    // Group services by category
    const servicesByCategory = {};
    for (const service of allServicesData) {
        if (!servicesByCategory[service.category]) {
            servicesByCategory[service.category] = [];
        }
        servicesByCategory[service.category].push(service);
    }
    
    let html = '';
    
    for (const [category, services] of Object.entries(servicesByCategory)) {
        html += `<div class="service-category-header">${category}</div>`;
        
        for (const service of services) {
            const currentRoute = serviceRoutesData[service.id] || '';
            const hasCustomRoute = currentRoute !== '';
            const domainsPreview = service.domains.slice(0, 2).join(', ') + (service.domains.length > 2 ? '...' : '');
            
            html += `
                <div class="service-route-item ${hasCustomRoute ? 'has-custom-route' : ''}">
                    <div class="service-route-icon">${service.icon}</div>
                    <div class="service-route-info">
                        <div class="service-route-name">${service.name}</div>
                        <div class="service-route-domains">${domainsPreview || 'Нет доменов'}</div>
                    </div>
                    <select class="service-route-select" 
                            data-service-id="${service.id}" 
                            onchange="updateServiceRoute('${service.id}', this.value)"
                            ${!canRoute ? 'disabled' : ''}>
                        ${tunnelOptions}
                    </select>
                </div>
            `;
        }
    }
    
    container.innerHTML = html;
    
    // Set current values
    for (const [serviceId, outbound] of Object.entries(serviceRoutesData)) {
        const select = container.querySelector(`select[data-service-id="${serviceId}"]`);
        if (select) {
            select.value = outbound;
        }
    }
}

function updateServiceRoute(serviceId, outbound) {
    if (outbound) {
        serviceRoutesData[serviceId] = outbound;
    } else {
        delete serviceRoutesData[serviceId];
    }
    
    // Update visual indicator
    const container = document.getElementById('service-routes-list');
    const item = container?.querySelector(`select[data-service-id="${serviceId}"]`)?.closest('.service-route-item');
    if (item) {
        item.classList.toggle('has-custom-route', !!outbound);
    }
}

async function applyServiceRoutes() {
    showLoading('Применение маршрутов...', 'Генерация конфигурации');
    
    try {
        // Build rules from service routes
        const rules = [];
        
        for (const [serviceId, outbound] of Object.entries(serviceRoutesData)) {
            const service = allServicesData.find(s => s.id === serviceId);
            if (service && service.domains.length > 0) {
                rules.push({
                    name: service.name,
                    service_id: serviceId,
                    outbound: outbound,
                    domains: service.domains,
                    domain_keywords: [],
                    enabled: true
                });
            }
        }
        
        // Save all rules
        await api('/routing-rules/batch', {
            method: 'POST',
            body: JSON.stringify({ rules })
        });
        
        // Apply config
        await api('/singbox/apply', { method: 'POST' });
        
        hideLoading();
        showToast('Маршруты применены', 'success');
        
    } catch (error) {
        hideLoading();
        showToast('Ошибка: ' + error.message, 'error');
    }
}

async function resetAllRoutes() {
    if (!confirm('Сбросить все маршруты? Весь трафик будет идти через сервер по умолчанию.')) {
        return;
    }
    
    serviceRoutesData = {};
    
    try {
        await api('/routing-rules/batch', {
            method: 'POST',
            body: JSON.stringify({ rules: [] })
        });
        
        await loadServiceRoutes();
        showToast('Маршруты сброшены', 'success');
    } catch (error) {
        showToast('Ошибка', 'error');
    }
}

function populateRoutingDefaultSelector() {
    const select = document.getElementById('routing-default-outbound');
    if (!select) return;
    
    let options = '<option value="">Выберите сервер...</option>';
    
    // Add enabled tunnels
    for (const t of tunnelsData) {
        if (t.enabled) {
            const tag = `${t.type}-${t.id}`;
            options += `<option value="${tag}">${t.name} (${t.type})</option>`;
        }
    }
    
    // Add groups
    for (const g of groupsData) {
        options += `<option value="${g.tag}">${g.name} (группа)</option>`;
    }
    
    select.innerHTML = options;
}

async function setRoutingDefault() {
    const select = document.getElementById('routing-default-outbound');
    const outbound = select?.value;
    
    if (!outbound) return;
    
    try {
        await api('/routing-rules/set-default', {
            method: 'POST',
            body: JSON.stringify({ default_outbound: outbound })
        });
        showToast('Сервер по умолчанию установлен', 'success');
    } catch (error) {
        showToast('Ошибка', 'error');
    }
}

// ============ Dependencies Management ============

let dependenciesData = null;

async function loadDependencies() {
    const systemList = document.getElementById('dep-system-list');
    const pythonList = document.getElementById('dep-python-list');
    const statusBadge = document.getElementById('dep-status-badge');
    const btnInstallAll = document.getElementById('btn-install-all');
    
    if (!systemList || !pythonList) return;
    
    systemList.innerHTML = '<div class="dep-loading">Проверка...</div>';
    pythonList.innerHTML = '<div class="dep-loading">Проверка...</div>';
    statusBadge.textContent = 'Проверка...';
    statusBadge.className = 'dep-status-badge';
    
    try {
        dependenciesData = await api('/dependencies');
        
        // Update summary
        document.getElementById('dep-installed').textContent = dependenciesData.summary.installed;
        document.getElementById('dep-missing').textContent = 
            dependenciesData.summary.missing_required + dependenciesData.summary.missing_optional;
        document.getElementById('dep-total').textContent = dependenciesData.summary.total;
        
        // Update status badge
        if (dependenciesData.summary.ready) {
            statusBadge.textContent = 'Готово';
            statusBadge.className = 'dep-status-badge ready';
            btnInstallAll.style.display = 'none';
        } else if (dependenciesData.summary.missing_required > 0) {
            statusBadge.textContent = `Отсутствует: ${dependenciesData.summary.missing_required}`;
            statusBadge.className = 'dep-status-badge error';
            btnInstallAll.style.display = 'inline-flex';
        } else {
            statusBadge.textContent = 'Опционально';
            statusBadge.className = 'dep-status-badge missing';
            btnInstallAll.style.display = 'none';
        }
        
        // Render system dependencies
        renderDependencyList(systemList, dependenciesData.system, 'system');
        
        // Render Python packages
        renderDependencyList(pythonList, dependenciesData.python, 'python');
        
        // Load service status
        await loadServiceStatus();
        
    } catch (error) {
        console.error('Failed to load dependencies:', error);
        systemList.innerHTML = '<div class="dep-loading">Ошибка загрузки</div>';
        pythonList.innerHTML = '<div class="dep-loading">Ошибка загрузки</div>';
        statusBadge.textContent = 'Ошибка';
        statusBadge.className = 'dep-status-badge error';
    }
}

async function loadServiceStatus() {
    const badge = document.getElementById('service-badge');
    const btnEnable = document.getElementById('btn-service-enable');
    const btnDisable = document.getElementById('btn-service-disable');
    
    if (!badge) return;
    
    try {
        const status = await api('/dependencies/service-status');
        
        if (status.running) {
            badge.textContent = 'Работает (автозапуск)';
            badge.className = 'service-badge running';
            btnEnable.style.display = 'none';
            btnDisable.style.display = 'inline-flex';
        } else if (status.enabled) {
            badge.textContent = 'Автозапуск включен';
            badge.className = 'service-badge enabled';
            btnEnable.style.display = 'none';
            btnDisable.style.display = 'inline-flex';
        } else if (status.installed) {
            badge.textContent = 'Установлена (выключена)';
            badge.className = 'service-badge disabled';
            btnEnable.style.display = 'inline-flex';
            btnDisable.style.display = 'inline-flex';
        } else {
            badge.textContent = 'Не установлена';
            badge.className = 'service-badge not-installed';
            btnEnable.style.display = 'inline-flex';
            btnDisable.style.display = 'none';
        }
    } catch (error) {
        badge.textContent = 'Ошибка';
        badge.className = 'service-badge not-installed';
    }
}

function renderDependencyList(container, deps, type) {
    if (!deps || deps.length === 0) {
        container.innerHTML = '<div class="dep-loading">Нет данных</div>';
        return;
    }
    
    let html = '';
    
    for (const dep of deps) {
        const isInstalled = dep.installed;
        const isRequired = dep.required;
        
        let itemClass = isInstalled ? 'installed' : 'missing';
        if (!isInstalled && isRequired) itemClass += ' required';
        
        let statusClass = isInstalled ? 'ok' : (isRequired ? 'missing' : 'optional');
        let statusText = isInstalled ? 'OK' : (isRequired ? 'Нужен' : 'Опц.');
        
        // Don't allow removing certain packages
        const canRemove = isInstalled && dep.id !== 'luci' && dep.id !== 'python3';
        
        html += `
            <div class="dep-item ${itemClass}" data-id="${dep.id}" data-type="${type}">
                <div class="dep-item-info">
                    <div class="dep-item-name">${dep.name}${isRequired ? ' *' : ''}</div>
                    <div class="dep-item-desc">${dep.description || ''}</div>
                    ${dep.version ? `<div class="dep-item-version">v${dep.version}</div>` : ''}
                </div>
                <div class="dep-item-actions">
                    <span class="dep-item-status ${statusClass}">${statusText}</span>
                    ${!isInstalled ? 
                        `<button class="btn btn-sm btn-primary" onclick="installDependency('${dep.id}', this)">Установить</button>` 
                        : (canRemove ? `<button class="btn btn-sm btn-danger" onclick="removeDependency('${dep.id}', ${isRequired}, this)">Удалить</button>` : '')}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

async function installDependency(depId, btn) {
    if (!depId) return;
    
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;
    
    try {
        showToast(`Установка ${depId}...`, 'info');
        
        const result = await api(`/dependencies/install/${depId}`, {
            method: 'POST'
        });
        
        if (result.success) {
            showToast(`${depId} установлен!`, 'success');
            // Refresh the list
            await loadDependencies();
        } else {
            showToast(`Ошибка установки ${depId}`, 'error');
            btn.textContent = originalText;
            btn.disabled = false;
        }
    } catch (error) {
        console.error('Install error:', error);
        showToast(`Ошибка: ${error.message}`, 'error');
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function removeDependency(depId, isRequired, btn) {
    if (!depId) return;
    
    const confirmMsg = isRequired 
        ? `${depId} — обязательный пакет!\n\nУдаление может нарушить работу PinPoint.\n\nВы уверены?`
        : `Удалить пакет ${depId}?`;
    
    if (!confirm(confirmMsg)) return;
    
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;
    
    try {
        showToast(`Удаление ${depId}...`, 'info');
        
        const url = isRequired 
            ? `/dependencies/remove/${depId}?force=true`
            : `/dependencies/remove/${depId}`;
        
        const result = await api(url, { method: 'POST' });
        
        if (result.success) {
            showToast(`${depId} удалён!`, 'success');
            await loadDependencies();
        } else {
            showToast(`Ошибка удаления ${depId}`, 'error');
            btn.textContent = originalText;
            btn.disabled = false;
        }
    } catch (error) {
        console.error('Remove error:', error);
        showToast(`Ошибка: ${error.message}`, 'error');
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function disablePinpointService() {
    if (!confirm('Отключить автозапуск PinPoint?\n\nСлужба будет удалена из init.d.')) {
        return;
    }
    
    try {
        const result = await api('/dependencies/disable-pinpoint', {
            method: 'POST'
        });
        
        if (result.success) {
            showToast('Автозапуск отключен', 'success');
            await loadServiceStatus();
        } else {
            showToast('Ошибка отключения', 'error');
        }
    } catch (error) {
        showToast(`Ошибка: ${error.message}`, 'error');
    }
}

async function installAllDependencies() {
    const btn = document.getElementById('btn-install-all');
    const originalText = btn.textContent;
    btn.textContent = 'Установка...';
    btn.disabled = true;
    
    showLoading('Установка зависимостей', 'Это может занять несколько минут...');
    
    try {
        const result = await api('/dependencies/install-all', {
            method: 'POST'
        });
        
        hideLoading();
        
        if (result.summary.ready) {
            showToast('Все зависимости установлены!', 'success');
        } else {
            showToast(`Установлено: ${result.results.filter(r => r.success).length}`, 'info');
        }
        
        // Refresh the list
        await loadDependencies();
        
    } catch (error) {
        hideLoading();
        console.error('Install all error:', error);
        showToast(`Ошибка: ${error.message}`, 'error');
    }
    
    btn.textContent = originalText;
    btn.disabled = false;
}

async function setupPinpointService() {
    if (!confirm('Установить PinPoint как системную службу OpenWRT?\n\nЭто создаст init.d скрипт для автозапуска.')) {
        return;
    }
    
    try {
        const result = await api('/dependencies/setup-pinpoint', {
            method: 'POST'
        });
        
        if (result.success) {
            showToast('PinPoint установлен как служба!', 'success');
        } else {
            showToast('Ошибка установки службы', 'error');
        }
    } catch (error) {
        showToast(`Ошибка: ${error.message}`, 'error');
    }
}

async function showOpkgInfo() {
    try {
        const info = await api('/dependencies/opkg-info');
        
        let feedsHtml = info.feeds.map(f => 
            `<div class="opkg-info-item">
                <span class="opkg-info-label">${f.name}</span>
                <span class="opkg-info-value" style="font-size: 10px; word-break: break-all;">${f.url}</span>
            </div>`
        ).join('');
        
        const html = `
            <div class="opkg-info">
                <div class="opkg-info-item">
                    <span class="opkg-info-label">Архитектура</span>
                    <span class="opkg-info-value">${info.arch || 'Неизвестно'}</span>
                </div>
                <div class="opkg-info-item">
                    <span class="opkg-info-label">Установлено пакетов</span>
                    <span class="opkg-info-value">${info.installed_count}</span>
                </div>
                <h4 style="margin: 16px 0 8px; font-size: 13px;">Репозитории:</h4>
                ${feedsHtml || '<div class="opkg-info-item">Нет данных</div>'}
            </div>
        `;
        
        // Create modal if not exists
        let modal = document.getElementById('opkg-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'opkg-modal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 500px;">
                    <div class="modal-header">
                        <h3>📦 Информация opkg</h3>
                        <button class="modal-close" onclick="closeOpkgModal()">×</button>
                    </div>
                    <div class="modal-body" id="opkg-modal-body"></div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        document.getElementById('opkg-modal-body').innerHTML = html;
        modal.classList.add('active');
        
    } catch (error) {
        showToast(`Ошибка: ${error.message}`, 'error');
    }
}

function closeOpkgModal() {
    const modal = document.getElementById('opkg-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

// Tab switching - updated to include monitor and settings tabs

// Load theme on page load
loadTheme();
