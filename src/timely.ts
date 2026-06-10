/**
 * Timely.mn API client.
 *
 * Handles JWT login (POST /v3/login), token caching with automatic refresh,
 * and a shared POST helper for the v3 endpoints. All Timely responses follow
 * the shape { success: "1" | "0", data?, message?, pagination? }.
 *
 * Docs: https://developer.timely.mn/
 */

const DEFAULT_BASE_URL = "https://api.timely.mn";

export interface TimelyConfig {
  username: string;
  password: string;
  baseUrl?: string;
  /** Optional default company register used when a tool call omits it. */
  defaultCompanyRegister?: string;
}

/** A normalized Timely envelope. `success` is coerced to a boolean. */
export interface TimelyResult<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  pagination?: unknown;
  /** Raw decoded body, kept for callers that want fields we didn't model. */
  raw: unknown;
}

export class TimelyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "TimelyError";
  }
}

export class TimelyClient {
  private readonly baseUrl: string;
  private token: string | null = null;
  /** De-dupes concurrent logins so we only hit /v3/login once at a time. */
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly config: TimelyConfig) {
    if (!config.username || !config.password) {
      throw new Error(
        "Timely credentials missing. Set TIMELY_USERNAME and TIMELY_PASSWORD."
      );
    }
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  get defaultCompanyRegister(): string | undefined {
    return this.config.defaultCompanyRegister;
  }

  /** Authenticate and cache the JWT. Returns the token string. */
  async login(force = false): Promise<string> {
    if (this.token && !force) return this.token;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      const res = await fetch(`${this.baseUrl}/v3/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: this.config.username,
          password: this.config.password,
        }),
      });

      const body = await this.safeJson(res);
      if (!res.ok) {
        throw new TimelyError(
          `Login failed (HTTP ${res.status})`,
          res.status,
          body
        );
      }

      const token = extractToken(body);
      if (!token) {
        throw new TimelyError(
          "Login succeeded but no JWT was found in the response. " +
            "Inspect the raw body and adjust extractToken() if Timely changed its shape.",
          res.status,
          body
        );
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

  /**
   * POST to a /v3 endpoint with the bearer token attached. On a 401/403 (or an
   * auth-shaped failure) the token is refreshed once and the request retried.
   */
  async post<T = unknown>(
    path: string,
    payload: Record<string, unknown>
  ): Promise<TimelyResult<T>> {
    const doRequest = async (token: string): Promise<Response> =>
      fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

    let token = await this.login();
    let res = await doRequest(token);

    if (res.status === 401 || res.status === 403) {
      token = await this.login(true);
      res = await doRequest(token);
    }

    const body = await this.safeJson(res);

    if (!res.ok) {
      throw new TimelyError(
        `Timely API error on ${path} (HTTP ${res.status})`,
        res.status,
        body
      );
    }

    return normalizeEnvelope<T>(body);
  }

  private async safeJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text; // non-JSON body; surface as-is
    }
  }
}

/** Coerce Timely's stringy `success` flag and pull out common fields. */
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

/** Best-effort JWT extraction across the field names Timely might use. */
function extractToken(body: unknown): string | null {
  if (typeof body === "string") return body || null;
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, any>;
  const candidates = [
    obj.token,
    obj.access_token,
    obj.accessToken,
    obj.jwt,
    obj.data?.token,
    obj.data?.access_token,
    obj.data?.accessToken,
    obj.data?.jwt,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}
