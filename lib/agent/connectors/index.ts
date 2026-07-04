import type { ToolSet } from "ai";
import { listConnectorSettings } from "../../db/connectors";
import { getToolPermissions } from "../../db/tool-permissions";
import type { ConnectorType } from "../../global/schema";
import { buildGmailTools, GMAIL_SCOPES, gmailPrompt, gmailToolInfo, type ConnectorToolInfo } from "./gmail";

// Everything the settings UI needs to render a connector card: display name,
// OAuth scopes it will request, and the tool catalog the permission toggles
// come from. One entry per CONNECTOR_TYPES member.
export const CONNECTOR_CATALOG: Record<
  ConnectorType,
  { name: string; scopes: string[]; tools: ConnectorToolInfo[] }
> = {
  gmail: { name: "Gmail", scopes: GMAIL_SCOPES, tools: gmailToolInfo },
};

/**
 * The connector toolset for one chat turn: tools of every *connected*
 * connector the sender has, filtered by their per-agent permission levels
 * (Settings → Tools; only "allow" tools are offered — "ask" is withheld until
 * the approval flow exists). Returns the tools plus the matching system-prompt
 * sections. Stable for a given (user, agent, settings), so the prompt prefix
 * stays KV-cache friendly across turns.
 */
export async function buildConnectorTools(opts: {
  userId: string;
  agentId: string;
}): Promise<{ tools: ToolSet; prompt: string }> {
  const [connectors, permissions] = await Promise.all([
    listConnectorSettings(opts.userId),
    getToolPermissions(opts.userId, opts.agentId),
  ]);

  const tools: ToolSet = {};
  const prompts: string[] = [];

  const gmail = connectors.find((c) => c.connector === "gmail");
  if (gmail?.status === "connected") {
    const gmailTools = buildGmailTools(opts.userId, permissions.gmail);
    if (Object.keys(gmailTools).length > 0) {
      Object.assign(tools, gmailTools);
      prompts.push(gmailPrompt);
    }
  }

  return { tools, prompt: prompts.join("\n\n") };
}
