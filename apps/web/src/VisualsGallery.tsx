import { useEffect, useState } from "react";
import { call } from "./api.ts";
import { Loading } from "./Skeleton.tsx";
import { Modal } from "./Modal.tsx";

export interface CatalogEntry { code: string; formId: string; name: string; blurb: string; example: string; needs: string[]; available: boolean; reason?: string }
interface Props { revision?: string; onClose: () => void; onShow: (entry: CatalogEntry, question: string) => void }

export const SYSTEM_CHARTS: Pick<CatalogEntry, "code" | "formId" | "name" | "blurb" | "example" | "needs">[] = [
  // ── Already-mapped chart types ──────────────────────────────────────────────────────
  // S1 covers: C4 container diagram, UML component diagram, UML deployment diagram, hexagonal/ports-and-adapters.
  { code: "S1", formId: "GeneratedChart", name: "C4 container / component architecture", blurb: "Show the main components and who calls what, including the Redis and MySQL boundaries when they are visible in the indexed code. Also covers UML component, deployment and hexagonal port-and-adapter layouts.", example: "Build a C4 container-style architecture diagram for the reserve fast path. Show who calls what and distinguish Redis from MySQL using repository evidence.", needs: [] },
  // S2 covers: sequence diagram, swimlane flowchart, UML activity diagram, control flow graph, interaction overview.
  { code: "S2", formId: "TransactionJourney", name: "Reserve fast-path sequence / swimlane", blurb: "Follow reserve through its callers and callees, with swim lanes, conditional branches, transaction markers and failure exits. Also serves as a UML activity diagram or control-flow graph for any single operation.", example: "Draw the reserve fast path as a sequence diagram from request through Redis and MySQL. Include decision points and failure branches supported by the code.", needs: [] },
  // S3 covers: state machine, timing diagram, Petri net, state transition table.
  { code: "S3", formId: "GeneratedChart", name: "BatchId lifecycle state machine", blurb: "Map reserve, post, rollback and idempotent repeats from observed code paths; missing transitions are called out as gaps. Also serves as a timing diagram or Petri net for the same lifecycle.", example: "Draw the batchId lifecycle as a state machine: reserve → post or rollback, including idempotent repeats. Use only states and transitions evidenced in the code, and list gaps.", needs: [] },
  // S4 covers: ledger ER sketch, double-entry INSERT IGNORE specifics.
  { code: "S4", formId: "GeneratedChart", name: "Ledger and entry relationships", blurb: "Sketch the double-entry writes and the INSERT IGNORE and batchId + \"_0\" behavior where the source supports them.", example: "Create an ER-style ledger sketch for double-entry writes, INSERT IGNORE behavior, and batchId with the \"_0\" suffix. Ground each table or operation in repository evidence and note gaps.", needs: [] },
  // S5 covers: test traceability matrix, test-guarantee matrix.
  { code: "S5", formId: "TestConfidence", name: "Test-guarantee matrix", blurb: "Map tests to behaviors and named invariants. Code reach and test names are signals; they do not alone prove an invariant.", example: "Which tests support each reserve and ledger invariant? Separate tests that only reach code from tests whose names indicate an assertion, and show untested gaps.", needs: ["tests"] },

  // ── Genuinely new chart types ───────────────────────────────────────────────────────
  // S6: Use Case Diagram — actors + use cases. Nothing in V1-V19 or S1-S5 shows actor/use-case topology.
  { code: "S6", formId: "GeneratedChart", name: "Use case diagram", blurb: "Actors (callers, admins, external systems) and the use cases they trigger, grounded in the entry points and guard checks visible in the code. Missing actors and undeclared relationships are listed as gaps.", example: "Draw a use case diagram for the bookkeeping component. Show each caller role and the operations (reserve, post, rollback, audit) they can invoke, based on entry-point and authorisation evidence in the code.", needs: [] },
  // S7: BPMN — process flow with explicit gateway shapes (XOR/AND) and end events. Distinct from TransactionJourney's call-order lanes.
  { code: "S7", formId: "GeneratedChart", name: "BPMN process diagram", blurb: "Business-process view: start/end events, tasks, XOR gateways and compensation boundaries, arranged as a BPMN-style flow grounded in indexed control-flow and error-handling evidence.", example: "Draw a BPMN process diagram for the reserve → post / rollback flow. Show start and end events, decision gateways for provider response and DB sync, and the compensation boundary around cancelFast. Use only evidence from the indexed code.", needs: [] },
  // S8: Event Storming / Event Modeling — commands, domain events, aggregates on a timeline. No existing form shows this framing.
  { code: "S8", formId: "GeneratedChart", name: "Event storming / event modeling", blurb: "Commands, domain events and read models arranged on a timeline. Commands are derived from public entry points, events from emitted topics and state transitions, aggregates from the entities that own them.", example: "Build an event storming board for the bookkeeping component. Place commands (Reserve, Post, Rollback), domain events (FundsReserved, TransactionPosted, LedgerEntryWritten, ReservationRolledBack) and the aggregates that own them on a timeline, grounded in indexed topics and state-transition evidence.", needs: [] },
  // S9: Generic ER Diagram — all persisted tables/entities and their FK relationships. S4 is ledger-specific; this is repo-wide.
  { code: "S9", formId: "GeneratedChart", name: "Entity-relationship (ER) diagram", blurb: "All persisted tables, their key columns and foreign-key relationships as an ER sketch. Each table and relationship is traced to indexed schema or write-fact evidence; inferred relationships are shown dashed.", example: "Draw an ER diagram for all persisted state in this repository: tables, primary keys, foreign keys and the relationships between them. Distinguish schema-evidenced relationships (solid) from inferred ones (dashed) and list gaps.", needs: [] },
  // S10: Data Flow Diagram — shows data flowing between processes, stores and external entities. Distinct from V5 DataLineage which centres on one field.
  { code: "S10", formId: "GeneratedChart", name: "Data flow diagram (DFD)", blurb: "Data flows between processes, data stores and external entities across the whole reserve/post/rollback pipeline — showing what data moves, not which code calls which code. Complements V5 DataLineage which centres on one field.", example: "Draw a level-1 data flow diagram for the bookkeeping component. Show external entities (caller, provider), processes (validate, reserve, persist, post ledger), data stores (Redis, transaction_state, ledger) and the data flows between them, grounded in indexed read/write facts.", needs: [] },
  // S11: Decision Table — guard conditions × outcomes. No canvas form shows tabular guard logic; GeneratedChart renders it as a grid/matrix of nodes.
  { code: "S11", formId: "GeneratedChart", name: "Decision table", blurb: "Guard conditions (state exists, balance sufficient, DB sync result) mapped to outcomes (return existing, throw, compensate, persist). Each row is grounded in a branch condition visible in the indexed control-flow.", example: "Build a decision table for the reserve operation. Rows are combinations of: state-already-exists, balance-sufficient, DB-sync-succeeded. Columns are the outcome actions. Cite the code branch that produces each outcome and mark any combination not evidenced in the code as a gap.", needs: [] },
  // S12: Saga / Compensation Graph — happy path + compensation steps as a graph. V3 shows failure sites; this shows the compensation design.
  { code: "S12", formId: "GeneratedChart", name: "Saga / compensation graph", blurb: "The forward steps (reserve → post) and their compensation counterparts (rollback, cancelFast) laid out as a saga graph. Each compensation edge is traced to the code that implements it; missing compensations are flagged as gaps.", example: "Draw a saga compensation graph for the reserve → post → ledger flow. Show each forward step alongside its compensation action (rollback, cancelFast), the trigger condition (DB sync failure, provider failure), and cite the code evidence. Mark any forward step that has no visible compensation as a gap.", needs: [] },
  // S13: Outbox Pattern Diagram — service → outbox table → poller → downstream. No existing form shows this infrastructure topology explicitly.
  { code: "S13", formId: "GeneratedChart", name: "Outbox pattern topology", blurb: "The transactional outbox: which service writes to it, which poller reads from it, and which downstream targets (provider, ledger) are driven by it — grounded in indexed write-to-outbox and publish-from-outbox evidence.", example: "Draw the outbox pattern topology for the bookkeeping service. Show the service writing to the outbox table in the same transaction as state changes, the outbox poller, and the downstream targets it drives (provider callback, ledger writer). Cite the evidence for each step and list what could not be confirmed from the indexed code.", needs: [] },
  // S14: Idempotency Matrix — operation × duplicate-call scenario × result. V12 matrix is tests×behaviours; this is operations×duplicate-call-scenarios.
  { code: "S14", formId: "GeneratedChart", name: "Idempotency matrix", blurb: "Each operation (reserve, post, rollback) crossed with its duplicate-call scenario, showing whether the result is idempotent and what mechanism enforces it (batchId lookup, INSERT IGNORE, Redis idempotency key). Missing guarantees are gaps.", example: "Build an idempotency matrix for reserve, post and rollback. For each operation, show what happens on a duplicate call with the same batchId, which code mechanism enforces idempotency (state-exists check, INSERT IGNORE, Redis key), and cite the evidence. Mark any operation where idempotency is not evidenced as a gap.", needs: [] },
  // S15: DI / Wiring Diagram — which beans/providers are injected into which classes. No existing form shows this; V1 SemanticMap shows logical groupings, not injection wiring.
  { code: "S15", formId: "GeneratedChart", name: "DI wiring diagram", blurb: "Which classes are injected into which, how the dependency graph is wired by the container, and where circular or missing bindings would appear. Grounded in constructor-injection and field-injection evidence from the indexed code.", example: "Draw the dependency-injection wiring diagram for the bookkeeping component. Show which implementations are injected into which classes (BookkeepingEngineImpl → ReserveService → BalanceService, TransactionStateService, LedgerWriterServiceImpl), the injection mechanism (constructor vs field), and flag any dependency that could not be confirmed from the indexed code.", needs: [] },
];

