import type { ToolSet } from "ai";
import { isToolCallApproved } from "../../db/tool-approvals";
import type { ConnectorType, ToolPermissionLevel } from "../../global/schema";
import { SPOKEN_APPROVAL_NEEDED, spokenApprovalFor, type SpokenApproval } from "./spoken-approval";

// How "ask" tools are approved: in the chat UI ({agentId}), not at all because
// a headless run's creator allowed them ("allow"), or by a spoken yes on a
// device ({agentId, spoken}). No approval: they are withheld.
export type ConnectorApproval = { agentId: string; spoken?: SpokenApproval } | "allow";

// The permission catalog the settings UI renders toggles from, one entry per
// tool of a connector. `defaultLevel` is the level applied when the user never
// saved one — i.e. what a freshly created agent gets: read tools start at
// "allow", write tools at "ask" so no agent can mutate anything without a
// human approving each call until its owner explicitly allows it.
export type ConnectorToolKind = "read" | "write";
export type ConnectorToolInfo = {
  name: string;
  kind: ConnectorToolKind;
  description: string;
  defaultLevel: ToolPermissionLevel;
};

export const read = (name: string, description: string): ConnectorToolInfo => ({
  name,
  kind: "read",
  description,
  defaultLevel: "allow",
});
export const write = (name: string, description: string): ConnectorToolInfo => ({
  name,
  kind: "write",
  description,
  defaultLevel: "ask",
});

/**
 * A connector's toolset filtered by the per-agent permission map (tool name →
 * level; missing = the tool's catalog default: "allow" for read tools, "ask"
 * for write tools). "ask" tools get a `needsApproval` check: standing
 * (tool, target) approvals let the call run directly, anything else pauses the
 * stream for the user to approve or deny in the UI. Headless runs (no
 * `approval` scope, e.g. cron) withhold "ask" tools like "deny" — a tool the
 * user gated must not run with nobody there to ask — unless the caller passes
 * `"allow"` (a cron job whose creator opted its "ask" tools in). On a device
 * (`spoken`) they run after a spoken yes instead of pausing for the UI.
 */
export function filterConnectorTools(opts: {
  connector: ConnectorType;
  userId: string;
  tools: ToolSet;
  toolInfo: ConnectorToolInfo[];
  permissions?: Record<string, ToolPermissionLevel>;
  approval?: ConnectorApproval;
  /** Approval targets of one call: string list, or null when the tool is untargeted. */
  targetsFor: (toolName: string, input: unknown) => string[] | null;
}): ToolSet {
  const defaults: Record<string, ToolPermissionLevel> = Object.fromEntries(
    opts.toolInfo.map((t) => [t.name, t.defaultLevel])
  );
  return Object.fromEntries(
    Object.entries(opts.tools).flatMap(([name, definition]) => {
      const level = opts.permissions?.[name] ?? defaults[name] ?? "allow";
      if (level === "allow") return [[name, definition]];
      if (level !== "ask" || !opts.approval) return [];
      if (opts.approval === "allow") return [[name, definition]];
      const agentId = opts.approval.agentId;
      const approved = (input: unknown) =>
        isToolCallApproved({
          userId: opts.userId,
          agentId,
          connector: opts.connector,
          tool: name,
          targets: opts.targetsFor(name, input),
        });
      const spoken = opts.approval.spoken;
      if (spoken) {
        // A standing approval runs it; otherwise it runs after a spoken yes.
        return [
          [
            name,
            {
              ...definition,
              execute: async (input: unknown, options: Parameters<NonNullable<typeof definition.execute>>[1]) =>
                (await approved(input)) || spokenApprovalFor(spoken, name, opts.targetsFor(name, input)) === "run"
                  ? definition.execute!(input, options)
                  : SPOKEN_APPROVAL_NEEDED,
            },
          ],
        ];
      }
      return [
        [
          name,
          {
            ...definition,
            needsApproval: async (input: unknown) => !(await approved(input)),
          },
        ],
      ];
    })
  );
}
