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

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
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
    // Do NOT throw on missing creds here — tools/list and listing must work
    // without credentials. The check is deferred to login() (first API call).
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async login(force = false): Promise<string> {
    if (!this.username || !this.password) {
      throw new TimelyError("Timely credentials missing. Set TIMELY_USERNAME and TIMELY_PASSWORD.");
    }
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
    let body = await safeJson(res);
    // Timely's v3 endpoints return a valid success envelope even with an HTTP
    // 401 status, so only retry with a fresh token when the body is NOT already
    // a successful envelope.
    if ((res.status === 401 || res.status === 403) && !isSuccessEnvelope(body)) {
      token = await this.login(true);
      res = await doRequest(token);
      body = await safeJson(res);
    }
    // Trust the body envelope over the HTTP status (Timely's codes are unreliable).
    if (isEnvelope(body)) return normalizeEnvelope<T>(body);
    if (!res.ok) throw new TimelyError(`Timely API error on ${path} (HTTP ${res.status})`, res.status, body);
    return normalizeEnvelope<T>(body);
  }
}

/** True if the body is a Timely-shaped envelope (has a `success` field). */
function isEnvelope(body: unknown): boolean {
  return !!body && typeof body === "object" && "success" in (body as Record<string, unknown>);
}

/** True if the body is an envelope whose `success` flag is truthy. */
function isSuccessEnvelope(body: unknown): boolean {
  if (!isEnvelope(body)) return false;
  const s = (body as Record<string, unknown>).success;
  return s === "1" || s === 1 || s === true;
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
    typeof obj.data === "string" ? obj.data : undefined,
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
          dateFrom,
          dateTo,
        };
        if (div_id !== undefined) payload.div_id = div_id;
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

function tokenMatches(provided: string | null | undefined): boolean {
  const expected = process.env.TIMELY_MCP_AUTH_TOKEN;
  if (!expected || !provided) return false; // fail closed
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Token from the Authorization: Bearer header, if present. */
function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers["authorization"] ?? "";
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Token from the URL path, e.g. /mcp/<token>. This lets clients that don't
 * support custom auth headers (some MCP connector UIs that otherwise force an
 * OAuth flow on a 401) authenticate by embedding the secret in the URL.
 */
function pathToken(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && segments[0] === "mcp") return segments[1];
  return null;
}

function httpAuthorized(req: IncomingMessage, url: URL): boolean {
  return tokenMatches(bearerToken(req)) || tokenMatches(pathToken(url));
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

/**
 * Vercel function handler (default export). Vercel detects this module as the
 * project entrypoint and invokes this per request with Node req/res. Handles
 * any path: GET /health and other GETs return info (no auth); POST is the
 * bearer-guarded MCP endpoint over Streamable HTTP.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (req.method === "GET") {
    // 404 (not a 200 info page) so clients don't mistake any path — including
    // /.well-known/* — for OAuth metadata and start an OAuth flow.
    sendJson(res, 404, { error: "Not found. POST to /mcp (or /mcp/<token>) for the MCP endpoint." });
    return;
  }
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
  if (!httpAuthorized(req, url)) {
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }

  // Vercel may pre-parse the JSON body onto req.body; fall back to reading the stream.
  let body = (req as IncomingMessage & { body?: unknown }).body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }
  if (body === undefined) body = await readBody(req);

  try {
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
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
// Boot — stdio only when run directly as a CLI (local / Claude Desktop).
// When imported by Vercel as a function module, nothing runs at top level;
// Vercel invokes the default export above per request.
// ===========================================================================

function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  startStdio().catch((err) => {
    console.error("Fatal error starting timely-mcp:", err);
    process.exit(1);
  });
}
