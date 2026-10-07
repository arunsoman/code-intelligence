// Phase 1: program dependence graphs from TypeScript source, built on the typescript compiler API
// (infra decision 0.2 — no new parser dependency). There was no CFG/SSA infrastructure here to reuse;
// this is the one genuinely new piece of program-analysis infrastructure in the plan.
//
// Scope and honest limits:
//   - Statement granularity: one PDG node per statement/expression site, not per expression tree.
//   - "SSA" is per-function renaming of local variables with dominator-scoped def stacks; phi nodes are not
//     inserted. A read resolves to the definitions that dominate it; loop-carried dependences are added per
//     loop explicitly. Whole-program SSA is out of scope by decision.
//   - Control dependence uses the standard dominator-based approximation: n is control-dependent on c iff
//     c's block dominates n's block and n's block does not post-dominate c's block. Exact for structured code.
//   - try/catch/finally edges are approximated (the try entry and every try exit reach the catch entry);
//     precise exception edges are not attempted.
//   - Offsets in PDG nodes are character offsets into the entity's own source text; the entity's store
//     spans remain the byte-accurate anchors for evidence.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { Entity } from "@cie/schema";
import { CONCEPT_CONFIG } from "./config.ts";
import type { BasicBlock, Condition, ControlEdge, Cfg, DataEdge, GuardEdge, LoopInfo, Pdg, PdgIndex, PdgNode, Ssa } from "./types.ts";
import { policyFor } from "../access.ts";
import type { Store } from "../store.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const trim = (s: string, n = 200) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export const isTsFile = (file: string) => CONCEPT_CONFIG.sourceExtensions.some((ext) => file.endsWith(ext));

const SF_OPTS: ts.CreateSourceFileOptions = { languageVersion: ts.ScriptTarget.ES2022 };
const parse = (key: string, src: string) => ts.createSourceFile(key, src, SF_OPTS.languageVersion, true, ts.ScriptKind.TS);

// ---------------------------------------------------------------- statement fact collection

interface Facts { writes: string[]; writeOps: Record<string, string>; reads: string[]; calls: string[]; dynamicProperty: boolean; closureWrite: boolean; isAwait: boolean; hasLiteral: boolean }

const emptyFacts = (): Facts => ({ writes: [], writeOps: {}, reads: [], calls: [], dynamicProperty: false, closureWrite: false, isAwait: false, hasLiteral: false });

/** Canonical update operator of an assignment-like expression writing `target`. */
function writeOpOf(target: string, token: ts.SyntaxKind, rhs: ts.Expression | undefined): string {
  const isAddLike = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.PlusToken || e.operatorToken.kind === ts.SyntaxKind.MinusToken)) {
      const [l, r] = [e.left, e.right];
      return namesOf(l).includes(target) || namesOf(r).includes(target);
    }
    return false;
  };
  switch (token) {
    case ts.SyntaxKind.EqualsToken: {
      if (rhs && ts.isBinaryExpression(rhs)) {
        if (rhs.operatorToken.kind === ts.SyntaxKind.PlusToken && isAddLike(rhs)) return "add";
        if (rhs.operatorToken.kind === ts.SyntaxKind.MinusToken && isAddLike(rhs)) return "sub";
        if (rhs.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return "mul";
        if (rhs.operatorToken.kind === ts.SyntaxKind.SlashToken) return "div";
      }
      return "assign";
    }
    case ts.SyntaxKind.PlusEqualsToken: return "add";
    case ts.SyntaxKind.MinusEqualsToken: return "sub";
    case ts.SyntaxKind.AsteriskEqualsToken: return "mul";
    case ts.SyntaxKind.SlashEqualsToken: return "div";
    case ts.SyntaxKind.PlusPlusToken: return "add";
    case ts.SyntaxKind.MinusMinusToken: return "sub";
    default: return "assign";
  }
}

