# Deploy & operate

The repo is already on GitHub (`naranmunkh/timely-mcp`) and connected to Vercel
with Git integration. **Every push to `main` auto-deploys.**

## Set environment variables (one time)

In Vercel → Project `timely-mcp` → Settings → Environment Variables (Production):

| Name | Value |
| --- | --- |
| `TIMELY_USERNAME` | `ubcabholding` |
| `TIMELY_PASSWORD` | _Timely password_ |
| `TIMELY_MCP_AUTH_TOKEN` | output of `openssl rand -hex 32` |
| `TIMELY_COMPANY_REGISTER` | _7-digit register (optional)_ |

After adding/changing env vars, trigger a redeploy (Vercel → Deployments →
Redeploy, or push any commit).

## Test

```bash
# health (no auth)
curl -s https://timely-mcp.vercel.app/health

# tools/list (single line)
curl -s -X POST https://timely-mcp.vercel.app/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer <TIMELY_MCP_AUTH_TOKEN>' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

- 4 tools listed → working.
- `Unauthorized` (401) → token mismatch with `TIMELY_MCP_AUTH_TOKEN`.
- `TIMELY_MCP_AUTH_TOKEN not set` (500 JSON) → set the env var + redeploy.

## Make further changes

```bash
git clone https://github.com/naranmunkh/timely-mcp.git
cd timely-mcp && npm install
# edit src/index.ts
npm run typecheck
git commit -am "..." && git push   # auto-deploys
```

## Debugging deploys

Use the Vercel dashboard (Deployments → a deployment → Build Logs / Runtime
Logs). The architecture is deliberately a single `src/index.ts` with a default
`(req,res)` export and no `vercel.json` — don't add `/api` or `vercel.json`
without re-checking routing.
