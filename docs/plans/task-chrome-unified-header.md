# Unified task chrome: header expand = task tree

**Status:** plan — APPROVED (codex-plan-review 20260715-004, 2 rounds)  
**Audience:** implementer (webview only; host snapshot unchanged)  
**Evidence date:** 2026-07-15  
**Depends on:** I1–I3 task tree nav (`docs/plans/task-tree-navigation-ui.md`, shipped)  
**Product intent:** One compact header card. Expand shows **owning-root children tree**, not lifecycle prose. Click child → that node becomes the header (atomic `selectTask`).

**Plan-review fixes (ISSUE-1…5):** owning-root id retention, mandatory expand-transition tests, **inline tree only** (no overlay fallback), narrow viewport e2e, full verification gate.

---

## 1. Purpose and non-goals

### Purpose

Replace the **two-tier chrome** (`.task-tree-nav` + `.task-workspace-banner`) and the **lifecycle-prose expand body** with a **single task chrome** that:

1. Collapsed: shows current task identity + primary actions in ≤2 rows.  
2. Expanded: shows **interactive task tree** (reuse I1–I3 rows/helpers).  
3. Selecting a tree row focuses that task (header becomes that node).  
4. Keeps feature parity for Parent/breadcrumb, counts, lifecycle menu, backend pill, export, handoff bar, draft contracts.

### Problem (current)

| Layer | Content | Issue |
|-------|---------|--------|
| `.task-tree-nav` | Parent/breadcrumb + Tasks summary → overlay | Extra height; tree discovery split from “details” |
| `.task-workspace-banner` | Goal + status menu + backend + export + chevron | Separate card |
| Expand body | Seal/lifecycle prose | Low value vs hierarchy |

### Non-goals

- Host/protocol/`TaskSummary` changes.  
- Side-by-side tree + chat.  
- Auto-focus on child attention.  
- Full ARIA treeview keyboard model.  
- **Overlay / dual tree interaction models** (retired in this plan — see §2.7).  
- Redesigning handoff chrome (stays below header).

---

## 2. Target UX

### 2.1 Information architecture

```
TaskWorkspace (focused task)
├── .task-chrome                          ← single card
│   ├── .task-chrome__bar                 ← always visible
│   │   ├── identity: role icon + goal
│   │   ├── lifecycle status menu
│   │   ├── backend pill
│   │   ├── export
│   │   └── expand chevron (if showTaskNav)
│   ├── .task-chrome__meta                ← if showTaskNav
│   │   ├── Parent / breadcrumb (I3 wide|narrow)
│   │   └── Tasks n · active · need you   ← toggles treeExpanded
│   └── .task-chrome__tree                ← when treeExpanded
│         └── inline scrollable rows (reuse treeRows)
├── handoff bar (unchanged)
├── ChatThread (no scroll lock for this feature)
├── action panels / Composer
```

### 2.2 Collapsed chrome

**Row A — identity + actions**

| Element | Behavior |
|---------|----------|
| Role icon | `taskRoleIcon(focused.role)` |
| Goal | Truncated; tip = full |
| Lifecycle menu | Existing |
| Backend pill | Existing |
| Export | Existing |
| Expand chevron | When `showTaskNav`; toggles `treeExpanded` |

**Row B — hierarchy meta (only if `showTaskNav`)**

| Element | Behavior |
|---------|----------|
| Parent / breadcrumb | I3: `@media (min-width: 320px)` breadcrumb; below that Parent only |
| Tree summary chip | `formatTaskTreeSummary`; toggles `treeExpanded`; `aria-expanded` |

Collapsed height: ~36–56px with meta; ~32–40px solitary root.

### 2.3 Expanded body = inline task tree only

When `treeExpanded && showTaskNav`:

1. Render **inline** tree in `.task-chrome__tree` (`id="task-chrome-tree"`).  
2. Reuse I3: forest, `expandPathInCollapsed`, twistie, role icons, runtime labels.  
3. **Activate row** → `navSelectTask(id)`. Stay expanded per §2.6.  
4. **Escape** → `treeExpanded = false`.  
5. Max-height: `min(40vh, 280px)` + overflow auto inside tree region.  
6. **No overlay panel** for shipping. Remove `treePanelOpen`, overlay markup, overlay CSS path, and `scrollLocked` wiring used only for that panel.

### 2.4 Lifecycle prose relocation

| Content | Home |
|---------|------|
| lifecycle headline/detail | Tooltip on status button |
| Orchestration / outcome / continuation | Muted ≤2 lines under tree when expanded; tips when collapsed |

