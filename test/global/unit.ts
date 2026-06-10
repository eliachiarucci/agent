import { ensureTestDatabase } from "../setup/database";
import { TEST_DBS } from "../config";

export async function setup() {
  await ensureTestDatabase(TEST_DBS.unit);
}
