// Reads the AI SDK UI-message SSE stream that POST /agent/conversation
// produces and reduces it to something assertable.
export type ChatTurn = {
  /** Concatenated assistant text (all text-delta events). */
  text: string;
  /** Names of tools the model invoked during the turn. */
  toolCalls: string[];
  /** Every parsed SSE event, for ad-hoc assertions. */
  events: Array<Record<string, any>>;
};

export async function readChatStream(res: Response): Promise<ChatTurn> {
  const raw = await res.text();
  const events = raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter((data) => data !== "" && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, any>);

  const text = events
    .filter((e) => e.type === "text-delta")
    .map((e) => e.delta as string)
    .join("");

  const toolCalls = events
    .filter((e) => e.type === "tool-input-available")
    .map((e) => e.toolName as string);

  return { text, toolCalls, events };
}
