// Thin VS Code wrapper. All decisions live in events.ts.
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { EventStream, isLoopback, reportable, type WireEvent } from "./events.js";
import { findReferences, postOp, refQuickPicks, repoForPath, relativeTo, symbolIdForWord } from "./search.js";

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

  // F01: cross-repository find-references in the editor. The flow: repository of the active file, the
  // word under the caret, its indexed symbol id, then the references QuickPick — every row opens at its
  // line; rows carry their tier and, for hits from another repository, the package they travelled by.
  ctx.subscriptions.push(vscode.commands.registerCommand("cie.findReferences", async (at?: vscode.Uri, atLine?, atCol?) => {
    const url = config().url;
    if (!isLoopback(url)) { void vscode.window.showErrorMessage("CIE: the server must be on localhost"); return; }
    const ed = vscode.window.activeTextEditor;
    const doc = ed?.document;
    if (!doc || !reportable(doc.uri.scheme, doc.uri.fsPath)) { void vscode.window.showInformationMessage("CIE: open a real file first"); return; }
    let word = "";
    if (!ed.selection.isEmpty) word = doc.getText(ed.selection);
    else { const w = doc.getWordRangeAtPosition(ed.selection.active); if (w) word = doc.getText(w); }
    word = word.trim();
    if (!word) { void vscode.window.showInformationMessage("CIE: put the caret on a word"); return; }
    try {
      const repos = await postOp<{ repositories: { repositoryId: string; displayName: string; root: string | null; state: string; revision?: { id: string } }[] }>(url, "C04", "listRepositories", {});
      const repo = repoForPath(repos.repositories, doc.uri.fsPath);
      if (!repo) { void vscode.window.showInformationMessage("CIE: this file's repository is not registered with the local server"); return; }
      const revision = (await postOp<{ revision: string; textState: string }>(url, "C07", "indexStatus", { repositoryId: repo.repositoryId })).revision;
      const symbolId = await symbolIdForWord(url, repo.repositoryId, revision, word);
      if (!symbolId) {
        const pick = await vscode.window.showQuickPick(["Search text everywhere instead", "Give up"], { placeHolder: `“${word}” has no indexed definition in CIE — search its text instead?` });
        if (pick === "Search text everywhere instead") { await vscode.env.clipboard.writeText(word); void vscode.window.showInformationMessage(`“${word}” copied — paste it into the web app's search (Ctrl+K)`); }
        return;
      }
      const r = await findReferences(url, repo.repositoryId, revision, symbolId);
      if (!r) { void vscode.window.showInformationMessage("CIE: no references answered"); return; }
      const picks = refQuickPicks(r.references ?? []);
      const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: `${picks.length} reference(s) of ${word}${r.nextCursor ? " (more pages exist)" : ""}`,
        matchOnDetail: false,
      });
      if (!chosen) return;
      const root = repo.root ?? "";
      const rel = relativeTo(root, chosen.location.path);
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(`${root}/${rel}`), { selection: new vscode.Range(Math.max(0, chosen.location.line - 1), Math.max(0, chosen.location.column - 1), Math.max(0, chosen.location.line - 1), Math.max(0, chosen.location.column - 1)) });
    } catch (e) {
      status.text = "$(circle-slash) CIE offline";
      void vscode.window.showErrorMessage(`CIE: ${(e as Error).message}`);
    }
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
