/**
 * ⚡ NovaSpark Bot v5 — WhatsApp Pairing Server
 * Generates SESSION_ID for use in bot deployment
 * By Dev-Ntando | Render.com ready
 */

'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const zlib     = require('zlib');
const QRCode   = require('qrcode');
const pino     = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory session store ──────────────────────────────────────────────────
const sessions = new Map();
// { id: { sock, state, saveCreds, qr, pairingCode, sessionString, status, phone, tmpDir } }

function generateSessionId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// ── Encode creds.json → NovaSpark!<base64(gzip)> ────────────────────────────
function encodeCreds(credsJson) {
  const buf        = Buffer.from(credsJson, 'utf-8');
  const compressed = zlib.gzipSync(buf);
  return 'NovaSpark!' + compressed.toString('base64');
}

// ── Create a pairing session ──────────────────────────────────────────────────
async function createPairingSession(sessionId, phone) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ns-pair-${sessionId}-`));

  const { state, saveCreds } = await useMultiFileAuthState(tmpDir);
  const { version }          = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['NovaSpark Pairing', 'Chrome', '5.0.0'],
    keepAliveIntervalMs: 15000,
    connectTimeoutMs:    60000,
    defaultQueryTimeoutMs: 30000,
  });

  const sessionData = {
    sock,
    state,
    saveCreds,
    tmpDir,
    phone,
    qr:            null,
    qrDataUrl:     null,
    pairingCode:   null,
    sessionString: null,
    status:        'connecting',   // connecting | qr | pairing | success | failed | timeout
    createdAt:     Date.now(),
  };

  sessions.set(sessionId, sessionData);

  // ── QR code event ─────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
    const sd = sessions.get(sessionId);
    if (!sd) return;

    if (qr) {
      sd.qr     = qr;
      sd.status = 'qr';
      try {
        sd.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      } catch {}

      // If phone given, also request pairing code (phone pairing preferred)
      if (phone && !sd.pairingCode) {
        try {
          const code = await sock.requestPairingCode(phone);
          sd.pairingCode = code;
          sd.status      = 'pairing';
        } catch (e) {
          // Pairing code request failed, QR still works
          console.warn('[PAIR] Pairing code request failed:', e.message);
        }
      }
    }

    if (connection === 'open') {
      sd.status = 'success';
      try {
        await saveCreds();
        const credsPath = path.join(tmpDir, 'creds.json');
        if (fs.existsSync(credsPath)) {
          const credsJson    = fs.readFileSync(credsPath, 'utf-8');
          sd.sessionString   = encodeCreds(credsJson);
        }
      } catch (e) {
        console.error('[PAIR] Failed to read creds:', e.message);
        sd.status = 'failed';
      }
      // Disconnect after grabbing creds
      try { sock.end(); } catch {}
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (sd.status !== 'success') {
        sd.status = code === DisconnectReason.loggedOut ? 'failed' : 'failed';
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Auto-timeout after 5 minutes ──────────────────────────────────────────
  setTimeout(() => {
    const sd = sessions.get(sessionId);
    if (sd && sd.status !== 'success') {
      sd.status = 'timeout';
      try { sd.sock.end(); } catch {}
    }
  }, 5 * 60 * 1000);

  return sessionId;
}

// ── Cleanup old sessions (>10 min) ───────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, sd] of sessions.entries()) {
    if (now - sd.createdAt > 10 * 60 * 1000) {
      try { sd.sock.end(); } catch {}
      try { fs.rmSync(sd.tmpDir, { recursive: true, force: true }); } catch {}
      sessions.delete(id);
    }
  }
}, 2 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/pair — start a new pairing session
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body || {};

    // Sanitize phone: digits only, no + or spaces
    let cleanPhone = null;
    if (phone) {
      cleanPhone = String(phone).replace(/\D/g, '');
      if (cleanPhone.length < 7 || cleanPhone.length > 15) {
        return res.status(400).json({ error: 'Invalid phone number. Include country code, digits only (e.g. 263786831091).' });
      }
    }

    const sessionId = generateSessionId();
    await createPairingSession(sessionId, cleanPhone);

    return res.json({ sessionId, message: 'Session started. Poll /api/status/:id for updates.' });
  } catch (e) {
    console.error('[API /pair]', e);
    return res.status(500).json({ error: 'Failed to start pairing session.' });
  }
});

// GET /api/status/:id — poll session status
app.get('/api/status/:id', async (req, res) => {
  const sd = sessions.get(req.params.id);
  if (!sd) return res.status(404).json({ error: 'Session not found or expired.' });

  return res.json({
    status:        sd.status,
    qrDataUrl:     sd.qrDataUrl   || null,
    pairingCode:   sd.pairingCode || null,
    sessionString: sd.sessionString || null,
    phone:         sd.phone || null,
  });
});

// DELETE /api/session/:id — cancel a session
app.delete('/api/session/:id', (req, res) => {
  const sd = sessions.get(req.params.id);
  if (sd) {
    try { sd.sock.end(); } catch {}
    try { fs.rmSync(sd.tmpDir, { recursive: true, force: true }); } catch {}
    sessions.delete(req.params.id);
  }
  return res.json({ ok: true });
});

// Serve index.html for all other routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚡ NovaSpark Pairing Server running on port ${PORT}`);
});
