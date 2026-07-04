import type { ToolSet } from "ai";
import { listConnectorSettings } from "../../db/connectors";
import { getToolPermissions } from "../../db/tool-permissions";
import type { ConnectorType, ProviderType } from "../../global/schema";
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
 * connector the sender has, filtered by their per-model permission toggles
 * (Settings → Tools). Returns the tools plus the matching system-prompt
 * sections. Stable for a given (user, model, settings), so the prompt prefix
 * stays KV-cache friendly across turns.
 */
export async function buildConnectorTools(opts: {
  userId: string;
  provider: ProviderType;
  model: string;
}): Promise<{ tools: ToolSet; prompt: string }> {
  const [connectors, permissions] = await Promise.all([
    listConnectorSettings(opts.userId),
    getToolPermissions(opts.userId, opts.provider, opts.model),
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