/** Identifier names and dotted property paths mentioned by an expression (shallow, for self-reference detection). */
function namesOf(e: ts.Expression): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) { out.push(n.getText()); return; } // the whole path, not its parts
    if (ts.isIdentifier(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(e);
  return out;
}

/** The written expression: `x`, `a.b` (named path), or `a[...]` (dynamic). */
function writeTarget(expr: ts.Node): { name: string; dynamic: boolean } | null {
  if (ts.isIdentifier(expr)) return { name: expr.text, dynamic: false };
  if (ts.isPropertyAccessExpression(expr)) {
    const base = writeTarget(expr.expression);
    return { name: base ? `${base.name}.${expr.name.text}` : expr.name.text, dynamic: base?.dynamic ?? false };
  }
  if (ts.isElementAccessExpression(expr)) {
    const base = writeTarget(expr.expression);
    return { name: `${base ? base.name : ""}[…]`, dynamic: true };
  }
  if (ts.isParenthesizedExpression(expr)) return writeTarget(expr.expression);
  return null;
}

/** Identifiers that name something (a property, a declaration, a label) are not reads. */
function isNameNotRead(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return true;
  if (ts.isQualifiedName(p) && p.right === n) return true;
  if ((ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === n) return true;
  if (ts.isPropertyAssignment(p) && p.name === n) return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true;
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return true;
  return false;
}

function isBindingName(n: ts.Identifier): boolean {
  const p = n.parent;
  return (ts.isVariableDeclaration(p) && p.name === n) || (ts.isParameter(p) && p.name === n) || (ts.isBindingElement(p) && p.name === n);
}

function collectFacts(node: ts.Node, facts: Facts): void {
  const visit = (n: ts.Node): void => {
    // Closure bodies: a shallow walk marks closure interference; the body is not part of this statement's own flow.
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const inner = emptyFacts();
      const closureVisit = (c: ts.Node): void => {
        recordWrites(c, inner);
        if (ts.isCallExpression(c) || ts.isNewExpression(c)) inner.calls.push(trim(c.expression.getText(), 80));
        if (ts.isNumericLiteral(c) || ts.isStringLiteral(c) || ts.isNoSubstitutionTemplateLiteral(c)) inner.hasLiteral = true;
        ts.forEachChild(c, closureVisit);
      };
      if (n.body) ts.forEachChild(n.body, closureVisit);
      if (inner.writes.length || inner.dynamicProperty) facts.closureWrite = true;
      // A closure write is a write the statement may perform (asynchronously or later): carry the names
      // onto the statement so guard/interference analysis sees them.
      for (const w of inner.writes) {
        if (!facts.writes.includes(w)) facts.writes.push(w);
        if (facts.writeOps[w] === undefined) facts.writeOps[w] = "assign";
      }
      facts.dynamicProperty = facts.dynamicProperty || inner.dynamicProperty;
      if (inner.calls.length) facts.calls.push(...inner.calls);
      if (inner.hasLiteral) facts.hasLiteral = true;
      return;
    }
    if (ts.isIdentifier(n) && !isNameNotRead(n) && !isBindingName(n)) facts.reads.push(n.text);
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      facts.calls.push(trim(n.expression.getText(), 80));
      if (ts.isAwaitExpression(n.parent)) facts.isAwait = true;
    }
    if (ts.isAwaitExpression(n)) facts.isAwait = true;
    if (ts.isNumericLiteral(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) facts.hasLiteral = true;
    recordWrites(n, facts);
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** Record the writes of one assignment-like node onto `facts`. */
function recordWrites(n: ts.Node, facts: Facts): void {
  const add = (target: ts.Node, token: ts.SyntaxKind, rhs?: ts.Expression) => {
    const wt = writeTarget(target);
    if (!wt) return;
    if (!facts.writes.includes(wt.name)) facts.writes.push(wt.name);
    facts.writeOps[wt.name] = writeOpOf(wt.name, token, rhs);
    facts.dynamicProperty = facts.dynamicProperty || wt.dynamic;
  };
  if (ts.isBinaryExpression(n)) {
    const kind = n.operatorToken.kind;
    const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken]);
    if (ASSIGN.has(kind)) add(n.left, kind, n.right);
    return;
  }
  if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
    const op = (n as ts.PrefixUnaryExpression).operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) add((n as ts.PrefixUnaryExpression).operand, op);
    return;
  }
  if (ts.isVariableDeclaration(n) && n.initializer) add(n.name, ts.SyntaxKind.EqualsToken, n.initializer);
  if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && ts.isVariableDeclarationList(n.initializer)) {
    for (const d of n.initializer.declarations) add(d.name, ts.SyntaxKind.EqualsToken);
  }
}

// ---------------------------------------------------------------- CFG construction

interface BuildCtx {
  nodes: PdgNode[];
  blocks: BasicBlock[];
  edges: ControlEdge[];
  branches: Map<number, { true: number[]; false: number[] }>;
  /** break/continue targets, pushed by loops and switches in nesting order. */
  jumpScopes: { breakTo: number[]; continueTo: number[] | null }[];
  /** Condition blocks whose false branch is a fall-through whose target is not known yet (no else). */
  deferredFalse: number[];
  /** Index of the catch clause currently being emitted, or null. */
  catchId: number | null;
  exit: number;
  nextId: number;
}

interface SeqResult { entries: number[]; dangling: number[]; fallsThrough: boolean }

const NO_SEQ: SeqResult = { entries: [], dangling: [], fallsThrough: false };

function newNode(ctx: BuildCtx, node: ts.Node, kind: string, facts: Facts): number {
  const id = ctx.nextId++;
  ctx.nodes.push({
    id, kind,
    text: trim(node.getText()),
    start: node.getStart(),
    end: node.getEnd(),
    block: -1,
    writes: [...facts.writes],
    writeOps: { ...facts.writeOps },
    reads: [...new Set(facts.reads)],
    calls: [...new Set(facts.calls)],
    dynamicProperty: facts.dynamicProperty,
    closureWrite: facts.closureWrite,
    isAwait: facts.isAwait,
    hasLiteral: facts.hasLiteral,
    catchId: ctx.catchId,
  });
  return id;
}

function newBlock(ctx: BuildCtx, nodeIds: number[] = []): BasicBlock {
  const b: BasicBlock = { id: ctx.blocks.length, nodes: nodeIds, succs: [], preds: [] };
  for (const n of nodeIds) ctx.nodes[n].block = b.id;
  ctx.blocks.push(b);
  return b;
}

function edge(ctx: BuildCtx, from: number, to: number, kind: string) {
  if (from === to && kind === "fall") return;
  if (!ctx.blocks[from].succs.includes(to)) { ctx.blocks[from].succs.push(to); ctx.blocks[to].preds.push(from); }
  ctx.edges.push({ from, to, kind });
}

const wire = (ctx: BuildCtx, froms: number[], tos: number[], kind: string) => {
  for (const f of froms) for (const t of tos) edge(ctx, f, t, kind);
};

/** The statements a PDG is built over: whatever the entity's text puts at the top level. For a class,
 *  each concrete member becomes an independent sequence (no inter-member edges are invented). */
