// Pure editor-event logic, kept free of the `vscode` module so it can be unit-tested.
// Privacy: an event carries only a file path, line numbers and a sequence number; never text.
export type EventKind = "OPEN_FILE" | "SELECTION" | "DIFF" | "BREAKPOINT";
export interface WireEvent { sessionId: string; sequence: number; kind: EventKind; file: string; startLine?: number; endLine?: number }

export function isLoopback(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname); } catch { return false; }
}

/** Monotonic sequencing per editor session, plus coalescing of rapid selection changes (only the latest is sent). */
export class EventStream {
  private seq = 0;
  private pending: WireEvent | null = null;
  readonly sessionId: string;
  constructor(sessionId: string) { this.sessionId = sessionId; }

  make(kind: EventKind, file: string, startLine?: number, endLine?: number): WireEvent {
    const e: WireEvent = { sessionId: this.sessionId, sequence: this.seq++, kind, file };
    // Lines are 1-based on the wire; editors report 0-based.
    if (startLine !== undefined) e.startLine = startLine + 1;
    if (endLine !== undefined && endLine !== startLine) e.endLine = endLine + 1;
    return e;
  }

  /** Selections arrive in bursts while dragging; keep only the newest until `flush`. */
  coalesce(e: WireEvent) { this.pending = e; }
  flush(): WireEvent | null { const e = this.pending; this.pending = null; return e; }
}

/** Only real files on disk are worth reporting (not output panes, git diffs, untitled buffers). */
export function reportable(uriScheme: string, fsPath: string): boolean {
  return uriScheme === "file" && fsPath.length > 0 && !fsPath.includes("/node_modules/");
}
