import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  applyApprovalResponses,
  denyUnansweredApprovals,
  pendingApprovalParts,
} from "../../lib/agent/tool-approval";

// A paused turn: the model asked to run create_draft and the stream closed with
// the tool part waiting for the user's decision.
function pausedHistory(): UIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "email john" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Drafting it now." },
        {
          type: "tool-create_draft",
          toolCallId: "call-1",
          state: "approval-requested",
          input: { to: ["john@doe.com"], subject: "hi", body: "hello" },
          approval: { id: "appr-1" },
        },
      ],
    } as unknown as UIMessage,
  ];
}

describe("pendingApprovalParts", () => {
  it("finds approval-requested tool parts on the last assistant message only", () => {
    const history = pausedHistory();
    expect(pendingApprovalParts(history.at(-1))).toHaveLength(1);
    expect(pendingApprovalParts(history.at(0))).toHaveLength(0);
    expect(pendingApprovalParts(undefined)).toHaveLength(0);
  });
});

describe("applyApprovalResponses", () => {
  it("moves matched parts to approval-responded and reports the calls", () => {
    const history = pausedHistory();
    const outcome = applyApprovalResponses(history, [
      { approvalId: "appr-1", approved: true, always: true },
    ]);
    expect(outcome).toMatchObject({
      applied: [
        {
          toolName: "create_draft",
          input: { to: ["john@doe.com"], subject: "hi", body: "hello" },
          response: { approvalId: "appr-1", approved: true, always: true },
        },
      ],
    });
    const part = history.at(-1)?.parts.at(-1) as { state: string; approval: unknown };
    expect(part.state).toBe("approval-responded");
    expect(part.approval).toEqual({ id: "appr-1", approved: true });
  });

  it("rejects responses that reference no pending prompt", () => {
    const outcome = applyApprovalResponses(pausedHistory(), [
      { approvalId: "nope", approved: true },
    ]);
    expect(outcome).toHaveProperty("error");
  });
});

describe("denyUnansweredApprovals", () => {
  it("turns pending prompts into denied results and leaves the rest alone", () => {
    const history = pausedHistory();
    denyUnansweredApprovals(history, "The user moved on.");
    const part = history.at(-1)?.parts.at(-1) as { state: string; approval: unknown };
    expect(part.state).toBe("output-denied");
    expect(part.approval).toEqual({ id: "appr-1", approved: false, reason: "The user moved on." });
    // Idempotent on a history with nothing pending.
    denyUnansweredApprovals(history, "again");
    expect(part.approval).toEqual({ id: "appr-1", approved: false, reason: "The user moved on." });
  });
});
