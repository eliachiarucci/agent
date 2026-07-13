import type { ToolSet } from "ai";
import { listConnectorSettings } from "../../db/connectors";
import { getToolPermissions } from "../../db/tool-permissions";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type ToolPermissionLevel,
} from "../../global/schema";
import type { ConnectorToolInfo } from "./shared";
import {
  buildGmailTools,
  GMAIL_SCOPES,
  gmailApprovalTargetsFor,
  gmailPromptFor,
  gmailToolInfo,
} from "./gmail";
import {
  buildGoogleCalendarTools,
  GOOGLE_CALENDAR_SCOPES,
  googleCalendarApprovalTargetsFor,
  googleCalendarPromptFor,
  googleCalendarToolInfo,
} from "./google-calendar";

// Everything a connector plugs into the app with: what the settings UI needs
// to render its card (display name, OAuth scopes, the tool catalog the
// permission toggles come from) plus the runtime hooks (toolset builder,
// system-prompt section, approval-target derivation). One entry per
// CONNECTOR_TYPES member — adding a connector is one tool module + one entry.
export const CONNECTOR_CATALOG: Record<
  ConnectorType,
  {
    name: string;
    scopes: string[];
    tools: ConnectorToolInfo[];
    buildTools: (
      userId: string,
      permissions?: Record<string, ToolPermissionLevel>,
      approval?: { agentId: string } | "allow"
    ) => ToolSet;
    promptFor: (tools: ToolSet) => string;
    approvalTargetsFor: (toolName: string, input: unknown) => string[] | null;
  }
> = {
  gmail: {
    name: "Gmail",
    scopes: GMAIL_SCOPES,
    tools: gmailToolInfo,
    buildTools: buildGmailTools,
    promptFor: gmailPromptFor,
    approvalTargetsFor: gmailApprovalTargetsFor,
  },
  // Rendered as "Google Calendar" (the UI prefixes "Google ").
  "google-calendar": {
    name: "Calendar",
    scopes: GOOGLE_CALENDAR_SCOPES,
    tools: googleCalendarToolInfo,
    buildTools: buildGoogleCalendarTools,
    promptFor: googleCalendarPromptFor,
    approvalTargetsFor: googleCalendarApprovalTargetsFor,
  },
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
  return CONNECTOR_CATALOG[connector].approvalTargetsFor(toolName, input);
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
  // Headless runs only: what to do with "ask"-level tools — withhold them like
  // "deny" (default) or run them unattended like "allow" (a cron job's
  // creator-picked askPolicy). Ignored when interactive.
  headlessAskPolicy?: "deny" | "allow";
}): Promise<{ tools: ToolSet; prompt: string }> {
  const [connectors, permissions] = await Promise.all([
    listConnectorSettings(opts.userId),
    getToolPermissions(opts.userId, opts.agentId),
  ]);

  const approval = opts.interactive
    ? { agentId: opts.agentId }
    : opts.headlessAskPolicy === "allow"
      ? ("allow" as const)
      : undefined;

  const tools: ToolSet = {};
  const prompts: string[] = [];

  for (const connector of CONNECTOR_TYPES) {
    const row = connectors.find((c) => c.connector === connector);
    if (row?.status !== "connected") continue;
    const entry = CONNECTOR_CATALOG[connector];
    const built = entry.buildTools(opts.userId, permissions[connector], approval);
    if (Object.keys(built).length === 0) continue;
    Object.assign(tools, built);
    prompts.push(entry.promptFor(built));
  }

  return { tools, prompt: prompts.join("\n\n") };
}
