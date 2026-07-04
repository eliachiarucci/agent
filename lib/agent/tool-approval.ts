import {
  getToolOrDynamicToolName,
  isToolOrDynamicToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";

// A decision the user made on one approval prompt. `always` additionally
// records a standing (tool, target) approval so future matching calls skip
// the prompt (only meaningful with approved: true).
export type ToolApprovalResponse = {
  approvalId: string;
  approved: boolean;
  always?: boolean;
};

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** The approval prompts of a message still waiting for a decision. */
export function pendingApprovalParts(message: UIMessage | undefined): AnyToolPart[] {
  if (message?.role !== "assistant") return [];
  return message.parts.filter(
    (part): part is AnyToolPart =>
      isToolOrDynamicToolUIPart(part) && part.state === "approval-requested"
  );
}

export type AppliedApproval = {
  toolName: string;
  input: unknown;
  response: ToolApprovalResponse;
};

/**
 * Apply the user's decisions to the pending approval prompts of the last
 * message, in place: each matched part moves approval-requested →
 * approval-responded, which convertToModelMessages turns into the
 * tool-approval-response message streamText resumes on (executing approved
 * calls, denying the rest). Returns the matched calls so the route can persist
 * "always" overrides, or an error when a response references no pending prompt.
 */
export function applyApprovalResponses(
  history: UIMessage[],
  responses: ToolApprovalResponse[]
): { applied: AppliedApproval[] } | { error: string } {
  const pending = pendingApprovalParts(history.at(-1));
  const applied: AppliedApproval[] = [];
  for (const response of responses) {
    const part = pending.find(
      (p) => p.state === "approval-requested" && p.approval.id === response.approvalId
    );
    if (!part) {
      return { error: `No pending approval "${response.approvalId}" in this conversation` };
    }
    Object.assign(part, {
      state: "approval-responded",
      approval: { id: response.approvalId, approved: response.approved },
    });
    applied.push({ toolName: getToolOrDynamicToolName(part), input: part.input, response });
  }
  return { applied };
}

/**
 * Deny any approval prompts still pending on the last message, in place. Used
 * when the user sends a new message instead of answering: the dangling calls
 * become denied tool results (execution-denied) so the model's view stays
 * coherent instead of losing the calls.
 */
export function denyUnansweredApprovals(history: UIMessage[], reason: string): void {
  for (const part of pendingApprovalParts(history.at(-1))) {
    if (part.state !== "approval-requested") continue;
    Object.assign(part, {
      state: "output-denied",
      approval: { id: part.approval.id, approved: false, reason },
    });
  }
}
