# ⚡ NovaSpark Pairing Site — v7

A web-based WhatsApp pairing tool that generates a valid `SESSION_ID` for deploying **NovaSpark Bot v7** on **NovaSpark Nodes**.

## How it works
1. User enters their WhatsApp number (or scans QR code)
2. WhatsApp sends a 6-digit pairing code (or displays QR)
3. User links their device in WhatsApp → Linked Devices
4. Server encodes the session credentials as a `NovaSpark!...` string
5. User copies the SESSION_ID into their NovaSpark Nodes environment variable

## Deploy the Pairing Site

### Option A — NovaSpark Nodes (recommended)
1. Log in at [novaspark-nodes.zone.id](https://novaspark-nodes.zone.id)
2. Create a new Node.js service
3. Link this GitHub repo: `dev-modder/NovaSpark-Pairing`
4. Set `PORT` env var if needed
5. Deploy — the pairing site will be live instantly

### Option B — Manual (VPS / any Node host)
```bash
git clone https://github.com/dev-modder/NovaSpark-Pairing.git
cd NovaSpark-Pairing
npm install
node server.js
```

## Environment Variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to run the pairing server on |

## Related
- [NovaSpark-Bot](https://github.com/dev-modder/NovaSpark-Bot) — the bot itself
- [NovaSpark Nodes](https://novaspark-nodes.zone.id) — official hosting panel

---
_By Dev-Ntando_
