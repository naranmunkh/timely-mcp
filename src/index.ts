#!/usr/bin/env node
/**
 * Timely MCP server — single self-contained entry point.
 *
 * Runs two ways from this one file:
 *   - HTTP mode  (Vercel): when PORT is set, starts a Node HTTP server that
 *     serves the MCP over Streamable HTTP at any path (canonically /mcp),
 *     guarded by a bearer token. Vercel's "node" framework auto-detects this
 *     file as the root entrypoint and routes all traffic to it.
 *   - stdio mode (local / Claude Desktop): when PORT is not set.
 *
 * SELF-CONTAINED ON PURPOSE: no relative imports, so neither Vercel's bundler
 * nor Node's ESM loader has to resolve sibling ".ts"/".js" files.
 *
 * Env:
 *   TIMELY_USERNAME, TIMELY_PASSWORD   required
 *   TIMELY_MCP_AUTH_TOKEN              required in HTTP mode (fails closed)
 *   TIMELY_COMPANY_REGISTER            optional default register
 *   TIMELY_BASE_URL                    optional API base override
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ===========================================================================
// Timely API client
// ===========================================================================

const DEFAULT_BASE_URL = "https://api.timely.mn";

interface TimelyResult<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  pagination?: unknown;
  raw: unknown;
}

class TimelyError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
    this.name = "TimelyError";
  }
}

class TimelyClient {
  private readonly baseUrl: string;
  private token: string | null = null;
  private loginInFlight: Promise<string> | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    baseUrl: string | undefined,
    readonly defaultCompanyRegister: string | undefined
  ) {
    if (!username || !password) {
      throw new Error("Timely credentials missing. Set TIMELY_USERNAME and TIMELY_PASSWORD.");
    }
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async login(force = false): Promise<string> {
    if (this.token && !force) return this.token;
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const res = await fetch(`${this.baseUrl}/v3/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.username, password: this.password }),
      });
      const body = await safeJson(res);
      if (!res.ok) throw new TimelyError(`Login failed (HTTP ${res.status})`, res.status, body);
      const token = extractToken(body);
      if (!token) {
        throw new TimelyError("Login succeeded but no JWT was found in the response.", res.status, body);
      }
      this.token = token;
      return token;
    })();
    try {
      return await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
  }

  async post<T = unknown>(path: string, payload: Record<string, unknown>): Promise<TimelyResult<T>> {
    const doRequest = (token: string) =>
      fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

    let token = await this.login();
    let res = await doRequest(token);
    if (res.status === 401 || res.status === 403) {
      token = await this.login(true);
      res = await doRequest(token);
    }
    const body = await safeJson(res);
    if (!res.ok) throw new TimelyError(`Timely API error on ${path} (HTTP ${res.status})`, res.status, body);
    return normalizeEnvelope<T>(body);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeEnvelope<T>(body: unknown): TimelyResult<T> {
  if (body === null || typeof body !== "object") {
    return { success: false, raw: body, message: "Empty or non-JSON response" };
  }
  const obj = body as Record<string, unknown>;
  const success = obj.success === "1" || obj.success === 1 || obj.success === true;
  return {
    success,
    data: obj.data as T | undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
    pagination: obj.pagination,
    raw: body,
  };
}

function extractToken(body: unknown): string | null {
  if (typeof body === "string") return body || null;
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, any>;
  const candidates = [
    obj.token, obj.access_token, obj.accessToken, obj.jwt,
    obj.data?.token, obj.data?.access_token, obj.data?.accessToken, obj.data?.jwt,
  ];
  for (const c of candidates) if (typeof c === "string" && c.length > 0) return c;
  return null;
}

// ===========================================================================
// MCP server + tools
// ===========================================================================

let cachedClient: TimelyClient | null = null;
function getClient(): TimelyClient {
  if (!cachedClient) {
    cachedClient = new TimelyClient(
      process.env.TIMELY_USERNAME ?? "",
      process.env.TIMELY_PASSWORD ?? "",
      process.env.TIMELY_BASE_URL,
      process.env.TIMELY_COMPANY_REGISTER
    );
  }
  return cachedClient;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");
const registerSchema = z.string().min(1, "Company register is required (7 digits)");

function resolveRegister(provided?: string): string {
  const value = provided ?? getClient().defaultCompanyRegister;
  if (!value) {
    throw new Error("company_register is required. Pass it in the call or set TIMELY_COMPANY_REGISTER.");
  }
  return value;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toToolResult(result: TimelyResult): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result.raw ?? result, null, 2) }],
    isError: !result.success,
  };
}

async function guarded(fn: () => Promise<TimelyResult>): Promise<ToolResult> {
  try {
    return toToolResult(await fn());
  } catch (err) {
    if (err instanceof TimelyError) {
      const detail = err.body != null ? `\n${JSON.stringify(err.body, null, 2)}` : "";
      return { content: [{ type: "text", text: `${err.message}${detail}` }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "timely-mcp", version: "1.0.0" });
  const client = getClient();

  server.tool(
    "timely_employer_info",
    "Get organization (company) info from Timely for a given 7-digit company register. " +
      "Returns the registered company name. Useful to verify a register number is valid.",
    {
      company_register: registerSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
    },
    async ({ company_register }) =>
      guarded(() =>
        client.post("/v3/employer-info", { company_register: resolveRegister(company_register) })
      )
  );

  server.tool(
    "timely_overview_attd",
    "Company-wide attendance report between two dates. Returns per-employee attendance " +
      "detail (worked days/hours, late, absent, leave, overtime, vacation, etc.) with " +
      "pagination. Set div_id to a department id, or '0' for all departments.",
    {
      company_register: registerSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
      div_id: z.union([z.string(), z.number()]).optional().describe("Department id; '0' (default) = all."),
      dateFrom: dateSchema.describe("Start date, e.g. 2023-01-01"),
      dateTo: dateSchema.describe("End date, e.g. 2023-01-31"),
      page: z.number().int().positive().optional().describe("Page number (optional)."),
      limit: z.number().int().positive().optional().describe("Employees per page (optional)."),
    },
    async ({ company_register, div_id, dateFrom, dateTo, page, limit }) =>
      guarded(() => {
        const payload: Record<string, unknown> = {
          company_register: resolveRegister(company_register),
          div_id: div_id ?? "0",
          dateFrom,
          dateTo,
        };
        if (page !== undefined) payload.page = page;
        if (limit !== undefined) payload.limit = limit;
        return client.post("/v3/overview-attd", payload);
      })
  );

  server.tool(
    "timely_employee_attd",
    "Attendance report for a single employee between two dates. Identify the employee " +
      "by register number and/or phone. Returns supposed vs. actual worked days and hours.",
    {
      company_register: registerSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
      register: z.string().optional().describe("Employee national register number, e.g. УУ12345678."),
      phone: z.union([z.string(), z.number()]).optional().describe("Employee phone number."),
      dateFrom: dateSchema.describe("Start date, e.g. 2023-01-01"),
      dateTo: dateSchema.describe("End date, e.g. 2023-01-31"),
    },
    async ({ company_register, register, phone, dateFrom, dateTo }) =>
      guarded(() => {
        if (!register && phone === undefined) throw new Error("Provide at least one of: register, phone.");
        const payload: Record<string, unknown> = {
          company_register: resolveRegister(company_register),
          dateFrom,
          dateTo,
        };
        if (register) payload.register = register;
        if (phone !== undefined) payload.phone = phone;
        return client.post("/v3/employee-attd", payload);
      })
  );

  server.tool(
    "timely_employee_info",
    "Get a single employee's profile from Timely (name, register, phone, salary, bank " +
      "details). Identify by register, tax id (tin_number), and/or phone.",
    {
      company_register: registerSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
      register: z.string().optional().describe("Employee national register number."),
      tin_number: z.string().optional().describe("Taxpayer (TIN) number."),
      phone: z.union([z.string(), z.number()]).optional().describe("Employee phone number."),
    },
    async ({ company_register, register, tin_number, phone }) =>
      guarded(() => {
        if (!register && !tin_number && phone === undefined) {
          throw new Error("Provide at least one of: register, tin_number, phone.");
        }
        const payload: Record<string, unknown> = {
          company_register: resolveRegister(company_register),
        };
        if (register) payload.register = register;
        if (tin_number) payload.tin_number = tin_number;
        if (phone !== undefined) payload.phone = phone;
        return client.post("/v3/employee-info", payload);
      })
  );

  return server;
}

// ===========================================================================
// HTTP mode (Vercel) — bearer-guarded Streamable HTTP
// ===========================================================================

function httpAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.TIMELY_MCP_AUTH_TOKEN;
  if (!expected) return false; // fail closed
  const raw = req.headers["authorization"] ?? "";
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const secret = Buffer.from(expected);
  if (provided.length !== secret.length) return false;
  return timingSafeEqual(provided, secret);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function startHttpServer(port: number): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Health check (no auth)
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    // Info page for any other GET (no auth)
    if (req.method === "GET") {
      sendJson(res, 200, {
        name: "timely-mcp",
        message: "POST to /mcp with Authorization: Bearer <token> to use the MCP endpoint.",
      });
      return;
    }
    // Everything else must be a POST to the MCP endpoint
    if (req.method !== "POST") {
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      return;
    }

    if (!process.env.TIMELY_MCP_AUTH_TOKEN) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Server misconfigured: TIMELY_MCP_AUTH_TOKEN not set." },
        id: null,
      });
      return;
    }
    if (!httpAuthorized(req)) {
      sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }

    const body = await readBody(req);
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: null,
        });
      }
    }
  });
  server.listen(port, () => {
    console.error(`timely-mcp HTTP server listening on :${port}`);
  });
}

// ===========================================================================
// stdio mode (local)
// ===========================================================================

async function startStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("timely-mcp server running on stdio");
}

// ===========================================================================
// Boot — HTTP when PORT is set (Vercel), otherwise stdio.
// ===========================================================================

const port = process.env.PORT ? Number(process.env.PORT) : undefined;
if (port && Number.isFinite(port)) {
  startHttpServer(port);
} else {
  startStdio().catch((err) => {
    console.error("Fatal error starting timely-mcp:", err);
    process.exit(1);
  });
}
