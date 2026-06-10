import { ensureTestDatabase } from "../setup/database";
import { startTestServer } from "../setup/server";
import { dbUrl, SERVER_PORTS, TEST_DBS } from "../config";

let stopServer: (() => void) | undefined;

export async function setup() {
  await ensureTestDatabase(TEST_DBS.api);
  stopServer = await startTestServer({ port: SERVER_PORTS.api, databaseUrl: dbUrl("api") });
}

export async function teardown() {
  stopServer?.();
}
