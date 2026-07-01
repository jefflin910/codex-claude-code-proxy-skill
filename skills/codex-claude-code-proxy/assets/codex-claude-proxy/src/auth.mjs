import fs from "node:fs/promises";

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export async function readCodexAuth(authPath, now = Date.now()) {
  let raw;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch (error) {
    throw new AuthError(`Codex auth file is not readable at ${authPath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthError(`Codex auth file is not valid JSON at ${authPath}`);
  }

  const token = parsed?.tokens?.access_token;
  if (!token || typeof token !== "string") {
    throw new AuthError("Codex auth file does not contain tokens.access_token. Re-login to Codex.");
  }

  const claims = decodeJwtPayload(token);
  if (!claims?.exp) {
    throw new AuthError("Codex access token does not contain an expiration claim.");
  }

  const secondsLeft = claims.exp - Math.floor(now / 1000);
  if (secondsLeft <= 60) {
    throw new AuthError("Codex access token is expired or about to expire. Reopen Codex or run codex login.");
  }

  return {
    accessToken: token,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    secondsLeft,
    accountId: parsed?.tokens?.account_id || null,
  };
}

export function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function requireLocalBearer(request, expectedToken) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== expectedToken) {
    throw new AuthError("Invalid or missing local gateway bearer token.", 401);
  }
}
