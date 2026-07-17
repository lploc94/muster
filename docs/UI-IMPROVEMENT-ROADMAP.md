# UI Improvement Roadmap

**Status:** Deferred product UI inventory recorded by **M014**.  
**Scope rule:** M014 ships deterministic visual baselines + blocking visual CI only.
The items below are **not implemented** in M014 and must not expand M014 into a
product redesign.

Use this document to seed later milestones. Every item carries evidence, priority,
user impact, acceptance direction, and a proposed milestone boundary so planning
does not collapse into vague bullets.

## How to use

1. Pick a P1 item that retires a concrete accessibility or interaction risk.
2. Open a dedicated milestone/slice with vertical acceptance (browser and/or
   native as required by the item).
3. Keep visual baselines green via the compare/update split in
   [UI-VISUAL-REGRESSION.md](UI-VISUAL-REGRESSION.md); do not auto-update goldens
   in CI when product chrome changes.
4. Do not batch unrelated redesigns into a single “UI polish” milestone.

## Priority legend

| Priority | Meaning |
|----------|---------|
| **P1** | User-blocking accessibility, hit-target, motion, or theme/zoom gaps that affect daily task workflows. Prefer next UI milestone. |
| **P2** | Performance, density, or design-system consolidation that improves scale and maintainability after P1 risks are retired. |

## Deferred prioritized items

### UI-01: Task-list search and rename accessibility

- **Priority:** P1
- **Evidence:** `webview/src/components/TaskList.svelte` search `<input>` uses
  `placeholder="Search tasks…"` without an accessible name (`aria-label` /
  `<label>`). Rename controls expose some `aria-label`s (Save/Cancel/Rename), but
  focus-visible treatment is incomplete relative to Settings/icon-button patterns
  (`:focus-visible` exists on settings icon buttons; task-list search chrome does
  not guarantee equivalent keyboard focus rings).
- **User impact:** Keyboard and screen-reader users cannot reliably discover or
  operate task search and may lose rename focus context in the compact sidebar.
- **Acceptance direction:** Search input has a stable accessible name and
  description; rename edit field and confirm/cancel controls expose names, error
  text when invalid, and visible `:focus-visible` rings; Playwright a11y checks
  cover search + rename without requiring a visual redesign of the list.
- **Proposed milestone boundary:** **M015** (accessibility vertical slice) —
  ship search/rename a11y only; no task-list visual restyle beyond focus tokens.

### UI-02: Complete hit-target policy

- **Priority:** P1
- **Evidence:** Shared toolbar `.icon-btn` documents a 28×28 CSS-pixel minimum in
  `webview/src/app.css`, but callers override smaller hit areas (for example
  TaskList clear-search uses inline `width: 16px; height: 16px`). Settings
  `.settings-panel__icon-btn` uses 26×26. Policy is incomplete beyond the shared
  toolbar class.
- **User impact:** Compact chrome controls are easy to miss-click/miss-tap,
  especially at 320px sidebar width and on pen/touch hosts.
- **Acceptance direction:** Repository-wide minimum hit-target policy (document
  28px practical compact target; call out any WCAG 44px exceptions) applied to
  task list, composer, presentation, and settings icon controls; ban silent
  inline shrinks without an explicit densified pattern; contract tests or
  Playwright assertions sample critical controls.
- **Proposed milestone boundary:** **M015** or early **M016** — policy + fixes for
  interactive chrome only; not a global spacing rewrite.

### UI-03: Presentation reduced-motion handling

- **Priority:** P1
- **Evidence:** `webview/src/Presentation.svelte` `scrollToHeading` always uses
  `behavior: 'smooth'`. Global `prefers-reduced-motion` handling in `app.css`
  only disables the streaming cursor blink — it does not gate Presentation
  smooth scrolling.
- **User impact:** Users who prefer reduced motion still receive animated scroll
  jumps in long presentation documents, which can cause vestibular discomfort.
- **Acceptance direction:** Honor `prefers-reduced-motion: reduce` (and any host
  reduced-motion signal already used by the visual fixture) by using instant
  scroll (`auto`/`instant`) for heading navigation; add a Playwright or unit
  proof that reduced-motion path does not request smooth behavior.
- **Proposed milestone boundary:** **M015** — isolated Presentation motion fix;
  no presentation layout redesign.

