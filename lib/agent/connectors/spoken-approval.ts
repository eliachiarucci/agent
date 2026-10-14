// Devices have no Approve button: an "ask" connector tool runs once someone
// says yes out loud. The first call doesn't run; it is noted as pending and
// the model is told to ask. A call of the same tool for the same targets in a
// later turn of what the microphone heard runs: the person answered in
// between, and the model judged it a yes. A call in the same turn, or in an
// agent run woken by the camera, only asks (again). In memory: a pending
// request is short-lived, and a restart just means asking again.

const PENDING_MS = 10 * 60_000;

export type SpokenApproval = {
  conversationId: string;
  // The user message the model is answering: a <heard> turn, or a run's report.
  turnId: string;
  // The turn is what the microphone heard (someone could have said yes).
  heard: boolean;
};

const pending = new Map<string, { turnId: string; at: number }>();

function key(approval: SpokenApproval, tool: string, targets: string[] | null): string {
  return JSON.stringify([approval.conversationId, tool, targets ? [...targets].sort() : null]);
}

/** Whether this call runs now ("run") or has to be asked about first ("ask", noted as pending). */
export function spokenApprovalFor(
  approval: SpokenApproval,
  tool: string,
  targets: string[] | null,
  now = Date.now()
): "run" | "ask" {
  for (const [k, p] of pending) if (now - p.at > PENDING_MS) pending.delete(k);
  const k = key(approval, tool, targets);
  const asked = pending.get(k);
  if (asked && approval.heard && asked.turnId !== approval.turnId) {
    pending.delete(k);
    return "run";
  }
  pending.set(k, { turnId: approval.turnId, at: now });
  return "ask";
}

export const SPOKEN_APPROVAL_NEEDED = {
  done: false,
  needsApproval:
    "Not done yet: this needs a yes out loud. Ask them now, in your reply: say what you are about to do and whether to go ahead. If they say yes, call this tool again with the same input.",
};