/** All sixteen forms from the spec's catalogue, each with what it answers, what it needs, and whether it can be shown right now. */
export function VisualsGallery({ revision, onClose, onShow }: Props) {
  const [items, setItems] = useState<CatalogEntry[] | null>(null);
  // Shared editable-question state for both system charts and built-in visuals, keyed by chart code.
  const [text, setText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void call<CatalogEntry[]>("C19", "visuals", { revision }).then((r) => (r.ok ? setItems(r.value) : setError(r.error.message))); }, [revision]);

  return (
    <Modal title="Visuals" onClose={onClose} className="wide tall"
      actions={<><span className="muted small">Greyed ones need something the repository does not have yet.</span><button onClick={onClose}>Done</button></>}>
      <p className="muted small">Choose a built-in analysis or a focused system-design view. Edit the question before clicking Show to tailor it to your codebase.</p>
      {error && <div className="banner error" role="alert">{error}</div>}

      {/* ── System-design charts (S1–S5) ─────────────────────────────────────────────── */}
      <div className="gallery-section-header">
        <h3>System-design charts</h3>
        <p className="muted small">Focused views for exploring a codebase's structure, behavior and data: architecture, sequences, state machines, event flows, ER diagrams, DFDs, decision tables, saga graphs, outbox topology, idempotency guarantees, DI wiring and test coverage. Each renders on the interactive canvas with zoom, click-to-inspect, and evidence links. 26 of the 35 standard diagram types are covered by S1–S5 or by the built-in V1–V19 visuals below; the 10 entries here add what those do not.</p>
      </div>
      <ul className="gallery" tabIndex={0} aria-label="System-design charts">
        {SYSTEM_CHARTS.map((chart) => {
          const testVisual = chart.formId === "TestConfidence" ? items?.find((item) => item.formId === "TestConfidence") : undefined;
          const available = !!revision && (chart.formId !== "TestConfidence" || !!testVisual?.available);
          const reason = !revision
            ? "index a repository first"
            : chart.formId === "TestConfidence"
              ? (testVisual?.reason ?? "loading test availability")
              : undefined;
          const entry: CatalogEntry = { ...chart, available, ...(reason ? { reason } : {}) };
          const q = text[chart.code] ?? chart.example;
          const isTrace = chart.formId === "HypothesisGraph";
          return (
            <li key={chart.code} className={available ? "" : "off"}>
              <div className="between">
                <span><span className="chip system-chip">{chart.code}</span> <strong>{chart.name}</strong></span>
                {!available && <span className="badge warn">{reason}</span>}
              </div>
              <p>{chart.blurb}</p>
              {isTrace
                ? <p className="muted small">Paste a stack trace into the conversation to open this view.</p>
                : (
                  <div className="row">
                    <label className="sr" htmlFor={`g-${chart.code}`}>Question for {chart.name}</label>
                    <input
                      id={`g-${chart.code}`}
                      value={q}
                      onChange={(e) => setText({ ...text, [chart.code]: e.target.value })}
                      title="Edit the question to match your codebase before showing"
                    />
                    <button
                      disabled={!available || !q.trim()}
                      title={available ? "Render this view on the interactive canvas" : reason}
                      onClick={() => onShow(entry, q)}
                    >Show</button>
                  </div>
                )}
            </li>
          );
        })}
      </ul>

      {/* ── Built-in visuals (V1–V19) ─────────────────────────────────────────────────── */}
      <div className="gallery-section-header">
        <h3>Built-in visuals</h3>
      </div>
      <Loading pending={items === null && !error} label="Loading the visuals catalogue" rows={3} lines={2} />
      <ul className="gallery" tabIndex={0} aria-label="Visuals">
        {(items ?? []).map((it) => {
          const q = text[it.code] ?? it.example;
          const isTrace = it.formId === "HypothesisGraph";
          return (
            <li key={it.code} className={it.available ? "" : "off"}>
              <div className="between"><span><span className="chip">{it.code}</span> <strong>{it.name}</strong></span>{!it.available && <span className="badge warn">{it.reason}</span>}</div>
              <p>{it.blurb}</p>
              {isTrace ? <p className="muted small">Paste a stack trace into the conversation to open this view.</p> : (
                <div className="row">
                  <label className="sr" htmlFor={`g-${it.code}`}>Question for {it.name}</label>
                  <input id={`g-${it.code}`} value={q} onChange={(e) => setText({ ...text, [it.code]: e.target.value })} />
                  <button disabled={!it.available || !q.trim()} title={it.available ? "Show this visual" : it.reason} onClick={() => onShow(it, q)}>Show</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
