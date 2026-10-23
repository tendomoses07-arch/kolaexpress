// Kola Express Client API Helper Module

const API_BASE = '/api';

function getStoredToken() {
  return localStorage.getItem('kola_token');
}

function setStoredToken(token) {
  if (token) {
    localStorage.setItem('kola_token', token);
  } else {
    localStorage.removeItem('kola_token');
  }
}

function getStoredUser() {
  const u = localStorage.getItem('kola_user');
  try {
    return u ? JSON.parse(u) : null;
  } catch (e) {
    return null;
  }
}

function setStoredUser(user) {
  if (user) {
    localStorage.setItem('kola_user', JSON.stringify(user));
  } else {
    localStorage.removeItem('kola_user');
  }
}

async function request(endpoint, options = {}) {
  const token = getStoredToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMsg = (data.error || '').toLowerCase();
    const isAuthTokenFailure = response.status === 401 || (response.status === 403 && (
      errorMsg.includes('token') ||
      errorMsg.includes('expired') ||
      errorMsg.includes('session') ||
      errorMsg.includes('deactivated')
    ));

    if (isAuthTokenFailure && !endpoint.includes('/auth/login') && !endpoint.includes('/auth/register')) {
      // Clear stale, invalid, or expired session data so user is not permanently stuck
      setStoredToken(null);
      setStoredUser(null);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kola:session-expired', { detail: { error: data.error, status: response.status } }));
        if (window.kolaApp && typeof window.kolaApp.handleSessionExpired === 'function') {
          window.kolaApp.handleSessionExpired(data.error);
        }
      }
    }

    const error = new Error(data.error || `Request failed with status ${response.status}`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

const api = {
  // Auth
  auth: {
    async register(userData) {
      const res = await request('/auth/register', {
        method: 'POST',
        body: JSON.stringify(userData)
      });
      setStoredToken(res.token);
      setStoredUser(res.user);
      return res;
    },
    async login(identifier, password) {
      const res = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password })
      });
      setStoredToken(res.token);
      setStoredUser(res.user);
      return res;
    },
    async me() {
      return await request('/auth/me');
    },
    logout() {
      setStoredToken(null);
      setStoredUser(null);
    },
    setUser: setStoredUser,
    setToken: setStoredToken,
    getUser: getStoredUser,
    getToken: getStoredToken,
    async sendVerificationCode(email) {
      return await request('/auth/send-verification-code', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
    },
    async verifyEmail(email, code) {
      return await request('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ email, code })
      });
    },
    async forgotPassword(identifier) {
      return await request('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ identifier, email: identifier })
      });
    },
    async verifyResetCode(identifier, code, token) {
      return await request('/auth/verify-reset-code', {
        method: 'POST',
        body: JSON.stringify({ identifier, code, token })
      });
    },
    async resetPassword(tokenOrData, code, newPassword) {
      const payload = typeof tokenOrData === 'object' && tokenOrData !== null
        ? tokenOrData
        : { token: tokenOrData, code, new_password: newPassword };
      return await request('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
  },

  // Pricing
  pricing: {
    async getRules() {
      return await request('/pricing');
    },
    async calculateQuote(quoteData) {
      return await request('/deliveries/quote', {
        method: 'POST',
        body: JSON.stringify(quoteData)
      });
    }
  },

  // Deliveries
  deliveries: {
    async create(deliveryData) {
      return await request('/deliveries', {
        method: 'POST',
        body: JSON.stringify(deliveryData)
      });
    },
    async get(trackingOrId) {
      return await request(`/deliveries/${encodeURIComponent(trackingOrId)}`);
    },
    async list(phone = null) {
      const url = phone ? `/deliveries?phone=${encodeURIComponent(phone)}` : '/deliveries';
      return await request(url);
    },
    async confirmHandover(deliveryId) {
      return await request(`/deliveries/${deliveryId}/confirm-handover`, {
        method: 'POST'
      });
    },
    async disputeHandover(deliveryId, reason = '') {
      return await request(`/deliveries/${deliveryId}/dispute-handover`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
    },
    async getSuggestions(query) {
      return await request(`/deliveries/suggestions?q=${encodeURIComponent(query)}`);
    },
    async getHandover(deliveryId) {
      return await request(`/deliveries/${deliveryId}/handover`);
    },
    async getActive() {
      return await request('/deliveries/active');
    },
    async getMapConfig() {
      return await request('/deliveries/map-config');
    },
    async reverseGeocode(lat, lng) {
      return await request('/deliveries/reverse-geocode', {
        method: 'POST',
        body: JSON.stringify({ lat, lng })
      });
    }
  },

  // Payments (100% Cashless MTN/Airtel)
  payments: {
    async initiate(paymentData) {
      return await request('/payments/initiate', {
        method: 'POST',
        body: JSON.stringify(paymentData)
      });
    },
    async verify(referenceId, simulateFailure = false) {
      return await request('/payments/verify', {
        method: 'POST',
        body: JSON.stringify({ reference_id: referenceId, simulate_failure: simulateFailure })
      });
    }
  },

  // Courier Operations
  courier: {
    async getMyDeliveries() {
      return await request('/courier/my-deliveries');
    },
    async markArrived(deliveryId, note = '') {
      return await request(`/courier/deliveries/${deliveryId}/arrive`, {
        method: 'POST',
        body: JSON.stringify({ note })
      });
    },
    async updateStatus(deliveryId, status, note = '') {
      return await request(`/courier/deliveries/${deliveryId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, note })
      });
    },
    async confirmReceipt(deliveryId) {
      return await request(`/courier/deliveries/${deliveryId}/confirm-receipt`, {
        method: 'POST'
      });
    },
    async reportNotReceived(deliveryId) {
      return await request(`/courier/deliveries/${deliveryId}/report-not-received`, {
        method: 'POST'
      });
    },
    async verifyPinAndDeliver(deliveryId, pin) {
      return await request(`/courier/deliveries/${deliveryId}/verify-pin-and-deliver`, {
        method: 'POST',
        body: JSON.stringify({ pin })
      });
    }
  },

  // Admin Portal
  admin: {
    async getStats() {
      return await request('/admin/stats');
    },
    async getDeliveries(status = 'all', search = '') {
      return await request(`/admin/deliveries?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`);
    },
    async getHandoverAudit(deliveryId) {
      return await request(`/admin/deliveries/${deliveryId}/handover-audit`);
    },
    async correctHandover(deliveryId, action, reason) {
      return await request(`/admin/deliveries/${deliveryId}/correct-handover`, {
        method: 'POST',
        body: JSON.stringify({ action, reason })
      });
    },
    async assignCourier(deliveryId, courierId) {
      return await request(`/admin/deliveries/${deliveryId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ courier_id: courierId })
      });
    },
    async updateStatus(deliveryId, status, note = '') {
      return await request(`/admin/deliveries/${deliveryId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, note })
      });
    },
    async getCouriers() {
      return await request('/admin/couriers');
    },
    async addCourier(courierData) {
      return await request('/admin/couriers', {
        method: 'POST',
        body: JSON.stringify(courierData)
      });
    },
    async toggleCourier(courierId) {
      return await request(`/admin/couriers/${courierId}/toggle`, {
        method: 'POST'
      });
    },
    async getPayments() {
      return await request('/admin/payments');
    },
    async getPricing() {
      return await request('/admin/pricing');
    },
    async updatePricing(pricingData) {
      return await request('/admin/pricing', {
        method: 'POST',
        body: JSON.stringify(pricingData)
      });
    },
    async getLogs() {
      return await request('/admin/logs');
    }
  },

  // Authoritative Realtime Client (Supabase Realtime & SSE Dual Engine)
  realtime: {
    eventSource: null,
    listeners: {},
    status: 'disconnected',
    reconnectTimer: null,
    reconnectAttempts: 0,

    connect() {
      const token = getStoredToken();
      if (!token) return;
      if (this.eventSource) {
        this.disconnect();
      }

      this.status = 'connecting';
      this.trigger('status', { status: 'connecting' });

      try {
        const url = `${API_BASE}/deliveries/stream?token=${encodeURIComponent(token)}`;
        const es = new EventSource(url);
        this.eventSource = es;

        es.onopen = () => {
          this.status = 'connected';
          this.reconnectAttempts = 0;
          this.trigger('status', { status: 'connected' });
        };

        es.addEventListener('connected', (e) => {
          try {
            const data = JSON.parse(e.data);
            this.trigger('connected', data);
          } catch (err) {}
        });

        es.addEventListener('delivery_status_update', (e) => {
          try {
            const data = JSON.parse(e.data);
            this.trigger('delivery_status_update', data);
          } catch (err) {
            console.error('Error parsing realtime delivery update:', err);
          }
        });

        es.onerror = () => {
          this.status = 'reconnecting';
          this.trigger('status', { status: 'reconnecting' });
          try { es.close(); } catch (e) {}
          this.eventSource = null;

          const delay = Math.min(10000, 2000 * Math.pow(1.4, this.reconnectAttempts));
          this.reconnectAttempts++;
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (getStoredToken()) {
              this.connect();
            }
          }, delay);
        };
      } catch (err) {
        console.warn('Realtime connection error:', err);
      }
    },

    disconnect() {
      clearTimeout(this.reconnectTimer);
      if (this.eventSource) {
        try { this.eventSource.close(); } catch (e) {}
        this.eventSource = null;
      }
      this.status = 'disconnected';
      this.trigger('status', { status: 'disconnected' });
    },

    on(event, callback) {
      if (!this.listeners[event]) this.listeners[event] = [];
      if (!this.listeners[event].includes(callback)) {
        this.listeners[event].push(callback);
      }
      return () => this.off(event, callback);
    },

    off(event, callback) {
      if (!this.listeners[event]) return;
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    },

    trigger(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(cb => {
          try { cb(data); } catch (e) { console.error(e); }
        });
      }
    },

    emit(event, data) {
      this.trigger(event, data);
    }
  }
};

window.kolaApi = api;
