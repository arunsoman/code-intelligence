// Thin VS Code wrapper. All decisions live in events.ts.
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { EventStream, isLoopback, reportable, type WireEvent } from "./events.js";

const stream = new EventStream(randomUUID());
let timer: ReturnType<typeof setTimeout> | undefined;
let status: vscode.StatusBarItem;

function config() {
  const c = vscode.workspace.getConfiguration("cie");
  return { enabled: c.get<boolean>("enabled", true), url: c.get<string>("serverUrl", "http://127.0.0.1:4317") };
}

async function post(e: WireEvent) {
  const { enabled, url } = config();
  if (!enabled) return;
  if (!isLoopback(url)) { status.text = "$(warning) CIE: server must be on localhost"; return; }
  try {
    const res = await fetch(`${url}/api/v1/components/C01/captureEditorEvent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: e }) });
    status.text = res.ok ? "$(eye) CIE" : "$(warning) CIE";
  } catch { status.text = "$(circle-slash) CIE offline"; }
}

export function activate(ctx: vscode.ExtensionContext) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.text = "$(eye) CIE"; status.tooltip = "Code Intelligence: sharing file path and line numbers (never contents). Click to toggle."; status.command = "cie.toggle"; status.show();
  ctx.subscriptions.push(status);

  ctx.subscriptions.push(vscode.commands.registerCommand("cie.toggle", async () => {
    const c = vscode.workspace.getConfiguration("cie");
    await c.update("enabled", !c.get<boolean>("enabled", true), vscode.ConfigurationTarget.Global);
    status.text = c.get<boolean>("enabled", true) ? "$(eye) CIE" : "$(eye-closed) CIE off";
  }));

  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed) => {
    if (ed && reportable(ed.document.uri.scheme, ed.document.uri.fsPath)) void post(stream.make("OPEN_FILE", ed.document.uri.fsPath));
  }));

  ctx.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
    const doc = e.textEditor.document;
    if (!reportable(doc.uri.scheme, doc.uri.fsPath)) return;
    const sel = e.selections[0];
    stream.coalesce(stream.make("SELECTION", doc.uri.fsPath, sel.start.line, sel.end.line));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { const ev = stream.flush(); if (ev) void post(ev); }, 300);
  }));

  ctx.subscriptions.push(vscode.debug.onDidChangeBreakpoints((e) => {
    for (const b of [...e.added, ...e.changed]) {
      if (b instanceof vscode.SourceBreakpoint && reportable(b.location.uri.scheme, b.location.uri.fsPath)) void post(stream.make("BREAKPOINT", b.location.uri.fsPath, b.location.range.start.line));
    }
  }));
}

export function deactivate() { if (timer) clearTimeout(timer); }
