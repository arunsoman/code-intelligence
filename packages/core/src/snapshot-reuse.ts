import type { EvidenceRef, EvidenceSnapshot, ResolvedEvidence, SourceSpan } from '@cie/schema';
import type { AccessPolicy } from './access.ts';
import type { RevisionRow, Store } from './store.ts';

export function validateSnapshotReuse(store: Store, snapshot: EvidenceSnapshot, rev: RevisionRow, question: string, access: AccessPolicy,
  resolve: (ev: EvidenceRef) => ResolvedEvidence): 'revision' | 'question' | 'access' | 'stale' | null {
  if(snapshot.revision!==rev.id || snapshot.bundle.revision!==rev.id)return 'revision';
  if(snapshot.question!==question)return 'question';
  if(store.isRevoked(rev.repoRoot))return 'access';
  const files=new Map(snapshot.bundle.entities.map(e=>[e.entityId,e.file]));
  if(snapshot.bundle.entities.some(e=>access.denied(e.file)||access.deniedEntity(e.entityId,id=>files.get(id))))return 'access';
  const checked=new Set<string>();
  const check=(ev:EvidenceRef) => {
    const span=ev.location.kind==='CodeLocation'?(ev.location as {span?:SourceSpan}).span:undefined;
    if(!span)return true;
    const key=`${span.sourceId}|${span.contentHash}`;
    if(checked.has(key))return true;
    checked.add(key);
    try { return resolve(ev).state==='CURRENT'; } catch { return false; }
  };
  // Validate all collected source files, including declarations omitted from the last prompt.
  for(const entity of snapshot.bundle.entities)for(const span of entity.spans){
    const ev:EvidenceRef={id:`reuse:${span.sourceId}`,sourceId:entity.file,location:{kind:'CodeLocation',span},class:'STATIC_PARSED',
      observedAt:rev.createdAt,accessScopeId:rev.repoRoot,state:'CURRENT'};
    if(!check(ev))return 'stale';
  }
  for(const ev of snapshot.bundle.evidence)if(ev.state==='CURRENT' && !check(ev))return 'stale';
  return null;
}