### UI-04: Browser and native theme and zoom acceptance

- **Priority:** P1
- **Evidence:** M014 visual matrix covers synthetic browser dark/light/high-contrast
  tokens only (see [UI-VISUAL-REGRESSION.md](UI-VISUAL-REGRESSION.md)
  browser-versus-native proof boundary). It does **not** prove native VS Code
  theme contribution, forced-colors, or 200 percent text zoom inside the Extension
  Development Host.
- **User impact:** High-contrast and low-vision users may hit unreadable chrome
  or clipped controls that browser goldens never catch.
- **Acceptance direction:** Dual proof class — (1) browser fixtures for extension
  tokens remain supportive; (2) native host acceptance checklist for high contrast,
  forced colors, and 200% text zoom on main webview + Presentation with a
  PASS/FAIL/ENVIRONMENT BLOCKED ledger. Do not pretend PNG goldens alone close
  native zoom/theme risk.
- **Proposed milestone boundary:** **M016** (native acceptance milestone) after
  M015 a11y P1s; may split browser forced-colors probes earlier if needed.

### UI-05: Long-conversation benchmarks

- **Priority:** P2
- **Evidence:** Task transcripts render through webview thread state without a
  documented performance budget. Store/projection audits note non-incremental
  snapshot costs at large histories; no committed benchmark gate for
  long-conversation scroll/render.
- **User impact:** Long-running tasks become janky to scroll and re-focus,
  slowing recovery and review.
- **Acceptance direction:** Establish a measured benchmark (message count ×
  render/scroll interaction) in CI or a tracked script; only then introduce
  windowing, lazy history, or virtualization if the budget fails. Avoid
  speculative virtualization without numbers.
- **Proposed milestone boundary:** **M017** (performance) — benchmark first,
  conditional windowing second; no visual redesign.

### UI-06: Task-profile density

- **Priority:** P2
- **Evidence:** Settings Agents / task-profile editor is a full form surface in a
  multi-domain shell. Compact 320px webview and list-detail alternatives are not
  productized; density feedback shows up as scroll and field packing pressure in
  the current layout.
- **User impact:** Users editing many task profiles spend excessive scroll time
  and lose context between list and detail.
- **Acceptance direction:** Explore compact list-detail interaction for task
  profiles at 320px width with preserved host-owned save/fail-closed contracts;
  acceptance via Settings Playwright plus density checklist — not a new top-level
  Settings tab.
- **Proposed milestone boundary:** **M018** (Settings density) after M012-style
  domain shell remains stable; optional spike before commit.

### UI-07: UI primitive consolidation

- **Priority:** P2
- **Evidence:** Typography, focus rings, tooltips (`tip` action), buttons, and
  surface tokens are duplicated across `app.css`, Settings, Presentation, and
  composer components. M013/M014 improved local consistency but did not create a
  single primitive layer.
- **User impact:** Inconsistent focus/tooltip/button behavior increases a11y
  defects and slows every UI slice with one-off CSS.
- **Acceptance direction:** Consolidate primitives through future vertical slice
  work (button/focus/tooltip/surface tokens) rather than a global CSS rewrite.
  Each vertical slice lands one primitive family with tests and updates callers
  incrementally; visual matrix stays green via explicit baseline updates only
  when chrome intentionally changes.
- **Proposed milestone boundary:** **post-M014** multi-milestone track (suggest
  **M015+** piggyback or dedicated **M019** design-system slices) — never a
  single big-bang restyle milestone.

## Explicit non-goals for M014

- No product redesign, new Settings domains, or global CSS rewrite in M014.
- No expansion of the visual matrix beyond the bounded eight-case cap to “cover”
  these product items.
- No automatic baseline acceptance when future milestones change chrome.

## Related docs

- [UI-VISUAL-REGRESSION.md](UI-VISUAL-REGRESSION.md) — compare, author, CI, artifacts
- [WEBVIEW.md](WEBVIEW.md) — chat + presentation product contracts
- [SETTINGS.md](SETTINGS.md) / [SETTINGS-DESIGN.md](SETTINGS-DESIGN.md) — host-backed settings
- [TASK-MODEL-UI-STATE-AUDIT.md](TASK-MODEL-UI-STATE-AUDIT.md) — task UI state baseline
