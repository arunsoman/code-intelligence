# Adaptive canvas layout slice

Apply `adaptive-canvas-incremental.patch` after all four earlier patches.

## Changes

Topology graphs compare two ELK layered layouts, horizontal and vertical, and choose the orientation requiring less shrinkage to fit the actual canvas. Fit uses node dimensions and routed edge bounds, with room for group margins. Tiny improvements below 4% keep the preferred orientation to reduce resize jitter. Equal fits prefer horizontal on a wide canvas and vertical on a tall canvas. A small graph is never stretched to occupy every pixel. Source identities, groups, evidence, relationships and selection are retained.

Semantic maps now use the same topology layout at detailed levels, preserving file/concept groups rather than forcing symbols into fixed vertical columns. Sequences, timelines, swimlanes and event bands keep their notation layouts; this patch does not distribute time arbitrarily across the canvas.

Displayed chart names are “Container / component architecture” and “System context.” Descriptions and examples omit C4 terminology. Internal roles, types and old C4 input aliases stay compatible.

## Limits

Two sequential worker layouts cost more than one; layout is still asynchronous, with existing cancellation-by-result guards and resize bucketing. If one orientation fails, the other may still be used; if both fail, the existing fallback is retained. Dense graphs still require semantic zoom and panning. This is an adaptive topology-layout patch, not the dedicated sequence/ER renderer implementation.

Automated geometry checks cover layout orientation, provenance preservation, grouping, routed edges and fallback. Browser interaction is not claimed without a browser run.
