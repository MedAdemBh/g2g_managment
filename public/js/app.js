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
  let currentProofBase64 = '';

  function compressImage(file, maxWidth = 1280, maxHeight = 1280, quality = 0.8) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(e.target.result);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }

  function setProofImage(base64Data) {
    currentProofBase64 = base64Data || '';
    const placeholder = document.getElementById('proofPlaceholder');
    const previewContainer = document.getElementById('proofPreviewContainer');
    const previewImg = document.getElementById('proofPreviewImg');
    const fileInput = document.getElementById('markSoldProofFile');
    if (base64Data) {
      if (previewImg) previewImg.src = base64Data;
      if (placeholder) placeholder.style.display = 'none';
      if (previewContainer) previewContainer.style.display = 'block';
    } else {
      if (previewImg) previewImg.src = '';
      if (placeholder) placeholder.style.display = 'block';
      if (previewContainer) previewContainer.style.display = 'none';
      if (fileInput) fileInput.value = '';
    }
  }

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
    if (num === 0) return '$0.00';
    if (num < 0.01) return `$${num.toFixed(4)}`;
    if (num < 1 && (num * 100) % 1 !== 0) return `$${num.toFixed(3)}`;
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
    if (categorySelect && presetSelect) {
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
    populateRadarPresets();
  }

  function populateRadarPresets() {
    const radarCat = document.getElementById('radarCategorySelect');
    const radarPreset = document.getElementById('radarProductPreset');
    if (!radarPreset) return;

    const cat = radarCat ? radarCat.value : '';
    let items = [];
    if (cat && arcCatalog[cat]) {
      items = arcCatalog[cat];
    } else {
      items = Array.from(new Set(Object.values(arcCatalog).flat())).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
      );
    }

    if (items.length > 0) {
      radarPreset.innerHTML = `<option value="">-- Choose from ${items.length} ARC Raiders items --</option>` +
        items.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
    } else {
      radarPreset.innerHTML = '<option value="">-- No presets available --</option>';
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
        sub.textContent = `G2G Store: ${user.g2gStoreName || 'Active'}`;
      } else {
        sub.textContent = `Stock Supplier • Direct Payout Account`;
      }
    }
    if (balance) balance.textContent = fmtCurrency(user.balance);

    // Active User Seller Breakdown (Adem, Amine, etc.)
    const sellerBreakdownEl = document.getElementById('activeUserSellerBreakdown');
    if (sellerBreakdownEl) {
      if (user.role === 'supplier') {
        const sellers = (appState.users || []).filter(u => u.role === 'seller');
        const breakdownHtml = sellers.map(s => {
          const sBal = (user.sellerBalances && user.sellerBalances[s.id]) || 0;
          const shortName = s.name.split(' ')[0];
          return `<span style="display: inline-block; background: rgba(0,240,255,0.06); padding: 1px 6px; border-radius: 4px; border: 1px solid rgba(0,240,255,0.15); margin-right: 4px; margin-top: 2px;">${shortName}: <strong style="color: ${sBal > 0 ? 'var(--accent-green)' : 'var(--text-dim)'};">${fmtCurrency(sBal)}</strong></span>`;
        }).join('');
        sellerBreakdownEl.innerHTML = `<div style="color: var(--text-dim); font-size: 10px; margin-bottom: 2px;">From Sellers:</div>${breakdownHtml}`;
        sellerBreakdownEl.style.display = 'block';
      } else {
        sellerBreakdownEl.style.display = 'none';
      }
    }

    // Fee Control Widget (hidden - no 10% fee added)
    const feeWidget = document.getElementById('sellerFeeControls');
    if (feeWidget) {
      feeWidget.style.display = 'none';
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
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const unitPrice = item.supplierTargetPrice || 0;
      const totalPrice = unitPrice * qty;

      const isMyDeposit = item.supplierId === currentUser.id;

      const depositorButtonsHtml = (isMyDeposit && item.status === 'available') ? `
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <button class="btn btn-secondary btn-sm" data-action="edit-qty-modal" data-item-id="${item.id}" style="flex: 1; font-size: 11px; padding: 4px 6px;">
            <span>📦</span> Edit Stock (${qty})
          </button>
          <button class="btn btn-danger btn-sm" data-action="delete-item" data-item-id="${item.id}" style="flex: 1; font-size: 11px; padding: 4px 6px;">
            <span>🗑️</span> Remove
          </button>
        </div>
      ` : '';

      let actionButton = '';
      if (currentUser.role === 'seller') {
        actionButton = `
          <button class="btn btn-primary" data-action="claim-modal" data-item-id="${item.id}" style="width: 100%;">
            <span>⚡</span> Set Price & Take to Sell
          </button>
          ${depositorButtonsHtml}
        `;
      } else {
        // Supplier view: show deposit info + edit/delete if it's their own
        actionButton = `
          <div style="font-size: 11px; color: var(--text-dim); text-align: center; padding: 6px;">
            ${isMyDeposit ? `Your Deposit: ${qty} pcs (Waiting for seller to take & set price)` : `Deposited by: ${escapeHtml(item.supplierName)}`}
          </div>
          ${depositorButtonsHtml}
        `;
      }

      const priceHtml = unitPrice > 0 ? `
        <div class="price-box">
          <div class="price-item">
            <div class="price-label">${qty > 1 ? 'Price (Per Unit)' : 'Item Price'}</div>
            <div class="price-val" style="color: #fff;">${fmtCurrency(unitPrice)}</div>
          </div>
          <div class="price-item g2g-est">
            <div class="price-label">${qty > 1 ? `Total (${qty} Units)` : 'G2G Listing Price'}</div>
            <div class="price-val" style="color: var(--accent-cyan);">${fmtCurrency(totalPrice)}</div>
          </div>
        </div>
      ` : `
        <div class="price-box" style="background: rgba(255, 183, 3, 0.08); border: 1px dashed rgba(255, 183, 3, 0.3);">
          <div class="price-item" style="flex: 2;">
            <div class="price-label">G2G Price</div>
            <div class="price-val" style="color: var(--accent-gold); font-size: 13px; font-weight: 700;">⏳ To be priced by seller</div>
          </div>
        </div>
      `;

      return `
        <div class="item-card">
          <div class="card-top">
            <span class="game-badge">ARC RAIDERS</span>
            <span class="category-badge">${escapeHtml(item.category)}</span>
            <span class="category-badge" style="background: rgba(0,240,255,0.15); color: var(--accent-cyan); font-weight: 700;">Qty: ${qty}x</span>
          </div>

          <h3 class="item-title">${escapeHtml(item.title)}</h3>

          ${priceHtml}

          <div class="card-meta-list">
            <div class="meta-row">
              <span>Deposited by:</span>
              <span class="val">${escapeHtml(item.supplierName)}</span>
            </div>
            <div class="meta-row">
              <span>Quantity:</span>
              <span class="val" style="color: var(--accent-gold); font-weight: 700;">${qty} pcs</span>
            </div>
          </div>

          <div class="card-actions">
            ${actionButton}
            <button class="btn btn-outline-cyan btn-sm" data-action="radar-check" data-query="${escapeHtml(item.title)}" style="width: 100%; margin-top: 6px; font-size: 11px;">
              <span>🎯</span> Check G2G 5 Lowest
            </button>
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
              <span style="font-size: 11px; opacity: 0.85;">If ${escapeHtml(item.lockedBySellerName)} leaves it for another seller, it will become available for you.</span>
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
              <span style="font-size: 11px; color: var(--accent-cyan);">Want to pass this to another seller? Click "Leave for Another Seller" below.</span>
            </div>
          </div>
        `;
        actionsHtml = `
          <div class="action-row">
            <button class="btn btn-outline-cyan btn-sm" data-action="edit-price-modal" data-item-id="${item.id}" style="flex: 1;">
              <span>✏️</span> Set/Edit Price
            </button>
            <button class="btn btn-success btn-sm" data-action="mark-sold-modal" data-item-id="${item.id}" style="flex: 1;">
              <span>🎉</span> Mark Sold
            </button>
          </div>
          <button class="btn btn-danger btn-sm" data-action="release" data-item-id="${item.id}" style="margin-top: 6px;" title="Leave this item for another seller">
            <span>🔓</span> Leave for Another Seller
          </button>
        `;
      }

      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const unitPrice = item.supplierTargetPrice || 0;
      const totalPrice = unitPrice * qty;

      const priceHtml = unitPrice > 0 ? `
        <div class="price-box">
          <div class="price-item">
            <div class="price-label">${qty > 1 ? 'Unit Price' : 'Price'}</div>
            <div class="price-val">${fmtCurrency(unitPrice)}</div>
          </div>
          <div class="price-item g2g-est">
            <div class="price-label">${qty > 1 ? `Total (${qty} Units)` : 'G2G Price'}</div>
            <div class="price-val" style="color: var(--accent-cyan);">${fmtCurrency(totalPrice)}</div>
          </div>
        </div>
      ` : `
        <div class="price-box" style="background: rgba(255, 183, 3, 0.08); border: 1px dashed rgba(255, 183, 3, 0.3);">
          <div class="price-item" style="flex: 2;">
            <div class="price-label">G2G Price</div>
            <div class="price-val" style="color: var(--accent-gold); font-size: 13px; font-weight: 700;">Click "Set/Edit Price" below</div>
          </div>
        </div>
      `;

      return `
        <div class="item-card ${cardClass}">
          <div class="card-top">
            <span class="game-badge">${escapeHtml(item.game)}</span>
            <span class="category-badge">${escapeHtml(item.category)}</span>
            <span class="category-badge" style="background: rgba(0,240,255,0.15); color: var(--accent-cyan); font-weight: 700;">Qty: ${qty}x</span>
          </div>

          <h3 class="item-title">${escapeHtml(item.title)}</h3>

          ${bannerHtml}

          ${priceHtml}

          <div class="card-meta-list">
            <div class="meta-row">
              <span>Deposited by:</span>
              <span class="val">${escapeHtml(item.supplierName)}</span>
            </div>
            <div class="meta-row">
              <span>Quantity:</span>
              <span class="val" style="color: var(--accent-gold); font-weight: 700;">${qty} pcs</span>
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
            <button class="btn btn-outline-cyan btn-sm" data-action="radar-check" data-query="${escapeHtml(item.title)}" style="width: 100%; margin-top: 6px; font-size: 11px;">
              <span>🎯</span> Check G2G 5 Lowest
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Helper: render breakdown of balances owed by each seller for a supplier
  function renderSellerBreakdownHtml(u, inline = false) {
    if (u.role !== 'supplier') return '';
    const sellers = (appState.users || []).filter(s => s.role === 'seller');
    if (inline) {
      const parts = sellers.map(s => {
        const amt = (u.sellerBalances && u.sellerBalances[s.id]) || 0;
        const shortName = s.name.split(' ')[0];
        return `<span style="white-space: nowrap;">${shortName}: <strong style="color: ${amt > 0 ? 'var(--accent-green)' : 'var(--text-dim)'};">${fmtCurrency(amt)}</strong></span>`;
      });
      return `<div style="font-size: 11px; color: var(--text-dim); margin-top: 3px;">${parts.join(' • ')}</div>`;
    }
    const lines = sellers.map(s => {
      const amt = (u.sellerBalances && u.sellerBalances[s.id]) || 0;
      const shortName = s.name.split(' ')[0];
      return `
        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 2px;">
          <span style="color: #fff;">🛒 ${shortName}:</span>
          <strong style="color: ${amt > 0 ? 'var(--accent-green)' : 'var(--text-dim)'};">${fmtCurrency(amt)}</strong>
        </div>
      `;
    }).join('');
    return `
      <div style="margin-top: 6px; padding: 6px 8px; background: rgba(0, 240, 255, 0.04); border-radius: 4px; border: 1px solid rgba(0, 240, 255, 0.12);">
        <div style="color: var(--text-dim); font-size: 10px; text-transform: uppercase; margin-bottom: 3px; font-weight: 700;">Balance by Seller:</div>
        ${lines}
      </div>
    `;
  }

  // TOPIC 3: TEAM & BALANCES (Adem, Amine, Aymen, Hmayma)
  function renderTeamTopic() {
    const cardsContainer = document.getElementById('teamCardsGrid');
    const tableBody = document.getElementById('userTableBody');
    if (!cardsContainer || !tableBody) return;

    // Team Cards
    cardsContainer.innerHTML = (appState.users || []).map(u => {
      const isCurrent = u.id === currentUserId;
      let roleDesc = u.role === 'seller' ? 'G2G Store Seller' : 'Stock Supplier / User';
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
            ${renderSellerBreakdownHtml(u, false)}
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
          </td>
          <td><span class="role-badge ${u.role}">${u.role.toUpperCase()}</span></td>
          <td>${escapeHtml(u.g2gStoreName || '—')}</td>
          <td>${u.role === 'seller' ? `${u.commissionRate || 10}%` : '—'}</td>
          <td style="color: var(--accent-green); font-weight: 700;">
            ${fmtCurrency(u.balance)}
            ${renderSellerBreakdownHtml(u, true)}
          </td>
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
        soldGrid.innerHTML = soldItems.map(item => {
          const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
          const unitPrice = item.supplierTargetPrice || 0;
          const totalPrice = unitPrice * qty;
          return `
          <div class="item-card" style="border-color: rgba(0,245,155,0.3);">
            <div class="card-top">
              <span class="game-badge">${escapeHtml(item.game)}</span>
              <span class="category-badge" style="background: rgba(0,245,155,0.1); color: var(--accent-green);">Sold (${qty}x)</span>
            </div>
            <h3 class="item-title">${escapeHtml(item.title)}</h3>
            <div class="price-box">
              <div class="price-item">
                <div class="price-label">Price</div>
                <div class="price-val">${fmtCurrency(totalPrice)}</div>
              </div>
              <div class="price-item profit">
                <div class="price-label">Final G2G Sold</div>
                <div class="price-val">${fmtCurrency(item.soldPrice || totalPrice)}</div>
              </div>
            </div>
            <div class="card-meta-list">
              <div class="meta-row">
                <span>Quantity:</span>
                <span class="val" style="color: var(--accent-gold); font-weight: 700;">${qty} pcs</span>
              </div>
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
            ${item.proofImage ? `
              <div style="margin-top: 10px;">
                <button class="btn btn-outline-cyan btn-sm" data-action="view-proof" data-item-id="${item.id}" style="width: 100%; font-size: 11px; padding: 5px 8px;">
                  <span>📸</span> View Sale Proof Screenshot
                </button>
              </div>
            ` : `
              <div style="margin-top: 8px; font-size: 11px; color: var(--text-dim); text-align: center;">
                No screenshot proof attached
              </div>
            `}
          </div>
        `;
        }).join('');
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

  async function deleteItem(itemId) {
    const user = getCurrentUser();
    try {
      const res = await fetch(`/api/items/${itemId}?requesterId=${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.success) {
        appState.items = (appState.items || []).filter(i => i.id !== itemId);
        renderAll();
        showToast('Your deposit has been removed.', 'success');
        await fetchState();
      } else {
        showToast(data.error || 'Could not delete item.', 'warning');
      }
    } catch (e) {
      console.error(e);
      showToast('Network error removing item.', 'warning');
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

      // Claim / Take to sell action (opens Set Price modal)
      const claimBtn = e.target.closest('button[data-action="claim"], button[data-action="claim-modal"]');
      if (claimBtn) {
        const item = appState.items.find(i => i.id === claimBtn.dataset.itemId);
        if (item) {
          const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
          document.getElementById('claimItemId').value = item.id;
          document.getElementById('claimItemTitle').textContent = `ARC Raiders: ${item.title}`;
          document.getElementById('claimItemQty').textContent = qty;
          document.getElementById('claimItemSupplier').textContent = item.supplierName || 'User';
          const priceInput = document.getElementById('claimItemPrice');
          if (priceInput) priceInput.value = item.supplierTargetPrice > 0 ? item.supplierTargetPrice : '';
          updateClaimPriceHint();
          openModal('modalClaimItem');
        }
        return;
      }

      // Edit price modal
      const editPriceBtn = e.target.closest('button[data-action="edit-price-modal"]');
      if (editPriceBtn) {
        const item = appState.items.find(i => i.id === editPriceBtn.dataset.itemId);
        if (item) {
          const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
          document.getElementById('editPriceItemId').value = item.id;
          document.getElementById('editPriceItemTitle').textContent = `ARC Raiders: ${item.title} (${qty} pcs)`;
          const priceInput = document.getElementById('editPriceValue');
          if (priceInput) priceInput.value = item.supplierTargetPrice || '';
          updateEditPriceHint();
          openModal('modalEditPrice');
        }
        return;
      }

      // Release action (Leave for another seller)
      const releaseBtn = e.target.closest('button[data-action="release"]');
      if (releaseBtn) {
        if (confirm('Leave this item for another seller? It will be released so another seller can take it immediately.')) {
          releaseItem(releaseBtn.dataset.itemId);
        }
        return;
      }

      // Edit stock quantity (supplier/depositor updates quantity while available)
      const editQtyBtn = e.target.closest('button[data-action="edit-qty-modal"]');
      if (editQtyBtn) {
        const item = appState.items.find(i => i.id === editQtyBtn.dataset.itemId);
        if (item) {
          const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
          document.getElementById('editQtyItemId').value = item.id;
          document.getElementById('editQtyItemTitle').textContent = `ARC Raiders: ${item.title}`;
          const qtyInput = document.getElementById('editQtyValue');
          if (qtyInput) qtyInput.value = qty;
          openModal('modalEditQuantity');
        }
        return;
      }

      // Delete item (supplier removes their own deposit)
      const deleteBtn = e.target.closest('button[data-action="delete-item"]');
      if (deleteBtn) {
        if (confirm('Remove this deposit? This cannot be undone.')) {
          deleteItem(deleteBtn.dataset.itemId);
        }
        return;
      }

      // Withdraw user action
      const withdrawUserBtn = e.target.closest('button[data-action="withdraw-user"]');
      if (withdrawUserBtn) {
        openWithdrawModal(withdrawUserBtn.dataset.userId);
        return;
      }

      // View proof screenshot modal
      const viewProofBtn = e.target.closest('button[data-action="view-proof"]');
      if (viewProofBtn) {
        const item = appState.items.find(i => i.id === viewProofBtn.dataset.itemId);
        if (item && item.proofImage) {
          const viewImg = document.getElementById('viewProofImg');
          const viewSub = document.getElementById('viewProofSub');
          if (viewImg) viewImg.src = item.proofImage;
          if (viewSub) viewSub.textContent = `${escapeHtml(item.title)} (${item.quantity} pcs) • Order: ${escapeHtml(item.g2gOrderId || '—')} • Sold by: ${escapeHtml(item.lockedBySellerName || 'Seller')}`;
          openModal('modalViewProof');
        }
        return;
      }

      // Mark sold modal (Supports full or partial quantity sale)
      const soldBtn = e.target.closest('button[data-action="mark-sold-modal"]');
      if (soldBtn) {
        const item = appState.items.find(i => i.id === soldBtn.dataset.itemId);
        if (item) {
          const totalQty = Math.max(1, parseInt(item.quantity, 10) || 1);
          const unitPrice = item.supplierTargetPrice || 0;

          document.getElementById('markSoldItemId').value = item.id;
          document.getElementById('markSoldItemTitle').textContent = `ARC Raiders: ${item.title} (${totalQty} available in stock)`;
          
          const qtyInput = document.getElementById('markSoldQuantity');
          const maxBadge = document.getElementById('markSoldMaxQtyBadge');
          const unitPriceEl = document.getElementById('markSoldUnitPrice');
          const orderIdEl = document.getElementById('markSoldOrderId');
          const finalPriceEl = document.getElementById('markSoldFinalPrice');

          if (qtyInput) {
            qtyInput.max = totalQty;
            qtyInput.value = totalQty;
          }
          if (maxBadge) maxBadge.textContent = `/ ${totalQty} max`;
          if (unitPriceEl) unitPriceEl.value = fmtCurrency(unitPrice);
          if (orderIdEl) orderIdEl.value = `G2G-ORD-${Math.floor(1000000 + Math.random() * 9000000)}`;
          if (finalPriceEl) {
            delete finalPriceEl.dataset.userEdited;
            delete finalPriceEl.dataset.lastQty;
          }

          setProofImage('');
          updateMarkSoldCalculations();
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

      // Radar Check from item card
      const radarBtn = e.target.closest('button[data-action="radar-check"]');
      if (radarBtn) {
        const query = radarBtn.dataset.query;
        switchToRadarTabAndScan(query);
        return;
      }

      // Modals close
      if (e.target.closest('[data-close-modal]') || e.target.classList.contains('modal-overlay')) {
        document.querySelectorAll('.modal-overlay').forEach(m => closeModal(m));
      }
    });

    // Open Add Item Modal buttons
    function openDepositModal() {
      updateModalSuppliers();
      const select = document.getElementById('addItemSupplier');
      if (select && currentUserId) {
        select.value = currentUserId;
      }
      openModal('modalAddItem');
    }
    const btnOpenAdd = document.getElementById('btnOpenAddItem');
    const btnDepositDirect = document.getElementById('btnDepositItemDirect');
    if (btnOpenAdd) btnOpenAdd.addEventListener('click', openDepositModal);
    if (btnDepositDirect) btnDepositDirect.addEventListener('click', openDepositModal);

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
            profitPreview.innerHTML = `Sale Price: <strong>${fmtCurrency(finalPrice)}</strong>. Seller Profit: <strong>${fmtCurrency(profit)}</strong>`;
          } else {
            profitPreview.style.borderColor = 'rgba(255, 51, 102, 0.25)';
            profitPreview.style.background = 'rgba(255, 51, 102, 0.1)';
            profitPreview.style.color = 'var(--accent-red)';
            profitPreview.innerHTML = `⚠️ Selling below cost: <strong>${fmtCurrency(profit)}</strong>!`;
          }
        }
      });
    }

    // Form Claim Item (Seller takes & sets price)
    const formClaimItem = document.getElementById('formClaimItem');
    const claimPriceInput = document.getElementById('claimItemPrice');
    function updateClaimPriceHint() {
      const hint = document.getElementById('claimItemPriceHint');
      const priceVal = parseFloat(claimPriceInput?.value) || 0;
      const qtyVal = parseInt(document.getElementById('claimItemQty')?.textContent, 10) || 1;
      if (!hint) return;
      if (priceVal > 0) {
        if (qtyVal > 1) {
          hint.innerHTML = `Total Listing Price: <strong>${fmtCurrency(priceVal * qtyVal)}</strong> (${qtyVal} pcs × ${fmtCurrency(priceVal)} each). No 10% added.`;
        } else {
          hint.innerHTML = `Listing Price: <strong>${fmtCurrency(priceVal)}</strong>. Direct price, no 10% added.`;
        }
      } else {
        hint.textContent = 'Direct listing price — no 10% added.';
      }
    }
    if (claimPriceInput) claimPriceInput.addEventListener('input', updateClaimPriceHint);

    if (formClaimItem) {
      formClaimItem.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const itemId = document.getElementById('claimItemId').value;
        const priceVal = parseFloat(claimPriceInput.value) || 0;

        if (priceVal <= 0) {
          showToast('Price must be greater than $0.00. Negative prices are not allowed.', 'warning');
          return;
        }

        try {
          const res = await fetch(`/api/items/${itemId}/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sellerId: user.id,
              sellerName: user.name,
              price: priceVal
            })
          });
          const data = await res.json();
          if (data.success) {
            closeModal(document.getElementById('modalClaimItem'));
            showToast(`Claimed! Set price to ${fmtCurrency(priceVal)}. Ready on G2G.`, 'success');
            playNotification('lock');
          } else {
            showToast(data.error || 'Failed to claim item', 'warning');
          }
        } catch (err) {
          console.error(err);
          showToast('Network error claiming item', 'warning');
        }
      });
    }

    // Check radar button from Claim Modal
    const btnClaimCheckRadar = document.getElementById('btnClaimCheckRadar');
    if (btnClaimCheckRadar) {
      btnClaimCheckRadar.addEventListener('click', () => {
        const itemId = document.getElementById('claimItemId').value;
        const item = appState.items.find(i => i.id === itemId);
        if (item) {
          closeModal(document.getElementById('modalClaimItem'));
          switchToRadarTabAndScan(item.title);
        }
      });
    }

    // Form Edit Price (Seller updates price anytime)
    const formEditPrice = document.getElementById('formEditPrice');
    const editPriceInput = document.getElementById('editPriceValue');
    function updateEditPriceHint() {
      const hint = document.getElementById('editPriceHint');
      const priceVal = parseFloat(editPriceInput?.value) || 0;
      if (!hint) return;
      if (priceVal > 0) {
        hint.innerHTML = `New Listing Price: <strong>${fmtCurrency(priceVal)}</strong>. Direct price, no 10% added.`;
      } else {
        hint.textContent = 'Direct price — no 10% added.';
      }
    }
    if (editPriceInput) editPriceInput.addEventListener('input', updateEditPriceHint);

    if (formEditPrice) {
      formEditPrice.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const itemId = document.getElementById('editPriceItemId').value;
        const priceVal = parseFloat(editPriceInput.value) || 0;

        if (priceVal <= 0) {
          showToast('Price must be greater than $0.00. Negative prices are not allowed.', 'warning');
          return;
        }

        try {
          const res = await fetch(`/api/items/${itemId}/price`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sellerId: user.id,
              price: priceVal
            })
          });
          const data = await res.json();
          if (data.success) {
            closeModal(document.getElementById('modalEditPrice'));
            showToast(`Price updated to ${fmtCurrency(priceVal)}.`, 'success');
          } else {
            showToast(data.error || 'Failed to update price', 'warning');
          }
        } catch (err) {
          console.error(err);
          showToast('Network error updating price', 'warning');
        }
      });
    }

    // Form Edit Quantity (Depositor updates stock while available)
    const formEditQty = document.getElementById('formEditQuantity');
    if (formEditQty) {
      formEditQty.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const itemId = document.getElementById('editQtyItemId').value;
        const newQty = parseInt(document.getElementById('editQtyValue').value, 10);

        if (isNaN(newQty) || newQty < 1) {
          showToast('Quantity must be at least 1.', 'warning');
          return;
        }

        try {
          const res = await fetch(`/api/items/${itemId}/quantity`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quantity: newQty,
              requesterId: user.id
            })
          });
          const data = await res.json();
          if (data.success) {
            closeModal(document.getElementById('modalEditQuantity'));
            const target = (appState.items || []).find(i => i.id === itemId);
            if (target) target.quantity = newQty;
            renderAll();
            showToast(`Stock updated to ${newQty} pcs!`, 'success');
            await fetchState();
          } else {
            showToast(data.error || 'Failed to update stock', 'warning');
          }
        } catch (err) {
          console.error(err);
          showToast('Network error updating stock', 'warning');
        }
      });
    }

    // Form Add Item (User deposits item - only item & quantity)
    const formAddItem = document.getElementById('formAddItem');
    if (formAddItem) {
      formAddItem.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const qtyVal = parseInt(document.getElementById('addItemQuantity')?.value, 10) || 1;
        const body = {
          game: 'ARC Raiders',
          category: document.getElementById('addItemCategory').value,
          supplierId: document.getElementById('addItemSupplier').value,
          title: document.getElementById('addItemTitle').value.trim(),
          quantity: Math.max(1, qtyVal),
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
          showToast('Item deposited! Adem or Amine will set the price when taking it.', 'success');
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

    // Dynamic Calculation & Proof Uploader for Mark Sold Modal
    function updateMarkSoldCalculations() {
      const itemId = document.getElementById('markSoldItemId')?.value;
      const item = appState.items.find(i => i.id === itemId);
      if (!item) return;

      const totalQty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const qtyInput = document.getElementById('markSoldQuantity');
      let soldQty = parseInt(qtyInput?.value, 10);
      if (isNaN(soldQty) || soldQty < 1) soldQty = 1;
      if (soldQty > totalQty) soldQty = totalQty;
      if (qtyInput && qtyInput.value != soldQty) qtyInput.value = soldQty;

      const unitPrice = item.supplierTargetPrice || 0;
      const totalCost = unitPrice * soldQty;

      const payoutEl = document.getElementById('markSoldSupplierPayout');
      const finalPriceEl = document.getElementById('markSoldFinalPrice');
      const profitPreview = document.getElementById('markSoldProfitPreview');
      const noticeBox = document.getElementById('markSoldPartialNotice');
      const noticeSold = document.getElementById('noticeSoldQty');
      const noticeRem = document.getElementById('noticeRemainingQty');

      if (payoutEl) payoutEl.value = fmtCurrency(totalCost);

      if (finalPriceEl && (!finalPriceEl.dataset.userEdited || finalPriceEl.dataset.lastQty != soldQty)) {
        finalPriceEl.value = totalCost.toFixed(2);
        finalPriceEl.dataset.lastQty = soldQty;
      }

      const finalSoldPrice = parseFloat(finalPriceEl?.value) || totalCost;
      const grossProfit = Math.max(0, finalSoldPrice - totalCost);

      if (profitPreview) {
        if (finalSoldPrice <= 0) {
          profitPreview.innerHTML = `<span style="color: var(--accent-red); font-weight: 700;">⚠️ Price must be greater than $0.00.</span>`;
        } else {
          profitPreview.innerHTML = `Final G2G Sale Price: <strong>${fmtCurrency(finalSoldPrice)}</strong> (${soldQty} pcs). Supplier: ${fmtCurrency(totalCost)}${grossProfit > 0 ? `, Profit: <strong>+${fmtCurrency(grossProfit)}</strong>` : ''}. No 10% added.`;
        }
      }

      const remainingQty = totalQty - soldQty;
      if (remainingQty > 0) {
        if (noticeBox) noticeBox.style.display = 'block';
        if (noticeSold) noticeSold.textContent = soldQty;
        if (noticeRem) noticeRem.textContent = remainingQty;
      } else {
        if (noticeBox) noticeBox.style.display = 'none';
      }
    }

    const markSoldQtyInput = document.getElementById('markSoldQuantity');
    const markSoldPriceInput = document.getElementById('markSoldFinalPrice');
    if (markSoldQtyInput) markSoldQtyInput.addEventListener('input', updateMarkSoldCalculations);
    if (markSoldPriceInput) {
      markSoldPriceInput.addEventListener('input', () => {
        markSoldPriceInput.dataset.userEdited = 'true';
        updateMarkSoldCalculations();
      });
    }

    // Proof Upload & Paste Handling
    const proofDropZone = document.getElementById('proofDropZone');
    const markSoldProofFile = document.getElementById('markSoldProofFile');
    const btnRemoveProof = document.getElementById('btnRemoveProof');

    if (proofDropZone) {
      proofDropZone.addEventListener('click', (e) => {
        if (e.target.closest('#btnRemoveProof')) return;
        if (markSoldProofFile) markSoldProofFile.click();
      });
      proofDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        proofDropZone.style.borderColor = 'var(--accent-cyan)';
      });
      proofDropZone.addEventListener('dragleave', () => {
        proofDropZone.style.borderColor = 'rgba(0, 240, 255, 0.35)';
      });
      proofDropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        proofDropZone.style.borderColor = 'rgba(0, 240, 255, 0.35)';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          const file = e.dataTransfer.files[0];
          if (file.type.startsWith('image/')) {
            const compressed = await compressImage(file);
            setProofImage(compressed);
            showToast('📸 Screenshot proof attached!', 'info');
          }
        }
      });
    }

    if (markSoldProofFile) {
      markSoldProofFile.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files[0]) {
          const compressed = await compressImage(e.target.files[0]);
          setProofImage(compressed);
          showToast('📸 Screenshot proof attached!', 'info');
        }
      });
    }

    if (btnRemoveProof) {
      btnRemoveProof.addEventListener('click', (e) => {
        e.stopPropagation();
        setProofImage('');
      });
    }

    // Clipboard Paste Listener (Ctrl+V) when Mark Sold Modal is Open
    window.addEventListener('paste', async (e) => {
      const modal = document.getElementById('modalMarkSold');
      if (!modal || !modal.classList.contains('active')) return;
      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile();
          if (blob) {
            const compressed = await compressImage(blob);
            setProofImage(compressed);
            showToast('📸 Screenshot pasted from clipboard!', 'info');
            break;
          }
        }
      }
    });

    // Form Mark Sold (Submit full or partial quantity sale)
    const formMarkSold = document.getElementById('formMarkSold');
    if (formMarkSold) {
      formMarkSold.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = getCurrentUser();
        const itemId = document.getElementById('markSoldItemId').value;
        const item = appState.items.find(i => i.id === itemId);
        if (!item) return;

        const totalQty = Math.max(1, parseInt(item.quantity, 10) || 1);
        const soldQty = parseInt(document.getElementById('markSoldQuantity')?.value, 10) || totalQty;
        const finalPrice = parseFloat(document.getElementById('markSoldFinalPrice')?.value);
        const g2gOrderId = document.getElementById('markSoldOrderId')?.value.trim();

        if (isNaN(finalPrice) || finalPrice <= 0) {
          showToast('Final sale price must be greater than $0.00. Negative prices are not allowed.', 'warning');
          return;
        }

        if (soldQty < 1 || soldQty > totalQty) {
          showToast(`Quantity must be between 1 and ${totalQty}.`, 'warning');
          return;
        }

        try {
          const res = await fetch(`/api/items/${itemId}/mark-sold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sellerId: user.id,
              g2gOrderId,
              finalPrice,
              soldQuantity: soldQty,
              proofImage: currentProofBase64
            })
          });
          const data = await res.json();
          if (data.success) {
            closeModal(document.getElementById('modalMarkSold'));
            setProofImage('');
            if (data.remainingQuantity > 0) {
              showToast(`Partial sale recorded! Sold ${soldQty} pcs. ${data.remainingQuantity} pcs remain locked for you.`, 'success');
            } else {
              showToast(`Sale recorded! Credited ${fmtCurrency(data.profit)} to seller balance.`, 'success');
            }
            playNotification('sold');
            await fetchState();
          } else {
            showToast(data.error || 'Failed to record sale', 'warning');
          }
        } catch (err) {
          console.error(err);
          showToast('Network error recording sale', 'warning');
        }
      });
    }

    // Withdraw Modal & Calculation Logic
    let currentWithdrawUser = null;
    function openWithdrawModal(targetUserId) {
      const user = targetUserId ? (appState.users.find(u => u.id === targetUserId) || getCurrentUser()) : getCurrentUser();
      currentWithdrawUser = user;
      const userNameEl = document.getElementById('withdrawUserName');
      const balanceEl = document.getElementById('withdrawAvailableBalance');
      const amountInput = document.getElementById('withdrawAmount');
      const destInput = document.getElementById('withdrawDestination');
      const alertBox = document.getElementById('withdrawAlertBox');
      const breakdownEl = document.getElementById('withdrawSellerBreakdown');
      const groupSeller = document.getElementById('groupWithdrawFromSeller');
      const sellerSelect = document.getElementById('withdrawFromSellerSelect');

      if (userNameEl) userNameEl.textContent = user.name;
      if (balanceEl) balanceEl.textContent = fmtCurrency(user.balance);

      const sellers = (appState.users || []).filter(u => u.role === 'seller');
      if (user.role === 'supplier') {
        const parts = sellers.map(s => {
          const amt = (user.sellerBalances && user.sellerBalances[s.id]) || 0;
          const shortName = s.name.split(' ')[0];
          return `🛒 ${shortName}: <strong style="color: ${amt > 0 ? 'var(--accent-green)' : 'inherit'};">${fmtCurrency(amt)}</strong>`;
        });
        if (breakdownEl) {
          breakdownEl.innerHTML = `<span style="color: var(--text-dim);">Balance from Sellers:</span> ${parts.join(' • ')}`;
          breakdownEl.style.display = 'block';
        }
        if (groupSeller && sellerSelect) {
          sellerSelect.innerHTML = `<option value="">Any / Proportional across sellers (${fmtCurrency(user.balance)})</option>` +
            sellers.map(s => {
              const amt = (user.sellerBalances && user.sellerBalances[s.id]) || 0;
              return `<option value="${s.id}">From ${s.name} (${fmtCurrency(amt)} available)</option>`;
            }).join('');
          groupSeller.style.display = 'block';
        }
      } else {
        if (breakdownEl) breakdownEl.style.display = 'none';
        if (groupSeller) groupSeller.style.display = 'none';
      }

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
      const user = optUser || currentWithdrawUser || getCurrentUser();
      const input = document.getElementById('withdrawAmount');
      const amount = parseFloat(input ? input.value : 0) || 0;
      const btnSubmit = document.getElementById('btnSubmitWithdraw');
      const alertBox = document.getElementById('withdrawAlertBox');
      const sellerSelect = document.getElementById('withdrawFromSellerSelect');
      const chosenSellerId = sellerSelect?.value || '';

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

      let maxAvailable = user.balance || 0;
      if (chosenSellerId) {
        maxAvailable = (user.sellerBalances && user.sellerBalances[chosenSellerId]) || 0;
      }

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

      if (amount > maxAvailable) {
        if (alertBox) {
          alertBox.style.display = 'block';
          alertBox.style.background = 'rgba(255, 51, 102, 0.15)';
          alertBox.style.border = '1px solid rgba(255, 51, 102, 0.3)';
          alertBox.style.color = 'var(--accent-red)';
          alertBox.textContent = `⚠️ Amount exceeds available balance (${fmtCurrency(maxAvailable)}).`;
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

    const withdrawFromSellerSelect = document.getElementById('withdrawFromSellerSelect');
    if (withdrawFromSellerSelect) {
      withdrawFromSellerSelect.addEventListener('change', () => {
        const user = currentWithdrawUser || getCurrentUser();
        const chosenSellerId = withdrawFromSellerSelect.value;
        const input = document.getElementById('withdrawAmount');
        let maxAvailable = user.balance || 0;
        if (chosenSellerId) {
          maxAvailable = (user.sellerBalances && user.sellerBalances[chosenSellerId]) || 0;
        }
        if (input) input.max = maxAvailable;
        updateWithdrawPreview(user);
      });
    }

    const btnWithdrawMax = document.getElementById('btnWithdrawMax');
    if (btnWithdrawMax) {
      btnWithdrawMax.addEventListener('click', () => {
        const user = currentWithdrawUser || getCurrentUser();
        const input = document.getElementById('withdrawAmount');
        const chosenSellerId = document.getElementById('withdrawFromSellerSelect')?.value;
        let maxAvailable = user.balance || 0;
        if (chosenSellerId) {
          maxAvailable = (user.sellerBalances && user.sellerBalances[chosenSellerId]) || 0;
        }
        if (input) {
          input.value = maxAvailable.toFixed(2);
          updateWithdrawPreview(user);
        }
      });
    }

    const formWithdraw = document.getElementById('formWithdraw');
    if (formWithdraw) {
      formWithdraw.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = currentWithdrawUser || getCurrentUser();
        const amount = parseFloat(document.getElementById('withdrawAmount').value);
        const method = document.getElementById('withdrawMethod').value;
        const destination = document.getElementById('withdrawDestination').value.trim();
        const fromSellerId = document.getElementById('withdrawFromSellerSelect')?.value || null;

        if (isNaN(amount) || amount <= 1.00) {
          showToast('Amount must exceed $1.00 flat fee.', 'warning');
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
              destination,
              fromSellerId
            })
          });
          const data = await res.json();
          if (data.success) {
            closeModal(document.getElementById('modalWithdraw'));
            
            // Instantly deduct money from local state so balance drops on screen immediately
            const targetUser = appState.users.find(u => u.id === user.id);
            if (targetUser) {
              targetUser.balance = data.newBalance !== undefined 
                ? data.newBalance 
                : parseFloat(Math.max(0, targetUser.balance - amount).toFixed(2));
              if (data.sellerBalances) {
                targetUser.sellerBalances = data.sellerBalances;
              }
            }
            if (data.withdrawal) {
              if (!appState.withdrawals) appState.withdrawals = [];
              appState.withdrawals.unshift(data.withdrawal);
            }
            renderAll();
            await fetchState();

            playChime();
            showToast(`💸 Withdrawal of ${fmtCurrency(data.withdrawal.amount)} confirmed! Net Received: ${fmtCurrency(data.withdrawal.netPayout)} (Fee: ${fmtCurrency(data.withdrawal.totalFee)})`, 'success');
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

    // Setup G2G Price Radar events
    setupRadarEvents();
  }

  // Multi-Item Radar Queue & 30s Auto-Refresh State
  let radarQueue = [];
  let radarLastScannedItems = [];
  let radarAutoRefreshEnabled = true;
  let radarAutoRefreshCountdown = 30;
  let radarAutoRefreshTimer = null;
  let radarIsScanning = false;

  function updateRadarAutoRefreshUI() {
    const badge = document.getElementById('radarAutoRefreshBadge');
    const dot = document.getElementById('radarPulseDot');
    const toggleBtn = document.getElementById('btnToggleAutoRefresh');
    const countText = document.getElementById('radarCountdownText');

    if (badge) {
      badge.textContent = radarAutoRefreshEnabled ? 'ACTIVE' : 'PAUSED';
      badge.className = `radar-live-badge ${radarAutoRefreshEnabled ? 'active' : 'paused'}`;
    }
    if (dot) {
      dot.className = `radar-pulse-dot ${radarAutoRefreshEnabled ? '' : 'paused'}`;
    }
    if (toggleBtn) {
      toggleBtn.textContent = radarAutoRefreshEnabled ? 'Pause' : 'Resume';
      toggleBtn.className = `btn ${radarAutoRefreshEnabled ? 'btn-secondary' : 'btn-outline-cyan'} btn-sm`;
    }
    if (countText) {
      if (!radarAutoRefreshEnabled) {
        countText.textContent = 'Auto-sync paused';
      } else {
        countText.textContent = `Refreshing in ${radarAutoRefreshCountdown}s`;
      }
    }
  }

  function startRadarAutoRefreshTimer() {
    if (radarAutoRefreshTimer) clearInterval(radarAutoRefreshTimer);

    radarAutoRefreshTimer = setInterval(() => {
      if (!radarAutoRefreshEnabled) return;

      const itemsToScan = radarQueue.length > 0 ? radarQueue : radarLastScannedItems;
      if (itemsToScan.length === 0) {
        const countText = document.getElementById('radarCountdownText');
        if (countText) countText.textContent = 'Add items to scan';
        return;
      }

      radarAutoRefreshCountdown--;
      const countText = document.getElementById('radarCountdownText');
      if (countText) {
        countText.textContent = `Refreshing in ${radarAutoRefreshCountdown}s`;
      }

      if (radarAutoRefreshCountdown <= 0) {
        radarAutoRefreshCountdown = 30;
        if (!radarIsScanning) {
          if (itemsToScan.length === 1) {
            triggerRadarScan(itemsToScan[0], true);
          } else {
            triggerRadarBatchScan(itemsToScan, true);
          }
        }
      }
    }, 1000);
  }

  function addRadarQueueItem(itemName) {
    if (!itemName) return;
    const parts = itemName.split(',').map(s => s.trim()).filter(Boolean);
    parts.forEach(part => {
      if (!radarQueue.includes(part)) {
        radarQueue.push(part);
      }
    });
    renderRadarQueue();
  }

  function removeRadarQueueItem(itemName) {
    radarQueue = radarQueue.filter(it => it !== itemName);
    renderRadarQueue();
  }

  function clearRadarQueue() {
    radarQueue = [];
    renderRadarQueue();
    const multiArea = document.getElementById('radarMultiResultsArea');
    const singleArea = document.getElementById('radarResultsArea');
    const placeholder = document.getElementById('radarPlaceholder');
    const errorBox = document.getElementById('radarErrorBox');
    if (multiArea) multiArea.style.display = 'none';
    if (singleArea) singleArea.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
    if (errorBox) errorBox.style.display = 'none';
  }

  function renderRadarQueue() {
    const container = document.getElementById('radarChipsContainer');
    const counter = document.getElementById('radarQueueCount');
    const btnText = document.getElementById('radarScanBtnText');

    if (counter) counter.textContent = radarQueue.length;

    if (btnText) {
      if (radarQueue.length > 1) {
        btnText.textContent = `Scan All (${radarQueue.length}) Items`;
      } else if (radarQueue.length === 1) {
        btnText.textContent = `Scan 5 Lowest Prices`;
      } else {
        btnText.textContent = `Scan Lowest Prices`;
      }
    }

    if (!container) return;

    if (radarQueue.length === 0) {
      container.innerHTML = `
        <span id="radarEmptyQueueNotice" style="font-size: 12px; color: var(--text-dim); font-style: italic;">
          No products selected yet. Pick items from above or click popular buttons below to compare multiple items at once.
        </span>
      `;
      return;
    }

    container.innerHTML = radarQueue.map(item => `
      <div class="radar-chip">
        <span>${escapeHtml(item)}</span>
        <button type="button" class="radar-chip-remove" data-remove-item="${escapeHtml(item)}" title="Remove ${escapeHtml(item)}">&times;</button>
      </div>
    `).join('');
  }

  function setupRadarEvents() {
    const categorySelect = document.getElementById('radarCategorySelect');
    const presetSelect = document.getElementById('radarProductPreset');
    const searchInput = document.getElementById('radarSearchInput');
    const addBtn = document.getElementById('btnAddItemToQueue');
    const addAllCategoryBtn = document.getElementById('btnAddAllCategory');
    const clearQueueBtn = document.getElementById('btnClearQueue');
    const scanBtn = document.getElementById('btnScanG2GPrices');
    const chipsContainer = document.getElementById('radarChipsContainer');
    const multiTableBody = document.getElementById('radarMultiTableBody');
    const toggleAutoRefreshBtn = document.getElementById('btnToggleAutoRefresh');

    if (toggleAutoRefreshBtn) {
      toggleAutoRefreshBtn.addEventListener('click', () => {
        radarAutoRefreshEnabled = !radarAutoRefreshEnabled;
        if (radarAutoRefreshEnabled) {
          radarAutoRefreshCountdown = 30;
          showToast('Live 30s auto-refresh resumed!', 'info');
        } else {
          showToast('Live auto-refresh paused.', 'info');
        }
        updateRadarAutoRefreshUI();
      });
    }

    if (categorySelect) {
      categorySelect.addEventListener('change', populateRadarPresets);
    }

    // Automatically add preset to queue on select
    if (presetSelect) {
      presetSelect.addEventListener('change', () => {
        if (presetSelect.value) {
          addRadarQueueItem(presetSelect.value);
          presetSelect.selectedIndex = 0;
        }
      });
    }

    // Add all in category button
    if (addAllCategoryBtn) {
      addAllCategoryBtn.addEventListener('click', () => {
        const cat = categorySelect ? categorySelect.value : '';
        const items = cat && arcCatalog[cat] ? arcCatalog[cat] : Object.values(arcCatalog).flat();
        if (items.length > 0) {
          items.forEach(it => {
            if (!radarQueue.includes(it)) radarQueue.push(it);
          });
          renderRadarQueue();
          showToast(`Added ${items.length} items to scan list!`, 'success');
        }
      });
    }

    // Add custom typed item
    if (addBtn && searchInput) {
      addBtn.addEventListener('click', () => {
        const val = searchInput.value.trim();
        if (val) {
          addRadarQueueItem(val);
          searchInput.value = '';
        } else {
          showToast('Please type an item name to add.', 'warning');
        }
      });
    }

    if (searchInput) {
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = searchInput.value.trim();
          if (val) {
            addRadarQueueItem(val);
            searchInput.value = '';
          }
        }
      });
    }

    // Clear Queue
    if (clearQueueBtn) {
      clearQueueBtn.addEventListener('click', clearRadarQueue);
    }

    // Remove single chip delegation
    if (chipsContainer) {
      chipsContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-remove-item]');
        if (removeBtn) {
          removeRadarQueueItem(removeBtn.dataset.removeItem);
        }
      });
    }

    // Toggle details row in multi-item comparison table
    if (multiTableBody) {
      multiTableBody.addEventListener('click', (e) => {
        const toggleBtn = e.target.closest('[data-toggle-details]');
        if (toggleBtn) {
          const targetId = toggleBtn.dataset.toggleDetails;
          const targetRow = document.getElementById(targetId);
          if (targetRow) {
            const isHidden = targetRow.style.display === 'none';
            targetRow.style.display = isHidden ? 'table-row' : 'none';
            toggleBtn.innerHTML = isHidden ? 'Hide Top 5 ▴' : 'Top 5 Sellers ▾';
          }
        }
      });
    }

    // Quick tag buttons add directly to queue
    document.querySelectorAll('.radar-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.query;
        addRadarQueueItem(q);
      });
    });

    // Main Scan Button
    if (scanBtn) {
      scanBtn.addEventListener('click', () => {
        const queryText = searchInput ? searchInput.value.trim() : '';
        if (queryText && !radarQueue.includes(queryText)) {
          addRadarQueueItem(queryText);
          searchInput.value = '';
        }

        if (radarQueue.length === 0) {
          showToast('Please select or add at least one product to check.', 'warning');
          return;
        }

        if (radarQueue.length === 1) {
          triggerRadarScan(radarQueue[0], false);
        } else {
          triggerRadarBatchScan(radarQueue, false);
        }
      });
    }
  }

  function switchToRadarTabAndScan(productQuery) {
    document.querySelectorAll('.topic-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.topic-content').forEach(c => c.classList.remove('active'));
    const radarTab = document.querySelector('.topic-tab[data-topic="radar"]');
    const radarSection = document.getElementById('topicRadarSection');
    if (radarTab) radarTab.classList.add('active');
    if (radarSection) radarSection.classList.add('active');

    radarQueue = [productQuery];
    renderRadarQueue();
    triggerRadarScan(productQuery, false);
    window.scrollTo({ top: 150, behavior: 'smooth' });
  }

  // Single Item Radar Scan
  async function triggerRadarScan(query, isAutoRefresh = false) {
    if (!query) return;
    radarIsScanning = true;
    radarAutoRefreshCountdown = 30;
    radarLastScannedItems = [query];

    const spinner = document.getElementById('radarSpinner');
    const scanIcon = document.getElementById('radarScanIcon');
    const scanText = document.getElementById('radarScanBtnText');
    const singleArea = document.getElementById('radarResultsArea');
    const multiArea = document.getElementById('radarMultiResultsArea');
    const placeholder = document.getElementById('radarPlaceholder');
    const errorBox = document.getElementById('radarErrorBox');

    if (!isAutoRefresh) {
      if (spinner) spinner.style.display = 'inline-block';
      if (scanIcon) scanIcon.style.display = 'none';
      if (scanText) scanText.textContent = 'Scanning G2G...';

      if (placeholder) placeholder.style.display = 'none';
      if (multiArea) multiArea.style.display = 'none';
      if (errorBox) errorBox.style.display = 'none';
    }

    try {
      const res = await fetch(`/api/g2g-prices?query=${encodeURIComponent(query)}&forceFresh=true`);
      const data = await res.json();

      if (!data.success || !data.top5 || data.top5.length === 0) {
        if (!isAutoRefresh) {
          if (singleArea) singleArea.style.display = 'none';
          if (errorBox) {
            errorBox.style.display = 'block';
            const errTitle = document.getElementById('radarErrorTitle');
            const errMsg = document.getElementById('radarErrorMessage');
            if (errTitle) errTitle.textContent = `No Offers Found for "${query}"`;
            if (errMsg) errMsg.textContent = data.error || 'G2G marketplace currently has 0 active listings for this query.';
          }
        }
        return;
      }

      // Render KPIs
      const kpiLowest = document.getElementById('radarKpiLowest');
      const kpiAvg = document.getElementById('radarKpiAvg');
      const kpiRec = document.getElementById('radarKpiRecommended');
      const kpiTotal = document.getElementById('radarKpiTotal');
      const kpiProduct = document.getElementById('radarQueriedProduct');
      const kpiTime = document.getElementById('radarKpiTime');

      if (kpiLowest) kpiLowest.textContent = data.formattedLowestPrice;
      if (kpiAvg) kpiAvg.textContent = data.formattedAveragePrice;
      if (kpiRec) kpiRec.textContent = data.formattedRecommendedPrice;
      if (kpiTotal) kpiTotal.textContent = `${data.totalFound} offers`;
      if (kpiProduct) kpiProduct.textContent = `"${data.query}"`;
      if (kpiTime) kpiTime.textContent = `Checked at ${new Date().toLocaleTimeString()} (auto-synced 30s)`;

      // Render 5 Lowest Cards
      const grid = document.getElementById('radarTop5Grid');
      if (grid) {
        grid.innerHTML = data.top5.map((offer, idx) => {
          const isLowest = idx === 0;
          return `
            <div class="radar-offer-card ${isLowest ? 'rank-1' : ''}">
              <div class="radar-card-header">
                <span class="rank-badge ${isLowest ? 'rank-1' : 'rank-default'}">
                  ${isLowest ? '🏆 #1 Lowest Price' : `#${offer.rank} Lowest`}
                </span>
                <span class="radar-price-tag">${escapeHtml(offer.formattedPrice)}</span>
              </div>

              <div class="radar-offer-title" title="${escapeHtml(offer.title)}">
                ${escapeHtml(offer.title)}
              </div>

              <div class="radar-seller-info">
                <div>
                  <div class="radar-seller-name">
                    <span>👤</span> ${escapeHtml(offer.sellerName)}
                  </div>
                  <div style="font-size: 10px; color: var(--text-dim);">
                    Seller Rank: Tier ${escapeHtml(offer.sellerRanking)}
                  </div>
                </div>
                <div style="text-align: right;">
                  <div class="radar-seller-stat">
                    ★ ${escapeHtml(offer.sellerRating)}
                  </div>
                  <div style="font-size: 10px; color: var(--text-dim);">
                    ${Number(offer.sellerOrders).toLocaleString()} orders
                  </div>
                </div>
              </div>

              <div style="display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: auto;">
                <span style="font-size: 11px; color: var(--text-dim);">
                  Stock: <strong style="color: #fff;">${Number(offer.availableQty).toLocaleString()}</strong>
                </span>
                <a href="${escapeHtml(offer.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-cyan btn-sm" style="font-size: 11px; padding: 4px 10px;">
                  View on G2G ↗
                </a>
              </div>
            </div>
          `;
        }).join('');
      }

      if (singleArea) singleArea.style.display = 'block';
      if (!isAutoRefresh) {
        showToast(`Found 5 lowest competitor prices on G2G for "${query}"!`, 'success');
      }
    } catch (err) {
      console.error('Radar scan error:', err);
      if (!isAutoRefresh) {
        if (singleArea) singleArea.style.display = 'none';
        if (errorBox) {
          errorBox.style.display = 'block';
          const errTitle = document.getElementById('radarErrorTitle');
          const errMsg = document.getElementById('radarErrorMessage');
          if (errTitle) errTitle.textContent = 'Network or API Error';
          if (errMsg) errMsg.textContent = 'Could not reach G2G API. Please check your connection and try again.';
        }
      }
    } finally {
      radarIsScanning = false;
      if (spinner) spinner.style.display = 'none';
      if (scanIcon) scanIcon.style.display = 'inline-block';
      renderRadarQueue();
    }
  }

  // Multi-Item Batch Radar Scan (Scan all chosen products simultaneously)
  async function triggerRadarBatchScan(itemsList, isAutoRefresh = false) {
    if (!itemsList || itemsList.length === 0) return;
    radarIsScanning = true;
    radarAutoRefreshCountdown = 30;
    radarLastScannedItems = [...itemsList];

    const spinner = document.getElementById('radarSpinner');
    const scanIcon = document.getElementById('radarScanIcon');
    const scanText = document.getElementById('radarScanBtnText');
    const multiArea = document.getElementById('radarMultiResultsArea');
    const singleArea = document.getElementById('radarResultsArea');
    const placeholder = document.getElementById('radarPlaceholder');
    const errorBox = document.getElementById('radarErrorBox');

    if (!isAutoRefresh) {
      if (spinner) spinner.style.display = 'inline-block';
      if (scanIcon) scanIcon.style.display = 'none';
      if (scanText) scanText.textContent = `Scanning ${itemsList.length} items on G2G...`;

      if (placeholder) placeholder.style.display = 'none';
      if (singleArea) singleArea.style.display = 'none';
      if (errorBox) errorBox.style.display = 'none';
    }

    try {
      const res = await fetch('/api/g2g-prices/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsList, forceFresh: true })
      });
      const data = await res.json();

      if (!data.success || !data.results || data.results.length === 0) {
        if (!isAutoRefresh) {
          if (multiArea) multiArea.style.display = 'none';
          if (errorBox) {
            errorBox.style.display = 'block';
            document.getElementById('radarErrorTitle').textContent = 'No Market Offers Found';
            document.getElementById('radarErrorMessage').textContent = data.error || 'G2G returned 0 offers for the selected items.';
          }
        }
        return;
      }

      // Compute Basket KPIs
      const validResults = data.results.filter(r => r.lowestPrice > 0);
      const totalBasketCost = validResults.reduce((acc, r) => acc + r.lowestPrice, 0);
      const avgBasketPrice = validResults.length > 0 ? (totalBasketCost / validResults.length) : 0;
      
      let cheapestItem = validResults.length > 0 
        ? validResults.reduce((prev, curr) => curr.lowestPrice < prev.lowestPrice ? curr : prev) 
        : null;

      document.getElementById('multiKpiCount').textContent = `${data.results.length} products`;
      document.getElementById('multiKpiBasketCost').textContent = `$${totalBasketCost.toFixed(2)}`;
      document.getElementById('multiKpiAvg').textContent = `$${avgBasketPrice.toFixed(2)}`;
      if (cheapestItem) {
        document.getElementById('multiKpiCheapest').textContent = cheapestItem.query;
        document.getElementById('multiKpiCheapestPrice').textContent = `Lowest: ${cheapestItem.formattedLowestPrice}`;
      } else {
        document.getElementById('multiKpiCheapest').textContent = '—';
        document.getElementById('multiKpiCheapestPrice').textContent = '$0.00';
      }
      document.getElementById('multiScanTimestamp').textContent = `Checked at ${new Date().toLocaleTimeString()} (auto-synced 30s) • ${data.results.length} items`;

      // Render Comparison Table Body (Lowest Prices Only)
      const tbody = document.getElementById('radarMultiTableBody');
      if (tbody) {
        tbody.innerHTML = data.results.map((r) => {
          const cheapestSeller = r.lowestSeller || (r.top5 && r.top5.length > 0 ? r.top5[0] : null);
          const g2gUrl = cheapestSeller?.url || `https://www.g2g.com/categories/arc-raiders-items?q=${encodeURIComponent(r.query)}`;

          return `
            <tr>
              <td>
                <strong style="color: #fff; font-size: 15px;">${escapeHtml(r.query)}</strong>
                <div style="font-size: 11px; color: var(--text-dim);">${r.totalFound} active listings on G2G</div>
              </td>
              <td>
                <strong style="font-size: 18px; color: var(--accent-green); font-family: Outfit, sans-serif; letter-spacing: 0.02em;">
                  ${r.formattedLowestPrice}
                </strong>
              </td>
              <td>
                ${cheapestSeller ? `
                  <div style="font-weight: 700; color: #fff; font-size: 13px;">👤 ${escapeHtml(cheapestSeller.name || cheapestSeller.sellerName)}</div>
                  <div style="font-size: 11px; color: var(--accent-cyan);">★ ${escapeHtml(cheapestSeller.rating || cheapestSeller.sellerRating)} • ${Number(cheapestSeller.orders || cheapestSeller.sellerOrders || 0).toLocaleString()} orders</div>
                ` : '<span style="color: var(--text-dim);">—</span>'}
              </td>
              <td>
                <span style="font-weight: 600; color: #fff;">${Number(cheapestSeller?.stock || cheapestSeller?.availableQty || 1).toLocaleString()}</span>
                <span style="font-size: 11px; color: var(--text-dim);"> units</span>
              </td>
              <td>
                <span class="rank-badge rank-default" style="background: rgba(0, 240, 255, 0.1); color: var(--accent-cyan);">${r.totalFound} offers</span>
              </td>
              <td style="text-align: right;">
                <a href="${escapeHtml(g2gUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-cyan btn-sm" style="font-size: 11px; padding: 5px 12px; white-space: nowrap;">
                  View on G2G ↗
                </a>
              </td>
            </tr>
          `;
        }).join('');
      }

      if (multiArea) multiArea.style.display = 'block';
      if (!isAutoRefresh) {
        showToast(`Scanned ${data.results.length} products! Comparison table ready below.`, 'success');
      }
    } catch (err) {
      console.error('Batch scan error:', err);
      if (!isAutoRefresh) {
        if (multiArea) multiArea.style.display = 'none';
        if (errorBox) {
          errorBox.style.display = 'block';
          document.getElementById('radarErrorTitle').textContent = 'Network or API Error';
          document.getElementById('radarErrorMessage').textContent = 'Failed to fetch batch prices from G2G. Please try again.';
        }
      }
    } finally {
      radarIsScanning = false;
      if (spinner) spinner.style.display = 'none';
      if (scanIcon) scanIcon.style.display = 'inline-block';
      renderRadarQueue();
    }
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Boot
  async function boot() {
    setupEvents();
    startRadarAutoRefreshTimer();
    updateRadarAutoRefreshUI();
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

