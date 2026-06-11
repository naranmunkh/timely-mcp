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
import { timingSafeEqual, createHmac, createHash } from "node:crypto";
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

/** Read an application/x-www-form-urlencoded (or pre-parsed) body as a map. */
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (pre && typeof pre === "object" && !Buffer.isBuffer(pre)) {
    return pre as Record<string, string>;
  }
  let raw = typeof pre === "string" ? pre : "";
  if (!raw) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

// ===========================================================================
// OAuth 2.1 (PKCE) — lets MCP clients prompt the user for the secret at
// connect time instead of embedding a token in the URL. Stateless: auth codes
// and access tokens are HMAC-signed blobs (no datastore needed). The HMAC key
// and the password the user types are both TIMELY_MCP_AUTH_TOKEN.
// ===========================================================================

function hmac(data: string): string {
  return createHmac("sha256", process.env.TIMELY_MCP_AUTH_TOKEN ?? "").update(data).digest("base64url");
}

function signPayload(obj: unknown): string {
  const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${p}.${hmac(p)}`;
}

function verifySigned(token: string): Record<string, any> | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const p = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(p);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (typeof obj.exp === "number" && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

function mintAuthCode(redirectUri: string, codeChallenge: string): string {
  return signPayload({ t: "code", ru: redirectUri, cc: codeChallenge, exp: Date.now() + 5 * 60 * 1000 });
}

function mintAccessToken(): string {
  return signPayload({ t: "at", sub: "timely", exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
}

function isValidAccessToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const obj = verifySigned(token);
  return !!obj && obj.t === "at";
}

function pkceOk(verifier: string, challenge: string): boolean {
  const h = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(h);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

function baseUrl(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function authorizePage(params: URLSearchParams, error?: string): string {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "response_type"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? "")}">`)
    .join("\n");
  return `<!doctype html><html lang="mn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Timely MCP — Нэвтрэх</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:380px;margin:5rem auto;padding:0 1.25rem;color:#1a1a1a}
h1{font-size:1.25rem}label{display:block;margin:1rem 0 .35rem;font-size:.9rem}
input[type=password]{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;font-size:1rem;box-sizing:border-box}
button{margin-top:1rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:#1a1a1a;color:#fff;font-size:1rem;cursor:pointer}
.err{color:#b00020;font-size:.9rem;margin-top:.75rem}.muted{color:#666;font-size:.85rem;margin-top:1rem}</style></head>
<body><h1>Timely MCP холболт</h1><p class="muted">UBCab Holding-ийн Timely MCP сервер рүү холбогдохын тулд хандах түлхүүрээ оруулна уу.</p>
<form method="POST" action="/authorize">${hidden}
<label for="pw">Хандах түлхүүр (access token)</label>
<input id="pw" type="password" name="password" autocomplete="off" autofocus required>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<button type="submit">Зөвшөөрөх</button></form></body></html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * Vercel function handler (default export). Vercel detects this module as the
 * project entrypoint and invokes this per request with Node req/res. Handles
 * any path: GET /health and other GETs return info (no auth); POST is the
 * bearer-guarded MCP endpoint over Streamable HTTP.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // ---- OAuth discovery metadata ----
  if (method === "GET" && path === "/.well-known/oauth-protected-resource") {
    const base = baseUrl(req);
    sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    return;
  }
  if (
    method === "GET" &&
    (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")
  ) {
    const base = baseUrl(req);
    sendJson(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
    return;
  }

  // ---- OAuth dynamic client registration ----
  if (method === "POST" && path === "/register") {
    let reg = (req as IncomingMessage & { body?: unknown }).body as Record<string, unknown> | string | undefined;
    if (reg === undefined || typeof reg === "string") reg = (await readBody(req)) as Record<string, unknown>;
    const redirectUris = Array.isArray((reg as any)?.redirect_uris) ? (reg as any).redirect_uris : [];
    sendJson(res, 201, {
      client_id: "timely-mcp",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: redirectUris,
    });
    return;
  }

  // ---- OAuth authorize (login form the user sees at connect time) ----
  if (path === "/authorize") {
    if (!process.env.TIMELY_MCP_AUTH_TOKEN) {
      sendJson(res, 500, { error: "server_error", error_description: "TIMELY_MCP_AUTH_TOKEN not set" });
      return;
    }
    if (method === "GET") {
      sendHtml(res, 200, authorizePage(url.searchParams));
      return;
    }
    if (method === "POST") {
      const form = await readForm(req);
      const params = new URLSearchParams();
      for (const k of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "response_type"]) {
        if (form[k] !== undefined) params.set(k, form[k]);
      }
      const redirectUri = form.redirect_uri ?? "";
      const codeChallenge = form.code_challenge ?? "";
      if (!redirectUri || !codeChallenge || form.code_challenge_method !== "S256") {
        sendHtml(res, 400, authorizePage(params, "Буруу хүсэлт (PKCE S256 шаардлагатай)."));
        return;
      }
      if (!tokenMatches(form.password)) {
        sendHtml(res, 401, authorizePage(params, "Хандах түлхүүр буруу байна."));
        return;
      }
      const code = mintAuthCode(redirectUri, codeChallenge);
      const sep = redirectUri.includes("?") ? "&" : "?";
      let location = `${redirectUri}${sep}code=${encodeURIComponent(code)}`;
      if (form.state) location += `&state=${encodeURIComponent(form.state)}`;
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }
  }

  // ---- OAuth token exchange ----
  if (method === "POST" && path === "/token") {
    const form = await readForm(req);
    if (form.grant_type !== "authorization_code") {
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    const decoded = form.code ? verifySigned(form.code) : null;
    if (!decoded || decoded.t !== "code") {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    if (form.redirect_uri && form.redirect_uri !== decoded.ru) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    if (!form.code_verifier || !pkceOk(form.code_verifier, decoded.cc)) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
    sendJson(res, 200, {
      access_token: mintAccessToken(),
      token_type: "Bearer",
      expires_in: 30 * 24 * 60 * 60,
      scope: "mcp",
    });
    return;
  }

  // ---- Non-MCP GETs → 404 ----
  if (method === "GET") {
    sendJson(res, 404, { error: "Not found. POST to /mcp for the MCP endpoint." });
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }

  // ---- MCP endpoint (POST /mcp or /mcp/<token>) ----
  if (!process.env.TIMELY_MCP_AUTH_TOKEN) {
    sendJson(res, 500, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Server misconfigured: TIMELY_MCP_AUTH_TOKEN not set." },
      id: null,
    });
    return;
  }
  const bearer = bearerToken(req);
  const authed = isValidAccessToken(bearer) || tokenMatches(bearer) || tokenMatches(pathToken(url));
  if (!authed) {
    // 401 with resource-metadata pointer triggers the client's OAuth flow.
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
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
