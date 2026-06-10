import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signIn, signUp, TEST_PASSWORD, totpCode } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

// The full lifecycle in one test on purpose: each stage only makes sense after
// the previous one (enable → confirm → challenged login → disable).
it("TOTP: enable, verify, challenge on login, disable", async () => {
  const client = new TestClient(BASE);
  await signUp(client, "Elia");

  // Enabling requires the password and returns the otpauth URI + backup codes,
  // but 2FA only becomes active after a code confirms the authenticator.
  const enable = await client.post("/agent/auth/two-factor/enable", { password: TEST_PASSWORD });
  expect(enable.status).toBe(200);
  expect(enable.body.totpURI).toMatch(/^otpauth:\/\//);
  expect(enable.body.backupCodes).toHaveLength(10);

  const confirm = await client.post("/agent/auth/two-factor/verify-totp", {
    code: totpCode(enable.body.totpURI),
  });
  expect(confirm.status).toBe(200);

  // A fresh login now answers with a 2FA challenge instead of a session…
  const fresh = new TestClient(BASE);
  const challenged = await signIn(fresh, "elia");
  expect(challenged.status).toBe(200);
  expect(challenged.body.twoFactorRedirect).toBe(true);
  expect((await fresh.get("/agent/agents")).status).toBe(401);

  // …a wrong code is rejected, the right one completes the session.
  const bad = await fresh.post("/agent/auth/two-factor/verify-totp", { code: "000000" });
  expect(bad.status).toBeGreaterThanOrEqual(400);

  const good = await fresh.post("/agent/auth/two-factor/verify-totp", {
    code: totpCode(enable.body.totpURI),
  });
  expect(good.status).toBe(200);
  expect((await fresh.get("/agent/agents")).status).toBe(200);

  // Disabling restores plain password login.
  const disable = await fresh.post("/agent/auth/two-factor/disable", { password: TEST_PASSWORD });
  expect(disable.status).toBe(200);

  const plain = new TestClient(BASE);
  const login = await signIn(plain, "elia");
  expect(login.status).toBe(200);
  expect(login.body.twoFactorRedirect).toBeUndefined();
  expect((await plain.get("/agent/agents")).status).toBe(200);
});

it("backup codes work as a fallback for the second factor", async () => {
  const client = new TestClient(BASE);
  await signUp(client, "Elia");
  const enable = await client.post("/agent/auth/two-factor/enable", { password: TEST_PASSWORD });
  await client.post("/agent/auth/two-factor/verify-totp", {
    code: totpCode(enable.body.totpURI),
  });

  const fresh = new TestClient(BASE);
  await signIn(fresh, "elia");
  const viaBackup = await fresh.post("/agent/auth/two-factor/verify-backup-code", {
    code: enable.body.backupCodes[0],
  });
  expect(viaBackup.status).toBe(200);
  expect((await fresh.get("/agent/agents")).status).toBe(200);
});
