import { useEffect, useState } from "react";
import { call } from "./api.ts";
import { Loading } from "./Skeleton.tsx";
import { Modal } from "./Modal.tsx";
import { CHART_REGISTRY, type ChartId } from "@cie/schema";

export interface CatalogEntry { code: string; formId: string; name: string; blurb: string; example: string; needs: string[]; available: boolean; reason?: string }
interface Props { revision?: string; onClose: () => void; onShow: (entry: CatalogEntry, question: string) => void }

export const SYSTEM_CHARTS: Pick<CatalogEntry, "code" | "formId" | "name" | "blurb" | "example" | "needs">[] = [
  // ── Already-mapped chart types ──────────────────────────────────────────────────────
  // S1 covers: C4 container diagram, UML component diagram, UML deployment diagram, hexagonal/ports-and-adapters. Context level is S27.
  { code: "S1", formId: "GeneratedChart", name: "C4 container / component architecture", blurb: "Show the main components and who calls what, rendered as an evidence-grounded component graph. C4-style boundaries (Redis, MySQL and other stores) appear only where the indexed code names them; unsupported boundaries are listed as gaps instead of drawn. Also covers UML component, deployment and hexagonal port-and-adapter layouts.", example: "Build a C4 container-style architecture diagram for the reserve fast path. Show who calls what and distinguish Redis from MySQL using repository evidence.", needs: [] },
  // S2 covers: swimlane flowchart, UML activity diagram, control flow graph. Full sequence notation (lifelines, ordered messages, fragments) is S28.
  { code: "S2", formId: "TransactionJourney", name: "Reserve fast-path sequence / swimlane", blurb: "Follow reserve through its callers and callees as a swimlane journey: lanes per module, conditional branches, transaction markers and failure exits, ordered by static control-flow (not observed runtime timing). This is a swimlane journey rather than a full UML sequence diagram; for lifelines, ordered messages and alt/opt/loop fragments use the UML sequence diagram (S28). Also serves as a UML activity diagram or control-flow graph for any single operation.", example: "Draw the reserve fast path as a sequence diagram from request through Redis and MySQL. Include decision points and failure branches supported by the code.", needs: [] },
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
  // ── The remaining standard diagram types ───────────────────────────────────────────
  { code: "S16", formId: "GeneratedChart", name: "UML class diagram", blurb: "Classes, interfaces, enums and their attributes and operations, with inheritance (hollow triangle), realization, association, aggregation/composition (diamond at the owner end) and dependency relations. Relations not declared in source are drawn dashed and named as inferred.", example: "Draw a UML class diagram for the bookkeeping domain: classes with their evidenced attributes and operations, inheritance and realization between them, and the associations the code declares. Mark anything not declared in source as inferred and list gaps.", needs: [] },
  { code: "S17", formId: "GeneratedChart", name: "UML package diagram", blurb: "Packages/namespaces with their evidenced members and the dependencies between them, drawn dashed. Members come from the indexed declarations only.", example: "Draw a UML package diagram for this repository: the main packages, the classes or modules each contains, and which packages depend on which. Cite the declarations that evidence each dependency and list gaps.", needs: [] },
  { code: "S18", formId: "GeneratedChart", name: "UML communication diagram", blurb: "Participants linked by numbered messages: each message carries its sequence number, direction and kind (sync, async, return). The numbering gives the interaction order.", example: "Draw a UML communication diagram for the reserve flow: the caller, engine, balance, state and ledger participants, with numbered messages (1: reserve, 2: tryReserveFast, …) grounded in the indexed call relationships.", needs: [] },
  { code: "S19", formId: "GeneratedChart", name: "UML interaction overview", blurb: "The control-flow between interactions: initial and final markers, interaction frames that name the nested interaction they refer to, and decision points with guards on the outgoing flows.", example: "Draw an interaction overview for the bookkeeping lifecycle: one interaction frame per operation (reserve, post, rollback), connected through decision points with the guards the code evidences.", needs: [] },
  { code: "S20", formId: "GeneratedChart", name: "CRC cards", blurb: "One card per class: its evidenced responsibilities and the classes it collaborates with, rendered as a table plus a collaboration graph. Entries the source does not support are listed as gaps, not invented.", example: "Build CRC cards for ReserveService, BalanceService, TransactionStateService and LedgerWriterServiceImpl. List each class's responsibilities and collaborators, citing the code that evidences each entry.", needs: [] },
  { code: "S21", formId: "GeneratedChart", name: "Call graph", blurb: "Which functions call which, from statically resolved call relationships. Every edge is static source evidence; no runtime frequency or ordering beyond source order is implied.", example: "Draw the call graph rooted at reserve: each function it reaches through resolved calls, with the call-site evidence for every edge. Flag calls the indexer could not resolve.", needs: [] },
  { code: "S22", formId: "GeneratedChart", name: "Layered architecture", blurb: "Components grouped into named, ordered layers (API, service, domain, infrastructure…), with uses/calls and asynchronous dependencies between them. Layers only appear when the code evidences them.", example: "Draw the layered architecture of this service: an API layer, an application-service layer, a domain layer and an infrastructure layer, with the components the code places in each and the dependencies between layers.", needs: [] },
  { code: "S23", formId: "GeneratedChart", name: "Dependency / module graph", blurb: "Modules, packages and crates with the dependencies between them, labelled by kind (compile-time, runtime, test-only). Cycles and unsupported dependencies are shown as what they are.", example: "Draw the module dependency graph for this repository: each module/package, whether dependencies are compile-time, runtime or test-only, and any circular dependency the resolved graph contains.", needs: [] },
  { code: "S24", formId: "GeneratedChart", name: "State transition table", blurb: "A real table: current state × event → next state, with guards and forbidden transitions as negative facts. Combinations the source does not cover stay visibly unknown.", example: "Build the state transition table for the batchId lifecycle: rows for NoState, Reserved, Posted and RolledBack; columns for reserve, post and rollback; each cell names the next state and its guard, and forbidden transitions (rollback after post) are marked as forbidden.", needs: [] },
  { code: "S25", formId: "GeneratedChart", name: "FMEA / compensation matrix", blurb: "Failure mode × impact × compensation as a table, each cell backed by source or test evidence. A failure with no evidenced compensation is listed as a gap, never assumed recoverable.", example: "Build an FMEA matrix for the reserve fast path: Redis reserve failure, DB sync failure, provider failure, duplicate post. For each, the evidenced impact and the compensation in the code (cancelFast, rollback, INSERT IGNORE), and mark any failure without a compensation.", needs: [] },
  { code: "S26", formId: "GeneratedChart", name: "Metrics / telemetry map", blurb: "Metric names as declared in code, with their evidenced meaning and emitters. Declared names only — this chart never reports live values.", example: "List the metrics this component declares (reservation.fast.success, ledger.insert.ignored, …), what each measures based on the code that emits it, and which functions emit them. Do not invent live values.", needs: [] },
  { code: "S27", formId: "GeneratedChart", name: "C4 context diagram", blurb: "The widest view: people, the subject software system and external systems, with labelled relationships (operation, protocol or data purpose). Containers and components stay out of scope at context level (use S1 for those).", example: "Draw a C4 context diagram for the bookkeeping system: the caller and admin roles, the bookkeeping system itself, and Redis, MySQL and the provider as external systems, with the evidenced operations on each relationship.", needs: [] },
  { code: "S28", formId: "GeneratedChart", name: "UML sequence diagram", blurb: "Lifelines with ordered messages (sync, async, return, self) and alt/opt/loop/exception fragment regions, ordered by static control-flow — not observed runtime timing. Rendered as a navigable message outline; the order numbers are the source-evidenced sequence.", example: "Draw the reserve interaction as a UML sequence diagram: caller, engine, Redis and MySQL lifelines; numbered messages in evidenced order; an alt fragment for insufficient balance and an exception fragment for the DB-sync compensation.", needs: [] },
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

      {/* ── System-design charts (S1–S28) ────────────────────────────────────────────── */}
      <div className="gallery-section-header">
        <h3>System-design charts</h3>
        <p className="muted small">Focused views for exploring a codebase's structure, behavior and data: architecture, sequences, state machines, event flows, ER diagrams, DFDs, decision tables, saga graphs, outbox topology, idempotency guarantees, DI wiring, class/package/communication/interaction-overview diagrams, CRC cards, call and module graphs, layered views, transition tables, FMEA and metrics maps, C4 context and sequence notation. Each renders on the interactive canvas with zoom, click-to-inspect, and evidence links. All 35 standard diagram types are covered by S1–S28 here and by the built-in V1–V19 visuals below (types like the race-condition timeline, threat model, test traceability and profiling views live in the built-ins).</p>
      </div>
      <ul className="gallery" tabIndex={0} aria-label="System-design charts">
        {SYSTEM_CHARTS.map((chart) => {
          const testVisual = chart.formId === "TestConfidence" ? items?.find((item) => item.formId === "TestConfidence") : undefined;
          const compilerAvailable = CHART_REGISTRY[chart.code as ChartId]?.compiler !== "missing";
          const available = !!revision && compilerAvailable && (chart.formId !== "TestConfidence" || !!testVisual?.available);
          const reason = !revision
            ? "index a repository first"
            : !compilerAvailable
              ? "chart compiler is not implemented yet"
            : chart.formId === "TestConfidence"
              ? (testVisual?.reason ?? "loading test availability")
              : undefined;
          const name = CHART_REGISTRY[chart.code as ChartId]?.name ?? chart.name;
          const entry: CatalogEntry = { ...chart, name, available, ...(reason ? { reason } : {}) };
          const q = text[chart.code] ?? chart.example;
          const isTrace = chart.formId === "HypothesisGraph";
          return (
            <li key={chart.code} className={available ? "" : "off"}>
              <div className="between">
                <span><span className="chip system-chip">{chart.code}</span> <strong>{name}</strong></span>
                {!available && <span className="badge warn">{reason}</span>}
              </div>
              <p>{chart.blurb}</p>
              {isTrace
                ? <p className="muted small">Paste a stack trace into the conversation to open this view.</p>
                : (
                  <div className="row">
                    <label className="sr" htmlFor={`g-${chart.code}`}>Question for {name}</label>
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
