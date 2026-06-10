# Git push + Vercel deploy — step by step

Run these on your own Mac (not inside Cowork). Open Terminal and `cd` into this
folder first:

```bash
cd "~/Documents/Claude/Projects/WorkOS/WorkOS/UBCab/Development/timely-mcp"
```

## 1. Initialise git (clean)

A partial `.git` may have been left by the assistant — remove it and start fresh:

```bash
rm -rf .git
git init
git add -A
git commit -m "Initial commit: Timely MCP server (stdio + Vercel remote HTTP)"
```

`node_modules/`, `dist/`, and `.env` are already git-ignored, so they won't be
committed.

## 2. Create the GitHub repo and push

Create an **empty private** repo at https://github.com/new (e.g. name it
`timely-mcp`, no README/.gitignore). Then:

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/timely-mcp.git
git push -u origin main
```

When prompted for a password, paste a **Personal Access Token** (GitHub →
Settings → Developer settings → Tokens → Fine-grained, with `Contents: Read and
write` on this repo). Your normal password won't work for HTTPS push.

> Prefer SSH? Use `git@github.com:<your-username>/timely-mcp.git` as the remote
> instead and skip the token.

## 3. Deploy to Vercel

Easiest path — import the repo:

1. Go to https://vercel.com/new and import `timely-mcp`.
2. Framework preset: **Other** (leave build/output settings default — there's
   nothing to build for the functions).
3. Add Environment Variables (Settings → Environment Variables):

   | Name | Value |
   | --- | --- |
   | `TIMELY_USERNAME` | `ubcabholding` |
   | `TIMELY_PASSWORD` | _your Timely password_ |
   | `TIMELY_MCP_AUTH_TOKEN` | run `openssl rand -hex 32` and paste the output |
   | `TIMELY_COMPANY_REGISTER` | _your 7-digit register (optional)_ |

4. Deploy.

Or with the CLI:

```bash
npm i -g vercel
vercel            # link + first deploy
vercel env add TIMELY_USERNAME
vercel env add TIMELY_PASSWORD
vercel env add TIMELY_MCP_AUTH_TOKEN
vercel env add TIMELY_COMPANY_REGISTER
vercel --prod     # production deploy
```

## 4. Test the live endpoint

Replace the URL and token:

```bash
curl -s -X POST https://<your-project>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <TIMELY_MCP_AUTH_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should get a JSON-RPC response listing the four `timely_*` tools. A request
without the bearer token returns `401`.

## 5. Connect a client

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

## Security reminder

The deployed URL together with the bearer token can read employee **salary and
bank details**. Treat both as secrets, rotate the token if it leaks
(`openssl rand -hex 32` → update the Vercel env var → redeploy), and keep the
GitHub repo private.
```
