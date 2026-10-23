const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { calculateDeliveryQuote, calculateLiveDeliveryQuote } = require('../pricing');
const { searchAddressSuggestions, geocodeAddress } = require('../services/mapService');
const googleMapsService = require('../services/googleMapsService');
const { sanitizeAndValidateUgandaPhone } = require('../paymentGateway');
const realtimeService = require('../services/realtimeService');
const jwt = require('jsonwebtoken');
const { authenticateToken, verifyToken, JWT_SECRET } = require('./auth');

// Helper to optionally parse user token if present
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      const decodedUser = typeof verifyToken === 'function' ? verifyToken(token) : jwt.verify(token, JWT_SECRET);
      if (decodedUser) {
        let dbUser = null;
        if (decodedUser.id) {
          dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE id = ?').get(decodedUser.id);
        }
        if (!dbUser && (decodedUser.phone || decodedUser.email)) {
          if (decodedUser.phone) dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE phone = ?').get(decodedUser.phone);
          if (!dbUser && decodedUser.email) dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE LOWER(email) = LOWER(?)').get(decodedUser.email);
        }
        if (dbUser && dbUser.is_active !== 0) {
          req.user = {
            ...decodedUser,
            id: dbUser.id,
            full_name: dbUser.full_name,
            phone: dbUser.phone,
            email: dbUser.email,
            role: dbUser.role,
            admin_role: dbUser.admin_role,
            is_active: dbUser.is_active
          };
        }
      }
    } catch (_) {
      // Gracefully continue without failing on expired or invalid token in optionalAuth
    }
  }
  next();
}

// Generate unique tracking number e.g. KOLA-20261005-123456
function generateTrackingNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `KOLA-${year}${month}${day}-${rand}`;
}

// Generate secure 4-digit recipient verification delivery PIN
function generateDeliveryPin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// 0. Live Address Autocomplete Suggestions (Public endpoint for real-time address typing)
router.get('/suggestions', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.json({ suggestions: [] });
    }
    const suggestions = await searchAddressSuggestions(q.trim());
    res.json({ suggestions });
  } catch (err) {
    res.json({ suggestions: [] });
  }
});

// 0b. Live Map Provider & Config Endpoint
router.get('/map-config', (req, res) => {
  res.json(googleMapsService.getPublicMapConfig());
});

// 0b-2. Device Current Location Reverse Geocoding ("Use my current location")
router.post('/reverse-geocode', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'Latitude and longitude coordinates are required for reverse geocoding' });
    }
    const result = await googleMapsService.reverseGeocode({ lat, lng });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Reverse geocode failed: ' + err.message });
  }
});

// 0c. Live Delivery Realtime SSE Stream (Authenticated & Security-Isolated)
router.get('/stream', (req, res) => {
  realtimeService.handleSseConnection(req, res);
});

