# Backend

## Local setup

From the `backend/` directory, install dependencies:

```powershell
npm install
```

Copy `.env.example` to `.env` for local configuration. Replace the MongoDB URI placeholder with the Atlas connection string for your database user and cluster. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Keep `.env` local and out of Git. The example file contains a nonfunctional URI placeholder and safe defaults only.

## MongoDB Atlas setup

1. Create or select a MongoDB Atlas cluster and a database user.
2. Allow the development machine's IP address in the Atlas network access list. Avoid opening access to all IP addresses for convenience.
3. Copy the Atlas connection URI into `MONGODB_URI` in the local `backend/.env`. The application selects `whatsapp_sales_assistant` using Mongoose's `dbName` option, regardless of a database name in the URI path.
4. Percent-encode reserved characters in the database username or password when required by the URI format. Never commit or share the completed URI.

The backend waits for the MongoDB connection before opening its HTTP port. If configuration or connectivity is unavailable, startup fails with a safe message. No models or collections are created by this foundation step.

## Supported environment variables

| Variable | Accepted values | Default |
|---|---|---|
| `NODE_ENV` | `development`, `production`, `test` | `development` |
| `PORT` | Integer from `1` to `65535` | `5000` |
| `FRONTEND_ORIGIN` | One origin URL, without a path | `http://localhost:5173` |
| `MONGODB_URI` | MongoDB URI beginning with `mongodb://` or `mongodb+srv://` | Required; set in local `.env` or deployment secrets |
| `JWT_SECRET` | Random secret of at least 32 UTF-8 bytes | Required; keep private and set only in local `.env` or deployment secrets |
| `JWT_EXPIRES_IN` | Positive duration using `s`, `m`, `h`, or `d` (for example `1h`) | `1h` |

The backend loads `backend/.env`, validates configuration at startup, and stops with a value-free validation message if a setting is invalid. Deployment hosts should receive these settings through their private environment-variable configuration; do not upload or commit `.env`.

Generate a strong `JWT_SECRET` separately and set it only in the private backend environment. The value in `.env.example` is a nonfunctional placeholder and is rejected by validation. Login access tokens use the configured lifetime, which defaults to one hour; the backend pins signing and verification to HS256.

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
