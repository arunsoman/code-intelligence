import { EvidenceCoreBatchSchema, type AnalysisBatch, type EvidenceCoreBatchV1, type Fact, type Relationship } from "@cie/schema";
import { canonicalize, canonDigest, type Canon } from "@cie/canon";
import type { DatabaseSync } from "node:sqlite";
export const EVIDENCE_CORE_PRODUCER_VERSION = "2";
export function evidenceCoreConfig() {
  const mode = process.env.CIE_EVIDENCE_CORE_MODE ?? "off", strict = process.env.CIE_EVIDENCE_CORE_STRICT ?? "0", gates = process.env.CIE_EVIDENCE_CORE_COVERAGE_GATES ?? "0";
  if (!["off","shadow","on"].includes(mode) || !["0","1"].includes(strict) || gates !== "0") throw new Error("EVIDENCE_CORE_CONFIG: invalid flags or coverage gates not implemented");
  return { mode, strict: strict === "1" };
}
export function evidenceCoreIdentity(kind: string, value: Canon): string {
  const name = `cie.evidence-core.${kind}`;
  return `${name}@1:${canonDigest(name,"1",canonicalize(value))}`;
}
/** Cache canonical sort keys per operation, never across mutable batches. */
function sortAssociations<T extends Canon>(rows: T[]): T[] {
  return rows.map(value => ({value,key:Buffer.from(canonicalize(value))}))
    .sort((a,b)=>Buffer.compare(a.key,b.key)).map(row=>row.value);
}
/** Sidecar validation is independent of model output. No sidecar can authorize source access. */
export function validatedCore(batch: AnalysisBatch): EvidenceCoreBatchV1 | undefined {
  const config = evidenceCoreConfig();
  if (config.mode === "off") return undefined;
  if (!batch.evidenceCore) { if (config.strict) throw new Error("EVIDENCE_CORE_REQUIRED"); return undefined; }
  try {
    if (Buffer.byteLength(JSON.stringify(batch.evidenceCore)) > 16 * 1024 * 1024) throw new Error("metadata cap");
    const core = EvidenceCoreBatchSchema.parse(batch.evidenceCore);
    if (core.derivations?.length) throw new Error("derivation rules not registered");
    const entityById = new Map(batch.entities.map(e => [e.entityId,e]));
    const files = new Map(batch.entities.filter(e => e.kind === "file").map(e => [e.file,e]));
    const subjects = new Map<string, Fact | Relationship>([...batch.facts.map(f => [`FACT:${f.id}`,f] as const),...batch.relationships.map(r => [`RELATIONSHIP:${r.id}`,r] as const)]);
    const evidenceByRow = new Map([...subjects].map(([id,row]) => [id,new Map(row.evidence.map(e => [e.id,e]))]));
    const associationsByRun = new Map<string, {subjectKind: "FACT" | "RELATIONSHIP";subjectId:string;evidenceId:string;role:"SUPPORTS" | "CONTEXT" | "CONTRADICTS"}[]>();
    const runs = new Map(core.producerRuns.map(r => [r.id,r]));
    if (runs.size !== core.producerRuns.length || new Set(core.coverage.map(c => c.id)).size !== core.coverage.length) throw new Error("duplicate identities");
    for (const run of runs.values()) {
      if (run.revision !== batch.revision || run.analyzerVersion !== batch.analyzerVersion || run.producerId !== "cie.rust.static" || run.producerVersion !== EVIDENCE_CORE_PRODUCER_VERSION) throw new Error("producer binding");
      if (run.id !== evidenceCoreIdentity("run", [run.producerId,run.producerVersion,run.analyzerVersion,run.scope,run.inputDigest,run.outputDigest])) throw new Error("producer identity");
      const file = run.scope.kind === "FILE" ? run.scope.file : undefined;
      if (!file && run.scope.kind === "REPOSITORY" && run.inputDigest !== evidenceCoreIdentity("input",batch.manifest ?? {})) throw new Error("repository input binding");
      if (file && !files.get(file)?.spans.some(s => s.contentHash === run.inputDigest && s.revision === batch.revision)) throw new Error("input binding");
    }
    for (const coverage of core.coverage) {
      const run = runs.get(coverage.producerRunId);
      if (!run || coverage.revision !== batch.revision || JSON.stringify(coverage.scope) !== JSON.stringify(run.scope) || coverage.status === "COMPLETE" || coverage.domain !== "static.observations" || coverage.analyzedEntityIds !== undefined || coverage.exclusions.join("|") !== "reflection|dynamic dispatch|external dependencies|async delivery|generated or excluded sources" || coverage.unresolved.join("|") !== "No closed-world completeness claim; parser diagnostics remain authoritative") throw new Error("coverage binding");
      if (coverage.id !== evidenceCoreIdentity("coverage",[run.id,coverage.domain])) throw new Error("coverage identity");
    }
    const expected = new Set<string>();
    for (const [kind, rows] of [["FACT",batch.facts],["RELATIONSHIP",batch.relationships]] as const) for (const row of rows) for (const ev of row.evidence) expected.add(JSON.stringify([kind,row.id,ev.id]));
    const actual = new Set<string>();
    for (const link of core.links) {
      const run = runs.get(link.producerRunId), row = subjects.get(`${link.subjectKind}:${link.subjectId}`);
      const ev = evidenceByRow.get(`${link.subjectKind}:${link.subjectId}`)?.get(link.evidenceId);
      const ownerId = row && ("subject" in row ? row.subject : row.from), owner = ownerId ? entityById.get(ownerId) : undefined;
      if (!run || !row || !ev || link.role !== "SUPPORTS" || (run.scope.kind === "FILE" && owner?.file !== run.scope.file) || (run.scope.kind === "REPOSITORY" && owner)) throw new Error("orphan or divergent support link");
      if (ev.location.kind === "CodeLocation") {
        const span = (ev.location as { span: { sourceId: string; revision: string; contentHash: string; startByte: number; endByteExclusive: number } }).span;
        if (!span || span.revision !== batch.revision || span.sourceId !== ev.sourceId || span.startByte < 0 || !Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByteExclusive) || span.endByteExclusive < span.startByte || !files.get(ev.sourceId)?.spans.some(s => s.contentHash === span.contentHash)) throw new Error("evidence source binding");
      }
      const {producerRunId, ...association} = link;
      const group = associationsByRun.get(producerRunId) ?? []; group.push(association); associationsByRun.set(producerRunId,group);
      const key = JSON.stringify([link.subjectKind,link.subjectId,link.evidenceId]);
      if (actual.has(key)) throw new Error("duplicate support link"); actual.add(key);
    }
    if (actual.size !== expected.size || [...expected].some(k => !actual.has(k))) throw new Error("missing support link");
    for (const run of runs.values()) {
      const associations = associationsByRun.get(run.id) ?? [];
      // Bytewise order, independent of host locale.
      const sorted = sortAssociations(associations);
      const file = run.scope.kind === "FILE" ? run.scope.file : "";
      if (run.outputDigest !== evidenceCoreIdentity("output", [batch.manifest?.[file] ?? null,sorted])) throw new Error("output binding");
    }
    return core;
  } catch {
    if (config.strict) throw new Error("EVIDENCE_CORE_INVALID: sidecar rejected");
    batch.diagnostics.push({ code: "EVIDENCE_CORE_REJECTED", message: "Invalid optional metadata discarded; coverage remains unknown", relatedEntityIds: [], retryable: false });
    return undefined;
  }
}
export function insertCore(db: DatabaseSync, revision: string, core: EvidenceCoreBatchV1 | undefined, replace = true): void {
  if (!core) return;
  const runById = new Map(core.producerRuns.map(r => [r.id,r]));
  const grouped = new Map<string, {subjectKind:string;subjectId:string;evidenceId:string;role:string}[]>();
  for (const {producerRunId,...association} of core.links) { const rows=grouped.get(producerRunId)??[];rows.push(association);grouped.set(producerRunId,rows); }
  const manifestQuery=db.prepare("select digest from rev_files where revision=? and file=?");
  const fileQuery=db.prepare("select json from entities where revision=? and kind='file' and file=?");
  for (const r of core.producerRuns) {
    const file=r.scope.kind === "FILE" ? r.scope.file : "";
    const digest=(manifestQuery.get(revision,file) as {digest:string}|undefined)?.digest??null;
    const associations=grouped.get(r.id)??[];
    const sorted = sortAssociations(associations);
    if(r.outputDigest!==evidenceCoreIdentity("output",[digest,sorted]))throw new Error("EVIDENCE_CORE_PERSISTED_BINDING");
    if(r.scope.kind === "REPOSITORY") {
      const manifest=Object.fromEntries((db.prepare("select file,digest from rev_files where revision=?").all(revision) as {file:string;digest:string}[]).map(row=>[row.file,row.digest]));
      if(r.inputDigest!==evidenceCoreIdentity("input",manifest))throw new Error("EVIDENCE_CORE_PERSISTED_BINDING");
    }
    if(r.scope.kind === "FILE") {
      const row=fileQuery.get(revision,file) as {json:string}|undefined;
      if(!row || !JSON.parse(row.json).spans.some((s:{contentHash:string;revision:string})=>s.contentHash===r.inputDigest && s.revision===revision))throw new Error("EVIDENCE_CORE_PERSISTED_BINDING");
    }
  }
  if (replace) db.prepare("delete from evidence_core_producer_runs where revision=?").run(revision);
  const run = db.prepare("insert into evidence_core_producer_runs values(?,?,?,?,?)"), link = db.prepare("insert into evidence_core_links values(?,?,?,?,?,?)"), coverage = db.prepare("insert into evidence_core_coverage values(?,?,?,?,?,?,?)");
  for (const r of core.producerRuns) run.run(revision,r.id,r.producerId,r.scope.kind === "FILE" ? r.scope.file : null,JSON.stringify(r));
  const rowQueries = { FACT:db.prepare("select ev,file from facts where revision=? and id=?"), RELATIONSHIP:db.prepare("select ev,file from relationships where revision=? and id=?") };
  const evidenceQuery = db.prepare("select 1 from evidence where revision=? and id=?");
  const rowCache = new Map<string, Set<string>>(), evidenceCache = new Set<string>();
  for (const l of core.links) {
    const key = `${l.subjectKind}:${l.subjectId}`;
    if (!rowCache.has(key)) {
      const stored = rowQueries[l.subjectKind].get(revision,l.subjectId) as {ev:string;file:string} | undefined;
      const scope=runById.get(l.producerRunId)!.scope;
      if (!stored || (scope.kind === "FILE" ? scope.file !== stored.file : stored.file !== "")) throw new Error("EVIDENCE_CORE_PERSISTED_BINDING");
      rowCache.set(key,new Set(JSON.parse(stored.ev)));
    }
    if (!evidenceCache.has(l.evidenceId)) {
      if (!evidenceQuery.get(revision,l.evidenceId)) throw new Error("EVIDENCE_CORE_PERSISTED_BINDING");
      evidenceCache.add(l.evidenceId);
    }
    if (!rowCache.get(key)!.has(l.evidenceId)) throw new Error("EVIDENCE_CORE_PERSISTED_BINDING");
    link.run(revision,l.subjectKind,l.subjectId,l.evidenceId,l.producerRunId,l.role);
  }
  for (const c of core.coverage) coverage.run(revision,c.id,c.producerRunId,c.domain,c.scope.kind === "FILE" ? c.scope.file : null,c.status,JSON.stringify(c));
}

