import { sql } from "drizzle-orm";
import { db } from "../../lib/global/db";
import { agentMembers, agents, users } from "../../lib/global/schema";
import { createAgent } from "../../lib/db/agents";

// Wipes all rows between tests. Each test builds its own world from helpers,
// so suites stay order-independent.
export async function resetDb(): Promise<void> {
  await db.execute(sql`
    truncate table
      memory_conversations, cron_job_runs, cron_jobs, notes, conversations, memories,
      agent_members, agents, provider_settings, user_settings, connector_settings,
      tool_permissions, tool_approvals, session, account,
      verification, two_factor, passkey, users
    cascade
  `);
}

/** Closes the worker's pool so vitest doesn't wait on open handles. */
export async function closeDb(): Promise<void> {
  await db.$client.end();
}

// Direct-row user for unit tests (no credentials; API tests sign up for real).
export async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@test.local` })
    .returning();
  return user;
}

/** User + their own agent, optionally shared with more users — the common fixture. */
export async function makeUserWithAgent(name: string, shareWith: { id: string }[] = []) {
  const user = await makeUser(name);
  const agent = await createAgent({ name: `${name}'s agent`, ownerId: user.id });
  for (const member of shareWith) {
    await db.insert(agentMembers).values({ agentId: agent.id, userId: member.id });
  }
  return { user, agent };
}

export { db, agents, agentMembers, users };
