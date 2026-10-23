/**
 * Kola Express - Authoritative Delivery Realtime & Notification Service
 * 
 * Provides:
 * 1. Authoritative delivery state extraction (joined with couriers & latest history)
 * 2. Authenticated, tenant-isolated Server-Sent Events (SSE) streaming
 * 3. Security filtering: Customers only receive events for deliveries belonging to them
 * 4. Dual-bridge to Supabase database & Supabase Realtime when configured
 * 5. Instant event dispatching across all backend status transition points
 */

const EventEmitter = require('events');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { isSupabaseConfigured, getSupabaseClient, getSupabaseAdmin } = require('../supabase');

function getAuthVerifier() {
  try {
    return require('../routes/auth').verifyToken;
  } catch (_) {
    return (t) => jwt.verify(t, process.env.JWT_SECRET || 'kola_express_secret_jwt_key_2026');
  }
}

class DeliveryRealtimeService extends EventEmitter {
  constructor() {
    super();
    // Maximum listeners to prevent memory leak warnings with many clients
    this.setMaxListeners(200);

    // Map of connected client connections: connectionId -> clientInfo
    this.clients = new Map();
    this.nextClientId = 1;

    // Supabase Realtime channel instance if active
    this.supabaseChannel = null;
    this.initSupabaseRealtimeBridge();

    // Heartbeat timer to keep SSE connections alive across reverse proxies & routers
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 20000);
  }

  /**
   * Initializes Supabase Realtime channel bridge if Supabase credentials are configured
   */
  initSupabaseRealtimeBridge() {
    if (!isSupabaseConfigured()) {
      return;
    }

    try {
      const client = getSupabaseAdmin() || getSupabaseClient();
      if (!client || typeof client.channel !== 'function') return;

      this.supabaseChannel = client.channel('kola-express-delivery-events')
        .on('broadcast', { event: 'delivery_update' }, (payload) => {
          if (payload && payload.deliveryId) {
            // Forward Supabase broadcast to local SSE listeners
            this.dispatchToAuthorizedClients(payload.deliveryId, payload.data, 'supabase_realtime');
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.log('✓ Supabase Realtime channel subscribed: kola-express-delivery-events');
          }
        });
    } catch (err) {
      console.warn('Supabase Realtime bridge initialization warning:', err.message);
    }
  }

  /**
   * Sends SSE heartbeat comment to keep active connections alive
   */
  sendHeartbeat() {
    const pingMessage = ': ping\n\n';
    for (const [id, client] of this.clients.entries()) {
      try {
        client.res.write(pingMessage);
      } catch (err) {
        this.removeClient(id);
      }
    }
  }

  /**
   * Extracts authoritative delivery payload with courier details, latest update, and ETA
   */
  getDeliveryPayload(deliveryId) {
    if (!deliveryId) return null;

    const delivery = db.prepare(`
      SELECT d.*, 
             c.full_name as courier_name, 
             c.phone as courier_phone, 
             c.plate_number as courier_plate, 
             c.vehicle_type as courier_vehicle,
             c.rating as courier_rating,
             c.total_trips as courier_trips
      FROM deliveries d
      LEFT JOIN couriers c ON d.courier_id = c.id
      WHERE d.id = ?
    `).get(deliveryId);

    if (!delivery) return null;

    // Get latest status history record
    const latestHistory = db.prepare(`
      SELECT status, note, updated_by, timestamp 
      FROM delivery_status_history 
      WHERE delivery_id = ? 
      ORDER BY id DESC LIMIT 1
    `).get(deliveryId);

    // Get handover confirmation if exists
    const handover = db.prepare(`
      SELECT handover_id, confirmed_at, status 
      FROM handover_confirmations 
      WHERE delivery_id = ? 
      ORDER BY id DESC LIMIT 1
    `).get(deliveryId);

    // Format ETA
    let etaMinutes = delivery.eta_minutes || delivery.estimated_travel_time || 20;
    let etaText = `${etaMinutes} mins`;
    if (delivery.status === 'Delivered') {
      etaText = 'Delivered';
    } else if (delivery.status === 'Near Destination') {
      etaText = 'Arriving now (< 5 mins)';
    } else if (delivery.status === 'Awaiting Sender Confirmation') {
      etaText = 'Courier at pickup point';
    }

    // Format human-friendly status metadata
    const statusMeta = this.formatStatusMeta(delivery.status, delivery, latestHistory);

    return {
      delivery: {
        ...delivery,
        dropoff_location: delivery.delivery_location,
        price: delivery.delivery_fee,
        delivery_status: delivery.status
      },
      courier: delivery.courier_id ? {
        id: delivery.courier_id,
        name: delivery.courier_name,
        phone: delivery.courier_phone,
        plate: delivery.courier_plate,
        vehicle: delivery.courier_vehicle || 'Boda Boda (Motorcycle)',
        rating: delivery.courier_rating || 4.9,
        total_trips: delivery.courier_trips || 0
      } : null,
      latest_update: latestHistory ? {
        status: latestHistory.status,
        note: latestHistory.note,
        updated_by: latestHistory.updated_by,
        timestamp: latestHistory.timestamp,
        formatted_time: new Date(latestHistory.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } : {
        status: delivery.status,
        note: `Status is ${delivery.status}`,
        updated_by: 'Kola System',
        timestamp: delivery.created_at,
        formatted_time: new Date(delivery.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      },
      handover: handover || null,
      eta_minutes: etaMinutes,
      eta_text: etaText,
      status_meta: statusMeta,
      notification: statusMeta,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Status metadata with concise customer-friendly text and icon
   */
  formatStatusMeta(status, delivery, latestHistory) {
    const courierName = delivery.courier_name || 'Courier';
    switch (status) {
      case 'Request Created':
        return {
          title: 'Request Created',
          headline: 'Delivery request submitted',
          message: 'Your delivery request has been registered and is awaiting cashless payment.',
          icon: '📝',
          badgeClass: 'badge-info',
          color: '#2563eb',
          stepIndex: 1
        };
      case 'Awaiting Payment':
        return {
          title: 'Awaiting Payment',
          headline: 'Awaiting Cashless Payment',
          message: 'Please complete payment via MTN MoMo or Airtel Money to dispatch courier.',
          icon: '💳',
          badgeClass: 'badge-warning',
          color: '#d97706',
          stepIndex: 1
        };
      case 'Payment Confirmed':
        return {
          title: 'Payment Confirmed',
          headline: 'Payment confirmed & verified',
          message: 'Payment received. Assigning the nearest verified Kola Express courier.',
          icon: '✓',
          badgeClass: 'badge-success',
          color: '#059669',
          stepIndex: 1
        };
      case 'Courier Assigned':
        return {
          title: 'Courier Assigned',
          headline: `Courier ${courierName} assigned`,
          message: `Courier ${courierName} has been assigned and is preparing to head to your pickup location.`,
          icon: '👤',
          badgeClass: 'badge-primary',
          color: '#2563eb',
          stepIndex: 2
        };
      case 'Courier En Route to Pickup':
        return {
          title: 'Courier On The Way',
          headline: `Courier ${courierName} is en route to pickup`,
          message: `Your courier is en route to ${delivery.pickup_location}. Please prepare the package for handover.`,
          icon: '📍',
          badgeClass: 'badge-info',
          color: '#2563eb',
          stepIndex: 2
        };
      case 'Awaiting Sender Confirmation':
        return {
          title: 'Courier Has Arrived at Pickup',
          headline: `Courier ${courierName} arrived at pickup`,
          message: `Your courier has arrived to collect the package. Please confirm physical handover.`,
          icon: '📍',
          badgeClass: 'badge-warning',
          color: '#ea580c',
          stepIndex: 3
        };
      case 'Package Picked Up':
      case 'Item Picked Up':
        return {
          title: 'Package Picked Up',
          headline: 'Package securely collected',
          message: 'Physical handover confirmed by sender. Preparing for transit dispatch.',
          icon: '📦',
          badgeClass: 'badge-success',
          color: '#059669',
          stepIndex: 3
        };
      case 'In Transit':
        return {
          title: 'Package in Transit',
          headline: 'Package on the way to destination',
          message: 'Your package has been picked up and is now on the way to the recipient.',
          icon: '📦',
          badgeClass: 'badge-primary',
          color: '#2563eb',
          stepIndex: 4
        };
      case 'Near Destination':
        return {
          title: 'Courier Has Arrived',
          headline: 'Courier arrived near destination',
          message: `Your courier has arrived at ${delivery.delivery_location}. Recipient should have their 4-digit PIN ready.`,
          icon: '📍',
          badgeClass: 'badge-warning',
          color: '#d97706',
          stepIndex: 5
        };
      case 'Delivered':
        return {
          title: 'Package Delivered',
          headline: 'Delivered to rightful owner',
          message: `Your package has been successfully delivered and verified with Special Delivery PIN.`,
          icon: '✅',
          badgeClass: 'badge-success',
          color: '#059669',
          stepIndex: 6
        };
      case 'Cancelled':
        return {
          title: 'Delivery Cancelled',
          headline: 'Delivery request cancelled',
          message: latestHistory?.note || 'This delivery has been cancelled.',
          icon: '❌',
          badgeClass: 'badge-danger',
          color: '#dc2626',
          stepIndex: 0
        };
      default:
        return {
          title: status,
          headline: status,
          message: latestHistory?.note || `Delivery status: ${status}`,
          icon: '📦',
          badgeClass: 'badge-info',
          color: '#2563eb',
          stepIndex: 1
        };
    }
  }

  /**
   * Retrieves the currently active delivery for an authenticated customer or courier
   */
  getActiveDeliveryForUser(user) {
    if (!user) return null;

    let delivery = null;

    if (user.role === 'courier') {
      // Couriers do not have customer dashboard active deliveries
      return null;
    } else {
      // Customer: Active delivery where status is NOT Cancelled, and either NOT Delivered
      // or Delivered within the last 15 minutes
      delivery = db.prepare(`
        SELECT id FROM deliveries
        WHERE (customer_id = ? OR (sender_phone = ? AND ? != ''))
          AND (
            status NOT IN ('Delivered', 'Cancelled')
            OR (status = 'Delivered' AND delivered_at >= datetime('now', '-15 minutes'))
          )
        ORDER BY 
          CASE 
            WHEN status NOT IN ('Delivered', 'Cancelled') THEN 1
            ELSE 2
          END,
          id DESC
        LIMIT 1
      `).get(user.id, user.phone || '', user.phone || '');
    }

    if (!delivery) return null;
    return this.getDeliveryPayload(delivery.id);
  }

  /**
   * Syncs delivery update to Supabase PostgreSQL if Supabase is active
   */
  async syncToSupabase(deliveryId, payload) {
    if (!isSupabaseConfigured() || !payload) return;

    try {
      const adminClient = getSupabaseAdmin();
      if (!adminClient) return;

      const d = payload.delivery;
      await adminClient.from('deliveries').upsert({
        id: d.id,
        tracking_number: d.tracking_number,
        customer_id: d.customer_id,
        sender_name: d.sender_name,
        sender_phone: d.sender_phone,
        pickup_location: d.pickup_location,
        recipient_name: d.recipient_name,
        recipient_phone: d.recipient_phone,
        delivery_location: d.delivery_location,
        item_description: d.item_description,
        delivery_fee: d.delivery_fee,
        status: d.status,
        courier_id: d.courier_id,
        courier_assigned_at: d.courier_assigned_at,
        courier_arrived_at: d.courier_arrived_at,
        picked_up_at: d.picked_up_at,
        delivered_at: d.delivered_at,
        handover_confirmed_at: d.handover_confirmed_at,
        handover_confirmation_id: d.handover_confirmation_id,
        eta_minutes: d.eta_minutes
      }, { onConflict: 'id' });

      // Insert history if latest update is present
      if (payload.latest_update) {
        await adminClient.from('delivery_status_history').insert({
          delivery_id: d.id,
          status: payload.latest_update.status,
          note: payload.latest_update.note,
          updated_by: payload.latest_update.updated_by
        });
      }

      // Broadcast on Supabase Realtime channel
      if (this.supabaseChannel) {
        await this.supabaseChannel.send({
          type: 'broadcast',
          event: 'delivery_update',
          payload: { deliveryId, data: payload }
        });
      }
    } catch (err) {
      console.warn('Supabase sync warning (safe fallback to SQLite):', err.message);
    }
  }

  /**
   * MAIN BROADCAST METHOD:
   * Called whenever a delivery status changes anywhere in the backend.
   * Immediately notifies all authorized connected customers with zero latency.
   */
  broadcastDeliveryUpdate(deliveryId, eventDetails = {}) {
    try {
      const payload = this.getDeliveryPayload(deliveryId);
      if (!payload) return;

      // Asynchronously sync to Supabase database without blocking client response
      this.syncToSupabase(deliveryId, payload).catch(() => {});

      // Dispatch to connected SSE clients
      this.dispatchToAuthorizedClients(deliveryId, payload, 'local');
    } catch (err) {
      console.error('Broadcast delivery update error:', err);
    }
  }

  /**
   * Dispatches SSE payload strictly to clients authorized to view this delivery
   * RLS and Tenant Isolation guarantee: Customer never sees other customers' updates.
   */
  dispatchToAuthorizedClients(deliveryId, payload, source = 'local') {
    const delivery = payload.delivery;
    if (!delivery) return;

    for (const [clientId, client] of this.clients.entries()) {
      try {
        let isAuthorized = false;

        if (client.role === 'admin') {
          isAuthorized = true;
        } else if (client.role === 'courier') {
          // Courier only sees deliveries assigned to them
          if (client.courierId && Number(client.courierId) === Number(delivery.courier_id)) {
            isAuthorized = true;
          }
        } else {
          // Customer: Must match customer_id or sender_phone
          if (client.userId && Number(client.userId) === Number(delivery.customer_id)) {
            isAuthorized = true;
          } else if (client.phone && delivery.sender_phone && client.phone === delivery.sender_phone) {
            isAuthorized = true;
          }
        }

        if (!isAuthorized) {
          continue; // Strict isolation: do not send
        }

        // Prepare client-specific payload (Security: strip delivery_pin for couriers)
        let clientPayload = payload;
        if (client.role === 'courier' && clientPayload.delivery?.delivery_pin) {
          clientPayload = {
            ...payload,
            delivery: { ...payload.delivery }
          };
          delete clientPayload.delivery.delivery_pin;
        }

        const sseData = `event: delivery_status_update\ndata: ${JSON.stringify(clientPayload)}\n\n`;
        client.res.write(sseData);
      } catch (err) {
        this.removeClient(clientId);
      }
    }
  }

  /**
   * Attaches an incoming HTTP response stream as an SSE client
   */
  handleSseConnection(req, res) {
    // 1. Authenticate user from query parameter or Authorization header
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication token required for real-time stream' });
    }

    let user = null;
    try {
      const verifier = getAuthVerifier();
      user = verifier(token);
    } catch (err) {
      return res.status(403).json({ error: 'Invalid or expired token for real-time stream' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Malformed authentication token' });
    }

    // Verify user exists in database and is currently active
    let dbUser = null;
    if (user.id) {
      dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE id = ?').get(user.id);
    }
    if (!dbUser && (user.phone || user.email)) {
      if (user.phone) dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE phone = ?').get(user.phone);
      if (!dbUser && user.email) dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE LOWER(email) = LOWER(?)').get(user.email);
    }

    if (!dbUser) {
      return res.status(401).json({ error: 'User account not found' });
    }

    if (dbUser.is_active === 0 || dbUser.is_active === false) {
      return res.status(403).json({ error: 'Account has been deactivated' });
    }

    user = {
      ...user,
      id: dbUser.id,
      role: dbUser.role,
      phone: dbUser.phone,
      email: dbUser.email
    };

    // Resolve courier profile if user is a courier
    let courierId = user.courier_id || null;
    if (user.role === 'courier' && !courierId) {
      const courier = db.prepare('SELECT id FROM couriers WHERE user_id = ? OR phone = ?').get(user.id, user.phone);
      if (courier) courierId = courier.id;
    }

    // 2. Set Server-Sent Events headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    res.flushHeaders?.();

    const clientId = this.nextClientId++;
    const clientInfo = {
      id: clientId,
      res,
      req,
      userId: user.id,
      userRole: user.role,
      role: user.role,
      phone: user.phone || '',
      email: user.email || '',
      courierId
    };

    this.clients.set(clientId, clientInfo);

    // Clean up when client disconnects
    req.on('close', () => {
      this.removeClient(clientId);
    });

    // 3. Send initial connected confirmation
    const connectMsg = `event: connected\ndata: ${JSON.stringify({
      status: 'connected',
      client_id: clientId,
      user_id: user.id,
      timestamp: new Date().toISOString()
    })}\n\n`;
    res.write(connectMsg);

    // 4. Immediately send user's current active delivery if available (Zero-latency startup)
    try {
      const activeDelivery = this.getActiveDeliveryForUser(user);
      if (activeDelivery) {
        let payloadToSend = activeDelivery;
        if (user.role === 'courier' && payloadToSend.delivery?.delivery_pin) {
          payloadToSend = {
            ...activeDelivery,
            delivery: { ...activeDelivery.delivery }
          };
          delete payloadToSend.delivery.delivery_pin;
        }
        payloadToSend = {
          ...payloadToSend,
          is_initial: true
        };
        res.write(`event: delivery_status_update\ndata: ${JSON.stringify(payloadToSend)}\n\n`);
      }
    } catch (activeErr) {
      console.warn('Initial active delivery lookup error:', activeErr.message);
    }
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
    }
  }
}

// Export singleton instance
const realtimeService = new DeliveryRealtimeService();
module.exports = realtimeService;
