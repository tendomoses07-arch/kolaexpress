// Kola Express — Application Entry Point for Hostinger & Cloud Hosting
// Hostinger often looks for app.js by default
const serverApp = require('./server/server.js');
module.exports = serverApp.app || serverApp;
