// Program dependence graphs, hand-written on the TypeScript compiler API (plan §0.5).
// One graph per function entity: statement-grain nodes folded within basic blocks, flow edges for
// sequential control, data edges from local def-use chains (last-def-wins with scope shadowing —
// enough for motif matching; this is not a full SSA pass), and explicit guard edges from each branch
// condition to every node it controls, so no matcher ever re-derives control dependence.
//
// Bounds (all read from concept-config, all uncalibrated): a function is truncated after
// pdgMaxStatements nodes; functions past pdgMaxFunctions get no graph and are reported as gaps.
// A function whose bodyHash is unchanged from the previous run is reused whole — nothing is re-read
// from disk for it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Entity } from "@cie/schema";
import type { Store } from "../store.ts";
import { conceptConfig } from "./config.ts";
import type { Pdg, PdgEdge, PdgNode } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ACQUIRE = /^(open|acquire|connect|lock|begin|allocate)$/;
const RELEASE = /^(close|release|unlock|end|dispose|free|commit)$/;
const ASSERT = /^(assert|assertThat|assertEqual(s)?|expect|invariant|check)$/;

/** Function-like entity kinds: the only ones that have a body to graph. */
export const BODY_KINDS = new Set(["function", "method", "test"]);

export interface BuildPdgsResult {
  pdgs: Pdg[];
  /** Entity ids past the function budget, in a stable order. */
  skipped: string[];
  /** How many graphs came from the previous run unchanged. */
  reused: number;
  /** Entity ids whose body could not be located in the source tree (no graph). */
  unresolved: string[];
}

const classifyCall = (name: string | undefined): PdgNode["kind"] =>
  name && ASSERT.test(name) ? "assert" : name && ACQUIRE.test(name) ? "acquire" : name && RELEASE.test(name) ? "release" : "call";

class PdgBuilder {
  nodes: PdgNode[] = [];
  edges: PdgEdge[] = [];
  locals = new Set<string>();
  truncated = false;
  private at = 0;
  private limit: number;
  /** Guard sources active for the statement being emitted; every node gets a guard edge from each. */
  private guards: string[] = [];
  /** Scope stack of var -> def node id; uses link from the current binding. */
  private scopes: Map<string, string>[] = [new Map()];

  constructor(limit: number) { this.limit = limit; }

