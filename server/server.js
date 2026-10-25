const path = require('path');
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]:', reason);
});
try { require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); } catch (e) {}
try { require('dotenv').config({ path: path.resolve(__dirname, './.env') }); } catch (e) {}
try { require('dotenv').config(); } catch (e) {}
const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./db');
const { getActivePricingRules } = require('./pricing');

// Initialize database
initDatabase();

const PORT = process.env.PORT || 3000;
const ADMIN_PORT = process.env.ADMIN_PORT || 3001;

// Common API Router
const apiRouter = express.Router();
apiRouter.use(cors());
apiRouter.use(express.json());
apiRouter.use(express.urlencoded({ extended: true }));

// Public pricing info endpoint
apiRouter.get('/pricing', (req, res) => {
  try {
    const rules = getActivePricingRules();
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint for hostinger & load balancers
apiRouter.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Mount modular API routes
apiRouter.use('/auth', require('./routes/auth').router);
apiRouter.use('/deliveries', require('./routes/deliveries'));
apiRouter.use('/payments', require('./routes/payments'));
apiRouter.use('/couriers', require('./routes/couriers'));
apiRouter.use('/courier', require('./routes/couriers'));
apiRouter.use('/admin', require('./routes/admin'));

// =================================================================
// 1. MAIN PUBLIC APP (Port 3000 — Customer Website)
// =================================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint for hostinger & load balancers
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Mount API routes
app.use('/api', apiRouter);

// Subdomain routing check: if accessed via admin.kolaexpress.com or admin.localhost
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host.startsWith('admin.')) {
    return express.static(path.join(__dirname, '../admin'))(req, res, () => {
      res.sendFile(path.join(__dirname, '../admin/index.html'));
    });
  }
  next();
});

// Admin static route and SPA fallback on main domain (e.g. /admin)
app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.use('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});

// Public Customer Website static assets
app.use(express.static(path.join(__dirname, '../public')));

// Fallback to public index.html for customer SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// =================================================================
// 2. INDEPENDENT ADMIN APP (Port 3001 — Standalone Admin Portal)
// =================================================================
const adminApp = express();
adminApp.use(cors());
adminApp.use(express.json());
adminApp.use(express.urlencoded({ extended: true }));

// Mount identical API endpoints so admin client can talk directly
adminApp.use('/api', apiRouter);

// Serve Admin static frontend
adminApp.use(express.static(path.join(__dirname, '../admin')));

// Fallback for Admin SPA
adminApp.use((req, res) => {
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});

// Start Server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 KOLA EXPRESS Delivery Service is running!`);
  console.log(`📍 Public Customer Web App: http://0.0.0.0:${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`💳 Cashless Engine: MTN MoMo & Airtel Money`);
  console.log(`===============================================`);
});

server.on('error', (err) => {
  console.error('[SERVER LISTEN ERROR]:', err);
});

let adminServer = null;
const isCloudOrProd = process.env.NODE_ENV === 'production' || process.env.PORT || process.env.HOSTINGER;
if (!isCloudOrProd && ADMIN_PORT && String(ADMIN_PORT) !== String(PORT)) {
  try {
    adminServer = adminApp.listen(ADMIN_PORT, '0.0.0.0', () => {
      console.log(`⚡ Standalone Admin Portal on port ${ADMIN_PORT}`);
    });
    adminServer.on('error', (err) => {
      console.warn(`[Port ${ADMIN_PORT} Info]: Admin portal accessible at /admin on primary port.`);
    });
  } catch (err) {
    console.warn(`[Port ${ADMIN_PORT} Info]: Admin portal accessible at /admin on primary port.`);
  }
}

module.exports = { app, adminApp, server, adminServer };
