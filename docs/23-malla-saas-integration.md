# Malla SaaS Integration

How **Malla SaaS** (Next.js) uses OpenWA as its WhatsApp gateway. OpenWA replaces
the previous standalone `malla-wa-runtime` (a single-session open-wa Express
service) — same job, but with multi-session, persistence, a dashboard, retrying
webhooks and proper API-key auth.

## Architecture

```
┌────────────────────┐   send-text (X-API-Key)    ┌──────────────────┐
│  Malla SaaS         │ ─────────────────────────▶ │  OpenWA          │
│  (Next.js, Coolify) │                            │  (NestJS)        │
│                     │   message.received (HMAC)  │  malla-main      │
│  /api/webhooks/     │ ◀───────────────────────── │  WhatsApp session│
│    wa-message       │                            └──────────────────┘
└────────────────────┘
```

- **Outbound** (Malla → WhatsApp): `POST /api/sessions/{id}/messages/send-text`.
- **Inbound** (WhatsApp → Malla): OpenWA delivers a `message.received` webhook to
  Malla's `/api/webhooks/wa-message`, signed with HMAC-SHA256.
- **QR linking**: Malla's `/admin/wa` proxies `GET /api/sessions/{id}/qr`.

OpenWA must **not** be exposed publicly. Reach it only from Malla over the
internal network (Coolify). Anyone with the API key can use the WhatsApp number.

## Contract mapping (old runtime → OpenWA)

| Concern | malla-wa-runtime | OpenWA |
|---|---|---|
| Auth | `x-wa-secret` header | `X-API-Key` header |
| Send | `POST /send {to,message,raw}` → `{ok,jid,messageId}` | `POST /api/sessions/{id}/messages/send-text {chatId,text}` → `{messageId,timestamp}` |
| Phone format | auto-prepends `+52` | needs a full JID (`52…@c.us`) — Malla's `lib/wa.ts` builds it |
| QR | `GET /qr` → `{waReady,qr,qrAt}` | `GET /api/sessions/{id}/qr` → `{qrCode,status}` (HTTP 400 once linked) |
| Inbound auth | `x-wa-secret` | `X-OpenWA-Signature: sha256=<hex>` (HMAC over the raw JSON body) |
| Inbound shape | `{message:{…, isGroupMsg, senderName, media.dataUrl}}` | `{event,sessionId,data:{…, isGroup, senderName, media.data(base64)}}` |

The translation lives entirely on the **Malla** side (`lib/wa.ts` and
`/api/webhooks/wa-message`). OpenWA stays generic.

## Setup

### 1. Configure OpenWA

In OpenWA's `.env` set a master key (the stable credential Malla uses):

```env
API_MASTER_KEY=<64-hex-chars>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The master key authenticates as ADMIN via `X-API-Key` with no DB lookup and no
IP/session/expiry limits — ideal for a server-to-server integration.

### 2. Provision the session + webhook

With OpenWA running, run the bootstrap script (idempotent):

```bash
API_MASTER_KEY=<same-as-above> \
MALLA_WEBHOOK_URL=https://app.trymalla.live/api/webhooks/wa-message \
MALLA_WEBHOOK_SECRET=<shared-hmac-secret> \
npm run setup:malla
```

It creates the `malla-main` session, starts it, registers the inbound webhook,
and prints the env block for Malla — including the session **UUID** (the session
`id` used in URLs is a generated UUID, not the name `malla-main`).

### 3. Configure Malla SaaS

Paste the printed values into Malla's `.env.local` / Coolify:

```env
OPENWA_URL=http://openwa:2785          # internal URL of the OpenWA service
OPENWA_API_KEY=<API_MASTER_KEY>
OPENWA_SESSION_ID=<uuid-from-step-2>
OPENWA_WEBHOOK_SECRET=<shared-hmac-secret>
```

### 4. Link WhatsApp

Open Malla's `/admin/wa`, scan the QR with the Malla WhatsApp number. Once linked,
the QR view flips to "connected" and inbound/outbound messaging is live.

## Deploy on Coolify

1. New app from the OpenWA repo. Build with the included `Dockerfile`.
2. Env vars: at minimum `NODE_ENV=production`, `API_MASTER_KEY`, and (recommended)
   `DATABASE_TYPE=sqlite` for a single-session setup.
3. **Persistent volume** mounted at `/app/data` — holds the WhatsApp session,
   SQLite DB and media. Without it you re-scan the QR on every deploy.
4. Port `2785`, **internal only** (no public domain).
5. Healthcheck: `GET /api/health`.
6. Put Malla on the same internal network so `OPENWA_URL=http://openwa:2785`
   resolves.

## Notes & differences vs the old runtime

- **Sender name**: OpenWA now includes `senderName` (from WhatsApp's `notifyName`)
  on inbound messages, so the admin inbox keeps showing names. Falls back to
  "Sin nombre" when absent.
- **Media**: OpenWA sends media as raw base64 in `data.media.data` (no `data:`
  prefix); Malla's webhook builds the `data:<mime>;base64,…` data URL and keeps
  its own size cap. OpenWA always downloads media (no `tooLarge` flag).
- **Group messages**: Malla still ignores `isGroup` messages (1:1 prospect flow).
- **Multi-tenant**: this setup mirrors the single `malla-main` session. OpenWA
  already supports multiple sessions, so per-broker sessions are a natural next
  step (create a session + webhook per broker, store the session UUID per tenant).
