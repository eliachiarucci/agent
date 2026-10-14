import { HEARD_CLOSE, HEARD_OPEN, SILENT } from "../../agent/device-run";

// Text helpers for voice turns (plan 4.11): sentences go to TTS one by one as
// the reply streams; the reply is held until it can't be <silent/> any more;
// what was heard goes into the conversation as a <heard> block.

/** Splits streamed text into sentences for TTS: push deltas, take what's complete, flush the rest at the end. */
export class SentenceSplitter {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const end = sentenceEnd(this.buffer);
      if (end < 0) break;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }
}

// Index just past a sentence end: . ! ? … (and closing quotes or brackets)
// followed by whitespace, or a newline. Not inside numbers ("3.5"), and not
// before 12 characters, so "Mr. Rossi" style abbreviations rarely split.
function sentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      if (text.slice(0, i).trim()) return i + 1;
      continue;
    }
    if (!".!?…".includes(c)) continue;
    let j = i + 1;
    while (j < text.length && `"')]»”’`.includes(text[j])) j++;
    if (j >= text.length || !/\s/.test(text[j])) continue;
    if (c === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[j + 1] ?? "")) continue;
    if (text.slice(0, j).trim().length < 12 && c === ".") continue;
    return j;
  }
  return -1;
}

/** Holds the start of a reply until it is clearly <silent/> or clearly not. */
export class SilenceGate {
  private buffer = "";
  state: "undecided" | "silent" | "speak" = "undecided";

  /** Feeds a delta; returns the text that may be spoken now ("" while undecided or silent). */
  push(delta: string): string {
    if (this.state === "speak") return delta;
    if (this.state === "silent") return "";
    this.buffer += delta;
    const head = this.buffer.trimStart();
    if (head.startsWith(SILENT)) {
      this.state = "silent";
      return "";
    }
    if (SILENT.startsWith(head)) return ""; // could still become <silent/>
    this.state = "speak";
    return this.buffer;
  }

  /** At the end of the reply: an empty or partial reply counts as silent. */
  finish(): void {
    if (this.state === "undecided") this.state = "silent";
  }
}

/**
 * What of a streamed reply is spoken, step by step. Text a step writes before a
 * tool call is narration ("I'll check your emails."): spoken, it leaves the
 * person hanging when the answer after the tool turns out <silent/>. So each
 * step's first sentence is held until a second one completes or the step ends
 * without a tool call; a tool call drops what is still held. A step that
 * already spoke two sentences keeps them (they were said).
 */
export class SpokenReply {
  private gate = new SilenceGate();
  private splitter = new SentenceSplitter();
  private held: string[] = [];
  private released = false;
  private stepText = "";
  private step = 0;
  private calledTool = false;
  private spoke = false;
  // The kept text of the reply, across steps.
  text = "";
  // Steps whose text was dropped as narration (by index).
  readonly dropped = new Set<number>();

  /** A text delta; returns the sentences to speak now. */
  push(delta: string): string[] {
    this.stepText += delta;
    const open = this.gate.push(delta);
    if (!open) return [];
    const sentences = this.splitter.push(open);
    if (!this.released) {
      this.held.push(...sentences);
      if (this.held.length < 2) return [];
      sentences.splice(0, sentences.length, ...this.held.splice(0));
      this.released = true;
    }
    if (sentences.length) this.spoke = true;
    return sentences;
  }

  /** The step calls a tool: what it holds was narration. */
  toolCall(): void {
    this.calledTool = true;
    if (this.released || this.dropped.has(this.step)) return;
    this.dropped.add(this.step);
    this.held = [];
    this.stepText = "";
    this.gate = new SilenceGate();
    this.splitter = new SentenceSplitter();
  }

  /**
   * A step ended. After a tool call the next step starts fresh (unless this one
   * already spoke); a step without one is the answer, which finish() wraps up.
   */
  endStep(): void {
    if (!this.calledTool) return;
    this.calledTool = false;
    if (!this.dropped.has(this.step)) this.keep(this.stepText);
    this.stepText = "";
    this.step++;
    this.released = false;
    if (!this.spoke) this.gate = new SilenceGate();
    // A tool call's trailing half sentence isn't carried into the next step.
    this.splitter = new SentenceSplitter();
  }

  /** The end of the reply: the sentences still to speak. */
  finish(): string[] {
    this.keep(this.stepText);
    this.stepText = "";
    this.gate.finish();
    if (this.gate.state !== "speak") return [];
    const rest = this.splitter.flush();
    const out = [...this.held.splice(0), ...(rest ? [rest] : [])];
    if (out.length) this.spoke = true;
    return out;
  }

  /** Nothing of the reply is for speaking: it was <silent/> (or empty). */
  get silent(): boolean {
    return !this.spoke && this.gate.state === "silent";
  }

  private keep(text: string): void {
    if (text.trim()) this.text = this.text ? `${this.text} ${text.trim()}` : text.trim();
  }
}

/**
 * Plain spoken text: no markdown markers, no <silent/>, no tags. A model now
 * and then writes a tool call as text ("<speak><parameter …>"); its tags are
 * dropped and only the words remain.
 */
export function speakable(text: string): string {
  return text
    .replaceAll(SILENT, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type HeardLine = { speaker: string; text: string; language?: string };

/** The user message of a voice turn; notes go in the header, e.g. "in conversation: you spoke 8 s ago". */
export function heardBlock(time: string, lines: HeardLine[], notes: string[] = []): string {
  return [
    `${HEARD_OPEN} ${time}${notes.length ? ` (${notes.join("; ")})` : ""}`,
    ...lines.map((l) => `${l.speaker}${l.language ? ` (${l.language})` : ""}: ${l.text}`),
    HEARD_CLOSE,
  ].join("\n");
}
