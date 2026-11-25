# service-ui

A web UI for chatting with a **selected local Ollama model** through
[`service-gateway`](https://github.com/truongngh/service-gateway). The browser
talks only to `service-ui`, which proxies to the gateway — the UI has **no
direct Ollama dependency**. The conversation is kept in a server-side
**session** that is **restored on page refresh**; "New chat" clears it.

## How it works
- All `/api/*` routes proxy to `service-gateway` (`GATEWAY_BASE_URL`). The
  model list comes from the gateway's `models` service, which proxies Ollama
  `/api/tags`.
- Chat is **non-streaming** (matches the gateway's `stream:false` contract).
- Sessions are **in-memory** — a `Map<token, { messages, model }>` keyed by an
  `HttpOnly` `session` cookie. They are **lost on container restart**
  (acceptable for this scope; file-backed persistence is a future option).
- A failed chat request rolls back the user message, so the transcript stays
  clean.

## Endpoints
| UI endpoint | Behavior |
|---|---|
| `GET /api/models` | proxy `GET {gateway}/services/models` → model dropdown |
| `GET /api/services` | proxy `GET {gateway}/` → gateway registry (informational) |
| `GET /api/health` | proxy `GET {gateway}/services/health/health` → status pill |
| `POST /api/chat` `{model, message}` | append user msg → proxy `POST {gateway}/services/text/generate` → append reply → return `{message, session}` |
| `GET /api/session` | return the current transcript (**restores chat on refresh**) |
| `POST /api/session/reset` | clear the session ("New chat") |

## Local dev
```bash
cp .env.example .env
npm install
npm run dev          # or: npm start
npm test
```

## Container (Docker)
```bash
docker build -t service-ui .
docker run --rm -p 8081:8081 \
  --add-host=host.docker.internal:host-gateway \
  service-ui
# open http://localhost:8081
```

## Build pipeline
`.github/workflows/build-and-push.yml` runs on push to `main`:
`test -> build image -> push to ghcr.io/<owner>/service-ui`.
Pull and run:
```bash
docker pull ghcr.io/truongngh/service-ui:main
docker run --rm -p 8081:8081 --add-host=host.docker.internal:host-gateway \
  ghcr.io/truongngh/service-ui:main
# open http://localhost:8081
```

## Environment
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8081` | UI listen port |
| `GATEWAY_BASE_URL` | `http://host.docker.internal:8080` | service-gateway |
| `DEFAULT_MODEL` | `qwen3.8:27b` | pre-selected model |

> `host.docker.internal` reaches the host on macOS Docker Desktop. On Linux,
> add `--add-host=host.docker.internal:host-gateway` (same as the gateway).
