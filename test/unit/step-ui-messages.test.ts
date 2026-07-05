import { describe, expect, it } from "vitest";
import type { StepResult, ToolSet } from "ai";
import { stepsToUIMessageParts } from "../../lib/agent/step-ui-messages";

// Only `content` matters to the converter; the rest of StepResult is unused.
function step(content: unknown[]): StepResult<ToolSet> {
  return { content } as unknown as StepResult<ToolSet>;
}

describe("stepsToUIMessageParts", () => {
  it("keeps tool calls with their results, so cron conversations show them", () => {
    const parts = stepsToUIMessageParts([
      step([
        { type: "reasoning", text: "need the inbox" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "searchEmails",
          input: { query: "in:inbox" },
        },
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "searchEmails",
          input: { query: "in:inbox" },
          output: { messages: [{ subject: "Hello" }] },
        },
      ]),
      step([{ type: "text", text: "You have one new email." }]),
    ]);

    expect(parts).toEqual([
      { type: "step-start" },
      { type: "reasoning", text: "need the inbox", state: "done" },
      {
        type: "tool-searchEmails",
        toolCallId: "call-1",
        state: "output-available",
        input: { query: "in:inbox" },
        output: { messages: [{ subject: "Hello" }] },
      },
      { type: "step-start" },
      { type: "text", text: "You have one new email.", state: "done" },
    ]);
  });

  it("marks failed tool calls with output-error and the error message", () => {
    const parts = stepsToUIMessageParts([
      step([
        { type: "tool-call", toolCallId: "call-1", toolName: "readFile", input: { name: "x" } },
        {
          type: "tool-error",
          toolCallId: "call-1",
          toolName: "readFile",
          input: { name: "x" },
          error: new Error("no such file"),
        },
      ]),
    ]);

    expect(parts[1]).toEqual({
      type: "tool-readFile",
      toolCallId: "call-1",
      state: "output-error",
      input: { name: "x" },
      errorText: "no such file",
    });
  });

  it("resolves a result that lands in a later step than its call", () => {
    const parts = stepsToUIMessageParts([
      step([{ type: "tool-call", toolCallId: "c", toolName: "t", input: {} }]),
      step([{ type: "tool-result", toolCallId: "c", toolName: "t", input: {}, output: 42 }]),
    ]);
    expect(parts).toContainEqual({
      type: "tool-t",
      toolCallId: "c",
      state: "output-available",
      input: {},
      output: 42,
    });
  });

  it("maps dynamic tool calls to dynamic-tool parts and skips empty text", () => {
    const parts = stepsToUIMessageParts([
      step([
        { type: "text", text: "" },
        { type: "tool-call", toolCallId: "d", toolName: "mcpThing", input: { a: 1 }, dynamic: true },
        {
          type: "tool-result",
          toolCallId: "d",
          toolName: "mcpThing",
          input: { a: 1 },
          output: "ok",
          dynamic: true,
        },
      ]),
    ]);
    expect(parts).toEqual([
      { type: "step-start" },
      {
        type: "dynamic-tool",
        toolName: "mcpThing",
        toolCallId: "d",
        state: "output-available",
        input: { a: 1 },
        output: "ok",
      },
    ]);
  });
});