/** Rebind only unchanged FILE scopes. Repository scopes must be re-emitted by the worker. */
export function copyCoreDelta(db: DatabaseSync, old: string, revision: string): void {
  db.prepare(`insert into evidence_core_producer_runs select ?,id,producer_id,file,json_set(json,'$.revision',?) from evidence_core_producer_runs where revision=? and file is not null and file not in (select file from _delta_files)`).run(revision,revision,old);
  db.prepare(`insert into evidence_core_coverage select ?,c.id,c.producer_run_id,c.domain,c.file,c.status,json_set(c.json,'$.revision',?) from evidence_core_coverage c join evidence_core_producer_runs r on r.revision=? and r.id=c.producer_run_id where c.revision=?`).run(revision,revision,revision,old);
  for(const [kind,table] of [["FACT","facts"],["RELATIONSHIP","relationships"]]) db.prepare(`insert into evidence_core_links select ?,l.subject_kind,l.subject_id,l.evidence_id,l.producer_run_id,l.role from evidence_core_links l join evidence_core_producer_runs p on p.revision=? and p.id=l.producer_run_id join ${table} r on r.revision=? and r.id=l.subject_id join evidence e on e.revision=? and e.id=l.evidence_id where l.revision=? and l.subject_kind=? and exists(select 1 from json_each(r.ev) where value=l.evidence_id)`).run(revision,revision,revision,revision,old,kind);
  const expected=db.prepare(`select count(*) n from evidence_core_links l join evidence_core_producer_runs p on p.revision=? and p.id=l.producer_run_id where l.revision=?`).get(revision,old) as {n:number};
  const actual=db.prepare("select count(*) n from evidence_core_links where revision=?").get(revision) as {n:number};
  if(expected.n!==actual.n)throw new Error("EVIDENCE_CORE_DELTA_ORPHAN");
}

/** Bound the whole revision, including provenance copied from its base. */
export function enforceCoreRevisionLimits(db: DatabaseSync, revision: string): void {
  let bytes = 0;
  for (const table of ["evidence_core_producer_runs","evidence_core_coverage","evidence_core_links"]) {
    const row = db.prepare(`select count(*) n, coalesce(sum(length(cast(${table === "evidence_core_links" ? "json_array(subject_kind,subject_id,evidence_id,producer_run_id,role)" : "json"} as blob))),0) bytes from ${table} where revision=?`).get(revision) as {n:number;bytes:number};
    if(row.n > 100000) throw new Error("EVIDENCE_CORE_RESOURCE_LIMIT: revision row cap");
    bytes += row.bytes;
  }
  if(bytes > 16 * 1024 * 1024) throw new Error("EVIDENCE_CORE_RESOURCE_LIMIT: revision byte cap");
}
