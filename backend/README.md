# Backend

## Local setup

From the `backend/` directory, install dependencies:

```powershell
npm install
```

Copy `.env.example` to `.env` for local configuration. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Keep `.env` local and out of Git. The example file contains safe defaults only.

## Supported environment variables

| Variable | Accepted values | Default |
|---|---|---|
| `NODE_ENV` | `development`, `production`, `test` | `development` |
| `PORT` | Integer from `1` to `65535` | `5000` |
| `FRONTEND_ORIGIN` | One origin URL, without a path | `http://localhost:5173` |

The backend loads `backend/.env`, validates configuration at startup, and stops with a value-free validation message if a setting is invalid. Deployment hosts should receive these settings through their private environment-variable configuration; do not upload or commit `.env`.

For deployment, set `FRONTEND_ORIGIN` to the exact deployed frontend origin, for example `https://your-frontend.example`, without a trailing path. CORS allows that origin only; credentials are not enabled. The Vite development proxy remains available locally.

## Request protections

- Helmet's default security headers are enabled.
- JSON request bodies are limited to 100 KB.
- `/api/v1` requests are limited to 100 per IP per 15 minutes and return JSON when the limit is reached.
- The rate limiter uses in-memory state and is suitable only for the current single-instance MVP. Multi-instance deployment needs a shared store and trusted-proxy configuration decision.
- Malformed JSON, oversized bodies, rate-limit responses, and unknown routes return safe JSON. Unexpected errors return a generic server error without internal details.

## Run and build

```powershell
npm run dev
npm run typecheck
npm run build
npm start
```

`npm start` runs the compiled application from `dist/`.

## Frontend environment variables

Vite variables prefixed with `VITE_` are included in client-side code and are public. `VITE_API_BASE_URL` may contain the API base URL, defaulting to `/api/v1`; it must never contain API keys, tokens, passwords, database URLs, or other secrets. Configure only a public API URL in the frontend deployment settings.