### 2.5 Solitary root

No meta row, no expand chevron, no empty tree.

### 2.6 Expansion retention (owning-root identity) — normative

**Do not** use “focused ∈ subtree && length > 1” alone (always true after any multi-node snapshot).

**Required algorithm** (pure helper mandatory):

```ts
// webview/src/lib/task-tree.ts
export function owningRootIdFromSubtree(
  focusedId: string,
  subtree: readonly { id: string; parentId: string | null }[],
): string | null

export function shouldKeepTreeExpanded(input: {
  wasExpanded: boolean;
  previousOwningRootId: string | null;
  nextOwningRootId: string | null;
  nextShowTaskNav: boolean; // parentId or multi-node
}): boolean
// true iff wasExpanded && nextShowTaskNav
//   && previousOwningRootId != null
//   && previousOwningRootId === nextOwningRootId
```

**Owning root id:** DFS root of `subtree` (node with `parentId` null or parent not in subtree set) that is ancestor of `focusedId`; equivalently first node in host DFS list when host guarantees root-first order — **prefer compute from parent links** for robustness.

**UI state:**

- `treeExpanded: boolean`  
- `expandedOwningRootId: string | null` — set to current owning root when user expands; clear when collapse  

**On focus / snapshot apply (effect):**

1. Compute `nextRoot = owningRootIdFromSubtree(focused.id, subtree)`.  
2. If `shouldKeepTreeExpanded({ wasExpanded: treeExpanded, previousOwningRootId: expandedOwningRootId, nextOwningRootId: nextRoot, nextShowTaskNav })` → keep `treeExpanded=true`, set `expandedOwningRootId=nextRoot`.  
3. Else → `treeExpanded=false`, `expandedOwningRootId=null`.  
4. Draft mode / no focus → collapse + clear.

**User expand:** `treeExpanded=true`, `expandedOwningRootId=nextRoot`.  
**User collapse / Escape:** both clear.

### 2.7 Overlay retired

- Delete dual interaction model.  
- Inline scroll only.  
- `ChatThread` no longer takes `scrollLocked` from tree chrome (prop may remain for other uses; do not pass true from tree).  
- Out of scope: reintroducing overlay.

### 2.8 Accessibility

- Chevron + summary: `aria-expanded={treeExpanded}`, `aria-controls="task-chrome-tree"`.  
- Tree: `role="region"`, `aria-label="Current task tree"`.  
- Rows: native buttons; focused `aria-current="page"`.  
- Escape collapses.

### 2.9 Tokens / density

One card with existing banner tone border. Row min-height 28px; indent cap depth 4.

---

## 3. Feature parity checklist

| Feature | After |
|---------|--------|
| Parent / breadcrumb | Meta row |
| Counts chip | Meta row → expand |
| Tree + twistie + icons | Expand body |
| Atomic select | Unchanged |
| No auto-focus ask | Unchanged |
| Lifecycle / export / backend | Bar |
| Handoff | Below chrome |
| Lifecycle prose | Tips + muted under tree |
| Draft on hop | Unchanged |

---

## 4. Implementation steps

### Step 1 — Pure helpers (mandatory)

1. `owningRootIdFromSubtree` + `shouldKeepTreeExpanded` in `task-tree.ts`.  
2. Unit tests: same-root hop keep; different multi-node root collapse; draft/solitary collapse; not expanded stays collapsed.

### Step 2 — Markup (`TaskWorkspace.svelte`)

1. Single `.task-chrome` with bar + meta + tree.  
2. Remove standalone `.task-tree-nav` strip and banner-as-sibling structure.  
3. `treeExpanded` replaces lifecycle `detailsExpanded` body.  
4. Remove `treePanelOpen` overlay UI and related Escape/inert overlay paths.  
5. Wire retention effect per §2.6.

### Step 3 — CSS

1. `.task-chrome`, `__bar`, `__meta`, `__tree`.  
2. Inline tree max-height + scroll.  
3. Retire unused overlay-only rules when dead.  
4. Keep 320px breadcrumb media query.

### Step 4 — Secondary copy

Status button tips; muted under-tree lines.

### Step 5 — Tests (mandatory)

**Unit:** § Step 1 helpers — full table.

**E2E** (extend Owning-root suite):

