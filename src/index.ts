#!/usr/bin/env node
/**
 * Timely MCP server — stdio entry point (local / Claude Desktop).
 *
 * For the Vercel-hosted remote (Streamable HTTP) variant see api/mcp.ts.
 * All tools live in src/server.ts so both transports stay in sync.
 *
 * Configuration (environment variables):
 *   TIMELY_USERNAME            required — API login name
 *   TIMELY_PASSWORD            required — API password
 *   TIMELY_COMPANY_REGISTER    optional — default 7-digit company register
 *   TIMELY_BASE_URL            optional — defaults to https://api.timely.mn
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe; stdout is reserved for the MCP protocol stream.
  console.error("timely-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting timely-mcp:", err);
  process.exit(1);
});
