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

function generateSessionId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// ── Encode creds.json → NovaSpark!<base64(gzip)> ────────────────────────────
function encodeCreds(credsJson) {
  const buf        = Buffer.from(credsJson, 'utf-8');
  const compressed = zlib.gzipSync(buf);
  return 'NovaSpark!' + compressed.toString('base64');
}

// ── Attach event handlers to a socket for a given session ────────────────────
function attachHandlers(sock, sessionId, saveCreds) {
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    const sd = sessions.get(sessionId);
    if (!sd) return;

    // ── New QR (fires every ~20s as WhatsApp rotates it) ──────────────────
    if (qr) {
      try {
        sd.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      } catch (e) {
        console.error('[QR] toDataURL failed:', e.message);
      }

      // Request pairing code once (only if phone provided, only first time)
      if (sd.phone && !sd.pairingCodeRequested) {
        sd.pairingCodeRequested = true;
        try {
          const code     = await sock.requestPairingCode(sd.phone);
          sd.pairingCode = code;
          sd.status      = 'pairing';
        } catch (e) {
          console.warn('[PAIR] Pairing code failed, QR only:', e.message);
          sd.status = 'qr';
        }
      } else if (!sd.phone) {
        sd.status = 'qr';
      }
      // If pairing code already obtained, keep status='pairing' but QR still refreshes
    }

    // ── Connected ─────────────────────────────────────────────────────────
    if (connection === 'open') {
      if (sd.successHandled) return;
      sd.successHandled = true;
      sd.status         = 'success';

      try {
        await saveCreds();
        await new Promise(r => setTimeout(r, 600)); // let saveCreds flush
        const credsPath = path.join(sd.tmpDir, 'creds.json');
        if (!fs.existsSync(credsPath)) throw new Error('creds.json missing after save');
        sd.sessionString = encodeCreds(fs.readFileSync(credsPath, 'utf-8'));
      } catch (e) {
        console.error('[PAIR] Session encode failed:', e.message);
        sd.status = 'failed';
      }

      // End socket after a delay (avoid triggering close handler prematurely)
      setTimeout(() => { try { sock.end(); } catch {} }, 1500);
    }

    // ── Disconnected ──────────────────────────────────────────────────────
    if (connection === 'close') {
      if (sd.successHandled) return; // already done — ignore post-success close

      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        // Hard ban/logout — stop
        sd.status = 'failed';
        return;
      }

      // Everything else (408 timeout, stream error, restart required, etc.)
      // is a temporary disconnect — reconnect and keep going
      console.log(`[PAIR] Disconnect (code ${code}) on session ${sessionId} — reconnecting in 3s`);
      setTimeout(() => {
        const current = sessions.get(sessionId);
        if (!current || current.successHandled || current.status === 'timeout') return;
        reconnectSession(sessionId);
      }, 3000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Create a new pairing session ─────────────────────────────────────────────
async function createPairingSession(sessionId, phone) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ns-pair-${sessionId}-`));

  const sessionData = {
    tmpDir,
    phone:                phone || null,
    sock:                 null,
    qrDataUrl:            null,
    pairingCode:          null,
    pairingCodeRequested: false,
    sessionString:        null,
    status:               'connecting',
    createdAt:            Date.now(),
    successHandled:       false,
  };
  sessions.set(sessionId, sessionData);

  await spawnSocket(sessionId);

  // Auto-timeout after 5 minutes
  setTimeout(() => {
    const sd = sessions.get(sessionId);
    if (sd && !sd.successHandled && sd.status !== 'failed') {
      sd.status = 'timeout';
      try { sd.sock.end(); } catch {}
    }
  }, 5 * 60 * 1000);

  return sessionId;
}

// ── Spawn (or respawn) a Baileys socket for a session ────────────────────────
async function spawnSocket(sessionId) {
  const sd = sessions.get(sessionId);
  if (!sd) return;

  if (sd.sock) {
    try { sd.sock.end(); } catch {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(sd.tmpDir);
  const { version }          = await fetchLatestBaileysVersion();
  const logger               = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['NovaSpark Pairing', 'Safari', '17.0'],
    keepAliveIntervalMs: 15000,
    connectTimeoutMs:    60000,
    defaultQueryTimeoutMs: 30000,
  });

  sd.sock       = sock;
  sd.saveCreds  = saveCreds;

  attachHandlers(sock, sessionId, saveCreds);
}

// ── Reconnect (reuses same session data, just new socket) ────────────────────
async function reconnectSession(sessionId) {
  const sd = sessions.get(sessionId);
  if (!sd || sd.successHandled || sd.status === 'timeout' || sd.status === 'failed') return;
  try {
    await spawnSocket(sessionId);
  } catch (e) {
    console.error('[PAIR] Reconnect failed:', e.message);
  }
}

// ── Cleanup sessions older than 12 minutes ───────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, sd] of sessions.entries()) {
    if (now - sd.createdAt > 12 * 60 * 1000) {
      try { sd.sock.end(); } catch {}
      try { fs.rmSync(sd.tmpDir, { recursive: true, force: true }); } catch {}
      sessions.delete(id);
    }
  }
}, 2 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/pair  — body: { phone?: string }
// phone is OPTIONAL — omit it for pure QR-only mode
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body || {};

    let cleanPhone = null;
    if (phone && String(phone).trim() !== '') {
      cleanPhone = String(phone).replace(/\D/g, '');
      if (cleanPhone.length < 7 || cleanPhone.length > 15) {
        return res.status(400).json({ error: 'Invalid phone number. Include country code, digits only (e.g. 263786831091).' });
      }
    }

    const sessionId = generateSessionId();
    await createPairingSession(sessionId, cleanPhone);

    return res.json({ sessionId, method: cleanPhone ? 'code+qr' : 'qr' });
  } catch (e) {
    console.error('[API /pair]', e);
    return res.status(500).json({ error: 'Failed to start pairing session: ' + e.message });
  }
});

// GET /api/status/:id
app.get('/api/status/:id', (req, res) => {
  const sd = sessions.get(req.params.id);
  if (!sd) return res.status(404).json({ error: 'Session not found or expired.' });

  return res.json({
    status:        sd.status,
    qrDataUrl:     sd.qrDataUrl    || null,
    pairingCode:   sd.pairingCode  || null,
    sessionString: sd.sessionString || null,
    phone:         sd.phone        || null,
  });
});

// DELETE /api/session/:id — cancel
app.delete('/api/session/:id', (req, res) => {
  const sd = sessions.get(req.params.id);
  if (sd) {
    try { sd.sock.end(); } catch {}
    try { fs.rmSync(sd.tmpDir, { recursive: true, force: true }); } catch {}
    sessions.delete(req.params.id);
  }
  return res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚡ NovaSpark Pairing Server running on port ${PORT}`);
});
