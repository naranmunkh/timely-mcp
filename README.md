# Timely MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Timely.mn](https://developer.timely.mn/) v3 time-attendance API as tools for
Claude and any other MCP client.

Built for **UBCab Holding**. One self-contained file (`src/index.ts`) runs two ways:

- **Remote (Vercel)** — Vercel's Node framework invokes the file's default
  `(req, res)` handler. Live at `POST https://timely-mcp.vercel.app/mcp`,
  protected by a bearer token.
- **Local (stdio)** — when run directly (`node dist/index.js`), it speaks MCP
  over stdio for Claude Desktop.

## Tools

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `timely_employer_info` | `POST /v3/employer-info` | Company name lookup by 7-digit register |
| `timely_overview_attd` | `POST /v3/overview-attd` | Company-wide attendance report (paginated) |
| `timely_employee_attd` | `POST /v3/employee-attd` | One employee's attendance between two dates |
| `timely_employee_info` | `POST /v3/employee-info` | One employee's profile (name, salary, bank) |

Login (`POST /v3/login` → JWT) is automatic: the token is cached and refreshed
on a 401/403. Credentials are only required when a tool actually calls the API,
so `tools/list` works without them.

## Endpoints (deployed)

- `POST /mcp` — the MCP endpoint (bearer token required).
- `GET /health` — returns `{"status":"ok"}` (no auth).

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `TIMELY_USERNAME` | yes (for API calls) | Timely API login |
| `TIMELY_PASSWORD` | yes (for API calls) | Timely API password |
| `TIMELY_MCP_AUTH_TOKEN` | yes (remote) | Secret clients send as `Bearer`. The POST endpoint fails closed without it. Generate: `openssl rand -hex 32` |
| `TIMELY_COMPANY_REGISTER` | no | Default 7-digit register |
| `TIMELY_BASE_URL` | no | Defaults to `https://api.timely.mn` |

## Use locally (Claude Desktop)

```bash
npm install
npm run build
```

```json
{
  "mcpServers": {
    "timely": {
      "command": "node",
      "args": ["/absolute/path/to/timely-mcp/dist/index.js"],
      "env": {
        "TIMELY_USERNAME": "ubcabholding",
        "TIMELY_PASSWORD": "your-password",
        "TIMELY_COMPANY_REGISTER": "1234567"
      }
    }
  }
}
```

## Connect to the remote endpoint

Three ways to authenticate (the endpoint accepts any of them):

**1. OAuth (recommended — nothing secret in the URL).** Add a custom connector
with just the URL `https://timely-mcp.vercel.app/mcp`. The client discovers the
OAuth metadata, opens a login page, and prompts for the access token
(`TIMELY_MCP_AUTH_TOKEN`). Implemented as a stateless OAuth 2.1 + PKCE server:
`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/register`, `/authorize`, `/token`. Auth codes and access tokens are HMAC-signed
blobs (no datastore).

**2. Header (Claude Desktop JSON config).**

```json
{
  "mcpServers": {
    "timely-remote": {
      "type": "http",
      "url": "https://timely-mcp.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <TIMELY_MCP_AUTH_TOKEN>" }
    }
  }
}
```

**3. Token in URL path** (for clients that can't send a header):
`https://timely-mcp.vercel.app/mcp/<TIMELY_MCP_AUTH_TOKEN>`

Smoke test:

```bash
curl -s -X POST https://timely-mcp.vercel.app/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer <TIMELY_MCP_AUTH_TOKEN>' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deployment notes

- Vercel auto-detects this repo as a **Node** project and runs `src/index.ts`'s
  default export as a serverless function — there is **no `vercel.json`** and no
  `/api` directory by design. Adding either reintroduced routing/entrypoint bugs.
- Every push to `main` auto-deploys via Vercel's Git integration.
- Verify the JWT field with `node --env-file=.env scripts/test-login.mjs`; if the
  token lives under a field other than `token`/`access_token`/`accessToken`/`jwt`,
  add it to `extractToken()` in `src/index.ts`.

## Security

The deployed URL + bearer token can read employee **salary and bank details**.
Treat both as secrets; rotate the token (`openssl rand -hex 32` → update the
Vercel env var → redeploy) if it leaks.
