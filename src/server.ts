/**
 * Shared MCP server factory.
 *
 * Both entry points reuse this:
 *   - src/index.ts   → stdio transport (local / Claude Desktop)
 *   - api/mcp.ts     → Streamable HTTP transport (Vercel remote MCP)
 *
 * Tools are registered here once so the two transports never drift apart.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TimelyClient, TimelyError, type TimelyResult } from "./timely.js";

// ---------------------------------------------------------------------------
// Client (lazily built from env, memoized per process)
// ---------------------------------------------------------------------------

let cachedClient: TimelyClient | null = null;

export function getClient(): TimelyClient {
  if (cachedClient) return cachedClient;
  cachedClient = new TimelyClient({
    username: process.env.TIMELY_USERNAME ?? "",
    password: process.env.TIMELY_PASSWORD ?? "",
    baseUrl: process.env.TIMELY_BASE_URL,
    defaultCompanyRegister: process.env.TIMELY_COMPANY_REGISTER,
  });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Shared validation + helpers
// ---------------------------------------------------------------------------

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

const registerNumberSchema = z
  .string()
  .min(1, "Company register is required (7 digits)");

function resolveCompanyRegister(provided?: string): string {
  const value = provided ?? getClient().defaultCompanyRegister;
  if (!value) {
    throw new Error(
      "company_register is required. Pass it in the call or set TIMELY_COMPANY_REGISTER."
    );
  }
  return value;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function toToolResult(result: TimelyResult): ToolResult {
  const text = JSON.stringify(result.raw ?? result, null, 2);
  return { content: [{ type: "text", text }], isError: !result.success };
}

async function guarded(fn: () => Promise<TimelyResult>): Promise<ToolResult> {
  try {
    return toToolResult(await fn());
  } catch (err) {
    if (err instanceof TimelyError) {
      const detail =
        err.body != null ? `\n${JSON.stringify(err.body, null, 2)}` : "";
      return {
        content: [{ type: "text", text: `${err.message}${detail}` }],
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "timely-mcp", version: "1.0.0" });
  const client = getClient();

  server.tool(
    "timely_employer_info",
    "Get organization (company) info from Timely for a given 7-digit company register. " +
      "Returns the registered company name. Useful to verify a register number is valid.",
    {
      company_register: registerNumberSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
    },
    async ({ company_register }) =>
      guarded(() =>
        client.post("/v3/employer-info", {
          company_register: resolveCompanyRegister(company_register),
        })
      )
  );

  server.tool(
    "timely_overview_attd",
    "Company-wide attendance report between two dates. Returns per-employee attendance " +
      "detail (worked days/hours, late, absent, leave, overtime, vacation, etc.) with " +
      "pagination. Set div_id to a department id, or '0' for all departments.",
    {
      company_register: registerNumberSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
      div_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Department id; '0' (default) = all departments."),
      dateFrom: dateSchema.describe("Start date, e.g. 2023-01-01"),
      dateTo: dateSchema.describe("End date, e.g. 2023-01-31"),
      page: z.number().int().positive().optional().describe("Page number (optional)."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Employees per page (optional)."),
    },
    async ({ company_register, div_id, dateFrom, dateTo, page, limit }) =>
      guarded(() => {
        const payload: Record<string, unknown> = {
          company_register: resolveCompanyRegister(company_register),
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
      company_register: registerNumberSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
      register: z
        .string()
        .optional()
        .describe("Employee national register number, e.g. УУ12345678."),
      phone: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee phone number."),
      dateFrom: dateSchema.describe("Start date, e.g. 2023-01-01"),
      dateTo: dateSchema.describe("End date, e.g. 2023-01-31"),
    },
    async ({ company_register, register, phone, dateFrom, dateTo }) =>
      guarded(() => {
        if (!register && phone === undefined) {
          throw new Error("Provide at least one of: register, phone.");
        }
        const payload: Record<string, unknown> = {
          company_register: resolveCompanyRegister(company_register),
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
      company_register: registerNumberSchema
        .optional()
        .describe("7-digit company register. Falls back to TIMELY_COMPANY_REGISTER."),
      register: z.string().optional().describe("Employee national register number."),
      tin_number: z.string().optional().describe("Taxpayer (TIN) number."),
      phone: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Employee phone number."),
    },
    async ({ company_register, register, tin_number, phone }) =>
      guarded(() => {
        if (!register && !tin_number && phone === undefined) {
          throw new Error("Provide at least one of: register, tin_number, phone.");
        }
        const payload: Record<string, unknown> = {
          company_register: resolveCompanyRegister(company_register),
        };
        if (register) payload.register = register;
        if (tin_number) payload.tin_number = tin_number;
        if (phone !== undefined) payload.phone = phone;
        return client.post("/v3/employee-info", payload);
      })
  );

  return server;
}
