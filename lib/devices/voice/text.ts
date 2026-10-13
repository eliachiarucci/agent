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

/** The user message of a voice turn. */
export function heardBlock(time: string, lines: HeardLine[]): string {
  return [
    `${HEARD_OPEN} ${time}`,
    ...lines.map((l) => `${l.speaker}${l.language ? ` (${l.language})` : ""}: ${l.text}`),
    HEARD_CLOSE,
  ].join("\n");
}