1. Multi-node snapshot → `data-testid="task-chrome"` visible; no separate full-width dual chrome.  
2. Expand via summary or chevron → `#task-chrome-tree` / `task-chrome-tree` visible with rows.  
3. Expand body is tree rows, not seal prose as primary text.  
4. Click child → `focusTask` child; after child snapshot, header shows child goal **and tree remains expanded** (`task-chrome-tree` still visible).  
5. While expanded, post snapshot for **different** multi-node root → tree **collapses**.  
6. Expand then open draft / solitary root snapshot → collapses.  
7. Parent/breadcrumb still works.  
8. Composer draft survives expand/collapse and same-root hop.  
9. Escape collapses.  
10. **Narrow viewport** (`page.setViewportSize({ width: 280, height: 700 })`): Parent control available; breadcrumb not visible (display none / count 0 visible); export + status + goal still in DOM/visible; no horizontal page overflow (`document.documentElement.scrollWidth <= clientWidth`).  
11. Wide viewport (≥320): breadcrumb can show when parent path exists.

### Step 6 — Cleanup

- Update old e2e testids.  
- Note in `task-tree-navigation-ui.md`: chrome unified here.  
- Prefer `task-chrome`, `task-chrome-tree`; keep `task-tree-row`, `task-tree-summary`, `task-tree-parent` if still accurate.

---

## 5. Acceptance criteria

1. Single chrome card (no dual nav+banner strips).  
2. Expand = interactive tree, not seal prose primary.  
3. Click child → header is child.  
4. Parent/breadcrumb navigate up.  
5. Counts use existing §2.5 predicates.  
6. Escape collapses.  
7. **Stay expanded only when owning-root id unchanged** (not mere multi-node).  
8. Collapse on different root / draft / solitary.  
9. Parity: status menu, export, backend, handoff, icons, twistie.  
10. Solitary root: no empty expand.  
11. Unit + E2E (including narrow) green.  
12. Final gate: svelte-check + full webview e2e suite.  
13. No host/protocol changes.

---

## 6. Wireframe

### Collapsed multi-node

```
┌─────────────────────────────────────────────┐
│ ⧉ Coordinate work…  [Open ▾] [claude] [↗] [▾]│
│ ← Parent…     Tasks 4 · 2 active · 1 need you│
└─────────────────────────────────────────────┘
```

### Expanded → click child (same root, stays open)

```
┌─────────────────────────────────────────────┐
│ 🔧 Auth worker…     [Open ▾] [claude] [↗] [▴]│
│ Root › …            Tasks 4 · …             │
│ (tree still open; Auth aria-current)        │
└─────────────────────────────────────────────┘
```

---

## 7. Risks

| Risk | Mitigation |
|------|------------|
| Wrong stay-expanded | Owning-root id compare + unit tests |
| Height push | max-height + internal scroll only |
| Narrow clip | 280px e2e |
| Seal prose lost | status tip |
| Overlay leftover bugs | delete overlay path |

---

## 8. Files

| File | Change |
|------|--------|
| `webview/src/lib/task-tree.ts` | owningRoot + shouldKeepTreeExpanded |
| `webview/src/lib/task-tree.test.ts` | mandatory tables |
| `webview/src/components/TaskWorkspace.svelte` | chrome unify |
| `webview/src/app.css` | chrome styles; drop dead overlay |
| `e2e/muster-webview-state.spec.ts` | expand retention + narrow |
| `docs/plans/task-tree-navigation-ui.md` | pointer |

---

## 9. Verification

**Iterate:**

```bash
npx vitest run webview/src/lib/task-tree.test.ts
npx playwright test e2e/muster-webview-state.spec.ts -g "Owning-root task tree"
```

**Final gate (required before merge):**

```bash
npm run check:svelte   # or project-equivalent svelte-check
npx playwright test e2e/muster-webview-state.spec.ts
```

---

## 10. Checklist

- [ ] Helpers + unit tests  
- [ ] `.task-chrome` markup  
- [ ] Remove dual strip + overlay  
- [ ] Expand = tree; prose → tips  
- [ ] Owning-root retention effect  
- [ ] Escape  
- [ ] CSS density + max-height  
- [ ] E2E: hop stay open, other root collapse, narrow, draft  
- [ ] Final svelte-check + full e2e  
- [ ] Manual EDH  

---

## 11. Patterns

- VS Code Tree View select changes primary context  
- Progressive disclosure: secondary = hierarchy  
- Master–detail in-place header  

---

## 12. Out of scope

- Persist expand across reload  
- Overlay tree revival  
- Multi-select / DnD  
- Native VS Code TreeView contribution  
