# Contained source coverage and repair budgets

Apply `code-intelligence-contained-source-repairs.patch` after `code-intelligence-targeted-investigation.patch`. Base: local checkpoint `5a22c00`. Restart the server before using Continue investigation. No remote push was made.

## Remaining failure mechanisms

The user's latest run finds relevant Mi-Pay topup and recovery implementations, including a recovery job file, but reports its methods unread, consumes the investigation budget after a repair, and cannot finish the reviewer. The supplied output alone does not establish whether every method was in the delivered file pages. The following code defects were reproduced in controlled indexed-repository tests:

1. A file/class read updated only that entity's source coverage. A method fully delivered in those pages still needed a redundant method read to satisfy the citation gate.
2. Repairs shared the original 16-turn/28-call limits. A legitimate missing-source repair at the call cap could not fetch any more evidence.
3. The reviewer retained its separate 15-second ceiling even when the HTTP request had substantially more time remaining.

## Implemented behavior

- A fully delivered child source span inherits coverage from its containing file/class/interface. Matching file, source ID and content hash are required. Byte spans are mapped against the UTF-8 source; gaps, partially read methods, changed hashes, other files and zero-length spans do not count. Access policy checks still apply.
- Source coverage is restored for older saved investigations from their hash-verified files and recorded delivered ranges. Continue does not need duplicate reads to upgrade these checkpoints.
- Known missing/partial implementation reads are checked before the model review. They trigger targeted source repair rather than consuming a reviewer call on a draft already known to have an evidence gap.
- Each of at most two repairs gets up to four additional writer turns and eight calls. Absolute maxima are **24 writer turns and 44 tool calls**. A repair starts only when draft/review time remains; request deadlines still bound the entire run.
- The review ceiling is **30 seconds**, including its one format retry. The writer reserves up to **35 seconds** for review/finalization on longer requests; shorter requests retain proportionally bounded reserves. HTTP chat duration stays at the previously patched 180 seconds.
- Unsupported conclusions remain withheld. File reads prove inspected source coverage, not the absence of every recovery path or actual runtime execution.

## Validation

Four integration regressions fail before this patch and pass afterward: contained-method citations from a file read; missing-source repair at the original 28-call cap; review completion after 16 simulated seconds; and Continue upgrading an older file-only coverage checkpoint. Separate coverage tests exercise UTF-8 byte spans, disjoint page ranges, mismatched hashes/files and empty spans.

The related suite passes **58/58**, including source coverage, answer validation, source reads, deadline handling, lookup, conversation actions, session reader races, visuals and HTTP server tests. Typecheck and diff whitespace checks pass. Patch application was checked against the preceding checkpoint.

The user's actual Mi-Pay repository, provider model latency, and running deployment have not been tested here. These fixes address reproduced pipeline defects and cannot promise that this business question will always produce a validated yes/no answer. Earlier broad-suite failures remain outside this patch.
