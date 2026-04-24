/**
 * ⚡ NovaSpark Bot v7 — WhatsApp Pairing Server
 * By Dev-Ntando | NovaSpark Nodes ready — novaspark-nodes.zone.id
 *
 * Safe-pairing build:
 *  - syncFullHistory: false         → stops bulk history sync that freezes phones
 *  - markOnlineOnConnect: false     → no presence broadcast during auth
 *  - generateHighQualityLinkPreview: false → no extra HTTP fetches during auth
 *  - getMessage stub                → prevents internal crash on missed messages
 *  - emitOwnEvents: false           → only remote message events
 *  - maxMsgRetryCount: 3            → limit retry storms
 *  - fireInitQueries: false         → skip non-essential init queries
 *  - Exponential back-off reconnect (3s → 6s → 12s, max 4 attempts)
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
  delay,
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

// ── Spawn a Baileys socket ───────────────────────────────────────────────────
async function spawnSocket(sessionId, retryCount) {
  if (retryCount === undefined) retryCount = 0;
  const sd = sessions.get(sessionId);
  if (!sd) return;

  if (sd.sock) { try { sd.sock.end(); } catch {} sd.sock = null; }

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
    printQRInTerminal:              false,

    // ── Safe pairing: prevents phone freeze ──────────────────────────────
    syncFullHistory:                false,   // no bulk history dump on link
    markOnlineOnConnect:            false,   // don't broadcast presence
    generateHighQualityLinkPreview: false,   // no HTTP fetches during auth
    getMessage:         async () => ({ conversation: '' }), // stub
    emitOwnEvents:                  false,
    maxMsgRetryCount:               3,

    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    keepAliveIntervalMs:            20_000,
    connectTimeoutMs:               30_000,
    defaultQueryTimeoutMs:          20_000,
  });

  sd.sock      = sock;
  sd.saveCreds = saveCreds;

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    const s = sessions.get(sessionId);
    if (!s) return;

    // QR received
    if (qr !== undefined && qr !== null) {
      if (s.phone && !s.pairingCodeRequested) {
        s.pairingCodeRequested = true;
        setTimeout(async () => {
          const cur = sessions.get(sessionId);
          if (!cur || cur.successHandled) return;
          try {
            const code      = await sock.requestPairingCode(s.phone);
            cur.pairingCode = code;
            cur.status      = 'pairing';
            console.log('[PAIR] Code for ' + sessionId + ': ' + code);
          } catch (e) {
            console.warn('[PAIR] requestPairingCode failed for ' + sessionId + ': ' + e.message);
            cur.status = 'qr';
          }
        }, 600);
      } else if (!s.phone) {
        s.status = 'qr';
      }

      try {
        s.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      } catch (e) {
        console.error('[QR] toDataURL error:', e.message);
      }
    }

    // Connected
    if (connection === 'open') {
      if (s.successHandled) return;
      s.successHandled = true;
      s.status         = 'success';

      try {
        await saveCreds();
        await delay(800);
        const credsPath = path.join(s.tmpDir, 'creds.json');
        if (!fs.existsSync(credsPath)) throw new Error('creds.json not found');
        s.sessionString = encodeCreds(fs.readFileSync(credsPath, 'utf-8'));
        console.log('[PAIR] Session string ready for ' + sessionId);

        // Wait for WA to fully settle before sending — sending immediately
        // after connection.open causes the message to silently drop
        await delay(3000);

        // Resolve the phone: for QR users s.phone is null, read from creds
        let targetPhone = s.phone;
        if (!targetPhone) {
          try {
            const creds = JSON.parse(fs.readFileSync(path.join(s.tmpDir, 'creds.json'), 'utf-8'));
            // me.id looks like "263786831091:123@s.whatsapp.net"
            if (creds && creds.me && creds.me.id) {
              targetPhone = creds.me.id.split(':')[0].split('@')[0];
            }
          } catch (e) {
            console.warn('[PAIR] Could not extract phone from creds: ' + e.message);
          }
        }

        // Send SESSION_ID to the user's own WhatsApp inbox
        if (targetPhone) {
          try {
            const jid = targetPhone + '@s.whatsapp.net';
            const msg =
              '⚡ *NovaSpark Bot — SESSION_ID*\n\n' +
              'Your session has been generated successfully! Copy the string below and set it as your *SESSION_ID* environment variable on NovaSpark Nodes.\n\n' +
              s.sessionString + '\n\n' +
              '🔒 *Keep this private* — anyone with this string can control your bot.\n\n' +
              '_— NovaSpark Pairing Server_';
            await sock.sendMessage(jid, { text: msg });
            console.log('[PAIR] SESSION_ID sent to WhatsApp inbox for ' + sessionId);
          } catch (e) {
            console.warn('[PAIR] Could not send SESSION_ID to inbox: ' + e.message);
          }
        }
      } catch (e) {
        console.error('[PAIR] Encode failed for ' + sessionId + ':', e.message);
        s.status = 'failed';
      }

      // Close socket 2s after message send attempt, not immediately
      setTimeout(() => { try { sock.end(); } catch {} }, 2000);
    }

    // Disconnected
    if (connection === 'close') {
      if (s.successHandled) return;

      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;

      console.log('[PAIR] Disconnected session ' + sessionId + ' — code ' + code);

      if (
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.forbidden ||
        code === 403
      ) {
        s.status = 'failed';
        return;
      }

      if (retryCount >= 4) {
        console.warn('[PAIR] Max retries reached for ' + sessionId);
        s.status = 'failed';
        return;
      }

      const backoff = 3000 * Math.pow(2, retryCount);
      console.log('[PAIR] Reconnecting ' + sessionId + ' in ' + backoff + 'ms (attempt ' + (retryCount + 1) + ')...');

      setTimeout(async () => {
        const cur = sessions.get(sessionId);
        if (!cur || cur.successHandled || cur.status === 'timeout' || cur.status === 'failed') return;
        try {
          await spawnSocket(sessionId, retryCount + 1);
        } catch (e) {
          console.error('[PAIR] Reconnect failed for ' + sessionId + ':', e.message);
        }
      }, backoff);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Create session ───────────────────────────────────────────────────────────
async function createPairingSession(sessionId, phone) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pair-' + sessionId + '-'));

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

  await spawnSocket(sessionId, 0);

  // Hard 5-minute timeout
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && !s.successHandled && s.status !== 'failed') {
      s.status = 'timeout';
      try { s.sock && s.sock.end(); } catch {}
    }
  }, 5 * 60 * 1000);
}

// ── Cleanup sessions older than 12 minutes ───────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > 12 * 60 * 1000) {
      try { s.sock && s.sock.end(); } catch {}
      try { fs.rmSync(s.tmpDir, { recursive: true, force: true }); } catch {}
      sessions.delete(id);
    }
  }
}, 2 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

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
    console.error('[API /api/pair]', e);
    return res.status(500).json({ error: 'Failed to start session: ' + e.message });
  }
});

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

app.delete('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) {
    try { s.sock && s.sock.end(); } catch {}
    try { fs.rmSync(s.tmpDir, { recursive: true, force: true }); } catch {}
    sessions.delete(req.params.id);
  }
  return res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('⚡ NovaSpark Pairing Server on port ' + PORT));
