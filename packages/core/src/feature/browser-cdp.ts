// A very small Chrome DevTools Protocol driver (no dependencies): enough to open a page, press keys, and read what a person (or a
// screen reader's accessibility tree) would see. Only keyboard input is exposed on purpose: the tests that use it cannot cheat with a mouse.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** CIE_CHROME overrides the browser binary; the default is the usual Linux path. */
export const CHROME = process.env.CIE_CHROME ?? "/usr/bin/google-chrome-stable";
export const chromeAvailable = (): boolean => existsSync(CHROME);
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Browser {
  private proc!: ChildProcess;
  private profile = "";
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, Pending>();
  private sessionId = "";
  private listeners: ((m: any) => void)[] = [];
  readonly console: string[] = [];

  static async launch(): Promise<Browser> {
    const b = new Browser();
    const port = 9300 + Math.floor(Math.random() * 600);
    b.profile = mkdtempSync(join(tmpdir(), "cie-chrome-"));
    b.proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${b.profile}`, "--no-sandbox", "--disable-gpu", "--window-size=1400,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
    let version: any = null;
    for (let i = 0; i < 100 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
    if (!version) { b.proc.kill(); throw new Error("Chrome did not start"); }
    b.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { b.ws.onopen = () => res(); b.ws.onerror = () => rej(new Error("CDP connection failed")); });
    b.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && b.pending.has(m.id)) { const p = b.pending.get(m.id)!; b.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else for (const l of b.listeners) l(m);
    };
    const { targetId } = await b.send("Target.createTarget", { url: "about:blank" }, false);
    const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true }, false);
    b.sessionId = sessionId;
    await b.send("Page.enable"); await b.send("Runtime.enable"); await b.send("Accessibility.enable");
    b.listeners.push((m) => { if (m.method === "Runtime.consoleAPICalled") b.console.push(`${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ")}`); if (m.method === "Runtime.exceptionThrown") b.console.push(`exception: ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ""}`); });
    return b;
  }
  send(method: string, params: object = {}, session = true): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: this.sessionId } : {}) })); });
  }
  /** Navigates and waits for the page to finish loading. `readySelector` is for apps that render after load; no framework is assumed. */
  async goto(url: string, beforeLoad?: string, readySelector?: string) {
    if (beforeLoad) await this.send("Page.addScriptToEvaluateOnNewDocument", { source: beforeLoad });
    await this.send("Page.navigate", { url });
    await this.waitFor(() => `document.readyState === 'complete' && !!document.body${readySelector ? ` && !!document.querySelector(${JSON.stringify(readySelector)})` : ""}`, 15_000);
  }
  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expr: () => string, ms = 10_000, what = ""): Promise<void> {
    const t0 = Date.now(); let last: unknown;
    while (Date.now() - t0 < ms) { try { last = await this.eval(expr()); if (last) return; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 80)); }
    throw new Error(`timed out after ${ms}ms waiting for ${what || expr()} (last: ${String(last).slice(0, 200)})`);
  }
  // ---- keyboard only
  async key(key: string, o: { shift?: boolean; ctrl?: boolean } = {}) {
    const map: Record<string, [string, number, string?]> = { Tab: ["Tab", 9], Enter: ["Enter", 13, "\r"], Escape: ["Escape", 27], " ": ["Space", 32, " "], ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39], Home: ["Home", 36], End: ["End", 35] };
    const [code, vk, text] = map[key] ?? [key.length === 1 ? `Key${key.toUpperCase()}` : key, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, key.length === 1 ? key : undefined];
    const modifiers = (o.shift ? 8 : 0) | (o.ctrl ? 2 : 0);
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  }
  async type(text: string) { await this.send("Input.insertText", { text }); }
  /** Press Tab until the focused element satisfies `test` (a JS expression over `el`), or give up. */
  async tabTo(test: string, max = 120): Promise<void> {
    for (let i = 0; i < max; i++) { if (await this.eval(`(() => { const el = document.activeElement; return !!el && el !== document.body && (${test}); })()`)) return; await this.key("Tab"); }
    throw new Error(`Tab never reached an element matching ${test}`);
  }
  async axNames(): Promise<string[]> {
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    return nodes.filter((n: any) => !n.ignored).map((n: any) => `${n.role?.value ?? ""}: ${n.name?.value ?? ""}`.trim());
  }
  // The profile directory is 20 to 130 MB per run; without this every test run left one behind in /tmp until the disk was full.
  close() {
    try { this.ws.close(); } catch { /* closed */ }
    const remove = () => { try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* best effort */ } };
    this.proc.once("exit", remove);
    this.proc.kill("SIGKILL");
    setTimeout(remove, 1500).unref();
  }
}
