// Labelled example questions per form, for the nearest-neighbour layer of the router. Each form has phrasings that differ in wording
// on purpose (verbs, nouns, word order), so a new question is judged by overall similarity rather than by one keyword.
// The held-out questions in route.test.ts are written separately and are never added here.
export const EXEMPLARS: Record<string, string[]> = {
  SemanticMap: [
    "how is the code organised into modules", "how do the main components fit together",
    "describe the structure of the checkout feature", "what are the building blocks of the notification service", "show how the login feature is put together", "map out the billing module",
    "what are the layers of this application", "how are responsibilities split between packages",
  ],
  GeneratedChart: [
    "draw a sankey diagram for this flow", "show this as a sequence diagram", "make a chart type that is not in the gallery",
    "create a custom visual for this evidence", "use a timeline chart to explain these code paths", "pick the best chart to represent this relationship",
  ],
  "CausalGraph:failure": [
    "what could make an order submission fail", "list every place a request can be rejected", "what are all the ways this call can blow up", "under what conditions does the upload error out",
    "which exceptions can the payment flow raise", "where can the sync job give up", "how can a login attempt be refused", "what are the failure points of the import",
    "what can go wrong when saving a profile", "which errors can bubble out of the scheduler",
  ],
  "CausalGraph:invariant": [
    "how could the stock level end up negative", "how can two copies of the same value disagree", "what could leave the totals inconsistent", "where might the counter drift from the truth",
    "how might a balance be wrong after a retry", "which code could corrupt the order status", "what could cause the cache to hold stale data", "how can the ledger and the invoices fall out of step",
    "can the quantity ever become incorrect", "what writes could leave the record half updated",
  ],
  TransactionJourney: [
    "trace what happens from the click to the database when buying", "take me through the signup in order", "what are the steps when an invoice is paid", "follow the order from creation to delivery",
    "describe the sequence of calls for a refund", "step through the password reset", "what happens first, then next, when a message is published", "the life of a payment from start to finish",
    "show the path a request takes through the services", "lay out the checkout flow stage by stage",
    "what happens if the user pays but the mobile topup fails", "could payment succeed while the recharge is still pending",
    "show the sequence when customer payment is accepted but the operator topup fails", "what happens after a payment if the next service step fails",
  ],
  DataLineage: [
    "which code touches the customers table", "what reads the discount column", "who sets the shipped flag", "find every writer of the session state",
    "where does the price field get changed", "which functions use the cart contents", "where does this value come from and where does it go", "trace how the email address is stored and used",
    "what modifies the inventory record", "list readers and writers of the config object",
  ],
  SemanticDiff: [
    "what is different in this build compared to the old one", "summarise the changes in the latest revision", "how does the new version differ from the previous one", "what did the last commit alter conceptually",
    "show the behaviour that changed after the upgrade", "what has been added or removed since the previous index", "what moved between the two snapshots", "highlight what is new in this release",
    "which behaviours differ between the branches", "tell me what changed in the refactor",
  ],
  Archaeology: [
    "why was the cache layer introduced", "how did this module end up so complicated", "who decided to drop the transaction here and why", "what led to the current design of the router",
    "what is the background of the legacy adapter", "when and why did the retry logic change", "explain the reasons behind this odd workaround", "what is the history of the billing code",
    "which commits shaped the scheduler", "what was the motivation for this constraint",
  ],
  TrustBoundary: [
    "which endpoints can an anonymous user hit", "what stands between the internet and the database", "where are the permission checks", "can an unauthenticated caller reach the admin functions",
    "show the attack surface of the api", "who is allowed to perform deletions and what verifies that", "which entry points are unprotected", "where do untrusted inputs cross into privileged code",
    "what guards the payment endpoints", "map the authorisation checks along the request path",
  ],
  RuntimeOverlay: [
    "what has been erroring in production lately", "show the live hot spots", "which code is failing right now according to the reports", "project the recent incidents onto the code",
    "where did the latest exceptions come from", "what do the traces say about slow spots", "overlay observed errors on the architecture", "which functions are the noisiest in the telemetry",
    "what broke in the last deployment according to the logs", "show reported crashes by module",
  ],
  RaceWindow: [
    "could two requests update the same row at once", "is there a data race on the shared counter", "where might threads interleave badly", "can this be double processed under load",
    "are the locks taken in a consistent order", "could the same job run twice concurrently", "is the check then update safe against parallel callers", "where is shared mutable state accessed without protection",
    "can a deadlock occur between these services", "which operations are not safe to run in parallel",
  ],
  Counterfactual: [
    "what would be affected if we deleted this class", "if the cache disappeared what would stop working", "what depends on the legacy client and would break without it", "how far does a change to the schema ripple",
    "simulate removing the retry module", "what is the fallout of switching off the notifier", "which callers would be hit if this function were gone", "what happens to the system without the message bus",
    "estimate the impact of retiring this endpoint", "what if this service became asynchronous",
  ],
  TestConfidence: [
    "how well covered is the checkout by tests", "which important functions have no tests", "do the tests actually exercise the refund path", "show me the untested corners",
    "how much can I trust the test suite around billing", "which behaviours are asserted and which are not", "where are the gaps in coverage", "what is protected by tests and what is not",
    "which failing tests relate to the ledger", "rate the safety net around the importer",
  ],
  Ownership: [
    "who should I ask about the scheduler", "which people wrote most of the payments module", "where is knowledge concentrated in a single person", "who maintains the authentication code",
    "what is the bus factor of the api", "who are the main contributors to the ledger", "which areas have no clear owner", "who has touched the billing code recently",
    "find the experts for the search feature", "is the code owned by the team that changes it",
  ],
  ConceptAtlas: [
    "what business rules are buried in the code", "list the domain concepts the code implies", "which unwritten conventions does the code rely on", "what hidden assumptions does pricing make",
    "surface the concepts that are not documented", "what workflows exist implicitly in the services", "where do the same ideas appear in several places", "what vocabulary does the domain use",
    "what implicit constraints govern refunds", "extract the knowledge that lives only in the code",
  ],
  PolicyMap: [
    "which rules are enforced in code and which are not", "where can the approval requirement be bypassed", "are the compliance rules actually checked", "which policies exist only as comments",
    "show the places where the rule is skipped", "where is the retention rule enforced", "which routes get around the validation", "what requirements are written down but not enforced",
    "do all paths apply the rate limit", "audit the enforcement of the data handling rules",
  ],
  TraceLinkedProfile: [
    "where does the cpu actually go when this runs", "which functions dominate the sampled execution time", "show the profiling hotspots of the service", "what is the service spending its cpu on",
    "where are the allocation hotspots in this build", "which code paths eat the wall clock time", "rank the functions by self time from the profile", "what does the sampled profile say is hot",
    "which call stacks dominate the profile window", "where did the samples land during that run",
  ],
  ChangeRisk: [
    "which parts are hardest to modify safely", "where is the code most fragile", "what areas change the most and are tightly coupled", "which modules are likely to cause regressions",
    "rank the files by how risky they are to touch", "where is the technical debt concentrated", "what would be dangerous to refactor", "show hotspots of churn and complexity",
    "where should we be careful when making changes", "which code is risky to change without more tests",
  ],
};

