#!/usr/bin/env node
/**
 * Standalone live test — verifies credentials and prints the real response
 * shapes so you can confirm everything works end to end (and check that the
 * JWT field name matches what the client expects).
 *
 * Usage:
 *   TIMELY_USERNAME=ubcabholding TIMELY_PASSWORD='...' \
 *   TIMELY_COMPANY_REGISTER=1234567 \
 *   node scripts/test-login.mjs
 *
 * Or load a .env first:  node --env-file=.env scripts/test-login.mjs
 */

const BASE = (process.env.TIMELY_BASE_URL ?? "https://api.timely.mn").replace(/\/+$/, "");
const username = process.env.TIMELY_USERNAME;
const password = process.env.TIMELY_PASSWORD;
const companyRegister = process.env.TIMELY_COMPANY_REGISTER;

if (!username || !password) {
  console.error("Set TIMELY_USERNAME and TIMELY_PASSWORD first.");
  process.exit(1);
}

function findToken(body) {
  if (typeof body === "string") return body || null;
  if (!body || typeof body !== "object") return null;
  const c = [
    body.token, body.access_token, body.accessToken, body.jwt,
    body.data?.token, body.data?.access_token, body.data?.accessToken, body.data?.jwt,
  ];
  return c.find((v) => typeof v === "string" && v.length > 0) ?? null;
}

async function main() {
  console.log(`\n[1/2] POST ${BASE}/v3/login`);
  const loginRes = await fetch(`${BASE}/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: username, password }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  console.log("  HTTP", loginRes.status);
  console.log("  body:", JSON.stringify(loginBody, null, 2));

  const token = findToken(loginBody);
  if (!token) {
    console.error(
      "\n  No JWT found. Note the field name above and update extractToken() in src/timely.ts."
    );
    process.exit(1);
  }
  console.log("  ✓ token extracted (length", token.length + ")");

  if (!companyRegister) {
    console.log("\n[2/2] Skipped — set TIMELY_COMPANY_REGISTER to test employer-info.");
    return;
  }

  console.log(`\n[2/2] POST ${BASE}/v3/employer-info  (company_register=${companyRegister})`);
  const infoRes = await fetch(`${BASE}/v3/employer-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ company_register: companyRegister }),
  });
  const infoBody = await infoRes.json().catch(() => null);
  console.log("  HTTP", infoRes.status);
  console.log("  body:", JSON.stringify(infoBody, null, 2));
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