function bodyStatements(root: ts.Node): readonly ts.Statement[] {
  const fn = root as Partial<ts.FunctionLikeDeclaration>;
  if (ts.isFunctionLike(root) && fn.body) return ts.isBlock(fn.body) ? fn.body.statements : [];
  if (ts.isClassDeclaration(root) || ts.isClassExpression(root)) {
    return root.members.filter((m) => ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) as unknown as ts.Statement[];
  }
  if (ts.isSourceFile(root)) return root.statements;
  if (ts.isBlock(root)) return root.statements;
  return [];
}

/** Emit a statement list; the list's fall-through exits are wired to `cont` with `kind` ("fall" or "back").
 *  Deferred false-branches (from `if (c) …` with no else) are resolved against the next statement's entry,
 *  or against `cont` when the list ends — never guessed at emission time. */
function emitSeq(ctx: BuildCtx, stmts: readonly ts.Statement[], cont: number[], kind: string): SeqResult {
  if (!stmts.length) return { entries: [], dangling: [], fallsThrough: true };
  const mark = ctx.deferredFalse.length;
  let entries: number[] = [];
  let dangling: number[] = [];
  let fallsThrough = true;
  let first = true;
  for (const s of stmts) {
    const ours = ctx.deferredFalse.length - mark; // conds deferred by earlier statements of this list
    const cur = emitStmt(ctx, s, cont, kind);
    const targets = cur.entries.length ? cur.entries : cont;
    if (fallsThrough && dangling.length) wire(ctx, dangling, targets, cur.entries.length ? "fall" : kind);
    if (fallsThrough) resolveDeferred(ctx, ours, targets);
    if (first) { entries = cur.entries; first = false; }
    dangling = cur.dangling;
    fallsThrough = cur.fallsThrough;
  }
  if (fallsThrough && dangling.length) wire(ctx, dangling, cont, kind);
  resolveDeferred(ctx, ctx.deferredFalse.length - mark, cont); // everything still open in this scope
  return { entries, dangling, fallsThrough };
}

/** Wire the `count` oldest deferred conditions to `targets` (their false path) and record the branch targets. */
function resolveDeferred(ctx: BuildCtx, count: number, targets: number[]): void {
  if (count <= 0) return;
  const conds = ctx.deferredFalse.splice(0, Math.min(count, ctx.deferredFalse.length));
  for (const cond of conds) {
    if (!targets.length) { const br = ctx.branches.get(cond); if (br) ctx.branches.set(cond, { ...br, false: [] }); continue; }
    wire(ctx, [cond], targets, "false");
    const br = ctx.branches.get(cond);
    if (br) ctx.branches.set(cond, { ...br, false: [...targets] });
  }
}

