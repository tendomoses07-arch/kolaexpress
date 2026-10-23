// ===================================================================
// KOLA EXPRESS - SECURE ADMIN OPERATIONS PORTAL SCRIPT
// ===================================================================

document.addEventListener('DOMContentLoaded', () => {
  const authCard = document.getElementById('adminAuthCard');
  const dashboardContent = document.getElementById('adminDashboardContent');
  const nameDisplay = document.getElementById('adminNameDisplay');
  const headerLogoutBtn = document.getElementById('adminHeaderLogoutBtn');
  const adminLogoutBtn = document.getElementById('adminLogoutBtn');

  // Check current session
  checkAdminAuth();

  // Theme Sync
  const adminThemeToggleBtn = document.getElementById('adminThemeToggleBtn');
  const savedTheme = localStorage.getItem('kola_theme') || 'light';
  applyAdminTheme(savedTheme);

  function applyAdminTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (adminThemeToggleBtn) adminThemeToggleBtn.textContent = 'Dark';
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (adminThemeToggleBtn) adminThemeToggleBtn.textContent = 'Light';
    }
    localStorage.setItem('kola_theme', theme);
  }

  if (adminThemeToggleBtn) {
    adminThemeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      applyAdminTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  function checkAdminAuth() {
    const user = window.kolaApi.auth.getUser();
    const token = window.kolaApi.auth.getToken();

    if (!token || user?.role !== 'admin') {
      authCard.style.display = 'block';
      dashboardContent.style.display = 'none';
      if (headerLogoutBtn) headerLogoutBtn.style.display = 'none';
    } else {
      authCard.style.display = 'none';
      dashboardContent.style.display = 'block';
      if (typeof closePasswordRecoveryModal === 'function') closePasswordRecoveryModal();
      if (nameDisplay) nameDisplay.textContent = user.full_name;
      if (headerLogoutBtn) headerLogoutBtn.style.display = 'inline-block';
      loadDashboard();
    }
  }

  window.addEventListener('kola:session-expired', () => {
    checkAdminAuth();
  });

  // Admin Login Form
  const loginForm = document.getElementById('adminLoginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (typeof closePasswordRecoveryModal === 'function') closePasswordRecoveryModal();
      const identifier = document.getElementById('adminEmailInput').value.trim();
      const password = document.getElementById('adminPasswordInput').value;

      try {
        const res = await window.kolaApi.auth.login(identifier, password);
        if (res.user.role !== 'admin') {
          window.kolaApi.auth.logout();
          showToast('Access denied: Admin credentials required', 'error');
          return;
        }
        showToast(`Welcome, ${res.user.full_name}`, 'success');
        checkAdminAuth();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Universal Password Visibility Toggle Handler
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.password-toggle-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const wrap = btn.closest('.password-input-wrap');
    const input = wrap ? wrap.querySelector('input') : (btn.dataset.target ? document.getElementById(btn.dataset.target) : null);
    if (!input) return;

    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';

    const showIcon = btn.querySelector('.eye-show');
    const hideIcon = btn.querySelector('.eye-hide');
    if (showIcon && hideIcon) {
      showIcon.style.display = isPass ? 'none' : 'block';
      hideIcon.style.display = isPass ? 'block' : 'none';
    }

    const label = isPass ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);

    try {
      input.focus();
      const valLen = input.value.length;
      input.setSelectionRange(valLen, valLen);
    } catch (_) {}
  });

  // Logout Handlers
  [headerLogoutBtn, adminLogoutBtn].forEach(btn => {
    if (btn) {
      btn.addEventListener('click', () => {
        window.kolaApi.auth.logout();
        showToast('Signed out of admin portal', 'info');
        checkAdminAuth();
      });
    }
  });

  // Admin Tab Navigation
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-tab-pane').forEach(p => p.style.display = 'none');

      btn.classList.add('active');
      const pane = document.getElementById(btn.dataset.pane);
      if (pane) pane.style.display = 'block';
    });
  });

  // Load Dashboard Data
  function loadDashboard() {
    loadStats();
    loadDeliveries();
    loadCouriers();
    loadPayments();
    loadPricing();
  }

  // 1. Stats
  async function loadStats() {
    try {
      const stats = await window.kolaApi.admin.getStats();
      document.getElementById('statTotalDeliveries').textContent = stats.totalDeliveries;
      document.getElementById('statPendingPayments').textContent = stats.pendingPayment;
      document.getElementById('statActiveDeliveries').textContent = stats.activeDeliveries;
      document.getElementById('statCompletedDeliveries').textContent = stats.completedDeliveries;
      document.getElementById('statTotalRevenue').textContent = `UGX ${stats.totalRevenue.toLocaleString()}`;
      document.getElementById('statActiveCouriers').textContent = stats.activeCouriersCount;
    } catch (err) {
      console.warn('Stats error:', err);
    }
  }

  // 2. Deliveries Dispatch
  let cachedCouriers = [];
  async function loadDeliveries() {
    const tbody = document.getElementById('adminDeliveriesTableBody');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading deliveries...</td></tr>';

    try {
      cachedCouriers = await window.kolaApi.admin.getCouriers();
      const filter = document.getElementById('adminStatusFilter')?.value || 'all';
      const search = document.getElementById('adminSearchInput')?.value || '';

      const deliveries = await window.kolaApi.admin.getDeliveries(filter, search);
      tbody.innerHTML = '';

      if (deliveries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No deliveries match filter.</td></tr>';
        return;
      }

      deliveries.forEach(d => {
        const tr = document.createElement('tr');
        
        let courierOptions = `<option value="">-- Assign Courier --</option>`;
        cachedCouriers.forEach(c => {
          const selected = d.courier_id === c.id ? 'selected' : '';
          courierOptions += `<option value="${c.id}" ${selected}>${c.full_name} (${c.plate_number})</option>`;
        });

        let handoverCell = '';
        if (d.handover_confirmation_id) {
          handoverCell = `
            <span class="badge badge-success" style="font-size:0.75rem;">✓ Confirmed</span>
            <div style="font-family:monospace; font-size:0.725rem; color:var(--kola-blue-dark); margin-top:0.2rem;">${d.handover_confirmation_id}</div>
          `;
        } else if (d.status === 'Awaiting Sender Confirmation') {
          handoverCell = `
            <span class="badge badge-warning" style="font-size:0.75rem;">⏳ Awaiting Sender</span>
            <div style="font-size:0.7rem; color:#b45309; margin-top:0.2rem;">Arrived: ${d.courier_arrived_at ? new Date(d.courier_arrived_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : 'Pending'}</div>
          `;
        } else if (d.courier_arrived_at) {
          handoverCell = `
            <span class="badge badge-info" style="font-size:0.75rem;">Arrived</span>
          `;
        } else {
          handoverCell = `<span style="color:var(--text-muted); font-size:0.8rem;">— Pending</span>`;
        }

        let pinCell = '';
        if (d.delivery_pin) {
          const isPinVerified = d.delivery_confirmed_by_pin || d.status === 'Delivered';
          pinCell = `
            <div style="font-family:monospace; font-size:0.95rem; font-weight:800; color:var(--kola-blue-dark); letter-spacing:0.1em;">🔐 ${d.delivery_pin}</div>
            <div style="font-size:0.7rem; color:${isPinVerified ? '#059669' : '#b45309'}; font-weight:700;">
              ${isPinVerified ? '✓ Verified by recipient' : '⏳ Awaiting verification'}
            </div>
          `;
        } else {
          pinCell = `<span style="color:var(--text-muted); font-size:0.8rem;">—</span>`;
        }

        tr.innerHTML = `
          <td><strong>${d.tracking_number}</strong><br><small style="color:var(--text-muted);">${new Date(d.created_at).toLocaleDateString()}</small></td>
          <td>
            <strong>${escapeHtml(d.pickup_location)}</strong><br>
            <small style="color:var(--text-dim);">${escapeHtml(d.sender_name)} (${d.sender_phone})</small>
          </td>
          <td>
            <strong>${escapeHtml(d.delivery_location)}</strong><br>
            <small style="color:var(--text-dim);">${escapeHtml(d.recipient_name)} (${d.recipient_phone})</small>
          </td>
          <td>UGX ${d.delivery_fee.toLocaleString()}</td>
          <td><span class="badge ${getStatusBadgeClass(d.status)}">${d.status}</span></td>
          <td>${handoverCell}</td>
          <td>${pinCell}</td>
          <td>
            <select class="form-select admin-assign-select" data-id="${d.id}" style="padding:0.35rem 0.6rem; font-size:0.8rem; width:190px;">
              ${courierOptions}
            </select>
          </td>
          <td style="white-space:nowrap;">
            <button class="btn-secondary view-handover-audit-btn" data-id="${d.id}" style="padding:0.35rem 0.65rem; font-size:0.75rem; margin-right:0.3rem;">📜 Audit</button>
            <a href="/#track?id=${d.tracking_number}" target="_blank" class="copy-btn">Track</a>
          </td>
        `;
        tbody.appendChild(tr);
      });

      // Bind assign courier change
      tbody.querySelectorAll('.admin-assign-select').forEach(select => {
        select.addEventListener('change', async () => {
          const deliveryId = select.dataset.id;
          const courierId = select.value;
          if (!courierId) return;

          try {
            await window.kolaApi.admin.assignCourier(deliveryId, courierId);
            showToast('Courier assigned successfully', 'success');
            loadDashboard();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });

      // Bind view handover audit buttons
      tbody.querySelectorAll('.view-handover-audit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          openHandoverAuditModal(btn.dataset.id);
        });
      });

    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--danger-red);">${err.message}</td></tr>`;
    }
  }

  // Handover Audit Modal Handlers
  const adminHandoverModal = document.getElementById('adminHandoverModal');
  const adminHandoverModalClose = document.getElementById('adminHandoverModalClose');

  function closeHandoverModal() {
    if (adminHandoverModal) adminHandoverModal.classList.remove('active');
  }

  if (adminHandoverModalClose) adminHandoverModalClose.addEventListener('click', closeHandoverModal);
  if (adminHandoverModal) {
    adminHandoverModal.addEventListener('click', (e) => {
      if (e.target === adminHandoverModal) closeHandoverModal();
    });
  }

  async function openHandoverAuditModal(deliveryId) {
    if (!adminHandoverModal) return;
    
    try {
      const data = await window.kolaApi.admin.getHandoverAudit(deliveryId);
      const { delivery, auditTrail, history } = data;

      document.getElementById('auditModalTracking').textContent = delivery.tracking_number;
      document.getElementById('correctDeliveryId').value = delivery.id;

      // 1. Courier Arrived
      const arrivedBadge = document.getElementById('auditCourierStatusBadge');
      if (auditTrail.courier_arrived.timestamp) {
        const arrDate = new Date(auditTrail.courier_arrived.timestamp);
        document.getElementById('auditCourierArrivedDate').textContent = arrDate.toLocaleDateString();
        document.getElementById('auditCourierArrivedTime').textContent = arrDate.toLocaleTimeString();
        document.getElementById('auditCourierName').textContent = `${auditTrail.courier_arrived.courier} (${delivery.courier_phone || 'N/A'}, Plate: ${delivery.courier_plate || 'N/A'})`;
        arrivedBadge.className = 'badge badge-success';
        arrivedBadge.textContent = 'ARRIVED';
      } else {
        document.getElementById('auditCourierArrivedDate').textContent = '—';
        document.getElementById('auditCourierArrivedTime').textContent = '—';
        document.getElementById('auditCourierName').textContent = auditTrail.courier_arrived.courier;
        arrivedBadge.className = 'badge badge-warning';
        arrivedBadge.textContent = 'PENDING';
      }

      // 2. Sender Confirmed Handover
      const senderBadge = document.getElementById('auditSenderStatusBadge');
      if (auditTrail.sender_confirmed.timestamp) {
        const confDate = new Date(auditTrail.sender_confirmed.timestamp);
        document.getElementById('auditSenderConfirmedDate').textContent = confDate.toLocaleDateString();
        document.getElementById('auditSenderConfirmedTime').textContent = confDate.toLocaleTimeString();
        document.getElementById('auditSenderName').textContent = `${auditTrail.sender_confirmed.sender} (${delivery.sender_phone})`;
        document.getElementById('auditConfirmationId').textContent = auditTrail.sender_confirmed.confirmation_id || 'N/A';
        senderBadge.className = 'badge badge-success';
        senderBadge.textContent = 'CONFIRMED';
      } else {
        document.getElementById('auditSenderConfirmedDate').textContent = '—';
        document.getElementById('auditSenderConfirmedTime').textContent = '—';
        document.getElementById('auditSenderName').textContent = `${auditTrail.sender_confirmed.sender} (${delivery.sender_phone})`;
        document.getElementById('auditConfirmationId').textContent = 'Awaiting Physical Handover';
        senderBadge.className = 'badge badge-warning';
        senderBadge.textContent = delivery.status === 'Awaiting Sender Confirmation' ? 'AWAITING' : 'NOT CONFIRMED';
      }

      // 3. Package Picked Up
      const pickupBadge = document.getElementById('auditPickupStatusBadge');
      if (auditTrail.package_picked_up.timestamp) {
        const pDate = new Date(auditTrail.package_picked_up.timestamp);
        document.getElementById('auditPickedUpDate').textContent = pDate.toLocaleDateString();
        document.getElementById('auditPickedUpTime').textContent = pDate.toLocaleTimeString();
        pickupBadge.className = 'badge badge-success';
        pickupBadge.textContent = 'CUSTODY TRANSFERRED';
      } else {
        document.getElementById('auditPickedUpDate').textContent = '—';
        document.getElementById('auditPickedUpTime').textContent = '—';
        pickupBadge.className = 'badge badge-warning';
        pickupBadge.textContent = 'PENDING';
      }

      // 4. Recipient PIN Verification (Rightful Owner Confirmation)
      const pinBadge = document.getElementById('auditPinStatusBadge');
      const pinData = auditTrail.recipient_pin_delivery;
      if (pinData && document.getElementById('auditSpecialPin')) {
        document.getElementById('auditSpecialPin').textContent = pinData.pin || '—';
        document.getElementById('auditRecipientName').textContent = `${delivery.recipient_name} (${delivery.recipient_phone})`;

        if (pinData.verified && pinData.verified_at) {
          const vDate = new Date(pinData.verified_at);
          document.getElementById('auditPinVerifiedDate').textContent = vDate.toLocaleDateString();
          document.getElementById('auditPinVerifiedTime').textContent = vDate.toLocaleTimeString();
          if (pinBadge) {
            pinBadge.className = 'badge badge-success';
            pinBadge.textContent = 'RIGHTFUL OWNER VERIFIED';
          }
        } else {
          document.getElementById('auditPinVerifiedDate').textContent = '—';
          document.getElementById('auditPinVerifiedTime').textContent = '—';
          if (pinBadge) {
            pinBadge.className = 'badge badge-warning';
            pinBadge.textContent = 'AWAITING RECIPIENT PIN';
          }
        }
      }

      // Render transition log
      const logContainer = document.getElementById('auditTimelineLog');
      logContainer.innerHTML = '';
      (history || []).forEach(h => {
        const row = document.createElement('div');
        row.style.padding = '0.35rem 0';
        row.style.borderBottom = '1px solid var(--border-subtle)';
        row.innerHTML = `
          <div style="display:flex; justify-content:space-between; font-weight:700;">
            <span>${escapeHtml(h.status)}</span>
            <span style="color:var(--text-muted); font-size:0.75rem;">${new Date(h.timestamp).toLocaleString()}</span>
          </div>
          <div style="color:var(--text-dim); font-size:0.75rem;">By: <strong>${escapeHtml(h.updated_by)}</strong> • ${escapeHtml(h.note || '')}</div>
        `;
        logContainer.appendChild(row);
      });

      adminHandoverModal.classList.add('active');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // Admin Handover Correction Form Handler (Requirement 7)
  const correctionForm = document.getElementById('adminHandoverCorrectionForm');
  if (correctionForm) {
    correctionForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const deliveryId = document.getElementById('correctDeliveryId').value;
      const action = document.getElementById('correctActionSelect').value;
      const reason = document.getElementById('correctReasonInput').value.trim();

      if (!reason) {
        showToast('Please provide an audit justification reason', 'warning');
        return;
      }

      try {
        const res = await window.kolaApi.admin.correctHandover(deliveryId, action, reason);
        showToast(res.message, 'success');
        openHandoverAuditModal(deliveryId);
        loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const adminFilter = document.getElementById('adminStatusFilter');
  if (adminFilter) adminFilter.addEventListener('change', loadDeliveries);

  const adminSearch = document.getElementById('adminSearchInput');
  if (adminSearch) {
    adminSearch.addEventListener('input', () => {
      clearTimeout(window._searchTimer);
      window._searchTimer = setTimeout(loadDeliveries, 300);
    });
  }

  // 3. Couriers Fleet
  async function loadCouriers() {
    const grid = document.getElementById('adminCouriersGrid');
    if (!grid) return;

    try {
      const couriers = await window.kolaApi.admin.getCouriers();
      grid.innerHTML = '';

      couriers.forEach(c => {
        const item = document.createElement('div');
        item.className = 'form-card';
        item.style.padding = '1.25rem';
        item.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:0.75rem;">
            <div>
              <h4 style="font-size:1.1rem; margin-bottom:0.15rem;">${escapeHtml(c.full_name)}</h4>
              <div style="color:var(--kola-blue-dark); font-size:0.85rem; font-weight:700;">${c.phone}</div>
            </div>
            <span class="badge ${c.status === 'active' ? 'badge-success' : 'badge-danger'}">${c.status}</span>
          </div>

          <div style="font-size:0.825rem; color:var(--text-muted); margin-bottom:1rem;">
            <div>Vehicle: <strong>${escapeHtml(c.vehicle_type)}</strong></div>
            <div>Plate Number: <strong>${escapeHtml(c.plate_number)}</strong></div>
            <div>Trips: <strong>${c.total_trips}</strong> | Rating: <strong>★ ${c.rating}</strong></div>
          </div>

          <button class="btn-secondary toggle-courier-btn" data-id="${c.id}" style="padding:0.4rem 0.8rem; font-size:0.8rem; width:100%;">
            ${c.status === 'active' ? 'Set Offline' : 'Set Active'}
          </button>
        `;
        grid.appendChild(item);
      });

      grid.querySelectorAll('.toggle-courier-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          try {
            await window.kolaApi.admin.toggleCourier(id);
            showToast('Courier status updated', 'success');
            loadCouriers();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });
    } catch (err) {
      grid.innerHTML = `<div style="color:var(--danger-red);">${err.message}</div>`;
    }
  }

  // Add Courier Form
  const addCourierForm = document.getElementById('addCourierForm');
  if (addCourierForm) {
    addCourierForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const full_name = document.getElementById('newCourierName')?.value.trim();
      const phone = document.getElementById('newCourierPhone')?.value.trim();
      const vehicle_type = document.getElementById('newCourierVehicle')?.value.trim();
      const plate_number = document.getElementById('newCourierPlate')?.value.trim();

      try {
        await window.kolaApi.admin.addCourier({ full_name, phone, vehicle_type, plate_number });
        showToast('Courier registered successfully', 'success');
        addCourierForm.reset();
        loadCouriers();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // 4. Payments Ledger
  async function loadPayments() {
    const tbody = document.getElementById('adminPaymentsTableBody');
    if (!tbody) return;

    try {
      const payments = await window.kolaApi.admin.getPayments();
      tbody.innerHTML = '';

      if (payments.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No payment transactions recorded.</td></tr>';
        return;
      }

      payments.forEach(p => {
        const tr = document.createElement('tr');
        const isSuccess = p.payment_status === 'Successful';
        tr.innerHTML = `
          <td><strong>${p.reference_id}</strong></td>
          <td>${p.tracking_number}</td>
          <td>${escapeHtml(p.payment_method)} (${p.customer_phone})</td>
          <td><strong>UGX ${p.amount.toLocaleString()}</strong></td>
          <td><span class="badge ${isSuccess ? 'badge-success' : 'badge-warning'}">${p.payment_status}</span></td>
          <td><small style="color:var(--text-muted);">${new Date(p.created_at).toLocaleString()}</small></td>
        `;
        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger-red);">${err.message}</td></tr>`;
    }
  }

  // 5. Pricing Configuration
  async function loadPricing() {
    try {
      const rules = await window.kolaApi.admin.getPricing();
      document.getElementById('ruleBaseFee').value = rules.base_fee;
      document.getElementById('rulePerKmRate').value = rules.per_km_rate;
      document.getElementById('ruleMinFee').value = rules.min_fee;
      document.getElementById('ruleUrgentSurcharge').value = rules.urgent_surcharge;

      const cats = rules.category_surcharges || {};
      document.getElementById('catDocFee').value = cats.document ?? 0;
      document.getElementById('catSmallParcelFee').value = cats.small_parcel ?? 500;
      document.getElementById('catMediumBoxFee').value = cats.medium_box ?? 1500;
      document.getElementById('catLargePackageFee').value = cats.large_package ?? 3000;
      document.getElementById('catGroceriesFee').value = cats.groceries ?? 1000;
      document.getElementById('catFragileFee').value = cats.fragile ?? 2000;
    } catch (err) {
      console.warn('Pricing load error:', err);
    }
  }

  const pricingConfigForm = document.getElementById('pricingConfigForm');
  if (pricingConfigForm) {
    pricingConfigForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const base_fee = Number(document.getElementById('ruleBaseFee').value);
      const per_km_rate = Number(document.getElementById('rulePerKmRate').value);
      const min_fee = Number(document.getElementById('ruleMinFee').value);
      const urgent_surcharge = Number(document.getElementById('ruleUrgentSurcharge').value);

      const category_surcharges = {
        document: Number(document.getElementById('catDocFee').value),
        small_parcel: Number(document.getElementById('catSmallParcelFee').value),
        medium_box: Number(document.getElementById('catMediumBoxFee').value),
        large_package: Number(document.getElementById('catLargePackageFee').value),
        groceries: Number(document.getElementById('catGroceriesFee').value),
        fragile: Number(document.getElementById('catFragileFee').value)
      };

      try {
        await window.kolaApi.admin.updatePricing({
          base_fee,
          per_km_rate,
          min_fee,
          urgent_surcharge,
          category_surcharges
        });
        showToast('Pricing rules saved! New quotes will use these rates immediately.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Utilities
  function getStatusBadgeClass(status) {
    if (status === 'Delivered') return 'badge-success';
    if (status === 'Cancelled') return 'badge-danger';
    if (status === 'Awaiting Sender Confirmation') return 'badge-warning';
    if (['In Transit', 'Near Destination', 'Package Picked Up', 'Item Picked Up'].includes(status)) return 'badge-info';
    return 'badge-warning';
  }

  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✓' : (type === 'error' ? '✕' : 'ℹ');
    toast.innerHTML = `<span style="font-weight:bold; font-size:1.1rem;">${icon}</span> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ===================================================================
  // ADMIN PASSWORD RECOVERY MANAGER
  // ===================================================================
  const modalRecovery = document.getElementById('modalPasswordRecovery');
  const formStep1 = document.getElementById('recoveryStep1Form');
  const formStep2 = document.getElementById('recoveryStep2Form');
  const formStep3 = document.getElementById('recoveryStep3Form');
  const viewSuccess = document.getElementById('recoverySuccessView');

  const inputRecoveryIdentifier = document.getElementById('recoveryIdentifierInput');
  const inputRecoveryCode = document.getElementById('recoveryCodeInput');
  const inputRecoveryNewPass = document.getElementById('recoveryNewPassword');
  const inputRecoveryConfPass = document.getElementById('recoveryConfirmPassword');

  const errStep1 = document.getElementById('recoveryStep1Error');
  const errStep2 = document.getElementById('recoveryStep2Error');
  const errStep3 = document.getElementById('recoveryStep3Error');

  const targetMaskedEmail = document.getElementById('recoveryTargetMaskedEmail');
  const btnCloseRecovery = document.getElementById('closeRecoveryModalBtn');
  const btnBackStep1 = document.getElementById('recoveryBackToStep1Btn');
  const btnResend = document.getElementById('recoveryResendBtn');
  const btnRecoveryDone = document.getElementById('recoveryDoneBtn');

  let activeRecoveryToken = null;
  let activeRecoveryIdentifier = '';

  function openPasswordRecoveryModal(prefilledIdentifier = '') {
    if (!modalRecovery) return;
    activeRecoveryToken = null;
    activeRecoveryIdentifier = prefilledIdentifier;

    if (formStep1) { formStep1.reset(); formStep1.style.display = 'block'; }
    if (formStep2) { formStep2.reset(); formStep2.style.display = 'none'; }
    if (formStep3) { formStep3.reset(); formStep3.style.display = 'none'; }
    if (viewSuccess) viewSuccess.style.display = 'none';

    if (errStep1) errStep1.style.display = 'none';
    if (errStep2) errStep2.style.display = 'none';
    if (errStep3) errStep3.style.display = 'none';

    if (inputRecoveryIdentifier && prefilledIdentifier) {
      inputRecoveryIdentifier.value = prefilledIdentifier;
    }

    modalRecovery.style.display = 'flex';
    modalRecovery.classList.add('active');
    setTimeout(() => {
      if (inputRecoveryIdentifier) inputRecoveryIdentifier.focus();
    }, 100);
  }

  function closePasswordRecoveryModal() {
    if (!modalRecovery) return;
    modalRecovery.style.display = 'none';
    modalRecovery.classList.remove('active');
    activeRecoveryToken = null;
    activeRecoveryIdentifier = '';
  }

  if (btnCloseRecovery) btnCloseRecovery.addEventListener('click', closePasswordRecoveryModal);

  const btnCancelStep1 = document.getElementById('recoveryStep1CancelBtn');
  if (btnCancelStep1) {
    btnCancelStep1.addEventListener('click', () => {
      closePasswordRecoveryModal();
      const adminEmailInput = document.getElementById('adminEmailInput');
      if (adminEmailInput) adminEmailInput.focus();
    });
  }

  if (modalRecovery) {
    modalRecovery.addEventListener('click', (e) => {
      if (e.target === modalRecovery) {
        closePasswordRecoveryModal();
      }
    });
  }

  if (btnRecoveryDone) btnRecoveryDone.addEventListener('click', () => {
    const savedId = activeRecoveryIdentifier;
    closePasswordRecoveryModal();
    const adminEmailInput = document.getElementById('adminEmailInput');
    if (adminEmailInput && savedId) {
      adminEmailInput.value = savedId;
      const pass = document.getElementById('adminPasswordInput');
      if (pass) pass.focus();
    }
    showToast('Please sign in with your updated password.', 'info');
  });

  const adminForgLink = document.getElementById('adminPublicForgotPasswordLink');
  if (adminForgLink) {
    adminForgLink.addEventListener('click', (e) => {
      e.preventDefault();
      const adminEmailInput = document.getElementById('adminEmailInput');
      const candidate = adminEmailInput ? adminEmailInput.value.trim() : '';
      openPasswordRecoveryModal(candidate);
    });
  }

  if (formStep1) {
    formStep1.addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = inputRecoveryIdentifier ? inputRecoveryIdentifier.value.trim() : '';
      if (!identifier) return;

      if (!identifier.includes('@') || !identifier.includes('.')) {
        if (errStep1) {
          errStep1.textContent = 'Please enter a valid email address.';
          errStep1.style.display = 'block';
        } else {
          showToast('Please enter a valid email address.', 'warning');
        }
        return;
      }

      if (errStep1) errStep1.style.display = 'none';
      const btn = document.getElementById('recoveryStep1SubmitBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span>Sending Code...</span>'; }

      try {
        const res = await window.kolaApi.auth.forgotPassword(identifier);
        activeRecoveryIdentifier = identifier;
        activeRecoveryToken = res.token || null;

        if (targetMaskedEmail) {
          targetMaskedEmail.textContent = res.masked_email || identifier;
        }

        formStep1.style.display = 'none';
        if (formStep2) {
          formStep2.style.display = 'block';
          if (inputRecoveryCode) {
            inputRecoveryCode.value = '';
            inputRecoveryCode.focus();
          }
        }
        showToast('Recovery verification code sent to your email.', 'success');
      } catch (err) {
        if (errStep1) {
          errStep1.textContent = err.message;
          errStep1.style.display = 'block';
        } else {
          showToast(err.message, 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span>Send Recovery Code to Email →</span>'; }
      }
    });
  }

  if (formStep2) {
    formStep2.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = inputRecoveryCode ? inputRecoveryCode.value.trim() : '';
      if (!code) return;

      if (errStep2) errStep2.style.display = 'none';
      const btn = document.getElementById('recoveryStep2SubmitBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span>Verifying Code...</span>'; }

      try {
        const res = await window.kolaApi.auth.verifyResetCode(activeRecoveryIdentifier, code, activeRecoveryToken);
        if (res.token) activeRecoveryToken = res.token;

        formStep2.style.display = 'none';
        if (formStep3) {
          formStep3.style.display = 'block';
          if (inputRecoveryNewPass) {
            inputRecoveryNewPass.value = '';
            inputRecoveryNewPass.focus();
          }
        }
        showToast('Code verified! Enter your new password.', 'success');
      } catch (err) {
        if (errStep2) {
          errStep2.textContent = err.message;
          errStep2.style.display = 'block';
        } else {
          showToast(err.message, 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span>Verify Code &amp; Continue →</span>'; }
      }
    });
  }

  if (btnBackStep1) {
    btnBackStep1.addEventListener('click', () => {
      if (formStep2) formStep2.style.display = 'none';
      if (formStep1) {
        formStep1.style.display = 'block';
        if (inputRecoveryIdentifier) inputRecoveryIdentifier.focus();
      }
    });
  }

  if (btnResend) {
    btnResend.addEventListener('click', async () => {
      if (!activeRecoveryIdentifier) return;
      btnResend.disabled = true;
      btnResend.textContent = 'Resending...';
      try {
        const res = await window.kolaApi.auth.forgotPassword(activeRecoveryIdentifier);
        activeRecoveryToken = res.token || activeRecoveryToken;
        showToast('A fresh recovery code was sent to your email.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btnResend.disabled = false;
        btnResend.textContent = 'Resend Code';
      }
    });
  }

  if (formStep3) {
    formStep3.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newPass = inputRecoveryNewPass ? inputRecoveryNewPass.value : '';
      const confPass = inputRecoveryConfPass ? inputRecoveryConfPass.value : '';

      if (errStep3) errStep3.style.display = 'none';

      if (newPass !== confPass) {
        if (errStep3) {
          errStep3.textContent = 'Passwords do not match. Please re-enter.';
          errStep3.style.display = 'block';
        } else {
          showToast('Passwords do not match', 'error');
        }
        return;
      }

      if (newPass.length < 4) {
        if (errStep3) {
          errStep3.textContent = 'Password must be at least 4 characters long.';
          errStep3.style.display = 'block';
        } else {
          showToast('Password too short', 'error');
        }
        return;
      }

      const btn = document.getElementById('recoveryStep3SubmitBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span>Updating Password...</span>'; }

      try {
        const res = await window.kolaApi.auth.resetPassword({
          token: activeRecoveryToken,
          code: inputRecoveryCode ? inputRecoveryCode.value.trim() : '',
          new_password: newPass
        });

        formStep3.style.display = 'none';
        if (viewSuccess) viewSuccess.style.display = 'block';
        showToast(res.message || 'Password successfully updated!', 'success');
      } catch (err) {
        if (errStep3) {
          errStep3.textContent = err.message;
          errStep3.style.display = 'block';
        } else {
          showToast(err.message, 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span>Update Password &amp; Finish →</span>'; }
      }
    });
  }
});
