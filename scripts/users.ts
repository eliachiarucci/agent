import "dotenv/config";

// Public signup is disabled (lib/global/auth.ts); this CLI is the one place
// accounts get created. Must be set before the auth module is imported.
process.env.AUTH_SIGNUP = "on";

import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";

const { auth } = await import("../lib/global/auth");
const { db } = await import("../lib/global/db");
const { agents, agentMembers, users } = await import("../lib/global/schema");

const USAGE = `Manage user accounts (public signup is disabled).

Usage:
  npm run users -- list
  npm run users -- create <username> --name "Full Name" [--email addr]
  npm run users -- remove <username> [--yes]

create prompts for the password. --email defaults to <username>@agent.local
(no verification emails are sent). remove also deletes every agent the user
owns, including its memories and conversations — shared members lose access.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) fail("A TTY is required to prompt for the password.");
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

async function list() {
  const rows = await db
    .select({
      username: users.username,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);
  if (rows.length === 0) {
    console.log("No users.");
    return;
  }
  console.table(
    rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) }))
  );
}

async function create(username: string, name: string | undefined, email: string | undefined) {
  const password = await promptHidden("Password: ");
  if (password.length < 8) fail("Password must be at least 8 characters.");
  if (password !== (await promptHidden("Confirm password: "))) fail("Passwords do not match.");

  // Real signup: hashes the password and fires the databaseHook that creates
  // the default "Personal Assistant" agent.
  const { user } = await auth.api.signUpEmail({
    body: {
      username,
      name: name ?? username,
      email: email ?? `${username}@agent.local`,
      password,
    },
  });
  console.log(`Created user ${user.name} (@${username}, ${user.email}).`);
}

async function remove(username: string, skipConfirm: boolean) {
  const user = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (!user) fail(`No user with username "${username}".`);

  const owned = await db.select().from(agents).where(eq(agents.ownerId, user.id));
  const memberships = await db
    .select()
    .from(agentMembers)
    .where(eq(agentMembers.userId, user.id));

  console.log(`User: ${user.name} (@${username}, ${user.email})`);
  console.log(`Owned agents to be deleted (with all memories/conversations):`);
  for (const agent of owned) console.log(`  - ${agent.name}`);
  if (owned.length === 0) console.log("  (none)");
  console.log(`Memberships in other agents to be removed: ${memberships.length - owned.length}`);

  if (!skipConfirm && !(await confirm("Delete this user?"))) {
    console.log("Aborted.");
    return;
  }

  // agents.ownerId has no ON DELETE cascade, so owned agents go first; their
  // memories, conversations, and member rows cascade from there. Everything
  // else hanging off the user (sessions, passkeys, memberships) cascades too.
  await db.delete(agents).where(eq(agents.ownerId, user.id));
  await db.delete(users).where(eq(users.id, user.id));
  console.log(`Deleted user @${username}.`);
}

const { values, positionals } = parseArgs({
  options: {
    name: { type: "string" },
    email: { type: "string" },
    yes: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const [command, username] = positionals;

try {
  if (command === "list") {
    await list();
  } else if (command === "create" && username) {
    await create(username, values.name, values.email);
  } else if (command === "remove" && username) {
    await remove(username, values.yes);
  } else {
    fail(USAGE);
  }
} catch (error) {
  // Better Auth surfaces validation problems (duplicate username/email, weak
  // password) as APIError with a readable message.
  fail(error instanceof Error ? error.message : String(error));
}
process.exit(0);