  pushScope() { this.scopes.push(new Map()); }
  popScope() { this.scopes.pop(); }
  private bind(name: string, id: string) { this.scopes[this.scopes.length - 1].set(name, id); }
  private lastDef(name: string): string | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const d = this.scopes[i].get(name); if (d) return d; }
    return undefined;
  }

  private attachGuards(id: string) {
    for (const g of this.guards) if (g !== id) this.edges.push({ from: g, to: id, kind: "guard" });
  }

  private emit(n: Omit<PdgNode, "id" | "at">, flow = true, feedFrom: string[] = []): string | null {
    if (this.at >= this.limit) { this.truncated = true; return null; }
    const id = `n${this.at}`;
    this.nodes.push({ ...n, id, at: this.at });
    this.at++;
    if (flow) {
      const prev = this.nodes[this.nodes.length - 2];
      if (prev) this.edges.push({ from: prev.id, to: id, kind: "flow" });
    }
    for (const f of feedFrom) if (f !== id) this.edges.push({ from: f, to: id, kind: "data" });
    this.attachGuards(id);
    return id;
  }

  /** A def of a local variable; optionally carrying the binary operator that computed it. */
  define(name: string, op: PdgNode["op"], dynamic = false, feedFrom: string[] = []): string | null {
    this.locals.add(name);
    const id = this.emit({ kind: "def", name, op, dynamicWrite: dynamic });
    if (id) {
      this.bind(name, id);
      for (const f of feedFrom) if (f !== id) this.edges.push({ from: f, to: id, kind: "data" });
    }
    return id;
  }

  use(name: string): string | null {
    const d = this.lastDef(name);
    const id = this.emit({ kind: "use", name });
    if (id && d) this.edges.push({ from: d, to: id, kind: "data" });
    return id;
  }

  call(name: string | undefined, kind: PdgNode["kind"] = "call"): string | null {
    return this.emit({ kind, name });
  }

  /** A condition: its identifier reads are emitted first (with their data edges), then the branch node,
   * which carries the first identifier read and the data edges feeding it. */
  condition(e: ts.Expression): string | null {
    const reads = this.readExpression(e);
    return this.emit({ kind: "branch", name: reads.identifiers[0] }, false, reads.ids);
  }

  terminal(kind: "return" | "throw", feedFrom: string[] = []): string | null {
    return this.emit({ kind }, true, feedFrom);
  }
  // (condition() also feeds the branch node from the ids its reads emitted.)

  awaitExpr(): string | null {
    return this.emit({ kind: "await" });
  }

  /** Reads a value expression. Returns the ids of the nodes it emitted (uses, calls, awaits), the
   * identifiers read (in order, for condition capture), and the top-level binary operator. */
  readExpression(e: ts.Expression): { ids: string[]; identifiers: string[]; op: PdgNode["op"] } {
    const ids: string[] = [];
    const identifiers: string[] = [];
    let op: PdgNode["op"] | undefined;
    const walk = (x: ts.Expression): void => {
      if (ts.isIdentifier(x)) { identifiers.push(x.text); const u = this.use(x.text); if (u) ids.push(u); return; }
      if (ts.isBinaryExpression(x) && !isAssignment(x.operatorToken)) {
        const myOp = opOf(x.operatorToken.kind);
        op = op ?? myOp;
        walk(x.left); walk(x.right); return;
      }
      if (ts.isCallExpression(x)) {
        const c = this.call(this.calleeName(x.expression), classifyCall(this.calleeName(x.expression)));
        if (c) ids.push(c);
        x.arguments.forEach(walk);
        return;
      }
      if (ts.isNewExpression(x)) {
        const c = this.call(this.calleeName(x.expression));
        if (c) ids.push(c);
        (x.arguments ?? []).forEach((a) => walk(a as ts.Expression));
        return;
      }
      if (ts.isAwaitExpression(x)) { const a = this.awaitExpr(); if (a) ids.push(a); walk(x.expression); return; }
      if (ts.isPropertyAccessExpression(x)) { walk(x.expression); return; }
      if (ts.isElementAccessExpression(x)) { walk(x.expression); if (x.argumentExpression) walk(x.argumentExpression); return; }
      if (ts.isConditionalExpression(x)) { walk(x.condition); walk(x.whenTrue); walk(x.whenFalse); return; }
      if (ts.isPrefixUnaryExpression(x) || ts.isPostfixUnaryExpression(x)) { walk(x.operand); return; }
      if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)) { walk(x.expression); return; }
      if (ts.isTemplateExpression(x)) { x.templateSpans.forEach((s) => walk(s.expression)); return; }
      if (ts.isSpreadElement(x)) { walk(x.expression); return; }
      if (ts.isObjectLiteralExpression(x)) { x.properties.forEach((p) => { if (ts.isPropertyAssignment(p)) walk(p.initializer); else if (ts.isSpreadAssignment(p)) walk(p.expression); }); return; }
      if (ts.isArrayLiteralExpression(x)) { x.elements.forEach((el) => walk(el)); return; }
      // literals, this, etc: nothing to read
    };
    walk(e);
    return { ids, identifiers, op };
  }

  calleeName(e: ts.Expression): string | undefined {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return undefined;
  }

  /** The variable an assignment targets, and whether it is a dynamic property write. */
  writeTarget(e: ts.Node): { name: string; dynamic: boolean } | null {
    if (ts.isIdentifier(e)) return { name: e.text, dynamic: false };
    if (ts.isPropertyAccessExpression(e)) return { name: e.name.text, dynamic: false };
    if (ts.isElementAccessExpression(e)) {
      const lit = e.argumentExpression && ts.isStringLiteral(e.argumentExpression) ? e.argumentExpression.text : undefined;
      return lit ? { name: lit, dynamic: false } : { name: "[dynamic]", dynamic: true };
    }
    return null; // binding patterns and anything else: not a single named local
  }

  walkStatement(s: ts.Statement): void {
    if (this.truncated) return;
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) this.walkDeclaration(d);
      return;
    }
    if (ts.isExpressionStatement(s)) { this.walkExpressionStatement(s.expression); return; }
    if (ts.isIfStatement(s)) {
      const cond = this.condition(s.expression);
      const outer = this.guards;
      if (cond) this.guards = [...outer, cond];
      this.walkStatement(s.thenStatement);
      if (s.elseStatement) this.walkStatement(s.elseStatement);
      this.guards = outer;
      return;
    }
    if (ts.isWhileStatement(s) || ts.isDoStatement(s)) {
      const expr = ts.isWhileStatement(s) ? s.expression : s.expression;
      const cond = this.condition(expr);
      const outer = this.guards;
      if (cond) this.guards = [...outer, cond];
      this.walkStatement(s.statement);
      this.guards = outer;
      return;
    }
    if (ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s)) {
      let iterVar: { name: string; dynamic: boolean } | null = null;
      if (ts.isForStatement(s)) {
        if (s.initializer && ts.isVariableDeclarationList(s.initializer)) {
          for (const d of s.initializer.declarations) this.walkDeclaration(d);
        }
        if (s.condition) this.condition(s.condition);
      } else {
        if (ts.isVariableDeclarationList(s.initializer)) {
          for (const d of s.initializer.declarations) this.walkDeclaration(d);
        } else {
          iterVar = this.writeTarget(s.initializer);
          if (iterVar) this.define(iterVar.name, undefined, iterVar.dynamic);
        }
        this.condition(s.expression);
      }
      const outer = this.guards;
      const last = this.nodes[this.nodes.length - 1];
      if (last && last.kind === "branch") this.guards = [...outer, last.id];
      this.walkStatement(s.statement);
      this.guards = outer;
      return;
    }
    if (ts.isReturnStatement(s)) {
      const feeds = s.expression ? this.readExpression(s.expression).ids : [];
      this.terminal("return", feeds);
      return;
    }
    if (ts.isThrowStatement(s)) {
      const feeds = s.expression ? this.readExpression(s.expression).ids : [];
      this.terminal("throw", feeds);
      return;
    }
    if (ts.isBlock(s)) { this.pushScope(); for (const st of s.statements) this.walkStatement(st); this.popScope(); return; }
    if (ts.isTryStatement(s)) {
      this.walkStatement(s.tryBlock);
      if (s.catchClause) {
        if (s.catchClause.variableDeclaration) {
          const t = this.writeTarget(s.catchClause.variableDeclaration.name as ts.Node);
          if (t) this.define(t.name, undefined, t.dynamic);
        }
        this.walkStatement(s.catchClause.block);
      }
      if (s.finallyBlock) this.walkStatement(s.finallyBlock);
      return;
    }
    if (ts.isSwitchStatement(s)) {
      const cond = this.condition(s.expression);
      const outer = this.guards;
      if (cond) this.guards = [...outer, cond];
      for (const c of s.caseBlock.clauses) for (const st of c.statements) this.walkStatement(st);
      this.guards = outer;
      return;
    }
    // break/continue/empty/other declarations: no nodes; nested function declarations are skipped.
  }

  private walkDeclaration(d: ts.VariableDeclaration) {
    const t = this.writeTarget(d.name as ts.Node);
    if (!t) return;
    if (!d.initializer) { this.define(t.name, undefined, t.dynamic); return; }
    const r = this.readExpression(d.initializer);
    this.define(t.name, r.op, t.dynamic, r.ids);
  }

  private walkExpressionStatement(e: ts.Expression) {
    if (ts.isBinaryExpression(e) && isAssignment(e.operatorToken)) {
      const t = this.writeTarget(e.left);
      if (!t) return;
      if (isCompound(e.operatorToken)) {
        // read-modify-write: the old value's use flows into the new def, alongside the right side.
        const u = this.use(t.name);
        const r = this.readExpression(e.right);
        const d = this.define(t.name, opOfCompound(e.operatorToken.kind), t.dynamic, u ? [u, ...r.ids] : r.ids);
        void d;
        return;
      }
      const r = this.readExpression(e.right);
      this.define(t.name, r.op, t.dynamic, r.ids);
      return;
    }
    if (ts.isCallExpression(e)) {
      const name = this.calleeName(e.expression);
      const c = this.call(name, classifyCall(name));
      for (const a of e.arguments) {
        const { ids } = this.readExpression(a);
        if (c) for (const u of ids) this.edges.push({ from: u, to: c, kind: "data" });
      }
      return;
    }
    if (ts.isAwaitExpression(e)) {
      this.awaitExpr();
      if (ts.isCallExpression(e.expression)) this.walkExpressionStatement(e.expression);
      else this.readExpression(e.expression);
      return;
    }
    if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
      if (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken) {
        const t = this.writeTarget(e.operand);
        if (t) {
          const u = this.use(t.name);
          const op = e.operator === ts.SyntaxKind.PlusPlusToken ? "op:add" : "op:sub";
          this.define(t.name, op, t.dynamic, u ? [u] : []);
        }
      } else this.readExpression(e.operand);
      return;
    }
    if (ts.isDeleteExpression(e)) { this.readExpression(e.expression); return; }
    this.readExpression(e);
  }

  graph(): { nodes: PdgNode[]; edges: PdgEdge[]; locals: string[]; statements: number; truncated: boolean } {
    return { nodes: this.nodes, edges: this.edges, locals: [...this.locals].sort(), statements: this.at, truncated: this.truncated };
  }
}

