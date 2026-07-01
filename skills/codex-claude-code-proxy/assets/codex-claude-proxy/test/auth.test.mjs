import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeJwtPayload, readCodexAuth } from "../src/auth.mjs";

test("decodes JWT payload", () => {
  const jwt = makeJwt({ exp: 4102444800, sub: "user" });
  assert.deepEqual(decodeJwtPayload(jwt), { exp: 4102444800, sub: "user" });
});

test("reads Codex auth and rejects expired token", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-test-"));
  const file = path.join(dir, "auth.json");

  await fs.writeFile(
    file,
    JSON.stringify({
      tokens: {
        access_token: makeJwt({ exp: 4102444800 }),
        account_id: "acct",
      },
    }),
  );

  const auth = await readCodexAuth(file, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(auth.accountId, "acct");
  assert.equal(auth.expiresAt, "2100-01-01T00:00:00.000Z");

  await fs.writeFile(
    file,
    JSON.stringify({
      tokens: {
        access_token: makeJwt({ exp: 1 }),
      },
    }),
  );

  await assert.rejects(
    () => readCodexAuth(file, Date.parse("2026-01-01T00:00:00Z")),
    /expired/,
  );
});

function makeJwt(payload) {
  const enc = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64url")
      .replace(/=/g, "");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}
