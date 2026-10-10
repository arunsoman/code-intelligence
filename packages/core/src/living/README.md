# Living Investigation MVP

Durable, evidence-graded **case file** for diagnostic questions — on top of C22.

## Quick demo

1. Open the Investigations panel in the app.
2. Click **Start demo case file**.
3. Use tabs: Hypotheses → Next checks → run ▶ → watch grades move OPEN → CONTESTED → SUPPORTED.
4. **Assess completion (honest)** — can finish as `EXPLAINED_WITH_LIMITS` or `UNRESOLVED`.
5. **Views** tab emits `cie:living-view-hint` for the workspace.

No worker required for demo mode.

## Files

| Path | Role |
|------|------|
| `packages/core/src/living/living-investigation.ts` | Case-file model, demo state machine, C22-aligned commands |
| `apps/web/src/investigation.ts` | Web exports + assessment helpers |
| `apps/web/src/InvestigationPanel.tsx` | MVP UI (live C22 + demo fallback) |
| `apps/web/src/living.css` | Case-file / grade styles |
| `apps/web/src/living-import-snippet.txt` | Add `@import "./living.css";` to `styles.css` |

## Live vs demo

- **Live**: `create` (with `seed: true`), `getDetails` poll, `retireHypothesis`, `steer`.
- **Demo**: full client-side advancement when live ops fail or user clicks **Start demo case file**.

## Wire the workspace

```ts
window.addEventListener("cie:living-view-hint", (e: Event) => {
  const { concern, subjectRefs, investigationId } = (e as CustomEvent).detail;
  // open/focus tab for concern, preserve investigation subject
});
```

## Epistemic grades

| Grade | Meaning |
|-------|---------|
| Fact | Supported / refuted under gates |
| Inference | Contested / interpretive |
| Hypothesis | Proposed, not established |
| Fog | Insufficient evidence |

## Next hardening

- Map `runCheck` to C22 reserve → tool → assess step flow
- Persist demo → real investigation when worker is available
- Correlate hypothesis cards with claim ledger display modes
- Keyboard shortcuts for tabs and Run
