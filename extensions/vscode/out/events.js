export function isLoopback(url) {
    try {
        const u = new URL(url);
        return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    }
    catch {
        return false;
    }
}
/** Monotonic sequencing per editor session, plus coalescing of rapid selection changes (only the latest is sent). */
export class EventStream {
    seq = 0;
    pending = null;
    sessionId;
    constructor(sessionId) { this.sessionId = sessionId; }
    make(kind, file, startLine, endLine) {
        const e = { sessionId: this.sessionId, sequence: this.seq++, kind, file };
        // Lines are 1-based on the wire; editors report 0-based.
        if (startLine !== undefined)
            e.startLine = startLine + 1;
        if (endLine !== undefined && endLine !== startLine)
            e.endLine = endLine + 1;
        return e;
    }
    /** Selections arrive in bursts while dragging; keep only the newest until `flush`. */
    coalesce(e) { this.pending = e; }
    flush() { const e = this.pending; this.pending = null; return e; }
}
/** Only real files on disk are worth reporting (not output panes, git diffs, untitled buffers). */
export function reportable(uriScheme, fsPath) {
    return uriScheme === "file" && fsPath.length > 0 && !fsPath.includes("/node_modules/");
}
/** Does this extension understand the server it is pointed at? Mirrors `compatibility` in the server's ops.ts (a test keeps them in step). */
export function compatible(server, ext) {
    const parse = (v) => v.split(".").map((x) => Number(x) || 0);
    const cmp = (a, b) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < 3; i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1; return 0; };
    if (parse(server.api)[0] !== parse(ext.api)[0])
        return { ok: false, reason: `the extension speaks API ${ext.api} and the server API ${server.api}; update whichever is older` };
    if (cmp(ext.version, server.minExtension) < 0)
        return { ok: false, reason: `extension ${ext.version} is older than the ${server.minExtension} this server supports; update the extension` };
    return { ok: true };
}
export const EXTENSION_API = "1.1.0";
