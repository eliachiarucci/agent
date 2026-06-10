import type { TestClient } from "./client";

export { totpCode } from "./totp";

export const TEST_PASSWORD = "correct-horse-battery-staple-1";

export type TestUser = {
  id: string;
  name: string;
  email: string;
  username: string;
};

/**
 * Real signup through Better Auth: hashes the password, sets the session
 * cookie on the client, and fires the create-default-agent hook.
 */
export async function signUp(client: TestClient, name: string): Promise<TestUser> {
  const username = name.toLowerCase();
  const { status, body } = await client.post("/agent/auth/sign-up/email", {
    name,
    username,
    email: `${username}@test.local`,
    password: TEST_PASSWORD,
  });
  if (status !== 200) {
    throw new Error(`signUp(${name}) failed with ${status}: ${JSON.stringify(body)}`);
  }
  return { id: body.user.id, name, email: body.user.email, username };
}

export async function signIn(client: TestClient, username: string, password = TEST_PASSWORD) {
  return client.post("/agent/auth/sign-in/username", { username, password });
}
