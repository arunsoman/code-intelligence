# UI/UX defect log

**Scope:** source review of the React application in `apps/web/src`. Findings below are tied to concrete implementation patterns. This is a backlog and design direction, not a claim that every state has been visually exercised in a browser. Priorities describe user impact: **P1** blocks or seriously disrupts common use; **P2** adds recurring friction or inconsistency; **P3** is a smaller polish/accessibility issue.

## Defects

### UX-01 — Close controls move between the top-right and footer — P1

**Evidence:** The shared [`Modal`](apps/web/src/Modal.tsx) puts an icon close button in the title row. [`DefectPanel`](apps/web/src/DefectPanel.tsx) and [`InsightsPanel`](apps/web/src/InsightsPanel.tsx) put a text `Close ✕` at the top. [`FolderPicker`](apps/web/src/FolderPicker.tsx), jobs, audit, search, visuals, concept browsers, and hotspot views use a footer `Close` or `Cancel`. [`InvestigationPanel`](apps/web/src/InvestigationPanel.tsx) uses `Close investigations` in its heading; [`BuildFeature`](apps/web/src/build/BuildFeature.tsx) uses an icon button.

**Impact:** Users must scan each dialog to find the exit, and repeated actions do not look or behave alike. Some dialogs have both Escape/backdrop dismissal and a footer close; others have only one visible affordance.

**Recommendation:** Adopt one shared dialog shell for all modal panels: title at top-left, a consistent, labeled close button at top-right, the same hit area and spacing, Escape handling, backdrop policy, and focus handling. Keep footer buttons for task decisions such as **Cancel**, **Done**, or **Select**, not as the only way out. Preserve the existing busy-analysis confirmation in DefectPanel as a close policy within the shared shell.

### UX-02 — Dialogs do not share focus and dismissal behavior — P1

**Evidence:** [`Modal.tsx`](apps/web/src/Modal.tsx) traps Tab, sets initial focus, restores focus to its trigger, locks page scrolling, and supports Escape/backdrop. [`FolderPicker.tsx`](apps/web/src/FolderPicker.tsx) only focuses its dialog and handles Escape/backdrop. [`DefectPanel.tsx`](apps/web/src/DefectPanel.tsx) handles Escape but has no focus trap or restoration. [`PrPanel.tsx`](apps/web/src/PrPanel.tsx) handles Escape on the backdrop. Several panels implement their own partial keyboard handling.

**Impact:** Keyboard and screen-reader users encounter different navigation rules in visually similar dialogs. Focus can move behind an open dialog, and closing a dialog may leave focus in an unexpected place.

**Recommendation:** Route modal panels through the shared shell and define consistent focus behavior. Give nested confirmation/detail dialogs an explicit parent-child Escape rule so one Escape closes only the topmost layer.

### UX-03 — Multiple feature dialogs can be opened at once — P1

**Evidence:** [`App.tsx`](apps/web/src/App.tsx) stores independent open flags for Defects, PRs, Profiles, Tasks, Build, Campaigns, Releases, Search, Hotspots, Insights, Investigations, and other dialogs. Navigation actions set one flag without closing other panels. Each panel renders a modal backdrop at the same stacking level.

**Impact:** Keyboard shortcuts or repeated navigation can leave multiple modal dialogs mounted. The visible top dialog can obscure another, while both may announce themselves as modal and handle Escape.

**Recommendation:** Use one active-dialog state (with explicit child-dialog support only where needed), or close the current dialog before opening another. Preserve transitions that pass context, such as Release Board → Build Feature.

### UX-04 — The main workspace is squeezed at common laptop widths — P1

**Evidence:** [`styles.css`](apps/web/src/styles.css) fixes the desktop columns at 300px (controls) and 400px (conversation/evidence), with only the center column flexible. The layout remains three columns until 1000px, so widths just above the breakpoint leave little space for the canvas and header. At 1000px and below it abruptly changes to a tall, stacked layout.

**Impact:** Users get a cramped canvas near the breakpoint, then a major change in navigation and scrolling just below it. The persistent sidebars compete with the primary map for space.

**Recommendation:** Make the side panes collapsible or resizable, set fluid width bounds, and use a gradual responsive transition. Keep the selected repository, map, and conversation easy to reach when panes collapse.

### UX-05 — Narrow-screen grid does not name the right pane — P1

**Evidence:** The narrow-screen grid template in [`styles.css`](apps/web/src/styles.css) declares areas `h`, `s`, `m`, and `d`, but the conversation/evidence aside uses `grid-area: r`.

**Impact:** The right pane is not assigned to the declared mobile grid area and can be auto-placed into an implicit row, making its order and sizing less predictable on narrow screens.

**Recommendation:** Make the responsive template and the pane’s grid-area name agree, then explicitly define the narrow-screen order and height for conversation and evidence.

### UX-06 — Half of the right pane is reserved for evidence when there is none — P2

**Evidence:** [`styles.css`](apps/web/src/styles.css) gives `.right` two equal `minmax(0, 1fr)` rows. [`App.tsx`](apps/web/src/App.tsx) always renders the Evidence section, but its main code card only appears when a code item is selected.

**Impact:** In the common state with no code open, the chat is limited to half of a 400px-wide pane while the other half is largely empty. This weakens the primary ask-and-answer flow.

