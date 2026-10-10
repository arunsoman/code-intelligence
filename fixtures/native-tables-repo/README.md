# Native table fixture

This repository fragment supplies real class declarations and two statically declared metric instruments for headless CRC and metrics-table checks. Its meter is a local fake; it neither contacts a telemetry service nor supplies runtime measurements to the visualization.

Offline CRC responsibilities and collaborators intentionally remain unknown. Metric names and emitter source locations come from `createCounter` declarations, without reporting counter values.
