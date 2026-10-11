import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import type { Entity, EvidenceRef, InvestigationBudget, InvestigationGap, Relationship, ResolvedEvidence } from "@cie/schema";

/** No filesystem/compiler default host: all source comes through the caller's access/freshness resolver. */
export function sourceRecovery(input: {
  revision: string; roots: Entity[]; depths?: Map<string,number>; entities: Entity[]; budget: InvestigationBudget; until: number;
  resolve: (ev: EvidenceRef) => ResolvedEvidence; observedAt: string; accessScopeId: string;
}) {
  const files = new Map<string, Entity[]>();
  for (const e of input.entities) files.set(e.file, [...(files.get(e.file) ?? []), e]);
  const loaded = new Map<string, ts.SourceFile>();
  const evidenceByFile = new Map<string, EvidenceRef>();
  const gaps: InvestigationGap[] = [];
  let bytes = 0, unresolved = 0, limited = false;
  const virtual = (file: string) => `/repo/${file}`;
  const relative = (file: string) => file.replace(/^\/repo\//, "");
  const load = (path: string): ts.SourceFile | undefined => {
    const file = relative(path);
    if (loaded.has(file)) return loaded.get(file);
    const entities = files.get(file);
    if (!entities) return undefined;
    if (!/\.[cm]?[jt]sx?$/.test(file)) return undefined;
    if (performance.now() >= input.until || loaded.size >= input.budget.maxSourceFiles) { limited = true; return undefined; }
    const spans = entities.flatMap(e => e.spans);
    const span = spans[0];
    const end = Math.max(0, ...spans.map(s => s.endByteExclusive));
    if (!span || !end) return undefined;
    if (bytes + end > input.budget.maxSourceBytes) { limited = true; return undefined; }
    const ev: EvidenceRef = { id: `investigation-source:${createHash("sha256").update(`${input.revision}|${file}|${span.contentHash}`).digest("hex").slice(0,20)}`, sourceId: file,
      location: { kind: "CodeLocation", span: { ...span, startByte: 0, endByteExclusive: end } }, class: "STATIC_PARSED", state: "CURRENT", observedAt: input.observedAt, accessScopeId: input.accessScopeId };
    let text = "";
    // resolveEvidence caps excerpts at 4000 characters. Read bounded byte chunks to avoid parsing a truncated function.
    for (let offset = 0; offset < end; offset += 3000) {
      if (performance.now() >= input.until) { limited = true; return undefined; }
      const part = input.resolve({ ...ev, location: { kind: "CodeLocation", span: { ...span, startByte: offset, endByteExclusive: Math.min(end, offset + 3000) } } });
      if (part.state !== "CURRENT") {
        gaps.push({ code: part.state === "STALE" ? "SOURCE_STALE" : "SOURCE_UNAVAILABLE", message: `Current source could not be inspected for ${file}; refresh the index before tracing this file.` });
        return undefined;
      }
      text += part.snippet;
    }
    // Byte boundaries can split UTF-8. Reject rather than synthesize a relationship from corrupted text.
    if (text.includes("\ufffd")) { gaps.push({ code: "SOURCE_UNAVAILABLE", message: `Source chunk boundary needs a byte-preserving reader for ${file}.` }); return undefined; }
    bytes += end;
    const sf = ts.createSourceFile(virtual(file), text, ts.ScriptTarget.Latest, true);
    if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
      gaps.push({ code: "SOURCE_UNAVAILABLE", message: `Source parsing failed for ${file}.` }); return undefined;
    }
    loaded.set(file, sf); evidenceByFile.set(file, ev); return sf;
  };
  const host: ts.CompilerHost = {
    getSourceFile: file => load(file), getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "/repo",
    getDirectories: () => [], fileExists: file => files.has(relative(file)), readFile: file => load(file)?.text,
    getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    resolveModuleNames: (names, containing) => names.map(name => {
      if (!name.startsWith(".")) return undefined;
      const base = posix.normalize(posix.join(posix.dirname(relative(containing)), name));
      const stem = base.replace(/\.[cm]?js$/, "");
      const candidates = [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"].map(ext => stem + ext), stem + "/index.ts", stem + "/index.js"];
      const file = candidates.find(f => files.has(f));
      return file ? { resolvedFileName: virtual(file), extension: file.endsWith("tsx") ? ts.Extension.Tsx : file.endsWith("js") ? ts.Extension.Js : ts.Extension.Ts } : undefined;
    }),
  };
  const program = ts.createProgram(input.roots.filter(e => /\.[cm]?[jt]sx?$/.test(e.file)).map(e => virtual(e.file)), { noLib: true, allowJs: true, target: ts.ScriptTarget.Latest }, host);
  const checker = program.getTypeChecker();
  const mapped = (declaration: ts.Declaration): Entity | undefined => {
    const sf = declaration.getSourceFile(), file = relative(sf.fileName);
    const named = (declaration as ts.NamedDeclaration).name;
    if (!named || !ts.isIdentifier(named)) return undefined;
    const body = ts.isVariableDeclaration(declaration) && declaration.initializer ? declaration.initializer : declaration;
    const start = Buffer.byteLength(sf.text.slice(0, ts.isVariableDeclaration(declaration) ? body.getStart(sf) : named.getStart(sf))), end = Buffer.byteLength(sf.text.slice(0, body.end));
    const candidates = (files.get(file) ?? []).filter(e => ["function", "method"].includes(e.kind) && e.name.split(/[.#]/).at(-1) === named.text && e.spans.some(s => s.startByte <= start && s.endByteExclusive >= end));
    candidates.sort((a,b) => (a.spans[0]!.endByteExclusive-a.spans[0]!.startByte) - (b.spans[0]!.endByteExclusive-b.spans[0]!.startByte));
    return candidates[0];
  };
  const mutable = new Set<ts.Symbol>();
  const scanWrites = (node: ts.Node) => {
    if (performance.now() >= input.until) { limited = true; return; }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
      const symbol = checker.getSymbolAtLocation(node.left); if (symbol) mutable.add(symbol);
    }
    ts.forEachChild(node,scanWrites);
  };
  for (const sf of program.getSourceFiles()) scanWrites(sf);
  const relationships: Relationship[] = [];
  const visited = new Set<string>();
  const pending = input.roots.map(e => ({entity: e, depth: input.depths?.get(e.entityId) ?? 0}));
  while (pending.length && performance.now() < input.until && visited.size < input.budget.maxEntities) {
    const { entity, depth } = pending.shift()!;
    if (visited.has(entity.entityId)) continue;
    visited.add(entity.entityId);
    if (!/\.[cm]?[jt]sx?$/.test(entity.file)) { gaps.push({code:"UNSUPPORTED_LANGUAGE",entityId:entity.entityId,message:"Source recovery currently supports TypeScript and JavaScript; indexed relationships remain available for other languages."}); continue; }
    const sf = program.getSourceFile(virtual(entity.file));
    if (!sf) continue;
    const visit = (node: ts.Node) => {
      if (performance.now() >= input.until) { limited = true; return; }
      if (ts.isCallExpression(node)) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        const ownerDeclaration = owner && (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) && ts.isVariableDeclaration(owner.parent) ? owner.parent : owner;
        if (!ownerDeclaration || !(ts.isFunctionDeclaration(ownerDeclaration) || ts.isMethodDeclaration(ownerDeclaration) || ts.isVariableDeclaration(ownerDeclaration)) || mapped(ownerDeclaration as ts.Declaration)?.entityId !== entity.entityId) return;
        // Only immutable direct identifier bindings. Object dispatch, callbacks and mutable aliases stay unknown.
        let symbol = ts.isIdentifier(node.expression) ? checker.getSymbolAtLocation(node.expression) : undefined;
        if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const declarations = symbol?.declarations ?? [];
        const candidate = declarations.length === 1 ? declarations[0] : undefined;
        const immutableFunction = candidate && (ts.isFunctionDeclaration(candidate) || ts.isVariableDeclaration(candidate) && ts.isVariableDeclarationList(candidate.parent) && !!(candidate.parent.flags & ts.NodeFlags.Const) && candidate.initializer && (ts.isArrowFunction(candidate.initializer) || ts.isFunctionExpression(candidate.initializer)));
        const declaration = !node.questionDotToken && symbol && !mutable.has(symbol) && immutableFunction ? candidate : undefined;
        const target = declaration ? mapped(declaration) : undefined;
        if (target && evidenceByFile.has(target.file)) {
          const ev = evidenceByFile.get(entity.file)!;
          const callSpan = { ...entity.spans[0]!, startByte: Buffer.byteLength(sf.text.slice(0,node.getStart(sf))), endByteExclusive: Buffer.byteLength(sf.text.slice(0,node.end)) };
          const evidence = { ...ev, id: `${ev.id}:${callSpan.startByte}`, location: {kind:"CodeLocation",span:callSpan} };
          relationships.push({id:`recovered-call:${createHash("sha256").update(`${input.revision}|${entity.entityId}|${target.entityId}|${callSpan.startByte}`).digest("hex").slice(0,20)}`,from:entity.entityId,to:target.entityId,kind:"calls",resolution:"STATIC_RESOLVED",evidence:[evidence],label:"Source-resolved possible call; execution order not established"});
          if (depth < input.budget.maxDepth) pending.push({entity:target,depth:depth+1});
          else if (!visited.has(target.entityId)) limited = true;
        } else {
          unresolved++;
          if (gaps.filter(g=>g.code==="CALL_UNRESOLVED").length < 12) gaps.push({code:"CALL_UNRESOLVED",entityId:entity.entityId,message:`A call site in ${entity.name} could not be resolved by bounded direct-binding analysis.`});
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(sf);
  }
  if (pending.length) limited = true;
  if (limited) gaps.push({code:"BUDGET_EXHAUSTED",message:"Source tracing reached its time, depth, entity, file or byte budget; unexplored paths remain."});
  return {relationships,gaps,sourceFiles:loaded.size,sourceBytes:bytes,unresolved};
}
