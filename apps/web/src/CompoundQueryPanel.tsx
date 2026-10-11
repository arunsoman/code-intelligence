import type { CompoundQueryResult } from '@cie/schema';

const label = {present:'Supported',absent:'Excluded',unknown:'Unknown'};
export function CompoundQueryPanel({result,onEvidence}:{result:CompoundQueryResult;onEvidence:(row:CompoundQueryResult['rows'][number])=>void}) {
  const supported=result.rows.filter(r=>r.result==='present').length,unknown=result.rows.filter(r=>r.result==='unknown').length;
  return <details className="compound-query-panel" open>
    <summary>Static call comparison · {supported} supported · {unknown} unknown</summary>
    <div className="compound-query-results">
      <p className="muted small">{result.plan.operation==='difference' ? `${result.plan.left.label} minus ${result.plan.right.label}` : `${result.plan.left.label} ${result.plan.operation==='intersection'?'and':'or'} ${result.plan.right.label}`}. Unknown means the evidence does not establish membership or exclusion.</p>
      <table aria-label="Compound query membership">
        <caption className="sr">Direct static call comparison. {result.plan.direction==='outgoing'?'Called functions':'Callers'}.</caption>
        <thead><tr><th scope="col">Element</th><th scope="col">{result.plan.left.label}</th><th scope="col">{result.plan.right.label}</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead>
        <tbody>{result.rows.map(row=><tr key={row.entityId}><th scope="row" title={row.entityId}>{row.label}</th><td>{label[row.left]}</td><td>{label[row.right]}</td><td>{label[row.result]}</td><td>{row.evidenceIds.length>0?<button className="secondary small" aria-label={`Inspect call evidence for ${row.label}`} onClick={()=>onEvidence(row)}>Inspect</button>:'No current call evidence'}</td></tr>)}</tbody>
      </table>
      {!result.rows.length&&<p>No direct call candidates were established in this collection.</p>}
      <p className="muted small">The chart uses supported matches and the bound operands. Unknown candidates remain in this comparison.</p>
    </div>
  </details>;
}
