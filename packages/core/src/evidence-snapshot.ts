import { createHash } from 'node:crypto';
import type { CanonicalFinding, EvidenceBundle, EvidenceProjection, EvidenceSet, EvidenceSetOperation, EvidenceSnapshot, Membership } from '@cie/schema';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = <T extends { id: string }>(rows: T[]) => [...rows].sort((a,b) => a.id.localeCompare(b.id));
export function collectSnapshot(question: string, input: EvidenceBundle): EvidenceSnapshot {
  const bundle = structuredClone(input);
  // Timing and presentation notes are not evidence identity. Content and source hashes are.
  const identity = { revision: bundle.revision, question,
    entities: [...bundle.entities].sort((a,b) => a.entityId.localeCompare(b.entityId)),
    relationships: sorted(bundle.relationships), facts: sorted(bundle.facts), evidence: sorted(bundle.evidence),
    binding: bundle.investigation?.binding, directCallCoverage: bundle.investigation?.directCallCoverage, gaps: bundle.investigation?.gaps, unresolved: bundle.unresolved };
  const id = `snapshot:${digest(identity)}`;
  const current = new Set(bundle.evidence.filter(e => e.state === 'CURRENT').map(e => e.id));
  const findings: CanonicalFinding[] = [
    ...sorted(bundle.relationships).filter(r => r.resolution !== 'UNRESOLVED').map(r => ({ id: `finding:${digest([bundle.revision, 'relationship', r.id])}`, kind: 'relationship' as const,
      subjectIds: [r.from,r.to], evidenceIds: r.evidence.map(e => e.id), assertion: `${r.from} ${r.kind} ${r.to}`, validation: 'static-evidence' as const })),
    ...sorted(bundle.facts).filter(f => f.resolution !== 'UNRESOLVED' && !['source_excerpt','concept_guidance'].includes(f.predicate)).map(f => ({ id: `finding:${digest([bundle.revision, 'fact', f.id])}`, kind: 'fact' as const,
      subjectIds: [f.subject], evidenceIds: f.evidence.map(e => e.id), assertion: `${f.subject}: ${f.predicate} ${JSON.stringify(f.object)}`, validation: 'static-evidence' as const })),
  ].filter(f => f.evidenceIds.length > 0 && f.evidenceIds.every(id => current.has(id)));
  return { version: 'evidence-snapshot.v1', id, revision: bundle.revision, question, bundle, findings,
    coverage: { scope: 'bounded-static', exhaustive: false, gaps: [...new Set([...bundle.unresolved, ...(bundle.investigation?.gaps.map(g => g.message) ?? []), 'Collection is bounded; missing membership remains unknown.'])] } };
}
export function projectionOf(snapshot: EvidenceSnapshot, bundle: EvidenceBundle): EvidenceProjection {
  if (snapshot.revision !== bundle.revision) throw new Error('Cannot project evidence across revisions');
  const entities = new Set(bundle.entities.map(e => e.entityId));
  const relationships = new Set(bundle.relationships.map(e => e.id));
  const facts = new Set(bundle.facts.map(e => e.id));
  return { snapshotId: snapshot.id,
    omittedEntityIds: snapshot.bundle.entities.map(e => e.entityId).filter(id => !entities.has(id)).sort(),
    omittedRelationshipIds: snapshot.bundle.relationships.map(e => e.id).filter(id => !relationships.has(id)).sort(),
    // Changed/shortened facts also count as omitted detail.
    omittedFactIds: snapshot.bundle.facts.filter(f => !facts.has(f.id) || digest(f) !== digest(bundle.facts.find(p => p.id === f.id))).map(f => f.id).sort() };
}
export function combineEvidenceSets(left: EvidenceSet, right: EvidenceSet, operation: EvidenceSetOperation): EvidenceSet {
  if (left.snapshotId !== right.snapshotId) throw new Error('Set operands must use the same evidence snapshot');
  const members: Record<string, Membership> = Object.create(null);
  for (const id of [...new Set([...Object.keys(left.members), ...Object.keys(right.members)])].sort()) {
    const a = left.members[id] ?? 'unknown', b = right.members[id] ?? 'unknown';
    members[id] = operation === 'union' ? (a === 'present' || b === 'present' ? 'present' : a === 'absent' && b === 'absent' ? 'absent' : 'unknown')
      : operation === 'intersection' ? (a === 'absent' || b === 'absent' ? 'absent' : a === 'present' && b === 'present' ? 'present' : 'unknown')
      : a === 'absent' || b === 'present' ? 'absent' : a === 'present' && b === 'absent' ? 'present' : 'unknown';
  }
  return { snapshotId: left.snapshotId, members };
}

/** Evaluate nested query algebra over one collection, without querying or changing evidence. */
export function evaluateEvidenceSet(snapshot: EvidenceSnapshot, expression: import('@cie/schema').EvidenceSetExpression): EvidenceSet {
  const universe = new Set(snapshot.bundle.entities.map(e => e.entityId));
  let remaining = 128;
  const evaluate = (expr: import('@cie/schema').EvidenceSetExpression): EvidenceSet => {
    if (--remaining < 0) throw new Error('Evidence set expression exceeds 128 nodes');
    if (expr.kind === 'operation') return combineEvidenceSets(evaluate(expr.left), evaluate(expr.right), expr.operation);
    const members: Record<string, Membership> = Object.create(null);
    if (expr.kind === 'members') {
      for (const id of expr.entityIds) members[id] = universe.has(id) ? 'present' : 'unknown';
    } else {
      const subjects = new Set(expr.subjectIds.filter(id => universe.has(id)));
      const current = new Set(snapshot.bundle.evidence.filter(e => e.state === 'CURRENT').map(e => e.id));
      if (expr.relationshipKind === 'calls' && expr.direction === 'outgoing' && subjects.size === expr.subjectIds.length && subjects.size > 0) {
        const certificates = (snapshot.bundle.investigation?.revision === snapshot.revision ? snapshot.bundle.investigation.directCallCoverage ?? [] : [])
          .filter(c => subjects.has(c.entityId) && c.targetIds.every(id=>universe.has(id)) && !snapshot.bundle.relationships.some(r=>r.from===c.entityId && r.kind==='calls' && (r.resolution==='UNRESOLVED' || !c.targetIds.includes(r.to))) && c.evidence.length > 0 && c.evidence.every(e => current.has(e.id) && e.state === 'CURRENT' && ['STATIC_PARSED','STATIC_RESOLVED'].includes(e.class)));
        if ([...subjects].every(id => certificates.some(c => c.entityId === id))) {
          for (const id of universe) members[id] = certificates.some(c => c.targetIds.includes(id)) ? 'present' : 'absent';
        }
      }
      for (const r of snapshot.bundle.relationships) {
        if (r.kind !== expr.relationshipKind || r.resolution === 'UNRESOLVED' || !r.evidence.length || !r.evidence.every(e => current.has(e.id))) continue;
        const source = expr.direction === 'outgoing' ? r.from : r.to;
        const target = expr.direction === 'outgoing' ? r.to : r.from;
        if (subjects.has(source) && universe.has(target)) members[target] = 'present';
      }
    }
    return { snapshotId: snapshot.id, members };
  };
  return evaluate(expression);
}
