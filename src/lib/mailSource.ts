// A message's raw source is mostly base64 once it carries attachments — a 1.5 MB
// PDF alone is ~2 MB of it. Rendering that verbatim is slow and tells nobody
// anything, so the payload runs are folded away and only the structure that
// matters (headers, MIME part headers, boundaries, readable parts) is shown.
//
// This deliberately does not parse MIME. Part boundaries are unreliable in the
// wild, and a purely line-shaped rule survives malformed messages that a parser
// would choke on.

export interface SourceSegment {
  kind: "text" | "base64";
  /** The lines as they appear in the source, newline-joined, no trailing newline. */
  text: string;
  /** Lines in this segment. */
  lines: number;
  /** Decoded payload size in bytes. Only meaningful for base64 segments. */
  bytes: number;
}

// Wrapped base64 payloads run at a fixed width — 76 chars for MIME, 64 for the
// older PEM style. 60 stays under both while staying far above any header value
// that happens to be base64 (a DKIM signature line, say), which continuation
// lines keep short and indented.
const FULL_LINE = /^[A-Za-z0-9+/]{60,}$/;
const TAIL_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Runs shorter than this stay visible: they are short enough to read past. */
export const MIN_RUN_LINES = 8;

function base64Bytes(lines: readonly string[]): number {
  let chars = 0;
  let padding = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === "=") padding++;
      else chars++;
    }
  }
  return Math.max(0, Math.floor(((chars + padding) * 3) / 4) - padding);
}

/**
 * Split a raw message into readable text and foldable base64 payload runs.
 *
 * `minRunLines` is how many wrapped lines a run needs before it counts as a
 * payload rather than a long header value.
 */
export function splitMailSource(source: string, minRunLines: number = MIN_RUN_LINES): SourceSegment[] {
  if (!source) return [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const segments: SourceSegment[] = [];
  let text: string[] = [];

  function flushText() {
    if (text.length === 0) return;
    segments.push({ kind: "text", text: text.join("\n"), lines: text.length, bytes: 0 });
    text = [];
  }

  let i = 0;
  while (i < lines.length) {
    if (!FULL_LINE.test(lines[i])) {
      text.push(lines[i]);
      i++;
      continue;
    }

    let end = i;
    while (end < lines.length && FULL_LINE.test(lines[end])) end++;
    // The closing line of a payload is whatever is left over, so it is shorter
    // than the rest and may carry the padding.
    if (end < lines.length && TAIL_LINE.test(lines[end]) && !FULL_LINE.test(lines[end])) end++;

    const run = lines.slice(i, end);
    if (run.length >= minRunLines) {
      flushText();
      segments.push({ kind: "base64", text: run.join("\n"), lines: run.length, bytes: base64Bytes(run) });
    } else {
      text.push(...run);
    }
    i = end;
  }

  flushText();
  return segments;
}

/** Bytes of payload folded away, for the "show everything" hint. */
export function foldedBytes(segments: readonly SourceSegment[]): number {
  return segments.reduce((sum, s) => (s.kind === "base64" ? sum + s.bytes : sum), 0);
}