const isAssignment = (t: ts.BinaryOperatorToken) =>
  t.kind === ts.SyntaxKind.EqualsToken ||
  (t.kind >= ts.SyntaxKind.PlusEqualsToken && t.kind <= ts.SyntaxKind.CaretEqualsToken);
const isCompound = (t: ts.BinaryOperatorToken) => t.kind !== ts.SyntaxKind.EqualsToken;
const opOf = (k: ts.SyntaxKind): PdgNode["op"] | undefined =>
  k === ts.SyntaxKind.PlusToken ? "op:add"
  : k === ts.SyntaxKind.MinusToken ? "op:sub"
  : k === ts.SyntaxKind.AsteriskToken ? "op:mul"
  : k === ts.SyntaxKind.SlashToken ? "op:div"
  : undefined;
const opOfCompound = (k: ts.SyntaxKind): PdgNode["op"] | undefined =>
  k === ts.SyntaxKind.PlusEqualsToken ? "op:add"
  : k === ts.SyntaxKind.MinusEqualsToken ? "op:sub"
  : k === ts.SyntaxKind.AsteriskEqualsToken ? "op:mul"
  : k === ts.SyntaxKind.SlashEqualsToken ? "op:div"
  : undefined;

/** Find the function-like declaration an entity refers to: first by span, then by name. */
function locateFunction(sf: ts.SourceFile, name: string, span?: { startByte: number; endByteExclusive: number }): ts.Node | null {
  let found: ts.Node | null = null;
  const base = name.includes(".") ? name.split(".").pop()! : name;
  const visit = (n: ts.Node): void => {
    if (found) return;
    const fn = ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
    if (fn) {
      const declared = ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) ? n.name?.getText(sf) : undefined;
      if (span && span.endByteExclusive > span.startByte && n.getStart(sf) <= span.startByte && n.getEnd() >= span.endByteExclusive) {
        found = n; return;
      }
      if (declared === base || declared === name) { found = n; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const sourceCache = new Map<string, ts.SourceFile>();
function loadSource(repoRoot: string, file: string): ts.SourceFile | null {
  const key = `${repoRoot}::${file}`;
  const hit = sourceCache.get(key);
  if (hit) return hit;
  const abs = join(repoRoot, file);
  if (!existsSync(abs)) return null;
  let text: string;
  try { text = readFileSync(abs, "utf8"); } catch { return null; }
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  sourceCache.set(key, sf);
  return sf;
}
/** Tests build many tiny repos; the cache is keyed by repoRoot, so callers clear it between them. */
export function clearPdgSourceCache() { sourceCache.clear(); }

export function buildPdgForFunction(repoRoot: string, e: Entity): Pdg | null {
  const sf = loadSource(repoRoot, e.file);
  if (!sf) return null;
  const span = e.spans[0] ? { startByte: e.spans[0].startByte, endByteExclusive: e.spans[0].endByteExclusive } : undefined;
  const fn = locateFunction(sf, e.name, span);
  if (!fn) return null;
  const body = ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)
    ? fn.body
    : undefined;
  if (!body) return null;
  const bodyText = fn.getText(sf);
  const limit = conceptConfig().pdgMaxStatements.value;
  const b = new PdgBuilder(limit);
  if (ts.isBlock(body)) { b.pushScope(); for (const st of body.statements) b.walkStatement(st); b.popScope(); }
  else { b.readExpression(body as ts.Expression); } // arrow with an expression body
  const g = b.graph();
  const graphHash = sha(JSON.stringify({ n: g.nodes.map((x) => [x.kind, x.name ?? "", x.op ?? ""]), e: g.edges.map((x) => [x.from, x.to, x.kind]).sort(), l: g.locals }));
  return {
    entityId: e.entityId, file: e.file, bodyHash: sha(bodyText), graphHash,
    nodes: g.nodes, edges: g.edges, locals: g.locals, truncated: g.truncated, statements: g.statements,
  };
}

/** Build (or reuse) one graph per function-like entity of the revision, in stable file order. */
export function buildAllPdgs(store: Store, revision: string, repoRoot: string, previous?: Pdg[]): BuildPdgsResult {
  const maxFns = conceptConfig().pdgMaxFunctions.value;
  const prevByEntity = new Map((previous ?? []).map((p) => [p.entityId, p]));
  const fns = store.entities(revision)
    .filter((e) => BODY_KINDS.has(e.kind))
    .sort((a, b) => a.file.localeCompare(b.file) || a.entityId.localeCompare(b.entityId));
  const pdgs: Pdg[] = [];
  const skipped: string[] = [];
  const unresolved: string[] = [];
  let reused = 0;
  for (const e of fns) {
    if (pdgs.length >= maxFns) { skipped.push(e.entityId); continue; }
    const prev = prevByEntity.get(e.entityId);
    if (prev && e.symbolHash && prev.bodyHash === e.symbolHash) { pdgs.push(prev); reused++; continue; }
    const g = buildPdgForFunction(repoRoot, e);
    if (!g) { unresolved.push(e.entityId); continue; }
    if (prev && prev.bodyHash === g.bodyHash) { pdgs.push(prev); reused++; continue; }
    pdgs.push(g);
  }
  return { pdgs, skipped, reused, unresolved };
}