**Recommendation:** Let conversation use the available height until evidence exists. When evidence is open, offer a resizable split or a clearly labeled, dismissible evidence drawer. Keep evidence available without permanently reserving half the space.

### UX-07 — Setup and advanced work compete for attention in the same shell — P2

**Evidence:** [`App.tsx`](apps/web/src/App.tsx) places repository selection/indexing, concept discovery mode and extraction, hosted-model approval, exceptions, element selection, investigation saving, and a long list of analysis/work/release tools in the same workspace. The first four sidebar sections remain present regardless of task stage; advanced tools live in four navigation menus.

**Impact:** New users must distinguish setup from ongoing work and infer which step comes next. Experienced users repeatedly see setup controls even after indexing, while important features require remembering which menu contains them.

**Recommendation:** Present a short, state-aware setup sequence until a repository is ready, then make repository controls compact and persistent. Keep every feature, but organize secondary actions around the current task and expose them through a consistent tool finder or clearly grouped workspace navigation.

### UX-08 — The header navigation mixes product areas with duplicated labels — P2

**Evidence:** [`App.tsx`](apps/web/src/App.tsx) groups actions under Explore, Health, Work, and Releases. “Releases” appears both as a menu title and as an item within that menu. The settings destination is represented by a bare gear glyph; several menu entries depend on `title` text for explanation.

**Impact:** Users must open menus to discover available tasks, and the duplicate Releases label makes the distinction between release setup, board, and lens unclear. Explanatory titles are not reliably available to touch or keyboard users.

**Recommendation:** Use task-oriented labels that distinguish the three release actions, add persistent accessible names to icon-only controls, and make feature discovery possible without relying on hover tooltips.

### UX-09 — Repository path has no visible field label — P2

**Evidence:** [`App.tsx`](apps/web/src/App.tsx) labels the repository input with the visually hidden text “Absolute repository path”; the visible prompt is only an example filesystem path.

**Impact:** The field’s purpose is not obvious once the placeholder disappears after typing, and the example path can be mistaken for the required format rather than the current value.

**Recommendation:** Show a visible “Repository path” label and retain the example as helper text. Keep Browse and Index visually grouped as actions for that field.

### UX-10 — Conversation example prompts bypass the composer — P2

**Evidence:** [`ChatPanel.tsx`](apps/web/src/ChatPanel.tsx) wires each example button directly to `onSend(x)`, while regular questions go through the textarea and Send action.

**Impact:** Selecting an example submits immediately, so users cannot review or edit the suggested prompt first. The two ways of starting a conversation behave differently.

**Recommendation:** Put the selected example into the composer and focus it. Keep an explicit one-click submit only if it is presented as a separate, clearly labeled “Ask this” action.

### UX-11 — Selected map references can disappear from the visible context — P2

**Evidence:** [`ChatPanel.tsx`](apps/web/src/ChatPanel.tsx) displays at most six selected referent chips and then reports only “+N more”.

**Impact:** The user cannot inspect or remove a particular hidden reference from the conversation context, even though those references affect the next answer.

**Recommendation:** Provide an expandable “N selected” control with the full removable list, plus a clear-all action. Keep the compact chip row for the common small selection.

### UX-12 — Canvas controls and explanations are spread across several bands — P2

**Evidence:** [`App.tsx`](apps/web/src/App.tsx) can show a caption/route explanation, form-specific controls, overlays and legends, a canvas toolbar, and a footer containing epistemic summary, legend, gaps, and hidden candidates. Which controls appear depends on the selected view type.

**Impact:** The primary map can be visually compressed by multiple horizontal control bands, and related controls move when the view changes. Users need to scan several regions to understand or adjust a visualization.

**Recommendation:** Keep the map controls in one predictable toolbar with progressive disclosure for advanced settings. Keep evidence-state guidance close to the map, and retain the full legends, gaps, and omitted-candidate details behind clearly named expandable sections.

### UX-13 — Modal titles can change while users are inside a workflow — P3

**Evidence:** [`ProviderWizard.tsx`](apps/web/src/ProviderWizard.tsx) builds the shared modal title from the typed provider name and current wizard step. The shared shell uses that title both visually and for the dialog’s accessible name.

**Impact:** The title changes as the user types or advances, which can cause repeated screen-reader announcements and makes the dialog identity less stable.

**Recommendation:** Keep a stable dialog name such as “Create provider”; show the provider name and current step in the dialog body/progress indicator.

## Consolidated design rules

1. Use one shared dialog shell and place every dialog close button in the top-right with the same icon, size, accessible name, and hit target.
2. Keep task decisions in the footer; do not make footer Close the sole exit.
3. Allow only one top-level dialog at a time; define a deliberate rule for nested dialogs.
4. Keep the main map and conversation primary. Collapse or resize supporting panes instead of reserving fixed desktop widths and heights.
5. Preserve every capability, but reveal setup and advanced controls when relevant and keep their navigation names consistent.
6. Make selections and context inspectable and removable before the next action uses them.

## Suggested order

Address UX-01 through UX-06 first because they affect repeat navigation, keyboard access, or the usable workspace area. Then simplify setup/navigation and conversation context (UX-07 through UX-12). UX-13 is a small accessibility refinement.
