# Predictable response ranking

Apply `predictable-response-ranking-incremental.patch` after `typed-table-cleanup-incremental.patch`. It does not repeat either the table or canvas patch. No primary-chart compiler or provider routing is replaced by this slice.

## Policy

The `portfolio.v4` planner preserves the primary chart already returned by the router or explicitly selected by the user. It classifies supporting perspectives using bounded, whole-word keyword patterns. Query concerns follow their first mention in the question; the primary chart's concern is retained as a fallback/additional perspective. Incidental substrings such as test in latest and lock in clock no longer affect classification. Repeated terms do not increase ranking scores.

Candidates come from discovered chart descriptors and available native forms. Unknown evidence preflight remains requestable; known absent entity kinds and missing compilers are excluded. Classification records whether its basis was query keywords, the primary view, or general fallback. It is a transparent heuristic, not an LLM confidence or semantic proof score.

Candidate score = 100 × concern priority + 50 when the full diagram name/alias is present + the existing intent preference bonus (25 minus 2 × preference position). The numeric score is API metadata for inspection, not a percentage or UI confidence indicator. Equal scores use numeric chart suffix then lexical code as a stable tie-breaker. Selection takes one candidate per concern before filling remaining slots by score; there are at most three supporting tabs. A diversity-selected later concern can therefore precede a higher-scoring second candidate for the first concern.

Recommendation reasons explain matched terms, named notation and intent preference, and distinguish preflight from semantic evidence. Availability reasons remain separate. Unavailable views stay in All views with their original explanation. Suggested views still generate on demand; no additional model calls are introduced.

## UI and compatibility

Response interpretation stays collapsed by default. Expanding it shows classification terms and the selected supporting views' explanations. More views displays recommendation explanations where available. Recommendations, classification and policy version travel with exported response manifests and tab descriptors.

Existing `portfolio.v1`, `portfolio.v2` and `portfolio.v3` manifests remain accepted; new metadata is optional for older saved workspaces. Older deployed consumers that strictly validate policy versions need this schema update before consuming new v4 responses.

## Limits and validation

This is an English keyword policy; it does not parse negation, causality, synonym meaning or the user's desired number of diagrams. It ranks perspectives, not the correctness of generated diagrams. Primary routing, source extraction and the seven unresolved chart captures are unchanged by this batch.

Tests cover incidental substrings, singular/plural terms, mention order, explicit notation preference, concern diversity, availability, stable catalog ordering, repetition, fallback reasons, manifest compatibility, and existing workspace/navigation behavior. TypeScript and production build checks are included. Browser interaction is not verified here because Chrome is unavailable.
