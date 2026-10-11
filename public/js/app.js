// G2G StockNexus — Multi-Seller Management Portal
// Adem & Amine (Sellers) | Aymen & Hmayma (Suppliers)

(function () {
  'use strict';

  let appState = {
    users: [],
    items: [],
    activityLogs: []
  };

  let arcCatalog = {};
  let currentUserId = localStorage.getItem('g2g_session_user_id') || 'usr_seller_adem';
  let activeTopic = 'pool'; // 'pool' | 'operations' | 'team' | 'history'
  let opsFilter = 'all'; // 'all' | 'in_progress' | 'live' | 'mine'
  let poolSearchQuery = '';
  let poolGameFilter = '';
  let socket = null;
  let wsReconnectTimer = null;

  // Audio Notifications
  let audioCtx = null;
  function playNotification(type = 'info') {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const now = audioCtx.currentTime;

      if (type === 'lock') {
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.15);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'sold') {
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.1);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      }
    } catch (e) {}
  }

  function showToast(message, type = 'info', title = '') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    let icon = type === 'warning' ? '⚠️' : type === 'success' ? '🎉' : 'ℹ️';

    toast.innerHTML = `
      <div style="font-size: 16px;">${icon}</div>
      <div style="flex:1;">
        ${title ? `<strong style="display:block; margin-bottom:2px;">${escapeHtml(title)}</strong>` : ''}
        <span>${escapeHtml(message)}</span>
      </div>
    `;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  function fmtCurrency(val) {
    const num = parseFloat(val) || 0;
    return `$${num.toFixed(2)}`;
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const diffSec = Math.floor((new Date() - new Date(dateStr)) / 1000);
    if (diffSec < 45) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let pollInterval = null;
  let wsAttempts = 0;

  function startCloudPolling() {
    if (pollInterval) return;
    const badge = document.getElementById('wsStatusBadge');
    const text = document.getElementById('wsStatusText');
    if (badge) badge.className = 'ws-status-badge';
    if (text) text.textContent = 'Cloud Sync';
    pollInterval = setInterval(fetchState, 3000);
  }

  // WebSocket Connection with Vercel Cloud Polling Fallback
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const badge = document.getElementById('wsStatusBadge');
    const text = document.getElementById('wsStatusText');

    try {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        wsAttempts = 0;
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        if (badge) badge.className = 'ws-status-badge';
        if (text) text.textContent = 'Live Sync';
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'INIT_STATE' || msg.type === 'STATE_UPDATE') {
            appState = msg.state;
            renderAll();

            if (msg.type === 'STATE_UPDATE') {
              handleBroadcast(msg);
            }
          }
        } catch (e) {
          console.error(e);
        }
      };

      socket.onerror = () => {
        wsAttempts++;
        if (wsAttempts >= 2) {
          startCloudPolling();
        }
      };

      socket.onclose = () => {
        wsAttempts++;
        if (wsAttempts >= 2) {
          startCloudPolling();
        } else {
          if (badge) badge.className = 'ws-status-badge disconnected';
          if (text) text.textContent = 'Connecting...';
          wsReconnectTimer = setTimeout(initWebSocket, 2000);
        }
      };
    } catch (e) {
      startCloudPolling();
    }
  }

  function handleBroadcast(msg) {
    const current = getCurrentUser();
    if (msg.actionType === 'CLAIMED_FOR_G2G') {
      playNotification('lock');
      if (msg.actor !== current.name) {
        showToast(msg.detail, 'warning', '🔒 Stock Claimed by Other Seller!');
      }
    } else if (msg.actionType === 'ITEM_SOLD') {
      playNotification('sold');
      showToast(msg.detail, 'success', '🎉 Sale Recorded!');
    } else if (msg.actionType === 'ITEM_CREATED') {
      showToast(msg.detail, 'info', '📦 New Inventory Deposited');
    }
  }

  async function fetchCatalog() {
    try {
      const res = await fetch('/api/catalog');
      const data = await res.json();
      if (data.success && data.catalog) {
        arcCatalog = data.catalog;
        updateCatalogPresets();
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchState() {
    try {
      const res = await fetch('/api/state');
      const data = await res.json();
      if (data.success && (data.state || data.data)) {
        appState = data.state || data.data;
        renderAll();
      }
    } catch (e) {
      console.error('Failed to fetch initial state:', e);
    }
  }

  function updateCatalogPresets() {
    const categorySelect = document.getElementById('addItemCategory');
    const presetSelect = document.getElementById('addItemCatalogPreset');
    const datalist = document.getElementById('catalogItemPresets');
    if (!categorySelect || !presetSelect) return;

    const selectedCategory = categorySelect.value;
    const items = arcCatalog[selectedCategory] || [];

    if (items.length > 0) {
      presetSelect.innerHTML = `<option value="">-- Choose item from catalog (${items.length} presets) --</option>` +
        items.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
    } else {
      presetSelect.innerHTML = `<option value="">-- No presets for ${escapeHtml(selectedCategory)} (type custom) --</option>`;
    }

    if (datalist) {
      datalist.innerHTML = items.map(item => `<option value="${escapeHtml(item)}">`).join('');
    }
  }

  // Current Session User
  function getCurrentUser() {
    const user = appState.users.find(u => u.id === currentUserId);
    if (!user && appState.users.length > 0) {
      currentUserId = appState.users[0].id;
      localStorage.setItem('g2g_session_user_id', currentUserId);
      return appState.users[0];
    }
    return user || { id: 'usr_seller_adem', name: 'Adem (Seller 1)', role: 'seller', balance: 0 };
  }

  function switchUser(userId) {
    currentUserId = userId;
    localStorage.setItem('g2g_session_user_id', userId);
    renderHeaderProfile();
    renderAll();
    showToast(`Session switched to ${getCurrentUser().name}`, 'info');
  }

  // Header & Quick Profile Switcher (Adem, Amine, Aymen, Hmayma)
  function renderHeaderProfile() {
    const user = getCurrentUser();

    // Top switcher pills
    const pillsContainer = document.getElementById('quickSwitchPills');
    if (pillsContainer) {
      pillsContainer.innerHTML = (appState.users || []).map(u => {
        const isActive = u.id === currentUserId;
        let prefix = u.role === 'seller' ? '🛒' : u.role === 'supplier' ? '📦' : '👑';
        let firstName = u.name.split(' ')[0];
        return `
          <button class="btn-switch-pill ${isActive ? 'active' : ''}" data-switch-user="${u.id}">
            ${prefix} ${firstName}
          </button>
        `;
      }).join('');
    }

    // Profile strip details
    const avatar = document.getElementById('activeUserAvatar');
    const name = document.getElementById('activeUserName');
    const badge = document.getElementById('activeUserRoleBadge');
    const sub = document.getElementById('activeUserSub');
    const balance = document.getElementById('activeUserBalance');

    if (avatar) {
      avatar.textContent = user.name.substring(0, 2).toUpperCase();
      avatar.style.background = user.avatarColor || '#00f0ff';
    }
    if (name) name.textContent = user.name;
    if (badge) {
      badge.className = `role-badge ${user.role}`;
      badge.textContent = user.role.toUpperCase();
    }
    if (sub) {
      if (user.role === 'seller') {
        sub.textContent = `G2G Store: ${user.g2gStoreName || 'Active'} • Custom Fee: ${user.commissionRate || 10}%`;
      } else if (user.role === 'supplier') {
        sub.textContent = `Stock Supplier • Direct Payout Account`;
      } else {
        sub.textContent = `Administrator • Full Control`;
      }
    }
    if (balance) balance.textContent = fmtCurrency(user.balance);

    // Fee Control Widget
    const feeWidget = document.getElementById('sellerFeeControls');
    const feeInput = document.getElementById('inputMyFeeRate');
    if (feeWidget && feeInput) {
      if (user.role === 'seller') {
        feeWidget.style.display = 'flex';
        feeInput.value = user.commissionRate || 10;
      } else {
        feeWidget.style.display = 'none';
      }
    }
  }

  // Mini KPI & Topic Badges
  function renderMetrics() {
    const items = appState.items || [];
    const available = items.filter(i => i.status === 'available');
    const locked = items.filter(i => i.status === 'locked_by_seller');
    const sold = items.filter(i => i.status === 'sold');

    const elAvail = document.getElementById('miniKpiAvailable');
    const elLocked = document.getElementById('miniKpiLocked');

    if (elAvail) elAvail.textContent = available.length;
    if (elLocked) elLocked.textContent = locked.length;

    // Badges in Topic Tabs
    const badgePool = document.getElementById('badgeTopicPool');
    const badgeOps = document.getElementById('badgeTopicOps');
    const badgeTeam = document.getElementById('badgeTopicTeam');
    const badgeHistory = document.getElementById('badgeTopicHistory');

    if (badgePool) badgePool.textContent = available.length;
    if (badgeOps) badgeOps.textContent = locked.length;
    if (badgeTeam) badgeTeam.textContent = (appState.users || []).length;
    if (badgeHistory) badgeHistory.textContent = sold.length;
  }

  let poolCategoryFilter = '';

  // TOPIC 1: AVAILABLE STOCK POOL
  function renderPoolTopic() {
    const container = document.getElementById('poolGrid');
    const emptyState = document.getElementById('poolEmptyState');
    if (!container) return;

    const currentUser = getCurrentUser();
    let availableItems = (appState.items || []).filter(i => i.status === 'available');

    // Filter by ARC Category
    if (poolCategoryFilter) {
      availableItems = availableItems.filter(i => i.category === poolCategoryFilter);
    }

    // Filter by search
    if (poolSearchQuery) {
      const q = poolSearchQuery.toLowerCase();
      availableItems = availableItems.filter(i =>
        (i.title || '').toLowerCase().includes(q) ||
        (i.category || '').toLowerCase().includes(q) ||
        (i.supplierName || '').toLowerCase().includes(q)
      );
    }

    if (availableItems.length === 0) {
      container.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    container.innerHTML = availableItems.map(item => {
      const sellerFeeRate = currentUser.role === 'seller' ? (currentUser.commissionRate || 10) : 10;
      const sellerCut = item.supplierTargetPrice * (sellerFeeRate / 100);
      const suggestedG2G = item.supplierTargetPrice + sellerCut;

      let actionButton = '';
      if (currentUser.role === 'seller' || currentUser.role === 'admin') {
        actionButton = `
          <button class="btn btn-primary" data-action="claim" data-item-id="${item.id}" style="width: 100%;">
            <span>⚡</span> Take to Sell on G2G
          </button>
        `;
      } else {
        actionButton = `
          <div style="font-size: 11px; color: var(--text-dim); text-align: center; padding: 6px;">
            Your Offer: ${fmtCurrency(item.supplierTargetPrice)} (Waiting for Adem or Amine to take)
          </div>
        `;
      }

      return `
        <div class="item-card">
          <div class="card-top">
            <span class="game-badge">ARC RAIDERS</span>
            <span class="category-badge">${escapeHtml(item.category)}</span>
          </div>

          <h3 class="item-title">${escapeHtml(item.title)}</h3>

          <div class="price-box">
            <div class="price-item">
              <div class="price-label">User Wants Payout</div>
              <div class="price-val" style="color: #fff;">${fmtCurrency(item.supplierTargetPrice)}</div>
            </div>
            <div class="price-item g2g-est">
              <div class="price-label">Sell on G2G at (${sellerFeeRate}% fee)</div>
              <div class="price-val">${fmtCurrency(suggestedG2G)}</div>
            </div>
          </div>

          <div class="card-meta-list">
            <div class="meta-row">
              <span>Offer by:</span>
              <span class="val">${escapeHtml(item.supplierName)}</span>
            </div>
            <div class="meta-row">
              <span>Your Seller Cut:</span>
              <span class="val" style="color: var(--accent-green); font-weight: 700;">+${fmtCurrency(sellerCut)}</span>
            </div>
            ${item.notes ? `
              <div class="meta-row" style="font-style: italic; color: var(--text-dim);">
                <span>Notes:</span>
                <span class="val">${escapeHtml(item.notes)}</span>
              </div>
            ` : ''}
          </div>

          <div class="card-actions">
            ${actionButton}
          </div>
        </div>
      `;
    }).join('');
  }

  // TOPIC 2: TAKEN ITEMS & ANTI-COLLISION
  function renderOperationsTopic() {
    const container = document.getElementById('operationsGrid');
    const emptyState = document.getElementById('opsEmptyState');
    if (!container) return;

    const currentUser = getCurrentUser();
    let opsItems = (appState.items || []).filter(i => i.status === 'locked_by_seller');

    if (opsFilter === 'mine') {
      opsItems = opsItems.filter(i => i.lockedBySellerId === currentUser.id);
    }

    if (opsItems.length === 0) {
      container.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    container.innerHTML = opsItems.map(item => {
      const isLockedByMe = item.lockedBySellerId === currentUser.id;
      const isLockedByOther = item.lockedBySellerId && item.lockedBySellerId !== currentUser.id;

      let cardClass = '';
      let bannerHtml = '';
      let actionsHtml = '';

      if (isLockedByOther) {
        cardClass = 'is-locked-other';
        bannerHtml = `
          <div class="collision-banner locked-other">
            <span style="font-size: 18px;">⚠️</span>
            <div>
              <strong>TAKEN BY ${escapeHtml(item.lockedBySellerName).toUpperCase()}!</strong><br>
              Currently selling on G2G. <strong>DO NOT SELL.</strong><br>
              <span style="font-size: 11px; opacity: 0.85;">If ${escapeHtml(item.lockedBySellerName)} closes their PC and unlocks it, it will become available for you.</span>
            </div>
          </div>
        `;
        actionsHtml = `
          <button class="btn btn-secondary btn-disabled" style="width: 100%;">
            <span>⛔</span> Taken by ${escapeHtml(item.lockedBySellerName)} (Blocked)
          </button>
        `;
      } else if (isLockedByMe) {
        cardClass = 'is-locked-me';
        bannerHtml = `
          <div class="collision-banner locked-me">
            <span style="font-size: 18px;">🔒</span>
            <div>
              <strong>YOU TOOK THIS ITEM (Selling on G2G)</strong><br>
              The other seller is blocked from selling this.<br>
              <span style="font-size: 11px; color: var(--accent-cyan);">Closing your PC? Click "Unlock (Closing PC)" below to hand over to the other seller.</span>
            </div>
          </div>
        `;
        actionsHtml = `
          <div class="action-row">
            <button class="btn btn-success" data-action="mark-sold-modal" data-item-id="${item.id}">
              <span>🎉</span> Mark Sold
            </button>
            <button class="btn btn-secondary" data-action="view-creds" data-item-id="${item.id}">
              <span>🔐</span> Delivery Info
            </button>
          </div>
          <button class="btn btn-danger btn-sm" data-action="release" data-item-id="${item.id}" style="margin-top: 6px;" title="Release lock because you are shutting down PC">
            <span>📴</span> Unlock (Closing PC / Let other seller take it)
          </button>
        `;
      }

      return `
        <div class="item-card ${cardClass}">
          <div class="card-top">
            <span class="game-badge">${escapeHtml(item.game)}</span>
            <span class="category-badge">${escapeHtml(item.category)}</span>
          </div>

          <h3 class="item-title">${escapeHtml(item.title)}</h3>

          ${bannerHtml}

          <div class="price-box">
            <div class="price-item">
              <div class="price-label">Supplier Payout</div>
              <div class="price-val">${fmtCurrency(item.supplierTargetPrice)}</div>
            </div>
            <div class="price-item g2g-est">
              <div class="price-label">G2G Price</div>
              <div class="price-val">${fmtCurrency(item.g2gListingPrice)}</div>
            </div>
          </div>

          <div class="card-meta-list">
            <div class="meta-row">
              <span>Deposited by:</span>
              <span class="val">${escapeHtml(item.supplierName)}</span>
            </div>
            <div class="meta-row">
              <span>Handling Seller:</span>
              <span class="val" style="color: var(--accent-cyan);">${escapeHtml(item.lockedBySellerName || 'None')}</span>
            </div>
            <div class="meta-row">
              <span>Locked At:</span>
              <span class="val">${formatRelativeTime(item.lockedAt)}</span>
            </div>
          </div>

          <div class="card-actions">
            ${actionsHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  // TOPIC 3: TEAM & BALANCES (Adem, Amine, Aymen, Hmayma)
  function renderTeamTopic() {
    const cardsContainer = document.getElementById('teamCardsGrid');
    const tableBody = document.getElementById('userTableBody');
    if (!cardsContainer || !tableBody) return;

    // Team Cards
    cardsContainer.innerHTML = (appState.users || []).map(u => {
      const isCurrent = u.id === currentUserId;
      let roleDesc = u.role === 'seller' ? 'G2G Store Seller' : u.role === 'supplier' ? 'Stock Supplier / User' : 'Admin';
      let feeInfo = u.role === 'seller' ? `<div style="font-size: 11px; color: var(--accent-cyan); margin-top: 4px;">Custom Fee: ${u.commissionRate || 10}%</div>` : '';
      return `
        <div class="team-card" ${isCurrent ? 'style="border-color: var(--accent-cyan);"' : ''}>
          <div class="team-card-header">
            <div class="team-card-avatar" style="background: ${u.avatarColor || '#00f0ff'};">
              ${u.name.substring(0, 2).toUpperCase()}
            </div>
            <div>
              <strong style="color: #fff; font-size: 15px;">${escapeHtml(u.name)}</strong>
              <div style="font-size: 12px; color: var(--text-dim);">${roleDesc}</div>
              ${feeInfo}
            </div>
          </div>
          <div>
            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Balance Earned</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
              <div class="team-card-balance">${fmtCurrency(u.balance)}</div>
              <button class="btn btn-outline-green btn-sm" data-action="withdraw-user" data-user-id="${u.id}" style="padding: 2px 8px; font-size: 11px;">
                💸 Withdraw
              </button>
            </div>
          </div>
          <div style="margin-top: auto; padding-top: 8px;">
            ${!isCurrent ? `
              <button class="btn btn-secondary btn-sm" data-switch-user="${u.id}" style="width: 100%;">
                Switch to this User
              </button>
            ` : `
              <div style="font-size: 11px; color: var(--accent-cyan); font-weight: 700; text-align: center;">
                ● ACTIVE PROFILE
              </div>
            `}
          </div>
        </div>
      `;
    }).join('');

    // Detailed Table
    tableBody.innerHTML = (appState.users || []).map(u => {
      const isCurrent = u.id === currentUserId;
      return `
        <tr>
          <td>
            <strong style="color: #fff;">${escapeHtml(u.name)}</strong>
            <div style="font-size: 11px; color: var(--text-dim);">${escapeHtml(u.email || '')}</div>
          </td>
          <td><span class="role-badge ${u.role}">${u.role.toUpperCase()}</span></td>
          <td>${escapeHtml(u.g2gStoreName || '—')}</td>
          <td>${u.role === 'seller' ? `${u.commissionRate || 10}%` : '—'}</td>
          <td style="color: var(--accent-green); font-weight: 700;">${fmtCurrency(u.balance)}</td>
          <td>
            <div style="display: flex; gap: 6px; align-items: center;">
              <button class="btn btn-outline-green btn-sm" data-action="withdraw-user" data-user-id="${u.id}" style="padding: 3px 8px; font-size: 11px;">
                💸 Withdraw
              </button>
              ${!isCurrent ? `
                <button class="btn btn-secondary btn-sm" data-switch-user="${u.id}" style="padding: 3px 8px; font-size: 11px;">
                  Select
                </button>
              ` : '<span style="color: var(--accent-cyan); font-weight: 700; font-size: 12px; margin-left: 4px;">Active</span>'}
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Render Withdrawals Table
    const withdrawalsTbody = document.getElementById('withdrawalsTableBody');
    if (withdrawalsTbody) {
      const withdrawals = appState.withdrawals || [];
      if (withdrawals.length === 0) {
        withdrawalsTbody.innerHTML = `
          <tr>
            <td colspan="7" style="text-align: center; color: var(--text-dim); padding: 18px; font-size: 13px;">
              No withdrawals requested yet. Click "💸 Withdraw" to take out your earnings.
            </td>
          </tr>
        `;
      } else {
        withdrawalsTbody.innerHTML = withdrawals.map(w => `
          <tr>
            <td style="font-size: 12px; color: var(--text-muted);">${new Date(w.createdAt).toLocaleString()}</td>
            <td><strong style="color: #fff;">${escapeHtml(w.userName)}</strong></td>
            <td style="font-weight: 700; color: #fff;">${fmtCurrency(w.amount)}</td>
            <td style="color: var(--accent-red); font-size: 12px;">
              -${fmtCurrency(w.totalFee)} <span style="font-size: 10px; color: var(--text-dim);">($1.00 + 5%)</span>
            </td>
            <td style="font-weight: 800; color: var(--accent-green); font-size: 14px;">${fmtCurrency(w.netPayout)}</td>
            <td>
              <span style="font-size: 12px; color: #fff;">${escapeHtml(w.method)}</span>
              <div style="font-size: 11px; color: var(--text-dim);">${escapeHtml(w.destination)}</div>
            </td>
            <td><span class="status-badge live" style="font-size: 11px;">COMPLETED</span></td>
          </tr>
        `).join('');
      }
    }
  }

  // TOPIC 4: SALES & HISTORY
  function renderHistoryTopic() {
    const soldGrid = document.getElementById('soldGrid');
    const soldEmpty = document.getElementById('soldEmptyState');
    const feedList = document.getElementById('feedList');

    // Sold Items
    const soldItems = (appState.items || []).filter(i => i.status === 'sold');
    if (soldGrid) {
      if (soldItems.length === 0) {
        soldGrid.innerHTML = '';
        if (soldEmpty) soldEmpty.style.display = 'block';
      } else {
        if (soldEmpty) soldEmpty.style.display = 'none';
        soldGrid.innerHTML = soldItems.map(item => `
          <div class="item-card" style="border-color: rgba(0,245,155,0.3);">
            <div class="card-top">
              <span class="game-badge">${escapeHtml(item.game)}</span>
              <span class="category-badge" style="background: rgba(0,245,155,0.1); color: var(--accent-green);">Sold</span>
            </div>
            <h3 class="item-title">${escapeHtml(item.title)}</h3>
            <div class="price-box">
              <div class="price-item">
                <div class="price-label">Supplier Paid</div>
                <div class="price-val">${fmtCurrency(item.supplierTargetPrice)}</div>
              </div>
              <div class="price-item profit">
                <div class="price-label">Final G2G Sold</div>
                <div class="price-val">${fmtCurrency(item.soldPrice)}</div>
              </div>
            </div>
            <div class="card-meta-list">
              <div class="meta-row">
                <span>Sold By:</span>
                <span class="val">${escapeHtml(item.lockedBySellerName)}</span>
              </div>
              <div class="meta-row">
                <span>G2G Order:</span>
                <span class="val">${escapeHtml(item.g2gOrderId || '—')}</span>
              </div>
              <div class="meta-row">
                <span>Date:</span>
                <span class="val">${formatRelativeTime(item.soldAt)}</span>
              </div>
            </div>
          </div>
        `).join('');
      }
    }

    // Activity Logs
    if (feedList) {
      const logs = appState.activityLogs || [];
      if (logs.length === 0) {
        feedList.innerHTML = '<div style="color: var(--text-dim); font-size: 12px;">No activity recorded</div>';
      } else {
        feedList.innerHTML = logs.map(l => `
          <div class="feed-item">
            <div class="feed-icon">⚡</div>
            <div style="flex:1;">
              <div style="color:#fff;">${escapeHtml(l.message)}</div>
              <div class="feed-time">${formatRelativeTime(l.timestamp)} • by ${escapeHtml(l.actorName || 'User')}</div>
            </div>
          </div>
        `).join('');
      }
    }
  }

  // Master Render
  function renderAll() {
    renderHeaderProfile();
    renderMetrics();
    renderPoolTopic();
    renderOperationsTopic();
    renderTeamTopic();
    renderHistoryTopic();
    updateModalSuppliers();
  }

  function updateModalSuppliers() {
    const select = document.getElementById('addItemSupplier');
    if (!select) return;
    const users = (appState.users || []).filter(u => u.role === 'supplier' || u.role === 'seller');
    const curr = select.value;
    select.innerHTML = users.map(u => `
      <option value="${u.id}" ${curr === u.id ? 'selected' : ''}>
        ${u.name} (${u.role.toUpperCase()})
      </option>
    `).join('');
  }

  // API Calls
  async function claimItem(itemId) {
    const user = getCurrentUser();
    try {
      const res = await fetch(`/api/items/${itemId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerId: user.id, sellerName: user.name })
      });
      const data = await res.json();
      if (!data.success) {
        showToast(data.error || 'Failed to claim', 'warning', '⚠️ Conflict');
        return;
      }
      showToast('Item locked! Switch to G2G Operations tab to publish it.', 'success');
      playNotification('lock');
    } catch (e) {
      console.error(e);
    }
  }

  async function releaseItem(itemId) {
    const user = getCurrentUser();
    try {
      const res = await fetch(`/api/items/${itemId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerId: user.id, reason: 'Released back to pool' })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Item released back to stock pool.', 'info');
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Modal helpers
  function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
  }
  function closeModal(el) {
    if (el) el.classList.remove('active');
  }

  // Event Listeners Setup
  function setupEvents() {
    // Topic Navigation
    document.querySelectorAll('.topic-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.topic-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.topic-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        activeTopic = tab.dataset.topic;

        const target = document.getElementById(`topic${capitalize(activeTopic)}Section`);
        if (target) target.classList.add('active');
      });
    });

    // Ops filter buttons
    document.querySelectorAll('[data-ops-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-ops-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        opsFilter = btn.dataset.opsFilter;
        renderOperationsTopic();
      });
    });

    // Search and game filters in pool
    const poolSearch = document.getElementById('poolSearchInput');
    if (poolSearch) {
      poolSearch.addEventListener('input', (e) => {
        poolSearchQuery = e.target.value.trim();
        renderPoolTopic();
      });
    }

    const poolCategory = document.getElementById('poolCategoryFilter');
    if (poolCategory) {
      poolCategory.addEventListener('change', (e) => {
        poolCategoryFilter = e.target.value;
        renderPoolTopic();
      });
    }

    // Direct click listeners
    document.addEventListener('click', (e) => {
      // Profile switcher pills or buttons
      const switchBtn = e.target.closest('[data-switch-user]');
      if (switchBtn) {
        switchUser(switchBtn.dataset.switchUser);
        return;
      }

      // Claim action
      const claimBtn = e.target.closest('button[data-action="claim"]');
      if (claimBtn) {
        claimItem(claimBtn.dataset.itemId);
        return;
      }

      // Release action (Closing PC / Passing to other seller)
      const releaseBtn = e.target.closest('button[data-action="release"]');
      if (releaseBtn) {
        if (confirm('Unlock this item because you are closing your PC? The other seller will be able to take it immediately.')) {
          releaseItem(releaseBtn.dataset.itemId);
        }
        return;
      }

      // Withdraw user action
      const withdrawUserBtn = e.target.closest('button[data-action="withdraw-user"]');
      if (withdrawUserBtn) {
        openWithdrawModal(withdrawUserBtn.dataset.userId);
        return;
      }

      // Mark sold modal
      const soldBtn = e.target.closest('button[data-action="mark-sold-modal"]');
      if (soldBtn) {
        const item = appState.items.find(i => i.id === soldBtn.dataset.itemId);
        if (item) {
          const user = getCurrentUser();
          const feeRate = user.role === 'seller' ? (user.commissionRate || 10) : 10;
          const initialFinalPrice = item.supplierTargetPrice * (1 + feeRate / 100);
          const initialFeeCut = initialFinalPrice - item.supplierTargetPrice;

          document.getElementById('markSoldItemId').value = item.id;
          document.getElementById('markSoldItemTitle').textContent = `ARC Raiders: ${item.title}`;
          document.getElementById('markSoldSupplierPayout').value = fmtCurrency(item.supplierTargetPrice);
          document.getElementById('markSoldFinalPrice').value = initialFinalPrice.toFixed(2);
          document.getElementById('markSoldOrderId').value = `G2G-ORD-${Math.floor(1000000 + Math.random() * 9000000)}`;
          document.getElementById('markSoldProfitPreview').innerHTML = `Your Seller Fee Cut (${feeRate}%): <strong>${fmtCurrency(initialFeeCut)}</strong> will be credited to your balance.`;
          openModal('modalMarkSold');
        }
        return;
      }

      // View creds modal
      const credsBtn = e.target.closest('button[data-action="view-creds"]');
      if (credsBtn) {
        const item = appState.items.find(i => i.id === credsBtn.dataset.itemId);
        if (item) {
          document.getElementById('credItemTitle').textContent = `${item.game}: ${item.title}`;
          document.getElementById('credContentBox').textContent = item.secretCredentials || 'No credentials specified';
          openModal('modalViewCredentials');
        }
        return;
      }

      // Modals close
      if (e.target.closest('[data-close-modal]') || e.target.classList.contains('modal-overlay')) {
        document.querySelectorAll('.modal-overlay').forEach(m => closeModal(m));
      }
    });

    // Open Add Item Modal buttons
    const btnOpenAdd = document.getElementById('btnOpenAddItem');
    const btnDepositDirect = document.getElementById('btnDepositItemDirect');
    if (btnOpenAdd) btnOpenAdd.addEventListener('click', () => openModal('modalAddItem'));
    if (btnDepositDirect) btnDepositDirect.addEventListener('click', () => openModal('modalAddItem'));

    // Open Add User Modal
    const btnOpenAddUser = document.getElementById('btnOpenAddUser');
    if (btnOpenAddUser) btnOpenAddUser.addEventListener('click', () => openModal('modalAddUser'));

    // Save My Fee button (each seller sets their own fee)
    const btnSaveMyFee = document.getElementById('btnSaveMyFee');
    if (btnSaveMyFee) {
      btnSaveMyFee.addEventListener('click', async () => {
        const user = getCurrentUser();
        if (user.role !== 'seller') {
          showToast('Only sellers can set fees.', 'warning');
          return;
        }
        const newRate = parseFloat(document.getElementById('inputMyFeeRate').value);
        if (isNaN(newRate) || newRate < 0 || newRate > 100) {
          showToast('Fee must be between 0 and 100%.', 'warning');
          return;
        }
        try {
          const res = await fetch(`/api/users/${user.id}/fee`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commissionRate: newRate })
          });
          const data = await res.json();
          if (data.success) {
            showToast(`Your fee updated to ${newRate}%! Cards will now calculate with your new rate.`, 'success');
          } else {
            showToast(data.error || 'Failed to update fee', 'warning');
          }
        } catch (e) {
          console.error(e);
          showToast('Network error updating fee', 'warning');
        }
      });
    }

    // Live profit preview in Mark Sold modal
    const markSoldFinalPriceInput = document.getElementById('markSoldFinalPrice');
    if (markSoldFinalPriceInput) {
      markSoldFinalPriceInput.addEventListener('input', () => {
        const supplierPayoutStr = document.getElementById('markSoldSupplierPayout').value.replace('$', '');
        const supplierPayout = parseFloat(supplierPayoutStr) || 0;
        const finalPrice = parseFloat(markSoldFinalPriceInput.value) || 0;
        const profit = finalPrice - supplierPayout;
        const profitPreview = document.getElementById('markSoldProfitPreview');
        if (profitPreview) {
          if (profit >= 0) {
            profitPreview.style.borderColor = 'rgba(0, 245, 155, 0.25)';
            profitPreview.style.background = 'rgba(0, 245, 155, 0.1)';
            profitPreview.style.color = 'var(--accent-green)';
            profitPreview.innerHTML = `Your Seller Profit: <strong>${fmtCurrency(profit)}</strong> will be credited to your balance.`;
          } else {
            profitPreview.style.borderColor = 'rgba(255, 51, 102, 0.25)';
            profitPreview.style.background = 'rgba(255, 51, 102, 0.1)';
            profitPreview.style.color = 'var(--accent-red)';
            profitPreview.innerHTML = `⚠️ Loss: <strong>${fmtCurrency(profit)}</strong> — selling below supplier payout!`;
          }
        }
      });
    }

    // Form Add Item (User makes an offer)
    const formAddItem = document.getElementById('formAddItem');
    if (formAddItem) {
      formAddItem.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const body = {
          game: 'ARC Raiders',
          category: document.getElementById('addItemCategory').value,
          supplierId: document.getElementById('addItemSupplier').value,
          title: document.getElementById('addItemTitle').value.trim(),
          supplierTargetPrice: parseFloat(document.getElementById('addItemSupplierPrice').value),
          secretCredentials: document.getElementById('addItemCredentials').value.trim(),
          notes: document.getElementById('addItemNotes').value.trim(),
          createdByName: user.name
        };

        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success) {
          closeModal(document.getElementById('modalAddItem'));
          formAddItem.reset();
          showToast('Offer posted! Adem or Amine can now take it to sell on G2G.', 'success');
        }
      });
    }

    // Form Add User
    const formAddUser = document.getElementById('formAddUser');
    if (formAddUser) {
      formAddUser.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
          name: document.getElementById('addUserName').value.trim(),
          role: document.getElementById('addUserRole').value,
          email: document.getElementById('addUserEmail').value.trim(),
          g2gStoreName: document.getElementById('addUserG2gStore').value.trim(),
          commissionRate: parseFloat(document.getElementById('addUserCommission').value) || 10
        };

        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success) {
          closeModal(document.getElementById('modalAddUser'));
          formAddUser.reset();
          showToast(`Added ${data.user.name} to the team!`, 'success');
        }
      });
    }

    // Form Mark Sold
    const formMarkSold = document.getElementById('formMarkSold');
    if (formMarkSold) {
      formMarkSold.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const itemId = document.getElementById('markSoldItemId').value;
        const g2gOrderId = document.getElementById('markSoldOrderId').value.trim();
        const finalPrice = parseFloat(document.getElementById('markSoldFinalPrice').value);

        const res = await fetch(`/api/items/${itemId}/mark-sold`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sellerId: user.id, g2gOrderId, finalPrice })
        });
        const data = await res.json();
        if (data.success) {
          closeModal(document.getElementById('modalMarkSold'));
          showToast(`Sale recorded! Credited ${fmtCurrency(data.profit)} to seller balance.`, 'success');
        }
      });
    }

    // Withdraw Modal & Calculation Logic
    function openWithdrawModal(targetUserId) {
      const user = targetUserId ? (appState.users.find(u => u.id === targetUserId) || getCurrentUser()) : getCurrentUser();
      const userNameEl = document.getElementById('withdrawUserName');
      const balanceEl = document.getElementById('withdrawAvailableBalance');
      const amountInput = document.getElementById('withdrawAmount');
      const destInput = document.getElementById('withdrawDestination');
      const alertBox = document.getElementById('withdrawAlertBox');

      if (userNameEl) userNameEl.textContent = user.name;
      if (balanceEl) balanceEl.textContent = fmtCurrency(user.balance);
      if (amountInput) {
        amountInput.value = '';
        amountInput.max = user.balance || 0;
      }
      if (destInput) destInput.value = '';
      if (alertBox) alertBox.style.display = 'none';

      updateWithdrawPreview(user);
      openModal('modalWithdraw');
    }

    function updateWithdrawPreview(optUser) {
      const user = optUser || getCurrentUser();
      const input = document.getElementById('withdrawAmount');
      const amount = parseFloat(input ? input.value : 0) || 0;
      const btnSubmit = document.getElementById('btnSubmitWithdraw');
      const alertBox = document.getElementById('withdrawAlertBox');

      const grossEl = document.getElementById('previewWithdrawGross');
      const fixedEl = document.getElementById('previewWithdrawFixed');
      const percentEl = document.getElementById('previewWithdrawPercent');
      const totalFeeEl = document.getElementById('previewWithdrawTotalFee');
      const netEl = document.getElementById('previewWithdrawNet');

      // Calculation: $1.00 flat + 5% of withdrawn balance
      const fixedFee = 1.00;
      const percentFee = Math.round((amount * 0.05) * 100) / 100;
      const totalFee = Math.round((fixedFee + percentFee) * 100) / 100;
      const netPayout = Math.max(0, Math.round((amount - totalFee) * 100) / 100);

      if (grossEl) grossEl.textContent = fmtCurrency(amount);
      if (fixedEl) fixedEl.textContent = `-$1.00`;
      if (percentEl) percentEl.textContent = `-${fmtCurrency(percentFee)}`;
      if (totalFeeEl) totalFeeEl.textContent = `-${fmtCurrency(totalFee)}`;
      if (netEl) netEl.textContent = fmtCurrency(netPayout);

      if (amount <= 0) {
        if (alertBox) alertBox.style.display = 'none';
        if (btnSubmit) btnSubmit.disabled = true;
        return;
      }

      if (amount <= 1.00) {
        if (alertBox) {
          alertBox.style.display = 'block';
          alertBox.style.background = 'rgba(255, 183, 3, 0.15)';
          alertBox.style.border = '1px solid rgba(255, 183, 3, 0.3)';
          alertBox.style.color = 'var(--accent-gold)';
          alertBox.textContent = '⚠️ Withdrawal amount must exceed the $1.00 flat fee (minimum $1.01).';
        }
        if (btnSubmit) btnSubmit.disabled = true;
        return;
      }

      if (amount > (user.balance || 0)) {
        if (alertBox) {
          alertBox.style.display = 'block';
          alertBox.style.background = 'rgba(255, 51, 102, 0.15)';
          alertBox.style.border = '1px solid rgba(255, 51, 102, 0.3)';
          alertBox.style.color = 'var(--accent-red)';
          alertBox.textContent = `⚠️ Amount exceeds available balance of ${fmtCurrency(user.balance)}.`;
        }
        if (btnSubmit) btnSubmit.disabled = true;
        return;
      }

      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(0, 245, 155, 0.1)';
        alertBox.style.border = '1px solid rgba(0, 245, 155, 0.25)';
        alertBox.style.color = 'var(--accent-green)';
        alertBox.innerHTML = `✅ Net payout of <strong>${fmtCurrency(netPayout)}</strong> will be transferred.`;
      }
      if (btnSubmit) btnSubmit.disabled = false;
    }

    // Buttons to open withdraw modal
    const btnOpenWithdraw = document.getElementById('btnOpenWithdraw');
    if (btnOpenWithdraw) btnOpenWithdraw.addEventListener('click', () => openWithdrawModal());

    const btnOpenWithdrawSec = document.getElementById('btnOpenWithdrawSection');
    if (btnOpenWithdrawSec) btnOpenWithdrawSec.addEventListener('click', () => openWithdrawModal());

    const withdrawAmountInput = document.getElementById('withdrawAmount');
    if (withdrawAmountInput) {
      withdrawAmountInput.addEventListener('input', () => updateWithdrawPreview());
    }

    const btnWithdrawMax = document.getElementById('btnWithdrawMax');
    if (btnWithdrawMax) {
      btnWithdrawMax.addEventListener('click', () => {
        const user = getCurrentUser();
        const input = document.getElementById('withdrawAmount');
        if (input) {
          input.value = (user.balance || 0).toFixed(2);
          updateWithdrawPreview(user);
        }
      });
    }

    const formWithdraw = document.getElementById('formWithdraw');
    if (formWithdraw) {
      formWithdraw.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const amount = parseFloat(document.getElementById('withdrawAmount').value);
        const method = document.getElementById('withdrawMethod').value;
        const destination = document.getElementById('withdrawDestination').value.trim();

        if (isNaN(amount) || amount <= 1.00) {
          showToast('Amount must exceed $1.00 flat fee.', 'warning');
          return;
        }

        if (amount > (user.balance || 0)) {
          showToast(`Insufficient balance: ${fmtCurrency(user.balance)} available.`, 'warning');
          return;
        }

        try {
          const res = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: user.id,
              amount,
              method,
              destination
            })
          });
          const data = await res.json();
          if (data.success) {
            closeModal(document.getElementById('modalWithdraw'));
            playChime();
            showToast(`💸 Withdrawal of ${fmtCurrency(data.withdrawal.amount)} submitted! Net Received: ${fmtCurrency(data.withdrawal.netPayout)} (Fee: ${fmtCurrency(data.withdrawal.totalFee)})`, 'success');
          } else {
            showToast(data.error || 'Withdrawal failed', 'warning');
          }
        } catch (err) {
          console.error(err);
          showToast('Network error processing withdrawal', 'warning');
        }
      });
    }

    // Copy Creds
    const btnCopy = document.getElementById('btnCopyCredentials');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        const text = document.getElementById('credContentBox').textContent;
        navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!', 'info'));
      });
    }

    // ARC Catalog Preset selector change
    const categorySelect = document.getElementById('addItemCategory');
    if (categorySelect) {
      categorySelect.addEventListener('change', updateCatalogPresets);
    }
    const presetSelect = document.getElementById('addItemCatalogPreset');
    const titleInput = document.getElementById('addItemTitle');
    if (presetSelect && titleInput) {
      presetSelect.addEventListener('change', () => {
        if (presetSelect.value) {
          titleInput.value = presetSelect.value;
        }
      });
    }
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Boot
  async function boot() {
    setupEvents();
    await fetchCatalog();
    await fetchState();
    initWebSocket();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
