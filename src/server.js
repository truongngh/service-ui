import 'dotenv/config';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = process.env.PORT || 8081;
const GATEWAY = process.env.GATEWAY_BASE_URL || 'http://host.docker.internal:8080';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen3.8:27b';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---- In-memory session store -------------------------------------------------
// Map<token, { messages: [], model }>. Sessions live for the process lifetime
// and are cleared on container restart (by design for this scope).
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Return the session for this request, creating one (and issuing a cookie) if
// needed. A refresh re-sends the cookie, so GET /api/session re-hydrates the
// same transcript.
function getSession(req, res) {
  const token = parseCookies(req).session;
  if (token && sessions.has(token)) return sessions.get(token);
  const fresh = { messages: [], model: DEFAULT_MODEL };
  const newToken = randomBytes(16).toString('hex');
  sessions.set(newToken, fresh);
  res.setHeader('Set-Cookie', `session=${newToken}; Path=/; HttpOnly; SameSite=Lax`);
  return fresh;
}

// ---- Proxy helpers -----------------------------------------------------------
// The browser only talks to service-ui; every /api route forwards to the
// gateway. A dead gateway maps to a 502 JSON error the UI can surface.
async function proxy(req, res, { method = 'GET', path, body }) {
  try {
    const r = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'gateway unreachable', detail: e.message });
  }
}

// ---- API routes --------------------------------------------------------------
// Model dropdown: proxy the gateway's models service (it proxies Ollama).
app.get('/api/models', (req, res) => proxy(req, res, { path: '/services/models' }));

// Informational: the gateway's live service registry.
app.get('/api/services', (req, res) => proxy(req, res, { path: '/' }));

// Status pill: proxy the gateway's health check.
app.get('/api/health', (req, res) => proxy(req, res, { path: '/services/health/health' }));

// Restore: return the current transcript so a refresh re-renders the chat.
app.get('/api/session', (req, res) => {
  const session = getSession(req, res);
  res.json({ messages: session.messages, model: session.model });
});

// "New chat": clear the transcript for this session.
app.post('/api/session/reset', (req, res) => {
  const session = getSession(req, res);
  session.messages = [];
  session.model = DEFAULT_MODEL;
  res.json({ messages: session.messages, model: session.model });
});

// Chat: append the user message, proxy the full transcript to the gateway,
// append the assistant reply, and return the updated session.
app.post('/api/chat', async (req, res) => {
  const { model, message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  const session = getSession(req, res);
  const useModel = model || session.model || DEFAULT_MODEL;
  session.model = useModel;

  session.messages.push({ role: 'user', content: message });
  try {
    const r = await fetch(`${GATEWAY}/services/text/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, messages: session.messages }),
    });
    const data = await r.json();
    if (!r.ok) {
      session.messages.pop(); // roll back so the transcript stays clean
      return res.status(r.status).json(data);
    }
    const reply = data.response ?? '';
    session.messages.push({ role: 'assistant', content: reply });
    res.json({ message: reply, session: { messages: session.messages, model: session.model } });
  } catch (e) {
    session.messages.pop();
    res.status(502).json({ error: 'gateway unreachable', detail: e.message });
  }
});

// ---- Static UI -----------------------------------------------------------------
app.use(express.static(PUBLIC_DIR));
// Unknown non-API paths fall back to the SPA shell.
app.get('*', (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

// Only listen when run directly (node src/server.js), not when imported by tests.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  app.listen(PORT, () => console.log(`[service-ui] listening on :${PORT}`));
}

export { app, sessions };
