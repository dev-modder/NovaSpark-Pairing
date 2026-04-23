/**
 * ⚡ NovaSpark Bot v7 — WhatsApp Pairing Server
 * Generates SESSION_ID for use in bot deployment
 * By Dev-Ntando | NovaSpark Nodes ready — novaspark-nodes.zone.id
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
  default:     makeWASocket,
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
  const compressed = zlib.gzipSync(Buffer.from(credsJson, 'utf-8'));
  return 'NovaSpark!' + compressed.toString('base64');
}

// ── Spawn a Baileys socket and attach all handlers ───────────────────────────
async function spawnSocket(sessionId) {
  const sd = sessions.get(sessionId);
  if (!sd) return;

  // Kill old socket if any
  if (sd.sock) { try { sd.sock.end(); } catch {} }

  const { state, saveCreds } = await useMultiFileAuthState(sd.tmpDir);
  const { version }          = await fetchLatestBaileysVersion();
  const logger               = pino({ level: 'silent' });

  // IMPORTANT: Use 'Chrome' as browser[1] — this maps to PlatformType=1
  // which WhatsApp accepts for pairing code requests.
  // 'Safari' (PlatformType=5) causes WhatsApp to silently ignore pairing code requests.
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    keepAliveIntervalMs:      15000,
    connectTimeoutMs:         60000,
    defaultQueryTimeoutMs:    30000,
  });

  sd.sock      = sock;
  sd.saveCreds = saveCreds;

  // ── connection.update ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    const s = sessions.get(sessionId);
    if (!s) return;

    // ── QR received ─────────────────────────────────────────────────────────
    if (qr !== undefined && qr !== null) {

      // 1. Request pairing code FIRST (before any async work) if phone given
      //    and not yet requested. This must happen while ws is still open and
      //    synchronous relative to the QR event.
      if (s.phone && !s.pairingCodeRequested) {
        s.pairingCodeRequested = true;
        // Small delay to allow the Noise handshake to settle, then send
        setTimeout(async () => {
          const cur = sessions.get(sessionId);
          if (!cur || cur.successHandled) return;
          try {
            const code     = await sock.requestPairingCode(s.phone);
            cur.pairingCode = code;
            cur.status      = 'pairing';
            console.log(`[PAIR] Pairing code obtained for session ${sessionId}: ${code}`);
          } catch (e) {
            console.warn(`[PAIR] requestPairingCode failed for ${sessionId}: ${e.message}`);
            // Fall back to QR-only — don't kill the session
            cur.status = 'qr';
          }
        }, 500);
      } else if (!s.phone) {
        s.status = 'qr';
      }
      // else: pairing code already requested, just update QR image

      // 2. Generate QR data URL (async, after the pairing code request is fired)
      try {
        s.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      } catch (e) {
        console.error('[QR] toDataURL error:', e.message);
      }
    }

    // ── Connected ────────────────────────────────────────────────────────────
    if (connection === 'open') {
      if (s.successHandled) return;
      s.successHandled = true;
      s.status         = 'success';

      try {
        await saveCreds();
        await new Promise(r => setTimeout(r, 700)); // flush to disk
        const credsPath = path.join(s.tmpDir, 'creds.json');
        if (!fs.existsSync(credsPath)) throw new Error('creds.json not found');
        s.sessionString = encodeCreds(fs.readFileSync(credsPath, 'utf-8'));
        console.log(`[PAIR] Session string generated for ${sessionId}`);
      } catch (e) {
        console.error(`[PAIR] Failed to encode session ${sessionId}:`, e.message);
        s.status = 'failed';
      }

      // End socket after delay to avoid race with creds.update
      setTimeout(() => { try { sock.end(); } catch {} }, 1500);
    }

    // ── Disconnected ─────────────────────────────────────────────────────────
    if (connection === 'close') {
      if (s.successHandled) return; // post-success close — ignore

      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[PAIR] Disconnected session ${sessionId} — code ${code}`);

      if (code === DisconnectReason.loggedOut) {
        s.status = 'failed';
        return;
      }

      // All other codes: reconnect
      setTimeout(async () => {
        const cur = sessions.get(sessionId);
        if (!cur || cur.successHandled || cur.status === 'timeout' || cur.status === 'failed') return;
        console.log(`[PAIR] Reconnecting session ${sessionId}...`);
        try { await spawnSocket(sessionId); } catch (e) {
          console.error(`[PAIR] Reconnect failed for ${sessionId}:`, e.message);
        }
      }, 3000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Create a new pairing session ─────────────────────────────────────────────
async function createPairingSession(sessionId, phone) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ns-pair-${sessionId}-`));

  sessions.set(sessionId, {
    tmpDir,
    phone:                phone || null,
    sock:                 null,
    saveCreds:            null,
    qrDataUrl:            null,
    pairingCode:          null,
    pairingCodeRequested: false,
    sessionString:        null,
    status:               'connecting',
    createdAt:            Date.now(),
    successHandled:       false,
  });

  await spawnSocket(sessionId);

  // Hard timeout after 5 minutes
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && !s.successHandled && s.status !== 'failed') {
      s.status = 'timeout';
      try { s.sock.end(); } catch {}
    }
  }, 5 * 60 * 1000);
}

// ── Cleanup sessions older than 12 minutes ───────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > 12 * 60 * 1000) {
      try { s.sock.end(); } catch {}
      try { fs.rmSync(s.tmpDir, { recursive: true, force: true }); } catch {}
      sessions.delete(id);
    }
  }
}, 2 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/pair   body: { phone?: string }
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body || {};

    let cleanPhone = null;
    if (phone && String(phone).trim()) {
      cleanPhone = String(phone).replace(/\D/g, '');
      if (cleanPhone.length < 7 || cleanPhone.length > 15) {
        return res.status(400).json({ error: 'Invalid phone number. Use country code + digits only (e.g. 263786831091).' });
      }
    }

    const sessionId = generateSessionId();
    await createPairingSession(sessionId, cleanPhone);

    return res.json({ sessionId, method: cleanPhone ? 'code+qr' : 'qr' });
  } catch (e) {
    console.error('[API /pair]', e);
    return res.status(500).json({ error: 'Failed to start session: ' + e.message });
  }
});

// GET /api/status/:id
app.get('/api/status/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found or expired.' });
  return res.json({
    status:        s.status,
    qrDataUrl:     s.qrDataUrl     || null,
    pairingCode:   s.pairingCode   || null,
    sessionString: s.sessionString || null,
    phone:         s.phone         || null,
  });
});

// DELETE /api/session/:id
app.delete('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) {
    try { s.sock.end(); } catch {}
    try { fs.rmSync(s.tmpDir, { recursive: true, force: true }); } catch {}
    sessions.delete(req.params.id);
  }
  return res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`⚡ NovaSpark Pairing Server on port ${PORT}`));
