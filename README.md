# ⚡ NovaSpark Bot — Session Pairing Site

A web-based WhatsApp pairing tool that generates a valid `SESSION_ID` for deploying **NovaSpark Bot v7** on Render.com.

## How it works

1. User enters their WhatsApp number (with country code)
2. The server connects to WhatsApp via Baileys and requests a **pairing code**
3. User enters the code in WhatsApp → Linked Devices
4. The server captures `creds.json`, encodes it as `NovaSpark!<base64(gzip)>`, and displays it
5. User copies the SESSION_ID into their Render environment variable

## Deploy on Render.com

### Option A — One-click via render.yaml
1. Push this repo to GitHub
2. Go to [render.com/new](https://render.com/new) → **New Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — click **Deploy**

### Option B — Manual
| Setting       | Value            |
|---------------|------------------|
| Runtime       | Node             |
| Build Command | `npm install`    |
| Start Command | `node server.js` |
| Plan          | Free             |

No environment variables needed for the pairing site itself.

## Local development

```bash
npm install
node server.js
# Open http://localhost:3000
```

## Session format

Sessions are encoded as:
```
NovaSpark!<base64(gzip(creds.json))>
```
This matches the exact format expected by NovaSpark Bot v7's `index.js`.

## Notes
- Sessions expire from the pairing site's memory after 10 minutes (cleanup)
- The pairing site does NOT store your session after you close the page
- Each pairing session is isolated in a temp directory that gets cleaned up automatically
- Supports both pairing code method and QR code fallback