// Requests that are not a choice of view. `target` is the thing the request names, copied from the question; it is matched against the code afterwards
// (never trusted), and is empty when the request names nothing.
export const INTENT_EXEMPLARS: Record<string, [question: string, target: string][]> = {
  overview: [
    ["which architectural style is this project built in", ""], ["give me the big picture of the system", ""], ["what kind of application is this", ""], ["describe the structure of this codebase", ""],
    ["which frameworks and languages does the repo use", ""], ["tour of the whole project please", ""], ["how is this system laid out", ""], ["what does this project do", ""],
  ],
  resume: [["continue the payment investigation", "payment"], ["reopen my login session", "login"], ["pick up where I left off on the refund work", "refund"], ["resume the investigation", ""]],
  zoomIn: [["zoom in", ""], ["show more detail", ""], ["drill down into this", ""]],
  zoomOut: [["zoom out", ""], ["less detail please", ""], ["go up a level", ""]],
  whyShown: [["why are you showing this", ""], ["why is this node here", ""], ["what is this doing on the map", ""]],
  whyHidden: [["why isn't handleRefund shown", "handleRefund"], ["where is the ledger module, it is missing", "ledger module"], ["why was chargeCard left out of the view", "chargeCard"]],
  connected: [["why are these connected", ""], ["how are these two related", ""], ["explain this", ""], ["what links the selected items", ""]],
  pin: [["pin charge", "charge"], ["always keep the ledger visible", "ledger"], ["pin the retry handler", "retry handler"]],
  unpin: [["unpin charge", "charge"], ["reset the ledger", "ledger"], ["stop pinning the retry handler", "retry handler"]],
  boost: [["boost charge", "charge"], ["prioritise the ledger", "ledger"], ["rank the retry handler higher", "retry handler"]],
  demote: [["demote charge", "charge"], ["deprioritise the ledger", "ledger"], ["rank the retry handler lower", "retry handler"]],
  ignore: [["ignore checkFraud", "checkFraud"], ["rule out the cache hypothesis", "cache"], ["drop the retry suspect", "retry"]],
  restore: [["restore checkFraud", "checkFraud"], ["bring back the cache suspect", "cache"]],
  whySuspect: [["why do you suspect charge", "charge"], ["why is the lock ranked first", "lock"], ["why is this suspicious", ""]],
};
