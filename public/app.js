// service-ui frontend: talks only to the local service-ui server, which
// proxies to service-gateway. The session cookie is sent automatically, so a
// page refresh re-hydrates the transcript via GET /api/session.

const transcript = document.querySelector('#transcript');
const modelSel = document.querySelector('#model');
const statusPill = document.querySelector('#status');
const form = document.querySelector('#chat-form');
const input = document.querySelector('#input');
const newChatBtn = document.querySelector('#new-chat');

let currentModel = null; // model for this session (restored or picked)

function bubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = text;
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
  return div;
}

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) return;
    const data = await res.json();
    const models = data.models || [];
    modelSel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      modelSel.appendChild(opt);
    }
    if (models.length) {
      const match = models.find((m) => m.name === currentModel);
      modelSel.value = (match || models[0]).name;
      if (!match && !currentModel) currentModel = models[0].name;
    }
  } catch {
    // Ollama/gateway down: leave the dropdown empty; chat falls back to the
    // server's DEFAULT_MODEL.
  }
}

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.status === 'ok') {
      statusPill.textContent = 'gateway online';
      statusPill.className = 'pill ok';
    } else {
      statusPill.textContent = 'gateway offline';
      statusPill.className = 'pill err';
    }
  } catch {
    statusPill.textContent = 'gateway offline';
    statusPill.className = 'pill err';
  }
}

// Re-render the transcript from the server-side session (restore on refresh).
async function restoreSession() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    transcript.innerHTML = '';
    for (const m of data.messages || []) bubble(m.role, m.content);
    if (data.model) currentModel = data.model;
  } catch {
    // brand-new session; nothing to restore
  }
}

async function send(message) {
  bubble('user', message);
  input.value = '';
  const model = modelSel.value || currentModel;
  const thinking = bubble('assistant', '\u2026');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, message }),
    });
    const data = await res.json();
    thinking.remove();
    if (res.ok) {
      currentModel = data.session?.model || model;
      bubble('assistant', data.message);
    } else {
      bubble('assistant', `Error: ${data.error || res.status}`);
    }
  } catch (e) {
    thinking.remove();
    bubble('assistant', `Error: ${e.message}`);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (msg) send(msg);
});

newChatBtn.addEventListener('click', async () => {
  await fetch('/api/session/reset', { method: 'POST' });
  transcript.innerHTML = '';
  currentModel = null;
});

modelSel.addEventListener('change', () => {
  currentModel = modelSel.value;
});

(async function init() {
  // Restore first so the session's model is known when the dropdown is built.
  await restoreSession();
  await loadModels();
  await loadHealth();
})();
