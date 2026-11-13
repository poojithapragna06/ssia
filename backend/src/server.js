require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { initWebSocketServer } = require('./services/websocketService');
const path = require('path');
const fs = require('fs');
const os = require('os');

const authRoutes = require('./routes/authRoutes');
const playlistRoutes = require('./routes/playlistRoutes');
const taskRoutes = require('./routes/taskRoutes');
const alertRoutes = require('./routes/alertRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const playbackRoutes = require('./routes/playbackRoutes');
const userRoutes = require('./routes/userRoutes');
const instagramRoutes = require('./routes/instagramRoutes');

const app = express();

app.use(
  cors({
    // Comma-separated list, e.g. "http://localhost:5173,http://192.168.1.10:5173"
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : '*',
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'ScreenSync backend is healthy',
    // hostname: TV pages opened by IP switch to it - YouTube refuses some videos on IP addresses
    data: { uptime: process.uptime(), hostname: os.hostname().toLowerCase() },
  });
});

// ------------------------------------------------------------
// One server for everything (e.g. the department PC): besides the API it
// serves one shared TV page and the built dashboard on this same port.
//   http://<pc>:3000/                         -> dashboard
//   http://<pc>:3000/tv/?mode=lan&id=...      -> LAN reference display
//   http://<pc>:3000/tv/?mode=wifi&id=...     -> Wi-Fi buffered display
// ------------------------------------------------------------
const TV_DIR = path.join(__dirname, '../../tv-client');
const SHARED_TV_DIR = path.join(TV_DIR, 'shared');
const DASHBOARD_DIR = path.join(__dirname, '../../frontend/dist');

function redirectLegacyTv(mode, req, res) {
  const queryString = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)
    : '';
  const params = new URLSearchParams(queryString);
  params.set('mode', mode);
  return res.redirect(302, `/tv/?${params.toString()}`);
}

// Keep old TV bookmarks working while both screens move to the shared page.
app.get(['/tv/lan', '/tv/lan/'], (req, res) => redirectLegacyTv('lan', req, res));
app.get(['/tv/wifi', '/tv/wifi/'], (req, res) => redirectLegacyTv('wifi', req, res));
app.get('/tv', (req, res, next) => {
  // Allow /tv/ to reach the shared TV page.
  if (req.path.endsWith('/')) {
    return next();
  }

  const query = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : '';

  return res.redirect(302, `/tv/${query}`);
});
app.use('/tv', express.static(SHARED_TV_DIR));

// Dashboard pages share some paths with the API (/users): a browser opening a
// page asks for HTML, the dashboard's API calls ask for JSON
const DASHBOARD_PAGES = ['/', '/login', '/dashboard', '/playlists', '/tasks', '/alerts', '/devices', '/users', '/instagram'];
if (fs.existsSync(path.join(DASHBOARD_DIR, 'index.html'))) {
  app.get(DASHBOARD_PAGES, (req, res, next) => {
    if (req.accepts(['json', 'html']) !== 'html') return next();
    return res.sendFile(path.join(DASHBOARD_DIR, 'index.html'));
  });
  app.use(express.static(DASHBOARD_DIR, { index: false }));
} else {
  console.warn('[ScreenSync] Dashboard not built yet - run "npm run build" in frontend/ to serve it from here');
}

app.use('/auth', authRoutes);
app.use('/api/instagram', instagramRoutes);
app.use('/', playlistRoutes);
app.use('/', taskRoutes);
app.use('/', alertRoutes);
app.use('/', deviceRoutes);
app.use('/', playbackRoutes);
app.use('/', userRoutes);
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

initWebSocketServer(server);

async function start() {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`[ScreenSync] Backend listening on http://localhost:${PORT}`);
    console.log(`[ScreenSync] WebSocket endpoint: ws://localhost:${PORT}`);

    // The addresses other devices on the network should use
    const lanAddresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((net) => net && net.family === 'IPv4' && !net.internal)
      .map((net) => net.address);
    // Prefer the PC's name: it doesn't change like a DHCP address can, and
    // YouTube refuses some videos on pages opened by IP address
    const name = os.hostname().toLowerCase();
    console.log('[ScreenSync] Use these addresses on the TVs and other computers:');
    console.log(`    Dashboard    http://${name}:${PORT}/`);
    console.log(`    LAN TV       http://${name}:${PORT}/tv/?mode=lan&kiosk=1&id=<screen-name>`);
    console.log(`    Wi-Fi TV     http://${name}:${PORT}/tv/?mode=wifi&kiosk=1&id=<screen-name>`);
    if (lanAddresses.length) {
      console.log(`[ScreenSync] If a device can't find "${name}", use the IP instead: ${lanAddresses.join(' or ')}`);
      console.log('    (TV pages opened by IP switch to the name by themselves when they can reach it)');
    }
  });
}

start();

process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err);
});

module.exports = { app, server };
