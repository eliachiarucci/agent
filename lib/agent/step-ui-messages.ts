import type { StepResult, ToolSet, UIMessage } from "ai";

// The chat route persists UIMessages (via toUIMessageStream), and the UI only
// renders that shape — so non-streaming generateText callers (the cron runner)
// must convert their steps to the same parts before saving, or tool calls and
// reasoning silently vanish from the saved conversation.
export function stepsToUIMessageParts(
  steps: ReadonlyArray<StepResult<ToolSet>>
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  const toolParts = new Map<string, Record<string, unknown>>();
  for (const step of steps) {
    parts.push({ type: "step-start" });
    for (const item of step.content) {
      switch (item.type) {
        case "text":
          if (item.text) parts.push({ type: "text", text: item.text, state: "done" });
          break;
        case "reasoning":
          if (item.text) parts.push({ type: "reasoning", text: item.text, state: "done" });
          break;
        case "tool-call": {
          const part: Record<string, unknown> = item.dynamic
            ? {
                type: "dynamic-tool",
                toolName: item.toolName,
                toolCallId: item.toolCallId,
                state: "input-available",
                input: item.input,
              }
            : {
                type: `tool-${item.toolName}`,
                toolCallId: item.toolCallId,
                state: "input-available",
                input: item.input,
              };
          toolParts.set(item.toolCallId, part);
          parts.push(part as UIMessage["parts"][number]);
          break;
        }
        case "tool-result": {
          const part = toolParts.get(item.toolCallId);
          if (part) Object.assign(part, { state: "output-available", output: item.output });
          break;
        }
        case "tool-error": {
          const part = toolParts.get(item.toolCallId);
          if (part) {
            Object.assign(part, {
              state: "output-error",
              errorText: item.error instanceof Error ? item.error.message : String(item.error),
            });
          }
          break;
        }
      }
    }
  }
  return parts;
}