// 0d. Active Delivery for Authenticated User Dashboard
router.get('/active', authenticateToken, (req, res) => {
  try {
    if (req.user && req.user.role === 'courier') {
      return res.status(403).json({ error: 'Access restricted: couriers do not have customer active delivery cards', active: false, delivery: null });
    }
    const active = realtimeService.getActiveDeliveryForUser(req.user);
    if (!active) {
      return res.json({ active: false, delivery: null });
    }
    res.json({ active: true, ...active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Calculate Delivery Quote (Public endpoint for live geocoding, road distance, ETA & rate preview)
router.post('/quote', async (req, res) => {
  try {
    const {
      pickup_location,
      delivery_location,
      item_category,
      is_urgent,
      pickup_coords,
      delivery_coords
    } = req.body;

    if (!pickup_location || !delivery_location) {
      return res.status(400).json({ error: 'Pickup and delivery locations are required' });
    }

    const quote = await calculateLiveDeliveryQuote({
      pickup: pickup_location.trim(),
      destination: delivery_location.trim(),
      category: item_category || 'small_parcel',
      is_urgent: !!is_urgent,
      pickup_coords: pickup_coords || null,
      delivery_coords: delivery_coords || null
    });

    // Check for ambiguity
    if (quote.ambiguous) {
      return res.json({
        ambiguous: true,
        ambiguous_field: quote.ambiguous_field,
        field_label: quote.field_label,
        query: quote.query,
        message: quote.message,
        candidates: quote.candidates,
        provider: 'openstreetmap'
      });
    }

    if (quote.error) {
      return res.status(422).json({
        error: quote.message,
        field: quote.field,
        routing_error: !!quote.routing_error,
        not_found: !!quote.not_found,
        provider: 'osrm'
      });
    }

    res.json(quote);
  } catch (err) {
    console.error('[Route Quote Error]:', err.message);
    res.status(400).json({ error: 'Route calculation failed: ' + err.message, provider: 'osrm' });
  }
});

// 2. Create Delivery Request (Accepts authenticated user or self-heals by sender phone)
router.post('/', optionalAuth, async (req, res) => {
  try {
    if (req.user && req.user.role === 'courier') {
      return res.status(403).json({ error: 'Courier accounts are restricted from submitting customer delivery requests.' });
    }
    const {
      sender_name,
      sender_phone,
      pickup_location,
      pickup_directions,
      pickup_notes,
      pickup_coords,
      pickup_place_id,
      recipient_name,
      recipient_phone,
      delivery_location,
      delivery_directions,
      delivery_notes,
      delivery_coords,
      dropoff_place_id,
      item_description,
      item_category = 'small_parcel',
      special_instructions,
      is_urgent = false
    } = req.body;

    // Strict Validations
    if (!sender_name || !sender_name.trim()) {
      return res.status(400).json({ error: 'Sender full name is required' });
    }
    const senderPhoneCheck = sanitizeAndValidateUgandaPhone(sender_phone);
    if (!senderPhoneCheck.valid) {
      return res.status(400).json({ error: 'Sender: ' + senderPhoneCheck.message });
    }
    if (!pickup_location || !pickup_location.trim()) {
      return res.status(400).json({ error: 'Pickup location is required' });
    }

    if (!recipient_name || !recipient_name.trim()) {
      return res.status(400).json({ error: 'Recipient full name is required' });
    }
    const recipientPhoneCheck = sanitizeAndValidateUgandaPhone(recipient_phone);
    if (!recipientPhoneCheck.valid) {
      return res.status(400).json({ error: 'Recipient: ' + recipientPhoneCheck.message });
    }
    if (!delivery_location || !delivery_location.trim()) {
      return res.status(400).json({ error: 'Delivery destination location is required' });
    }

    if (!item_description || !item_description.trim()) {
      return res.status(400).json({ error: 'Item description is required' });
    }

    // Server-side calculated live quote (enforces correct road distance, ETA & fee calculation)
    const quote = await calculateLiveDeliveryQuote({
      pickup: pickup_location.trim(),
      destination: delivery_location.trim(),
      category: item_category,
      is_urgent: !!is_urgent,
      pickup_coords: pickup_coords || null,
      delivery_coords: delivery_coords || null
    });

    if (quote.ambiguous) {
      return res.status(400).json({
        error: `Address is ambiguous. Please clarify your ${quote.field_label || 'location'}.`,
        ambiguous: true,
        ambiguous_field: quote.ambiguous_field,
        candidates: quote.candidates
      });
    }

    if (quote.error) {
      return res.status(400).json({
        error: quote.message || 'Unable to resolve or route the provided address.',
        routing_error: !!quote.routing_error,
        field: quote.field,
        provider: 'osrm'
      });
    }

    const tracking_number = generateTrackingNumber();
    const delivery_pin = generateDeliveryPin();
    
    // Resolve & persist customer profile so order history is NEVER lost
    let customer_id = null;
    const cleanSenderPhone = senderPhoneCheck.formattedPhone;

    // 1. Verify if req.user.id actually exists in the users table
    if (req.user && req.user.id) {
      const dbUserById = db.prepare('SELECT id FROM users WHERE id = ?').get(req.user.id);
      if (dbUserById) {
        customer_id = dbUserById.id;
      }
    }

    // 2. If token user ID not found in DB, check by clean sender phone
    if (!customer_id && cleanSenderPhone) {
      const existingUserByPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(cleanSenderPhone);
      if (existingUserByPhone) {
        customer_id = existingUserByPhone.id;
      }
    }

    // 3. If still not found, check by token phone or token email
    if (!customer_id && req.user) {
      if (req.user.phone) {
        const pCheck = sanitizeAndValidateUgandaPhone(req.user.phone);
        if (pCheck.valid) {
          const byPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(pCheck.formattedPhone);
          if (byPhone) customer_id = byPhone.id;
        }
      }
      if (!customer_id && req.user.email) {
        const byEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(req.user.email);
        if (byEmail) customer_id = byEmail.id;
      }
    }

    // 4. If user does NOT exist anywhere in users table, create a customer record
    if (!customer_id) {
      try {
        const bcrypt = require('bcryptjs');
        const defaultCustPass = bcrypt.hashSync('customer123', 10);
        const ins = db.prepare(`
          INSERT INTO users (full_name, phone, password_hash, role)
          VALUES (?, ?, ?, 'customer')
        `).run(sender_name.trim(), cleanSenderPhone, defaultCustPass);
        customer_id = ins.lastInsertRowid;
      } catch (insertErr) {
        const fallback = db.prepare('SELECT id FROM users WHERE phone = ?').get(cleanSenderPhone);
        customer_id = fallback ? fallback.id : null;
      }
    }

    // 5. ABSOLUTE FOREIGN KEY INTEGRITY GUARANTEE:
    // Verify that customer_id exists in users table. If not, set to null (deliveries.customer_id is nullable)
    // so SQLite FOREIGN KEY constraint will NEVER fail!
    if (customer_id) {
      const verifyRow = db.prepare('SELECT id FROM users WHERE id = ?').get(customer_id);
      if (!verifyRow) {
        customer_id = null;
      }
    }

    const pLat = quote.origin?.lat || null;
    const pLng = quote.origin?.lng || null;
    const dLat = quote.destination?.lat || null;
    const dLng = quote.destination?.lng || null;
    const etaMins = quote.duration_minutes || null;

    const baseFee = quote.base_fee || 4000;
    const distanceFee = quote.distance_fee || 0;
    const surcharges = quote.urgent_fee || (is_urgent ? 3000 : 0);
    const discounts = 0;
    const finalFee = quote.total_fee || (baseFee + distanceFee + surcharges);
    const routingProvider = quote.map_provider || 'osrm';
    const routeRef = quote.route_type || 'OSRM Live Driving Route';

    const resolvedPickupPlaceId = pickup_place_id || pickup_coords?.place_id || null;
    const resolvedDropoffPlaceId = dropoff_place_id || delivery_coords?.place_id || null;

    let deliveryId;
    const createTxn = db.transaction(() => {
      const stmt = db.prepare(`
        INSERT INTO deliveries (
          tracking_number, customer_id, sender_name, sender_phone,
          pickup_location, pickup_directions, pickup_notes,
          recipient_name, recipient_phone, delivery_location,
          delivery_directions, delivery_notes, item_description,
          item_category, special_instructions, is_urgent,
          distance_km, delivery_fee, status, delivery_pin,
          pickup_lat, pickup_lng, delivery_lat, delivery_lng, eta_minutes,
          pickup_address, pickup_latitude, pickup_longitude,
          dropoff_address, dropoff_latitude, dropoff_longitude,
          road_distance, estimated_travel_time,
          base_delivery_fee, distance_fee, surcharges, discounts,
          final_delivery_fee, pricing_version, routing_provider,
          route_reference, pricing_calculation_timestamp,
          pickup_place_id, dropoff_place_id
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, 'Awaiting Payment', ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, 'v1.0', ?,
          ?, CURRENT_TIMESTAMP,
          ?, ?
        )
      `);

      const result = stmt.run(
        tracking_number,
        customer_id,
        sender_name.trim(),
        senderPhoneCheck.formattedPhone,
        pickup_location.trim(),
        pickup_directions ? pickup_directions.trim() : null,
        pickup_notes ? pickup_notes.trim() : null,
        recipient_name.trim(),
        recipientPhoneCheck.formattedPhone,
        delivery_location.trim(),
        delivery_directions ? delivery_directions.trim() : null,
        delivery_notes ? delivery_notes.trim() : null,
        item_description.trim(),
        item_category,
        special_instructions ? special_instructions.trim() : null,
        is_urgent ? 1 : 0,
        quote.distance_km,
        finalFee,
        delivery_pin,
        pLat,
        pLng,
        dLat,
        dLng,
        etaMins,
        pickup_location.trim(),
        pLat,
        pLng,
        delivery_location.trim(),
        dLat,
        dLng,
        quote.distance_km,
        etaMins,
        baseFee,
        distanceFee,
        surcharges,
        discounts,
        finalFee,
        routingProvider,
        routeRef,
        resolvedPickupPlaceId,
        resolvedDropoffPlaceId
      );

      deliveryId = result.lastInsertRowid;

      // Log initial history record
      db.prepare(`
        INSERT INTO delivery_status_history (delivery_id, status, note, updated_by)
        VALUES (?, 'Request Created', ?, 'Customer')
      `).run(deliveryId, `Delivery request created via live road route (${quote.distance_km} km, ETA: ${quote.eta_text || 'approx. 30 mins'})`);

      db.prepare(`
        INSERT INTO delivery_status_history (delivery_id, status, note, updated_by)
        VALUES (?, 'Delivery PIN Generated', ?, 'System')
      `).run(deliveryId, 'Recipient delivery confirmation PIN generated.');

      db.prepare(`
        INSERT INTO delivery_status_history (delivery_id, status, note, updated_by)
        VALUES (?, 'Awaiting Payment', ?, 'System')
      `).run(deliveryId, `Awaiting cashless Mobile Money payment of UGX ${quote.total_fee.toLocaleString()}`);
    });

    createTxn();

    // Broadcast new delivery request event in real-time
    realtimeService.broadcastDeliveryUpdate(deliveryId, { status: 'Awaiting Payment' });

    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);

    res.status(201).json({
      message: 'Delivery request created successfully',
      delivery,
      quote
    });
  } catch (err) {
    console.error('Create delivery error:', err);
    res.status(500).json({ error: 'Failed to create delivery: ' + err.message });
  }
});

// Helper to generate unique handover confirmation ID e.g. KOLA-HO-20261005-123456
function generateHandoverId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `KOLA-HO-${year}${month}${day}-${rand}`;
}

// 3. Sender Confirms Physical Package Handover (Strict Backend Authorization)
router.post('/:id/confirm-handover', authenticateToken, (req, res) => {
  try {
    const deliveryId = Number(req.params.id);
    if (!deliveryId) {
      return res.status(400).json({ error: 'Valid delivery ID is required' });
    }

    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const user = req.user;

    // RULE 1: Verify the delivery belongs to the sender
    const isSender = (
      user && (
        user.role === 'admin' ||
        delivery.customer_id === user.id ||
        (user.phone && delivery.sender_phone === user.phone) ||
        (user.full_name && delivery.sender_name.toLowerCase().trim() === user.full_name.toLowerCase().trim())
      )
    );

    if (!isSender) {
      return res.status(403).json({
        error: 'Security Authorization Failed: Only the verified sender of this delivery can confirm physical package handover.'
      });
    }

    // RULE 2: Verify courier is assigned
    if (!delivery.courier_id) {
      return res.status(400).json({
        error: 'No courier has been assigned to this delivery yet.'
      });
    }

    // RULE 3: Verify courier has marked arrival (status is Awaiting Sender Confirmation)
    if (delivery.status !== 'Awaiting Sender Confirmation') {
      if (['Package Picked Up', 'Item Picked Up', 'In Transit', 'Near Destination', 'Delivered'].includes(delivery.status)) {
        return res.status(400).json({
          error: 'Package handover has already been confirmed for this delivery.'
        });
      }
      return res.status(400).json({
        error: `Cannot confirm handover: Courier has not yet marked arrival at the pickup point. Current status: ${delivery.status}`
      });
    }

    // RULE 4: Verify request has not already been confirmed or cancelled
    if (delivery.handover_confirmed_at || delivery.handover_confirmation_id) {
      return res.status(400).json({
        error: 'Package handover has already been confirmed. Handover ID: ' + delivery.handover_confirmation_id
      });
    }

    if (delivery.status === 'Cancelled') {
      return res.status(400).json({
        error: 'Cannot confirm handover for a cancelled delivery.'
      });
    }

    const courier = db.prepare('SELECT * FROM couriers WHERE id = ?').get(delivery.courier_id);
    const courierName = courier ? courier.full_name : 'Courier';
    const courierPhone = courier ? courier.phone : '';

    const handoverId = generateHandoverId();
    const senderName = user.full_name || delivery.sender_name;
    const senderPhone = user.phone || delivery.sender_phone;

    let verifiedSenderId = (user && user.id) ? user.id : null;
    if (verifiedSenderId) {
      const senderRow = db.prepare('SELECT id FROM users WHERE id = ?').get(verifiedSenderId);
      if (!senderRow) verifiedSenderId = delivery.customer_id || null;
    }

    const confirmTxn = db.transaction(() => {
      // 1. Update delivery table
      db.prepare(`
        UPDATE deliveries
        SET status = 'Package Picked Up',
            picked_up_at = CURRENT_TIMESTAMP,
            handover_confirmed_at = CURRENT_TIMESTAMP,
            handover_confirmation_id = ?,
            handover_sender_id = ?,
            handover_status = 'confirmed',
            handover_notes = ?
        WHERE id = ?
      `).run(
        handoverId,
        verifiedSenderId,
        `Handover confirmed physically by sender ${senderName}`,
        deliveryId
      );

      // 2. Insert into permanent handover_confirmations audit table
      db.prepare(`
        INSERT INTO handover_confirmations (
          handover_id, delivery_id, tracking_number,
          sender_id, sender_name, sender_phone,
          courier_id, courier_name, courier_phone,
          courier_arrived_at, confirmed_at,
          previous_status, new_status, confirmation_type, status, notes
        ) VALUES (
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, CURRENT_TIMESTAMP,
          'Awaiting Sender Confirmation', 'Package Picked Up', 'sender_digital_handover', 'confirmed', ?
        )
      `).run(
        handoverId, deliveryId, delivery.tracking_number,
        verifiedSenderId, senderName, senderPhone,
        delivery.courier_id, courierName, courierPhone,
        delivery.courier_arrived_at, `Sender confirmed physical package handover at ${delivery.pickup_location}`
      );

      // 3. Insert into delivery_status_history
      db.prepare(`
        INSERT INTO delivery_status_history (delivery_id, status, note, updated_by)
        VALUES (?, 'Sender Confirmed Package Handover', ?, ?)
      `).run(
        deliveryId,
        `Sender ${senderName} physically confirmed package handover to courier ${courierName} (Handover ID: ${handoverId})`,
        `Sender (${senderName})`
      );

      db.prepare(`
        INSERT INTO delivery_status_history (delivery_id, status, note, updated_by)
        VALUES (?, 'Package Picked Up', ?, ?)
      `).run(
        deliveryId,
        `Package securely collected by courier ${courierName}. Ready for transit dispatch.`,
        'Kola System'
      );
    });

    confirmTxn();

    // Broadcast package handover confirmed event in real-time
    realtimeService.broadcastDeliveryUpdate(deliveryId, { status: 'Package Picked Up' });

    const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
    const handoverRecord = db.prepare('SELECT * FROM handover_confirmations WHERE handover_id = ?').get(handoverId);

    res.json({
      success: true,
      message: 'Package Handover Confirmed — Your package has been handed over to the courier and is now being processed for delivery.',
      handover_confirmation_id: handoverId,
      confirmed_at: updated.handover_confirmed_at,
      delivery: updated,
      handover: handoverRecord
    });
  } catch (err) {
    console.error('Confirm handover error:', err);
    res.status(500).json({ error: 'Failed to confirm package handover: ' + err.message });
  }
});

// 4. Sender Indicates Package Has NOT Been Handed Over
router.post('/:id/dispute-handover', authenticateToken, (req, res) => {
  try {
    const deliveryId = Number(req.params.id);
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const user = req.user;
    const isSender = (
      user && (
        user.role === 'admin' ||
        delivery.customer_id === user.id ||
        (user.phone && delivery.sender_phone === user.phone) ||
        (user.full_name && delivery.sender_name.toLowerCase().trim() === user.full_name.toLowerCase().trim())
      )
    );

    if (!isSender) {
      return res.status(403).json({ error: 'Only the sender associated with this delivery can report handover issues.' });
    }

    if (delivery.status !== 'Awaiting Sender Confirmation') {
      return res.status(400).json({ error: 'Delivery is not currently awaiting sender confirmation.' });
    }

    const disputeTxn = db.transaction(() => {
      db.prepare(`
        UPDATE deliveries
        SET handover_status = 'disputed',
            handover_notes = ?
        WHERE id = ?
      `).run(
        'Sender indicated package has NOT yet been handed over to courier',
        deliveryId
      );

      db.prepare(`
        INSERT INTO delivery_status_history (delivery_id, status, note, updated_by)
        VALUES (?, 'Awaiting Sender Confirmation', ?, ?)
      `).run(
        deliveryId,
        'Sender reported: I HAVE NOT HANDED OVER THE PACKAGE. Delivery remains waiting at pickup point.',
        `Sender (${user.full_name || delivery.sender_name})`
      );
    });

    disputeTxn();

    // Broadcast handover dispute notice in real-time
    realtimeService.broadcastDeliveryUpdate(deliveryId, { status: 'Awaiting Sender Confirmation' });

    const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);

    res.json({
      success: true,
      message: 'Notice recorded. The delivery remains Awaiting Sender Confirmation. The courier has been notified not to proceed until physical handover is confirmed.',
      delivery: updated
    });
  } catch (err) {
    console.error('Dispute handover error:', err);
    res.status(500).json({ error: 'Failed to record handover notice: ' + err.message });
  }
});

// 5. Get Handover Confirmation Audit Details
router.get('/:id/handover', (req, res) => {
  try {
    const deliveryId = Number(req.params.id);
    const handover = db.prepare(`
      SELECT * FROM handover_confirmations WHERE delivery_id = ? ORDER BY id DESC LIMIT 1
    `).get(deliveryId);

    if (!handover) {
      return res.status(404).json({ error: 'No handover confirmation record found for this delivery.' });
    }

    res.json(handover);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Track / Get Delivery by Tracking Number or ID
router.get('/:trackingOrId', optionalAuth, (req, res) => {
  try {
    const { trackingOrId } = req.params;
    let delivery;

    if (trackingOrId.startsWith('KOLA-')) {
      delivery = db.prepare('SELECT * FROM deliveries WHERE tracking_number = ?').get(trackingOrId.trim());
    } else {
      delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(trackingOrId);
    }

    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found. Please verify the tracking number (e.g., KOLA-20261005-000123).' });
    }

    // Get courier details if assigned
    let courier = null;
    if (delivery.courier_id) {
      courier = db.prepare(`
        SELECT id, full_name, phone, vehicle_type, plate_number, rating, total_trips
        FROM couriers WHERE id = ?
      `).get(delivery.courier_id);
    }

    // Get status history
    const history = db.prepare(`
      SELECT status, note, updated_by, timestamp
      FROM delivery_status_history
      WHERE delivery_id = ?
      ORDER BY id ASC
    `).all(delivery.id);

    // Get payment details
    const payment = db.prepare(`
      SELECT payment_method, amount, currency, reference_id, payment_status, confirmed_at, created_at
      FROM payments
      WHERE delivery_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(delivery.id);

    // Get handover confirmation record if exists
    const handover = db.prepare(`
      SELECT * FROM handover_confirmations WHERE delivery_id = ? ORDER BY id DESC LIMIT 1
    `).get(delivery.id);

    // SECURITY: The Special Delivery PIN is strictly confidential and must NEVER be exposed
    // to couriers, anonymous visitors, or unrelated parties. It is ONLY accessible to:
    // 1. The sender customer who placed the delivery, OR
    // 2. An authorized administrative dispatcher/super-admin.
    const deliveryPayload = { ...delivery };
    const isSender = req.user && (
      (delivery.customer_id && req.user.id === delivery.customer_id) ||
      (req.user.phone && delivery.sender_phone === req.user.phone) ||
      (req.user.email && delivery.customer_email === req.user.email)
    );
    const isAdmin = req.user && req.user.role === 'admin';

    if (!isSender && !isAdmin) {
      delete deliveryPayload.delivery_pin;
    }

    // SECURITY: Sanitize history records so sensitive PINs are never leaked to anonymous or unauthorized callers
    const sanitizedHistory = history.map(item => {
      let note = item.note || '';
      if (!isSender && !isAdmin) {
        if (item.status === 'Delivery PIN Generated' || /pin/i.test(note)) {
          note = note.replace(/Special recipient delivery confirmation PIN generated: \d+\.?\s*(Provide this PIN to recipient to read to courier on arrival\.)?/gi, 'Recipient delivery confirmation PIN generated.');
          note = note.replace(/(PIN(?:\s*generated)?:\s*)\d+/gi, '$1[PROTECTED]');
          if (delivery.delivery_pin) {
            const pStr = String(delivery.delivery_pin).trim();
            if (pStr.length > 0) {
              note = note.split(pStr).join('[PROTECTED]');
            }
          }
        }
      }
      return {
        ...item,
        note
      };
    });

    // Attach Google Maps turn-by-turn navigation deep links
    const pLat = delivery.pickup_latitude || delivery.pickup_lat;
    const pLng = delivery.pickup_longitude || delivery.pickup_lng;
    const dLat = delivery.dropoff_latitude || delivery.delivery_lat;
    const dLng = delivery.dropoff_longitude || delivery.delivery_lng;

    deliveryPayload.pickup_nav_url = (pLat && pLng)
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(pLat + ',' + pLng)}${delivery.pickup_place_id ? '&destination_place_id=' + encodeURIComponent(delivery.pickup_place_id) : ''}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(delivery.pickup_location + ', Uganda')}`;

    deliveryPayload.dropoff_nav_url = (dLat && dLng)
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dLat + ',' + dLng)}${delivery.dropoff_place_id ? '&destination_place_id=' + encodeURIComponent(delivery.dropoff_place_id) : ''}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(delivery.delivery_location + ', Uganda')}`;

    res.json({
      delivery: deliveryPayload,
      courier,
      history: sanitizedHistory,
      payment,
      handover: handover || null,
      map_config: googleMapsService.getPublicMapConfig()
    });
  } catch (err) {
    console.error('Fetch delivery error:', err);
    res.status(500).json({ error: 'Failed to fetch delivery: ' + err.message });
  }
});

// 4. List deliveries for logged in user (requires authentication)
router.get('/', authenticateToken, (req, res) => {
  try {
    if (req.user && req.user.role === 'courier') {
      return res.status(403).json({ error: 'Courier accounts must access assigned tasks via /api/couriers/my-deliveries' });
    }

    let deliveries = [];
    if (req.user.role === 'admin') {
      const { phone } = req.query;
      if (phone) {
        const pCheck = sanitizeAndValidateUgandaPhone(phone);
        const cleanPhone = pCheck.valid ? pCheck.formattedPhone : phone;
        deliveries = db.prepare(`
          SELECT d.*, c.full_name as courier_name, c.phone as courier_phone, c.plate_number as courier_plate
          FROM deliveries d
          LEFT JOIN couriers c ON d.courier_id = c.id
          WHERE d.sender_phone = ? OR d.recipient_phone = ?
          ORDER BY d.id DESC
        `).all(cleanPhone, cleanPhone);
      } else {
        deliveries = db.prepare(`
          SELECT d.*, c.full_name as courier_name, c.phone as courier_phone, c.plate_number as courier_plate
          FROM deliveries d
          LEFT JOIN couriers c ON d.courier_id = c.id
          ORDER BY d.id DESC
        `).all();
      }
    } else {
      const userPhone = req.user.phone || '';
      deliveries = db.prepare(`
        SELECT d.*, c.full_name as courier_name, c.phone as courier_phone, c.plate_number as courier_plate
        FROM deliveries d
        LEFT JOIN couriers c ON d.courier_id = c.id
        WHERE d.customer_id = ? 
           OR (d.sender_phone = ? AND ? != '')
        ORDER BY d.id DESC
      `).all(req.user.id, userPhone, userPhone);
    }

    // Ensure frontend compatibility attributes are present & protect PIN
    const formatted = deliveries.map(d => {
      const isSender = (d.customer_id && d.customer_id === req.user.id) ||
                       (req.user.phone && d.sender_phone === req.user.phone) ||
                       req.user.role === 'admin';
      const item = {
        ...d,
        dropoff_location: d.delivery_location,
        price: d.delivery_fee,
        delivery_status: d.status
      };
      if (!isSender) {
        delete item.delivery_pin;
      }
      return item;
    });

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deliveries: ' + err.message });
  }
});

module.exports = router;
