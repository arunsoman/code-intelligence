# Defect workflow implementation status

Source of requirements: `Code_Intelligence_Defect_Performance_and_PR_Design.md`.
The full document is the requested scope. This checklist distinguishes working code
from planned integration; a type or interface alone does not complete a feature.

## Delivery checklist

- [ ] §5: registered semantic IR and language adapters; CFG, effects, aliases, synchronization, loops
- [ ] §6: lock cycle witnesses, feasibility, consistent runtime wait snapshots, liveness escapes
- [ ] §7: memory and logical races, independent properties, bounded schedules and replay
- [ ] §8: performance candidates, safety obligations, overlap-aware trace costs and critical paths
- [ ] §9–10: durable C26/C27/C28 lifecycle and typed APIs, C22 integration
- [ ] §4/9: capability registry and isolated native/Rust/JVM/.NET adapters with declared exclusions
- [ ] §12: isolated patch proposals, validation against exact source and independent oracle
- [ ] §12/14: authorized draft PR publisher, drift checks, reconciliation and sanitized export
- [ ] §13: comparable paired benchmarks, uncertainty, secondary regression gates
- [ ] §14: transactional outbox, idempotency, leases, cancellation, retention and revocation
- [ ] §15: read-only specialized evidence views
- [ ] §16: DP01–DP20 acceptance fixtures with positive and negative controls

External tools are integration candidates, as specified in §4. Availability must be
reported from the environment; an absent adapter is not a successful analysis.
Publication of a real PR additionally requires the target repository, base branch
and a grant for the reviewed candidate. Implementing the publisher does not issue
that grant.
