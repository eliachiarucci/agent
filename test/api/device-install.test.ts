import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

async function script(): Promise<string> {
  const res = await fetch(`${BASE}/agent/devices/install.sh`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  return res.text();
}

// The script as `curl … | sh -s -- args` runs it, with its own HOME.
function run(text: string, args: string[], home: string) {
  return spawnSync("sh", ["-s", "--", ...args], {
    input: text,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home },
  });
}

describe("device install script", () => {
  it("is valid POSIX sh with the server's address in it", async () => {
    const text = await script();
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).not.toContain("__SERVER__");
    expect(text).toMatch(/^SERVER='https?:\/\/[^']+'$/m);
    for (const shell of ["sh", "dash"]) {
      if (spawnSync("sh", ["-c", `command -v ${shell}`]).status !== 0) continue;
      const check = spawnSync(shell, ["-n"], { input: text, encoding: "utf8" });
      expect(check.stderr, shell).toBe("");
      expect(check.status, shell).toBe(0);
    }
  });

  it("pairs with --pair-only, writing a key that connects", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    const { pairing, device } = (await client.post("/agent/devices", { name: "Pi" })).body;
    const home = mkdtempSync(join(tmpdir(), "device-install-"));
    try {
      const text = await script();
      // A wrong code fails before anything is written.
      const wrong = run(text, ["ABCDE-FGHJK", "--pair-only", "--server", BASE], home);
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain("Pairing failed");
      expect(run(text, ["bad;code", "--pair-only"], home).status).toBe(2);

      const ok = run(text, [pairing.code, "--pair-only", "--server", BASE], home);
      expect(ok.stderr).toBe("");
      expect(ok.status).toBe(0);
      const file = join(home, ".config", "agent-device", "device.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved).toMatchObject({ server: BASE, url: `${BASE.replace(/^http/, "ws")}/agent/devices/ws`, deviceId: device.id });

      const ws = new WebSocket(saved.url, { headers: { authorization: `Bearer ${saved.token}` } });
      const first = await new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString()).type));
        ws.once("unexpected-response", (_q, r) => reject(new Error(`HTTP ${r.statusCode}`)));
      });
      ws.terminate();
      expect(first).toBe("config");
      // The code is used up.
      expect(run(text, [pairing.code, "--pair-only", "--server", BASE], home).status).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(existsSync(home)).toBe(false);
  });
});