function emitStmt(ctx: BuildCtx, s: ts.Statement, cont: number[], kind: string): SeqResult {
  // --- class members appear as top-level items when the entity text is a class; each is an independent sequence.
  if (ts.isMethodDeclaration(s) || ts.isConstructorDeclaration(s) || ts.isGetAccessorDeclaration(s) || ts.isSetAccessorDeclaration(s)) {
    const body = (s as ts.MethodDeclaration).body;
    if (!body || !ts.isBlock(body)) return NO_SEQ;
    const r = emitSeq(ctx, body.statements, cont, kind);
    return { entries: r.entries, dangling: r.dangling, fallsThrough: r.fallsThrough };
  }
  // --- a top-level function declaration: its body is the flow (the declaration is not a runtime step).
  if (ts.isFunctionDeclaration(s) && s.body && ts.isBlock(s.body)) {
    return emitSeq(ctx, s.body.statements, cont, kind);
  }
  // --- jumps
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) {
    const facts = emptyFacts();
    collectFacts(s, facts);
    const n = newNode(ctx, s, ts.isReturnStatement(s) ? "return" : "throw", facts);
    const b = newBlock(ctx, [n]);
    edge(ctx, b.id, ctx.exit, "exit");
    return { entries: [b.id], dangling: [], fallsThrough: false };
  }
  if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
    const facts = emptyFacts();
    collectFacts(s, facts);
    const n = newNode(ctx, s, "jump", facts);
    const b = newBlock(ctx, [n]);
    // An unlabeled break leaves the innermost loop OR switch; an unlabeled continue only matches loops.
    if (s.label) { wire(ctx, [b.id], cont, "fall"); return { entries: [b.id], dangling: [], fallsThrough: false }; }
    for (let i = ctx.jumpScopes.length - 1; i >= 0; i--) {
      const scope = ctx.jumpScopes[i];
      const target = ts.isContinueStatement(s) ? scope.continueTo : scope.breakTo;
      if (target) { wire(ctx, [b.id], target, ts.isContinueStatement(s) ? "back" : "fall"); return { entries: [b.id], dangling: [], fallsThrough: false }; }
    }
    wire(ctx, [b.id], cont, "fall");
    return { entries: [b.id], dangling: [], fallsThrough: false };
  }
  // --- conditionals
  if (ts.isIfStatement(s)) {
    const facts = emptyFacts();
    collectFacts(s.expression, facts);
    const condNode = newNode(ctx, s.expression, "cond", facts);
    const c = newBlock(ctx, [condNode]);
    const thenR = emitStmt(ctx, s.thenStatement, cont, kind);
    if (s.elseStatement) {
      const elseR = emitStmt(ctx, s.elseStatement, cont, kind);
      const trueTargets = thenR.entries.length ? thenR.entries : (thenR.fallsThrough ? cont : []);
      const falseTargets = elseR.entries.length ? elseR.entries : (elseR.fallsThrough ? cont : []);
      wire(ctx, [c.id], trueTargets, "true");
      wire(ctx, [c.id], falseTargets, "false");
      ctx.branches.set(c.id, { true: trueTargets, false: falseTargets });
    } else {
      // No else: the false path is a fall-through whose target is the next statement (or the sequence's cont).
      const trueTargets = thenR.entries.length ? thenR.entries : (thenR.fallsThrough ? cont : []);
      wire(ctx, [c.id], trueTargets, "true");
      ctx.branches.set(c.id, { true: trueTargets, false: [] });
      ctx.deferredFalse.push(c.id);
    }
    return { entries: [c.id], dangling: [], fallsThrough: true };
  }
  if (ts.isWhileStatement(s)) {
    const facts = emptyFacts();
    collectFacts(s.expression, facts);
    const condNode = newNode(ctx, s.expression, "cond", facts);
    const c = newBlock(ctx, [condNode]);
    ctx.jumpScopes.push({ breakTo: cont, continueTo: [c.id] });
    const bodyR = emitStmt(ctx, s.statement, [c.id], "back");
    ctx.jumpScopes.pop();
    const trueTargets = bodyR.entries.length ? bodyR.entries : (bodyR.fallsThrough ? [c.id] : []);
    wire(ctx, [c.id], trueTargets, "true");
    wire(ctx, [c.id], cont, "false");
    ctx.branches.set(c.id, { true: trueTargets, false: cont });
    return { entries: [c.id], dangling: [], fallsThrough: true };
  }
  if (ts.isDoStatement(s)) {
    ctx.jumpScopes.push({ breakTo: cont, continueTo: null });
    const bodyR = emitStmt(ctx, s.statement, [], "fall");
    ctx.jumpScopes.pop();
    const facts = emptyFacts();
    collectFacts(s.expression, facts);
    const condNode = newNode(ctx, s.expression, "cond", facts);
    const c = newBlock(ctx, [condNode]);
    if (bodyR.fallsThrough && bodyR.dangling.length) wire(ctx, bodyR.dangling, [c.id], "fall");
    const trueTargets = bodyR.entries.length ? bodyR.entries : [c.id];
    wire(ctx, [c.id], trueTargets, "back");
    wire(ctx, [c.id], cont, "false");
    ctx.branches.set(c.id, { true: trueTargets, false: cont });
    return { entries: bodyR.entries.length ? bodyR.entries : [c.id], dangling: [], fallsThrough: true };
  }
  if (ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s)) {
    if (ts.isForStatement(s)) {
      // init → cond → body → update → cond (back); a missing part drops out of the chain.
      let initE: number[] = [];
      if (s.initializer) {
        const f = emptyFacts();
        collectFacts(s.initializer, f);
        const b = newBlock(ctx, [newNode(ctx, s.initializer, "stmt", f)]);
        initE = [b.id];
      }
      let condB: BasicBlock | null = null;
      if (s.condition) {
        const f = emptyFacts();
        collectFacts(s.condition, f);
        condB = newBlock(ctx, [newNode(ctx, s.condition, "cond", f)]);
      }
      const updateB = s.incrementor ? (() => { const f = emptyFacts(); collectFacts(s.incrementor!, f); return newBlock(ctx, [newNode(ctx, s.incrementor!, "stmt", f)]); })() : null;
      ctx.jumpScopes.push({ breakTo: cont, continueTo: updateB ? [updateB.id] : condB ? [condB.id] : null });
      const bodyR = emitStmt(ctx, s.statement, updateB ? [updateB.id] : condB ? [condB.id] : cont, "back");
      ctx.jumpScopes.pop();
      if (initE.length && condB) wire(ctx, initE, [condB.id], "fall");
      else if (initE.length && updateB) wire(ctx, initE, [updateB.id], "fall");
      const trueTargets = bodyR.entries.length ? bodyR.entries : (bodyR.fallsThrough && updateB ? [updateB.id] : bodyR.fallsThrough && condB ? [condB.id] : []);
      if (condB) {
        wire(ctx, [condB.id], trueTargets, "true");
        wire(ctx, [condB.id], cont, "false");
        ctx.branches.set(condB.id, { true: trueTargets, false: cont });
      }
      if (updateB) {
        if (bodyR.fallsThrough && bodyR.dangling.length) wire(ctx, bodyR.dangling, [updateB.id], "fall");
        const backTo = condB ? [condB.id] : [...initE];
        if (backTo.length) wire(ctx, [updateB.id], backTo, "back");
      } else if (bodyR.fallsThrough && bodyR.dangling.length && condB) {
        wire(ctx, bodyR.dangling, [condB.id], "back");
      }
      const entryBlocks = initE.length ? initE : condB ? [condB.id] : updateB ? [updateB.id] : bodyR.entries;
      return { entries: entryBlocks, dangling: [], fallsThrough: true };
    }
    // for-in / for-of: the header block carries the binding and the iteration condition role.
    const headerFacts = emptyFacts();
    collectFacts(s.expression, headerFacts);
    const bindingFacts = emptyFacts();
    recordWrites(s, bindingFacts);
    const headerParts: number[] = [newNode(ctx, s, "cond", { ...headerFacts, writes: [...bindingFacts.writes], writeOps: { ...bindingFacts.writeOps } })];
    const h = newBlock(ctx, headerParts);
    ctx.jumpScopes.push({ breakTo: cont, continueTo: [h.id] });
    const bodyR = emitStmt(ctx, s.statement, [h.id], "back");
    ctx.jumpScopes.pop();
    const trueTargets = bodyR.entries.length ? bodyR.entries : (bodyR.fallsThrough ? [h.id] : []);
    wire(ctx, [h.id], trueTargets, "true");
    wire(ctx, [h.id], cont, "false");
    ctx.branches.set(h.id, { true: trueTargets, false: cont });
    return { entries: [h.id], dangling: [], fallsThrough: true };
  }
  if (ts.isSwitchStatement(s)) {
    const facts = emptyFacts();
    collectFacts(s.expression, facts);
    const discNode = newNode(ctx, s.expression, "cond", facts);
    const d = newBlock(ctx, [discNode]);
    // Built last-case-first so each case's fall-through target (the next case's entry) exists.
    ctx.jumpScopes.push({ breakTo: cont, continueTo: null }); // a bare break inside a switch leaves the switch
    const clauses = s.caseBlock.clauses;
    const caseResults: SeqResult[] = new Array(clauses.length);
    let next = cont;
    for (let i = clauses.length - 1; i >= 0; i--) {
      const r = emitSeq(ctx, clauses[i].statements, next, "fall");
      caseResults[i] = r;
      next = r.entries.length ? r.entries : next;
    }
    ctx.jumpScopes.pop();
    for (const r of caseResults) if (r.entries.length) edge(ctx, d.id, r.entries[0], "switch");
    if (!caseResults.some((r) => r.entries.length)) wire(ctx, [d.id], cont, "fall");
    ctx.branches.set(d.id, { true: caseResults.flatMap((r) => r.entries), false: cont });
    return { entries: [d.id], dangling: [], fallsThrough: true };
  }
  if (ts.isTryStatement(s)) {
    const tryR = emitSeq(ctx, s.tryBlock.statements, cont, kind);
    let catchR = NO_SEQ;
    if (s.catchClause) {
      ctx.catchId = (ctx.catchId ?? -1) + 1;
      catchR = emitSeq(ctx, s.catchClause.block.statements, cont, kind);
      ctx.catchId = null;
    }
    // Approximate exception edges: the try entry and every try exit reach the catch entry.
    if (catchR.entries.length) wire(ctx, [...tryR.entries, ...tryR.dangling], catchR.entries, "fall");
    if (s.finallyBlock) {
      const finR = emitSeq(ctx, s.finallyBlock.statements, cont, kind);
      if (finR.entries.length) {
        wire(ctx, tryR.dangling, finR.entries, "fall");
        wire(ctx, catchR.dangling, finR.entries, "fall");
      }
      return { entries: tryR.entries.length ? tryR.entries : finR.entries.length ? finR.entries : [], dangling: [], fallsThrough: true };
    }
    return { entries: tryR.entries.length ? tryR.entries : catchR.entries, dangling: [...tryR.dangling, ...catchR.dangling], fallsThrough: tryR.fallsThrough || catchR.fallsThrough };
  }
  if (ts.isBlock(s)) return emitSeq(ctx, s.statements, cont, kind);
  if (ts.isLabeledStatement(s)) return emitStmt(ctx, s.statement, cont, kind);
  if (ts.isEmptyStatement(s)) return NO_SEQ;
  // --- a variable statement whose declarers are arrow/function expressions: the bodies are the flow.
  if (ts.isVariableStatement(s)) {
    const bodies = s.declarationList.declarations
      .map((d) => (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isBlock(d.initializer.body)) ? (d.initializer.body.statements as readonly ts.Statement[]) : null)
      .filter((x): x is readonly ts.Statement[] => !!x);
    if (bodies.length) {
      const facts = emptyFacts();
      collectFacts(s, facts);
      const n = newNode(ctx, s, "write", facts);
      const b = newBlock(ctx, [n]);
      let prevDangling = [b.id];
      let prevFalls = true;
      let firstEntries: number[] = [];
      let firstSet = false;
      for (const body of bodies) {
        const r = emitSeq(ctx, body, cont, kind);
        wire(ctx, prevDangling, r.entries.length ? r.entries : cont, r.entries.length ? "fall" : kind);
        if (!firstSet) { firstEntries = r.entries; firstSet = true; }
        prevDangling = r.dangling;
        prevFalls = r.fallsThrough;
      }
      return { entries: [b.id, ...firstEntries], dangling: prevFalls ? prevDangling : [], fallsThrough: prevFalls };
    }
  }
  // --- simple statement (expression, variable declaration, …)
  const facts = emptyFacts();
  collectFacts(s, facts);
  let nkind = "stmt";
  if (facts.writes.length) nkind = "write";
  else if (facts.calls.length) nkind = "call";
  if (facts.isAwait) nkind = "await";
  const n = newNode(ctx, s, nkind, facts);
  const b = newBlock(ctx, [n]);
  return { entries: [b.id], dangling: [b.id], fallsThrough: true };
}

