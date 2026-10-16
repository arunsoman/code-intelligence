# Business concept hierarchy: proposed projection

Status: design, not implemented by the incremental-performance patch.

## Intended experience

Offer a business-oriented projection above the existing architectural tree and structural semantic concepts:

System → Domain area / bounded-context candidate → Module → Domain concept → Behavior / use case → Rule / invariant → Implementation pattern.

These are available concept kinds, not mandatory nesting levels. A rule may constrain several behaviors; a pattern may implement several rules; one use case may span payment, inventory and ordering. Store the underlying relationships as a graph and render a primary tree with cross-links. Do not duplicate a shared rule as unrelated facts in different branches.

The existing concept browser can gain a Domain perspective alongside Architecture and Behaviors & rules. The user expands business terms and can inspect sources, supporting calls, unresolved references and implementation motifs. Preserve the current structural perspective as the fallback when business grouping has not been established.

## What the supplied checkout sample actually supports

| Candidate | Basis | Limitation |
| --- | --- | --- |
| Cart and CheckoutService | Class declarations | Declared classes, not automatically proven DDD entities/application services |
| Add item to cart | add_item implementation | Business label describes the observed method |
| Reject non-positive quantity | qty <= 0 branch raises ValueError | Scope this rule to the observed path; other mutation paths may bypass it |
| Calculate cart total | sum of item.product.price * item.qty | Observed expression; does not establish taxes, monetary precision or rounding policy |
| Create order from cart | Order.from_cart invocation | Order definition is not supplied |
| Authorize payment, reserve inventory | Calls in checkout | Callees are unresolved in the snippet; lexical call order is not an execution trace |
| CartItem, Product, OrderLine | Reference or domain hypothesis | CartItem/Order are referenced; Product/OrderLine definitions are not shown |
| PaymentGateway / InventoryRepository | Possible infrastructure roles | Neither interface is defined in the snippet |
| Authorization before fulfillment | Proposed business rule | No fulfillment implementation is shown, so this cannot be asserted from the snippet |

Catalog/Cart/Ordering boundaries may be useful proposals, but directory names or an LLM grouping alone do not establish bounded contexts. Display such boundaries as inferred until their contracts, ownership and dependencies are inspected or a user confirms their intended meaning.

## Representation

Use typed nodes SYSTEM, DOMAIN_AREA, MODULE, DOMAIN_CONCEPT, BEHAVIOR, RULE and IMPLEMENTATION_PATTERN. Each carries a stable source-derived identity, revision, label, member entity IDs, evidence IDs, coverage limits and provenance. Business descriptions/grouping are separate from the underlying structural observations.

Node/edge support states:

- CODE_OBSERVED: supported by indexed declarations, resolved relationships or an inspected expression/guard, within its stated scope.
- INFERRED: a proposed business label, boundary, role or interpretation.
- CONFIRMED: an explicitly attributed human interpretation; this does not prove runtime enforcement.
- UNRESOLVED: a required implementation/reference/contract is unavailable or conflicting.

Edges include CONTAINS, DEFINES, IMPLEMENTS, CONSTRAINS, CALLS and DEPENDS_ON. Keep source-backed edges distinct from inferred edges. Tree expansion must not visually imply that a speculative rule is implemented or enforced. Never create an empty source citation to make an inferred node look observed.

Example JSON shape (illustrative, not a live extraction):

```json
{
  "version": "business-hierarchy.v1",
  "revision": "indexed-revision",
  "nodes": [
    { "id": "domain:cart", "kind": "DOMAIN_AREA", "label": "Cart", "support": "INFERRED", "entityIds": ["class:cart.py#Cart"], "evidenceIds": [] },
    { "id": "behavior:cart-add", "kind": "BEHAVIOR", "label": "Add item to cart", "support": "CODE_OBSERVED", "entityIds": ["method:cart.py#Cart.add_item"], "evidenceIds": ["actual-indexed-guard-evidence"] },
    { "id": "rule:positive-quantity", "kind": "RULE", "label": "Reject non-positive quantity in add_item", "support": "CODE_OBSERVED", "entityIds": ["method:cart.py#Cart.add_item"], "evidenceIds": ["actual-indexed-guard-evidence"] }
  ],
  "edges": [
    { "from": "domain:cart", "to": "behavior:cart-add", "kind": "CONTAINS", "support": "INFERRED" },
    { "from": "rule:positive-quantity", "to": "behavior:cart-add", "kind": "CONSTRAINS", "support": "CODE_OBSERVED" }
  ]
}
```

## Incremental design

1. Reuse existing AST/semantic-IR entities, call relationships, PDGs, motifs, invariants and architectural membership. Avoid another repository parse or graph for every presentation mode.
2. Index reverse dependencies from every proposed node/edge to its source entities and grouping inputs. Edits invalidate the affected behavior/rule and its ancestors, plus cross-domain links depending on it.
3. Separate structural extraction fingerprints from label/grouping fingerprints. Label-only changes do not rerun PDG/motif analysis. Structural changes do not force unrelated business-label calls.
4. Batch LLM suggestions only for affected unresolved groups. Key suggested descriptions by member/source fingerprints, model, prompt/schema version and relevant confirmed terminology. The model proposes labels/groups, not new code facts.
5. Recompute cross-module/domain composition from the current graph. When impact cannot be bounded safely, fall back to a broader structural recomputation and disclose it; do not retain stale business rules to save time.
6. Resolve current permissions and evidence on access. Cached names/descriptions referencing denied code must be withheld or regenerated. Unresolved implementations stay visible as generic gaps without exposing protected identifiers.

## Acceptance checks before calling the feature complete

- Supplied checkout sample produces useful behaviors/rules while leaving absent classes, interfaces and fulfillment unproven.
- An added alternate mutation path does not leave a local guard represented as a global invariant.
- Changing authorize/reserve order updates the observed call sequence and invalidates dependent interpretations.
- One edited behavior updates its affected subtree while preserving unrelated stable IDs/labels; compare with a cold extraction.
- Deletions, renames, moved files, unresolved dynamic calls and cross-context rules remain correct.
- Cycles/multiple parents render as explicit cross-links; projection/JSON export does not invent ownership.
- Access revocation and source changes invalidate cached evidence and labels appropriately.
- Report structural, labeling and projection times separately; measure end-to-end warm/cold builds on a representative repository.

This projection is the next functional layer. The accompanying performance patch speeds existing structural concept construction; it does not yet supply this business ontology or a new Domain tab.
