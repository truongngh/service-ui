import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ---- Stub gateway -------------------------------------------------------------
// A tiny in-process gateway so chat/restore are tested without a real one.
const stub = createServer((req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/services/models') {
    return reply(200, { models: [{ name: 'stub-model', size: 1 }] });
  }
  if (req.method === 'GET' && req.url === '/services/health/health') {
    return reply(200, { status: 'ok' });
  }
  if (req.method === 'GET' && req.url === '/') {
    return reply(200, { gateway: 'stub', services: [] });
  }
  if (req.method === 'POST' && req.url === '/services/text/generate') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { model, messages } = JSON.parse(body);
      const last = messages?.[messages.length - 1]?.content ?? '';
      reply(200, { model, response: `echo: ${last}` });
    });
    return;
  }
  reply(404, { error: 'not found' });
});

const stubUrl = await new Promise((resolve) => {
  stub.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${stub.address().port}`));
});
let stubClosed = false;
function closeStub() {
  return new Promise((resolve) => {
    if (stubClosed) return resolve();
    stubClosed = true;
    stub.close(resolve);
  });
}

// Point the UI at the stub gateway before the app module is loaded.
process.env.GATEWAY_BASE_URL = stubUrl;
process.env.DEFAULT_MODEL = 'stub-model';

const { app, sessions } = await import('./server.js');

// Run the app on an ephemeral port (the module itself does not listen).
const ui = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${ui.address().port}`;

after(() => new Promise((resolve) => {
  ui.close(() => { closeStub().then(resolve); });
}));

function cookieFrom(res) {
  const header = res.headers.get('set-cookie');
  return header ? header.split(';')[0] : null;
}

test('session round-trip: a refresh re-hydrates the same session', async () => {
  const created = await fetch(`${base}/api/session`);
  assert.equal(created.status, 200);
  const cookie = cookieFrom(created);
  assert.ok(cookie?.startsWith('session='), 'issues a session cookie');
  const first = await created.json();
  assert.deepEqual(first.messages, []);
  assert.equal(first.model, 'stub-model');

  // A second request (the "refresh") with the same cookie gets the same
  // session, and no new cookie is issued.
  const again = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
  const second = await again.json();
  assert.deepEqual(second.messages, first.messages);
  assert.ok(!again.headers.get('set-cookie'), 'does not re-issue the cookie for an existing session');
});

test('chat: appends user + assistant messages, and the transcript restores on GET /api/session', async () => {
  const created = await fetch(`${base}/api/session`);
  const cookie = cookieFrom(created);

  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ model: 'stub-model', message: 'hello' }),
  });
  assert.equal(chat.status, 200);
  const data = await chat.json();
  assert.equal(data.message, 'echo: hello');
  assert.deepEqual(data.session.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'echo: hello' },
  ]);

  // Restore on refresh: the transcript is intact server-side.
  const restored = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(restored.messages, data.session.messages);
  assert.equal(restored.model, 'stub-model');
});

test('reset: clears the transcript ("New chat")', async () => {
  const created = await fetch(`${base}/api/session`);
  const cookie = cookieFrom(created);
  const token = cookie.split('=')[1];
  sessions.get(token).messages.push({ role: 'user', content: 'seed' });

  const reset = await fetch(`${base}/api/session/reset`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(reset.status, 200);
  const data = await reset.json();
  assert.deepEqual(data.messages, []);
  assert.equal(data.model, 'stub-model');
});

test('proxy error: gateway down -> 502 JSON, and the transcript stays clean', async () => {
  await closeStub();

  const models = await fetch(`${base}/api/models`);
  assert.equal(models.status, 502);
  const m = await models.json();
  assert.equal(m.error, 'gateway unreachable');

  const created = await fetch(`${base}/api/session`);
  const cookie = cookieFrom(created);
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ model: 'stub-model', message: 'hello' }),
  });
  assert.equal(chat.status, 502);
  const c = await chat.json();
  assert.equal(c.error, 'gateway unreachable');

  // The failed user message was rolled back.
  const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(session.messages, []);
});

test('chat: rejects a missing message with 400', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});
