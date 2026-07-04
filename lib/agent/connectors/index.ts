import type { ToolSet } from "ai";
import { listConnectorSettings } from "../../db/connectors";
import { getToolPermissions } from "../../db/tool-permissions";
import type { ConnectorType } from "../../global/schema";
import {
  buildGmailTools,
  GMAIL_SCOPES,
  gmailApprovalTargetsFor,
  gmailPrompt,
  gmailToolInfo,
  type ConnectorToolInfo,
} from "./gmail";

// Everything the settings UI needs to render a connector card: display name,
// OAuth scopes it will request, and the tool catalog the permission toggles
// come from. One entry per CONNECTOR_TYPES member.
export const CONNECTOR_CATALOG: Record<
  ConnectorType,
  { name: string; scopes: string[]; tools: ConnectorToolInfo[] }
> = {
  gmail: { name: "Gmail", scopes: GMAIL_SCOPES, tools: gmailToolInfo },
};

/** Which connector a tool name belongs to (tool names are unique across connectors). */
export function connectorForTool(toolName: string): ConnectorType | undefined {
  for (const [connector, entry] of Object.entries(CONNECTOR_CATALOG)) {
    if (entry.tools.some((t) => t.name === toolName)) return connector as ConnectorType;
  }
  return undefined;
}

/**
 * Approval targets of a pending call (e.g. create_draft → recipient emails),
 * derived server-side from the call input so "always approve" overrides can
 * never be spoofed by the client. null = the tool has no target concept.
 */
export function connectorApprovalTargets(
  connector: ConnectorType,
  toolName: string,
  input: unknown
): string[] | null {
  switch (connector) {
    case "gmail":
      return gmailApprovalTargetsFor(toolName, input);
  }
}

/**
 * The connector toolset for one turn: tools of every *connected* connector the
 * sender has, filtered by their per-agent permission levels (Settings → Tools).
 * In interactive runs (chat), "ask" tools are offered with a `needsApproval`
 * gate that pauses the stream for the user unless a standing (tool, target)
 * approval covers the call; headless runs (cron) withhold them like "deny".
 * Returns the tools plus the matching system-prompt sections. Stable for a
 * given (user, agent, settings), so the prompt prefix stays KV-cache friendly.
 */
export async function buildConnectorTools(opts: {
  userId: string;
  agentId: string;
  interactive?: boolean;
}): Promise<{ tools: ToolSet; prompt: string }> {
  const [connectors, permissions] = await Promise.all([
    listConnectorSettings(opts.userId),
    getToolPermissions(opts.userId, opts.agentId),
  ]);

  const tools: ToolSet = {};
  const prompts: string[] = [];

  const gmail = connectors.find((c) => c.connector === "gmail");
  if (gmail?.status === "connected") {
    const gmailTools = buildGmailTools(
      opts.userId,
      permissions.gmail,
      opts.interactive ? { agentId: opts.agentId } : undefined
    );
    if (Object.keys(gmailTools).length > 0) {
      Object.assign(tools, gmailTools);
      prompts.push(gmailPrompt);
    }
  }

  return { tools, prompt: prompts.join("\n\n") };
}