// ---------------------------------------------------------------- CFG assembly + folding

/** Build the CFG for one entity's source text: one node per statement site, then folded. */
export function buildControlFlowGraph(sourceFile: ts.SourceFile, root: ts.Node): Cfg {
  const stmts = bodyStatements(root);
  const ctx: BuildCtx = { nodes: [], blocks: [], edges: [], branches: new Map(), jumpScopes: [], deferredFalse: [], catchId: null, exit: -1, nextId: 0 };
  const entryBlock = newBlock(ctx); // synthetic entry
  ctx.exit = newBlock(ctx).id; // synthetic exit
  const seq = emitSeq(ctx, stmts, [ctx.exit], "fall");
  wire(ctx, [entryBlock.id], seq.entries.length ? seq.entries : [ctx.exit], "fall");
  const cfg: Cfg = {
    entry: entryBlock.id,
    exit: ctx.exit,
    blocks: ctx.blocks,
    edges: dedupeEdges(ctx.edges),
    nodes: ctx.nodes,
    conditionBlocks: [...ctx.branches.keys()],
    branches: ctx.branches,
    loops: [],
  };
  rebuildSuccsPreds(cfg);
  foldBasicBlocks(cfg);
  void sourceFile;
  return cfg;
}

function dedupeEdges(edges: ControlEdge[]): ControlEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => { const k = `${e.from}>${e.to}:${e.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function rebuildSuccsPreds(cfg: Cfg): void {
  for (const b of cfg.blocks) { b.succs = []; b.preds = []; }
  for (const e of dedupeEdges(cfg.edges)) {
    if (!cfg.blocks[e.from].succs.includes(e.to)) cfg.blocks[e.from].succs.push(e.to);
    if (!cfg.blocks[e.to].preds.includes(e.from)) cfg.blocks[e.to].preds.push(e.from);
  }
}

/** Merge single-successor → single-predecessor chains into one block (never across condition blocks,
 *  loop headers, or the entry/exit). Node block indices, edges and branch records are rewritten. */
export function foldBasicBlocks(cfg: Cfg): void {
  const blocks = cfg.blocks;
  const backTargets = new Set(cfg.edges.filter((e) => e.kind === "back").map((e) => e.to));
  const condBlocks = new Set(cfg.conditionBlocks);
  const predsOf = (b: number) => blocks[b].preds.length;
  const succsOf = (b: number) => new Set(cfg.edges.filter((e) => e.from === b).map((e) => e.to)).size;
  const remap = new Map<number, number>();
  for (const b of blocks) {
    if (remap.has(b.id) || b.id === cfg.entry || b.id === cfg.exit || backTargets.has(b.id) || condBlocks.has(b.id)) continue;
    if (b.nodes.length === 0) continue; // synthetic entry/exit stay alone
    // Follow the chain while the next block is a plain join-free straight-line block.
    const chain: number[] = [b.id];
    let cur = b.id;
    while (succsOf(cur) === 1) {
      const only = cfg.edges.find((e) => e.from === cur)!;
      const t = only.to;
      if (t === cfg.exit || backTargets.has(t) || condBlocks.has(t) || remap.has(t) || predsOf(t) !== 1 || blocks[t].nodes.length === 0) break;
      // A condition block must never absorb its successors either.
      if (cfg.edges.filter((e) => e.to === t).some((e) => condBlocks.has(e.from) && (e.kind === "true" || e.kind === "false" || e.kind === "switch"))) break;
      chain.push(t);
      cur = t;
    }
    if (chain.length === 1) continue;
    const keep = b.id;
    for (const id of chain.slice(1)) { blocks[keep].nodes.push(...blocks[id].nodes); remap.set(id, keep); }
  }
  if (remap.size) {
    const map = (x: number) => remap.get(x) ?? x;
    cfg.edges = dedupeEdges(cfg.edges.map((e) => ({ ...e, from: map(e.from), to: map(e.to) }))).filter((e) => e.from !== e.to || e.kind !== "fall");
    for (const n of cfg.nodes) n.block = map(n.block);
    cfg.conditionBlocks = [...new Set(cfg.conditionBlocks.map(map))];
    cfg.branches = new Map([...cfg.branches.entries()].map(([k, v]) => [map(k), { true: [...new Set(v.true.map(map))], false: [...new Set(v.false.map(map))] }]));
    rebuildSuccsPreds(cfg);
  }
}

// ---------------------------------------------------------------- dominators / post-dominators

/** Standard iterative dominator computation (Cooper–Harvey–Kennedy) over blocks reachable from `root`. */
function dominatorTree(blocks: BasicBlock[], edges: ControlEdge[], root: number, reverse = false): { idom: (number | null)[]; dominates: (a: number, b: number) => boolean } {
  const adj = (b: number) => (reverse ? blocks[b].preds : blocks[b].succs);
  const pred = (b: number) => (reverse ? blocks[b].succs : blocks[b].preds);
  // Postorder DFS from root, reversed → reverse postorder.
  const postorder: number[] = [];
  const seen = new Set<number>([root]);
  const stack: { b: number; idx: number; nexts: number[] }[] = [{ b: root, idx: 0, nexts: adj(root) }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.idx < top.nexts.length) {
      const n = top.nexts[top.idx++];
      if (!seen.has(n)) { seen.add(n); stack.push({ b: n, idx: 0, nexts: adj(n) }); }
    } else { postorder.push(top.b); stack.pop(); }
  }
  const rpo = postorder.reverse();
  const rpoIndex = new Map(rpo.map((b, i) => [b, i]));
  const idom: (number | null)[] = blocks.map(() => null);
  idom[root] = root;
  const intersect = (x: number, y: number): number => {
    let a = x, b = y;
    while (a !== b) {
      while ((rpoIndex.get(a) ?? 0) > (rpoIndex.get(b) ?? 0)) a = idom[a]!;
      while ((rpoIndex.get(b) ?? 0) > (rpoIndex.get(a) ?? 0)) b = idom[b]!;
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === root) continue;
      let newIdom: number | null = null;
      for (const p of pred(b)) {
        if (idom[p] === null || !rpoIndex.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(p, newIdom);
      }
      if (newIdom !== null && idom[b] !== newIdom) { idom[b] = newIdom; changed = true; }
    }
  }
  const dominates = (a: number, b: number): boolean => {
    let cur: number | null = b;
    let guard = 0;
    while (cur !== null && guard++ <= blocks.length) {
      if (cur === a) return true;
      if (cur === root) return a === root;
      cur = idom[cur]!;
    }
    return false;
  };
  return { idom, dominates };
}

// ---------------------------------------------------------------- SSA + data flow

/** Rename local writes to versions and resolve reads to dominating defs (reads before writes within a node:
 *  `x = x + 1` reads the previous version). Phi nodes are not inserted — see the file header. */
export function convertToSsa(cfg: Cfg, sourceText: string): Ssa {
  const locals = localVariables(sourceText);
  const ssa: Ssa = { defs: [], uses: [] };
  const nextVersion = new Map<string, number>();
  const stack = new Map<string, { version: number; node: number }[]>();
  const children = new Map<number, number[]>();
  const dom = dominatorTree(cfg.blocks, cfg.edges, cfg.entry);
  for (let b = 0; b < cfg.blocks.length; b++) {
    const p = dom.idom[b];
    if (p === null || p === b) continue;
    children.set(p, [...(children.get(p) ?? []), b]);
  }
  const visited = new Set<number>();
  const enter = (bid: number): void => {
    if (visited.has(bid)) return;
    visited.add(bid);
    const pushed: string[] = [];
    for (const nid of cfg.blocks[bid].nodes) {
      const n = cfg.nodes[nid];
      for (const r of n.reads) {
        if (!locals.has(r)) continue;
        const st = stack.get(r) ?? [];
        if (st.length) ssa.uses.push({ node: nid, block: bid, variable: r, versions: st.map((d) => d.version) });
      }
      for (const w of n.writes) {
        if (!locals.has(w)) continue;
        const v = nextVersion.get(w) ?? 0;
        nextVersion.set(w, v + 1);
        stack.set(w, [...(stack.get(w) ?? []), { version: v, node: nid }]);
        ssa.defs.push({ variable: w, version: v, node: nid, block: bid });
        pushed.push(w);
      }
    }
    for (const child of children.get(bid) ?? []) enter(child);
    for (const w of [...new Set(pushed)]) { const st = stack.get(w)!; st.pop(); if (!st.length) stack.delete(w); }
  };
  enter(cfg.entry);
  // Loop-carried dependences: a write of v inside a loop feeds reads of v inside the same loop (next iteration).
  for (const loop of cfg.loops) {
    const inLoop = (nid: number) => loop.blocks.includes(cfg.nodes[nid].block);
    for (const d of ssa.defs) {
      if (!inLoop(d.node) || !locals.has(d.variable)) continue;
      for (const b of loop.blocks) {
        for (const nid of cfg.blocks[b].nodes) {
          const n = cfg.nodes[nid];
          if (n.id === d.node || !n.reads.includes(d.variable)) continue;
          ssa.uses.push({ node: nid, block: b, variable: d.variable, versions: [d.version] });
        }
      }
    }
  }
  return ssa;
}

/** Build def→use edges from the SSA result. */
export function buildDataFlowGraph(ssa: Ssa): DataEdge[] {
  const out: DataEdge[] = [];
  const seen = new Set<string>();
  for (const u of ssa.uses) {
    for (const v of [...new Set(u.versions)]) {
      for (const d of ssa.defs.filter((d) => d.variable === u.variable && d.version === v)) {
        const key = `${d.node}>${u.node}:${u.variable}`;
        if (seen.has(key) || d.node === u.node) continue;
        seen.add(key);
        out.push({ from: d.node, to: u.node, variable: u.variable });
      }
    }
  }
  return out;
}

/** Locals of the fragment: parameters and let/const/var names at any depth (per-function scope). */
function localVariables(sourceText: string): Set<string> {
  const sf = parse("locals.ts", sourceText);
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) out.add(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) out.add(n.name.text);
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- guard edges, loops, assertions

/** Guard edges: condition blocks whose block dominates a node's block that does not post-dominate the condition.
 *  Both edge endpoints are node ids (the guard id is the condition site itself). */
export function extractGuardEdges(cfg: Cfg): GuardEdge[] {
  const dom = dominatorTree(cfg.blocks, cfg.edges, cfg.entry);
  const pdom = dominatorTree(cfg.blocks, cfg.edges, cfg.exit, true);
  const condNodeOf = (b: number): number | null => {
    const blk = cfg.blocks[b];
    if (!blk) return null;
    const cond = blk.nodes.find((id) => cfg.nodes[id].kind === "cond");
    return cond ?? blk.nodes[0] ?? null;
  };
  const out: GuardEdge[] = [];
  const seen = new Set<string>();
  for (const c of cfg.conditionBlocks) {
    const guardNode = condNodeOf(c);
    if (guardNode === null || !cfg.blocks[c]) continue;
    const br = cfg.branches.get(c);
    for (const b of cfg.blocks) {
      if (b.nodes.length === 0 || !dom.dominates(c, b.id) || b.id === c) continue;
      if (pdom.dominates(b.id, c)) continue; // runs unconditionally after the condition: not guarded by it
      const isLoopGuard = cfg.edges.some((e) => e.kind === "back" && e.to === c);
      let kind = "control";
      if (isLoopGuard && b.id !== cfg.exit) kind = "loop";
      else if (br) {
        const onTrue = br.true.some((t) => dom.dominates(t, b.id));
        const onFalse = br.false.some((f) => dom.dominates(f, b.id));
        if (onTrue && !onFalse) kind = "true-branch";
        else if (onFalse && !onTrue) kind = "false-branch";
      }
      for (const nid of b.nodes) {
        if (nid === guardNode) continue;
        const key = `${nid}<${guardNode}:${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ node: nid, guard: guardNode, kind });
      }
    }
  }
  return out;
}

