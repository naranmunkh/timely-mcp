# Timely MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Timely.mn](https://developer.timely.mn/) v3 time-attendance API as tools for
Claude and any other MCP client.

Built for **UBCab Holding**. Runs two ways from one codebase:

- **Local (stdio)** — `src/index.ts`, for Claude Desktop / Cowork.
- **Remote (Streamable HTTP)** — `api/mcp.ts`, deployed on **Vercel**, reachable
  at `POST /mcp` and protected by a bearer token.

## Tools

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `timely_employer_info` | `POST /v3/employer-info` | Company name lookup by 7-digit register |
| `timely_overview_attd` | `POST /v3/overview-attd` | Company-wide attendance report (paginated) |
| `timely_employee_attd` | `POST /v3/employee-attd` | One employee's attendance between two dates |
| `timely_employee_info` | `POST /v3/employee-info` | One employee's profile (name, salary, bank) |

Login (`POST /v3/login` → JWT) is handled automatically: the token is cached and
refreshed on a 401/403.

## Project layout

```
timely-mcp/
├── api/
│   └── mcp.ts          # Vercel function — remote MCP over Streamable HTTP (+ bearer auth)
├── src/
│   ├── index.ts        # stdio entry point (local)
│   ├── server.ts       # shared MCP server + tool definitions
│   └── timely.ts       # API client (login, token cache, POST helper)
├── public/index.html   # landing page for the Vercel root
├── scripts/test-login.mjs
├── vercel.json
├── .env.example
├── package.json
└── tsconfig.json
```

## Setup

Requires Node.js 18+.

```bash
cd timely-mcp
npm install
npm run build       # compiles src/ → dist/ (stdio build)
npm run typecheck   # typechecks both the stdio and Vercel builds
```

Copy `.env.example` to `.env` and fill it in.

## Verify credentials (live test)

Prints the real `/v3/login` response so you can confirm the JWT field name,
then calls `employer-info`:

```bash
node --env-file=.env scripts/test-login.mjs
```

If the JWT lives under a field other than `token` / `access_token` /
`accessToken` / `jwt`, add it to `extractToken()` in `src/timely.ts`.

## Use locally (Claude Desktop)

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

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

## Deploy to Vercel (remote MCP)

The endpoint **fails closed**: if `TIMELY_MCP_AUTH_TOKEN` is not set, every
request is rejected. Set these environment variables in the Vercel project
(Settings → Environment Variables):

| Variable | Required | Notes |
| --- | --- | --- |
| `TIMELY_USERNAME` | yes | Timely API login |
| `TIMELY_PASSWORD` | yes | Timely API password |
| `TIMELY_MCP_AUTH_TOKEN` | yes | Secret clients send as `Bearer`. Generate: `openssl rand -hex 32` |
| `TIMELY_COMPANY_REGISTER` | no | Default 7-digit register |
| `TIMELY_BASE_URL` | no | Defaults to `https://api.timely.mn` |

After deploy, the MCP endpoint is `https://<your-project>.vercel.app/mcp`.

Connect a client (e.g. Claude custom connector / `mcp.json`):

```json
{
  "mcpServers": {
    "timely-remote": {
      "type": "http",
      "url": "https://<your-project>.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <TIMELY_MCP_AUTH_TOKEN>" }
    }
  }
}
```

Quick smoke test once deployed:

```bash
curl -s -X POST https://<your-project>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <TIMELY_MCP_AUTH_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Notes

- Responses use a `{ "success": "1" | "0", ... }` envelope; the server coerces
  `success` to a boolean and marks the MCP result as an error when `"0"`,
  passing through Timely's `message`.
- Dates must be `YYYY-MM-DD`; company register is the 7-digit number.
- Never commit `.env`.
- Treat the deployed URL + bearer token as secrets — they expose employee
  salary and bank details.
```
