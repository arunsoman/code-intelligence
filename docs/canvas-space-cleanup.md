# Canvas space cleanup

Apply to c789210 after the combined exploration/navigation patch. View controls and verbose response interpretation start collapsed. The middle-column controls scroll within a bounded region, leaving a drawing region with a minimum height. Long questions and purpose text no longer expand without limit. Very short windows can scroll the main region rather than clipping away the chart.

Focus canvas removes both side columns from layout while preserving their mounted state and the user's controls-collapse preference. Chat and evidence can be opened as an overlay from the always-visible workspace toolbar. Inspecting a node, relationship or source opens that overlay in focus mode. Exit canvas focus restores the regular layout. Existing renderer ResizeObservers handle dimension changes; focus changes do not remount the graph.

This patch addresses workspace space allocation. Dedicated table renderers and investigation of the seven missing screenshot captures remain separate work. No renderer correctness or native font-readability claim is inferred from the compressed contact sheet.

Validation: TypeScript, production build and focused response/navigation suites. A browser geometry regression checks focus width, restored panel layout and accessible panel controls when Chrome is available; unavailable Chrome is reported as a skipped check.

Content-aware topology layout now also covers BPMN, saga, communication and interaction overview diagrams, comparing horizontal and vertical results against the actual canvas. Parallel edge merging is disabled, and the shared graph renderer retains actual self-relationships while suppressing misleading self-links created by aggregation. Sequence time axes and responsibility lanes retain their notation semantics. Connections remain clickable for evidence and contextual exploration; missing indexed relationships are not invented.

Unconnected class/interface/enum cards use a measured grid that chooses its column count from available canvas dimensions and compartment heights. Connected class diagrams retain topology layout to preserve relationship readability.