/** Natural loops from back edges: header = back-edge target; body = header + everything reaching the source without passing the header. */
export function extractLoops(cfg: Cfg): LoopInfo[] {
  const dom = dominatorTree(cfg.blocks, cfg.edges, cfg.entry);
  const backEdges = cfg.edges.filter((e) => e.kind === "back" && dom.dominates(e.to, e.from));
  const loops: LoopInfo[] = [];
  for (const be of backEdges) {
    const body = new Set<number>([be.to, be.from]);
    const work = [be.from];
    while (work.length) {
      const b = work.pop()!;
      for (const p of cfg.blocks[b].preds) if (!body.has(p)) { body.add(p); work.push(p); }
    }
    loops.push({ header: be.to, blocks: [...body].sort((a, b) => a - b), depth: 1 });
  }
  for (const l of loops) l.depth = 1 + loops.filter((o) => o !== l && l.blocks.includes(o.header) && o.header !== l.header).length;
  return loops;
}

/** Explicit assertions: calls whose callee name is in the configured list. */
export function extractAssertions(sourceFile: ts.SourceFile): Condition[] {
  const names = new Set<string>(CONCEPT_CONFIG.assertions.names);
  const out: Condition[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && names.has(name) && n.arguments.length) {
        const arg = n.arguments[0];
        out.push({ text: trim(arg.getText()), start: arg.getStart(), end: arg.getEnd(), negated: false, node: null });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return out;
}

// ---------------------------------------------------------------- assembly

/** Structural signature: everything the motif extractors read (node kinds and texts, write operators,
 *  callees, control/data edge shapes, per-node degrees), hashed. Two PDGs with equal signatures yield
 *  equal motifs — that is what makes the Phase 2 memo sound across revisions. */
export function pdgSignature(pdg: Omit<Pdg, "signature">): string {
  const kinds = pdg.nodes.map((n) => n.kind).sort();
  const ctrl = pdg.controlEdges.map((e) => `${e.kind}:${e.from}>${e.to}`).sort();
  const data = pdg.dataEdges.map((e) => `${e.variable}:${e.from}>${e.to}`).sort();
  const guards = pdg.guardEdges.map((e) => `${e.kind}:${e.node}<${e.guard}`).sort();
  const nodeFacts = pdg.nodes.map((n) => `${n.kind}|${n.text}|${n.writes.map((w) => `${w}:${n.writeOps[w] ?? "assign"}`).join(",")}|${n.reads.join(",")}|${n.calls.join(",")}|${n.dynamicProperty ? "D" : ""}${n.closureWrite ? "C" : ""}${n.isAwait ? "A" : ""}${n.catchId !== null ? `K${n.catchId}` : ""}`).sort();
  return sha(JSON.stringify([kinds, ctrl, data, guards, nodeFacts])).slice(0, 24);
}

/** Build the PDG of one entity from its source text. */
export function buildPdg(entity: Entity, sourceText: string): Pdg {
  const sf = parse(entity.file || "entity.ts", sourceText);
  const cfg = buildControlFlowGraph(sf, rootStatement(sf) ?? sf);
  cfg.loops = extractLoops(cfg);
  const ssa = convertToSsa(cfg, sourceText);
  const dataEdges = buildDataFlowGraph(ssa);
  const guardEdges = extractGuardEdges(cfg);
  const assertions = extractAssertions(sf);
  const base: Omit<Pdg, "signature"> = {
    entityId: entity.entityId,
    file: entity.file,
    language: "typescript",
    nodes: cfg.nodes,
    blocks: cfg.blocks.map((b) => ({ ...b, nodes: [...b.nodes], succs: [...b.succs], preds: [...b.preds] })),
    controlEdges: cfg.edges.map((e) => ({ ...e })),
    dataEdges,
    guardEdges,
    loops: cfg.loops.map((l) => ({ ...l, blocks: [...l.blocks] })),
    assertions,
    entryBlock: cfg.entry,
    exitBlock: cfg.exit,
    bodyHash: entity.symbolHash ?? sha(sourceText),
  };
  return { ...base, signature: pdgSignature(base) };
}

function rootStatement(sf: ts.SourceFile): ts.Node | null {
  const stmts = sf.statements.filter((s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s));
  if (stmts.length === 1) return stmts[0];
  return sf;
}

const readCache = new Map<string, Buffer | null>();

/** Build PDGs for every non-file, non-test entity of a revision, reusing `previous` where bodyHash is unchanged. */
export function buildAllPdgs(store: Store, revision: string, repoRoot: string, previous?: PdgIndex): PdgIndex {
  const index: PdgIndex = new Map();
  const access = policyFor(store, repoRoot);
  const byFile = new Map<string, Entity[]>();
  for (const e of store.entities(revision)) {
    if (e.kind === "file" || e.kind === "test") continue;
    if (!isTsFile(e.file) || access.denied(e.file)) continue;
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }
  for (const [file, entities] of byFile) {
    let buf: Buffer | null;
    if (readCache.has(file)) buf = readCache.get(file)!;
    else {
      try { buf = readFileSync(resolve(repoRoot, file)); } catch { buf = null; }
      if (readCache.size > 512) readCache.clear();
      readCache.set(file, buf);
    }
    if (!buf) continue;
    for (const e of entities) {
      const prev = previous?.get(e.entityId);
      if (prev && (e.symbolHash ? e.symbolHash === prev.bodyHash : prev.bodyHash === sha(spanText(buf, e)))) {
        index.set(e.entityId, prev);
        continue;
      }
      const src = spanText(buf, e);
      if (!src.trim()) continue;
      try { index.set(e.entityId, buildPdg(e, src)); } catch { /* a parse failure on one entity never stops the phase */ }
    }
  }
  return index;
}

function spanText(buf: Buffer, e: Entity): string {
  const span = e.spans[0];
  if (!span) return buf.toString("utf8");
  return buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
}

/** Forget the per-process file cache (used between repositories in long runs and by tests). */
export function clearPdgReadCache(): void {
  readCache.clear();
}
