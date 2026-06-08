#!/usr/bin/env node
/**
 * Provision OpenWA for Malla SaaS.
 *
 * Idempotently ensures there is a WhatsApp session (default name "malla-main")
 * and a webhook pointing at Malla's inbound endpoint, then prints the env block
 * Malla needs. Run it against a *running* OpenWA instance.
 *
 *   API_MASTER_KEY=<key> \
 *   MALLA_WEBHOOK_URL=https://app.trymalla.live/api/webhooks/wa-message \
 *   MALLA_WEBHOOK_SECRET=<secret> \
 *   node scripts/setup-malla.mjs
 *
 * Optional env:
 *   OPENWA_URL        Base URL of the API (default http://localhost:2785)
 *   SESSION_NAME      Session name (default malla-main)
 *   WEBHOOK_EVENTS    Comma-separated events (default message.received)
 *
 * The session "id" used in URLs is a generated UUID, NOT the name — this script
 * prints it so you can set OPENWA_SESSION_ID in Malla.
 */

const OPENWA_URL = (process.env.OPENWA_URL || 'http://localhost:2785').replace(/\/$/, '');
const API_KEY = process.env.API_MASTER_KEY;
const SESSION_NAME = process.env.SESSION_NAME || 'malla-main';
const WEBHOOK_URL = process.env.MALLA_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.MALLA_WEBHOOK_SECRET;
const WEBHOOK_EVENTS = (process.env.WEBHOOK_EVENTS || 'message.received')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!API_KEY) die('API_MASTER_KEY is required (use the master key from OpenWA .env).');
if (!WEBHOOK_URL) die('MALLA_WEBHOOK_URL is required (Malla inbound endpoint).');
if (!WEBHOOK_SECRET) die('MALLA_WEBHOOK_SECRET is required (shared HMAC secret).');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${OPENWA_URL}/api${path}`, {
    method,
    headers: {
      'X-API-Key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  console.log(`→ OpenWA: ${OPENWA_URL}`);

  // 1) Find or create the session (by unique name).
  const list = await api('/sessions');
  if (!list.ok) {
    die(`Could not list sessions (HTTP ${list.status}). Is OpenWA running and the key valid?`);
  }
  let session = Array.isArray(list.data) ? list.data.find((s) => s.name === SESSION_NAME) : undefined;

  if (session) {
    console.log(`✓ Session "${SESSION_NAME}" already exists (id: ${session.id}, status: ${session.status}).`);
  } else {
    const created = await api('/sessions', { method: 'POST', body: { name: SESSION_NAME } });
    if (!created.ok) die(`Failed to create session: HTTP ${created.status} ${JSON.stringify(created.data)}`);
    session = created.data;
    console.log(`✓ Created session "${SESSION_NAME}" (id: ${session.id}).`);
  }

  // 2) Start it (so it connects / produces a QR). Tolerate "already started".
  const started = await api(`/sessions/${session.id}/start`, { method: 'POST' });
  if (started.ok) {
    console.log(`✓ Session started (status: ${started.data?.status ?? 'unknown'}).`);
  } else if (started.status === 400) {
    console.log('✓ Session already started.');
  } else {
    console.warn(`! Could not start session (HTTP ${started.status}). Start it from the dashboard if needed.`);
  }

  // 3) Find or create the inbound webhook for this session.
  const hooks = await api(`/sessions/${session.id}/webhooks`);
  const existing = Array.isArray(hooks.data) ? hooks.data.find((w) => w.url === WEBHOOK_URL) : undefined;

  if (existing) {
    console.log(`✓ Webhook already registered (id: ${existing.id}).`);
  } else {
    const hook = await api(`/sessions/${session.id}/webhooks`, {
      method: 'POST',
      body: { url: WEBHOOK_URL, events: WEBHOOK_EVENTS, secret: WEBHOOK_SECRET },
    });
    if (!hook.ok) die(`Failed to create webhook: HTTP ${hook.status} ${JSON.stringify(hook.data)}`);
    console.log(`✓ Created webhook → ${WEBHOOK_URL} (events: ${WEBHOOK_EVENTS.join(', ')}).`);
  }

  // 4) Print the env block Malla needs.
  console.log('\n────────────────────────────────────────────────────────');
  console.log(' Add these to Malla SaaS (.env.local / Coolify):');
  console.log('────────────────────────────────────────────────────────');
  console.log(`OPENWA_URL=${OPENWA_URL}`);
  console.log(`OPENWA_API_KEY=${API_KEY}`);
  console.log(`OPENWA_SESSION_ID=${session.id}`);
  console.log(`OPENWA_WEBHOOK_SECRET=${WEBHOOK_SECRET}`);
  console.log('────────────────────────────────────────────────────────');
  console.log(`\nScan the QR at: ${OPENWA_URL}/api/sessions/${session.id}/qr (or via Malla /admin/wa).\n`);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
