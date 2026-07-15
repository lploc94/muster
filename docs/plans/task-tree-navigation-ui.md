# Task tree navigation UI (hybrid chrome + transient panel)

**Status:** I1–I3 shipped; chrome unified by `docs/plans/task-chrome-unified-header.md`  
**Audience:** implementer (webview + host snapshot)  
**Evidence date:** 2026-07-15  
**Decision source:** codex-think-about hybrid **C**

---

## 1. Purpose and non-goals

### Purpose

Replace non-interactive “Subtree:” badges with hybrid navigation:

1. Parent ↔ child location awareness  
2. Jump any node in **owning root** tree  
3. Preserve chat continuity (draft, scroll, single-task focus)

### Non-goals

- Side-by-side transcripts; third permanent screen; VS Code TreeView  
- Full ARIA collapse tree keyboard model (I3 optional)  
- Worker `report_progress` persistence; auto-focus on child attention  
- TaskSummary protocol bloat

---

## 2. Target UX

### 2.1 IA

```
inChat → TaskWorkspace
  ├── Nav chrome: ↑ Parent | Tree summary
  ├── Status banner
  ├── Transient Current Task Tree panel (I1 minimal list → I2 overlay)
  ├── ChatThread / actions / Composer
```

### 2.2 Nav chrome

| Control | Behavior |
|---------|----------|
| **↑ Parent** | If `parentId`; `selectTask(parentId)` |
| **Tree summary** | `Tasks {n} · {active} active · {attention} need you` → open tree |

Remove non-interactive badge strip.

### 2.3 Tree panel

- Overlay (I2 polish); I1 may ship functional list that can open/select nodes  
- Rows: role icon + goal + lifecycle/activity; indent by depth  
- Activate → atomic `selectTask` → close  
- Escape closes; preserve draft + scroll (I2 proof)

### 2.5 Count predicates (locked)

| Counter | Predicate |
|---------|-----------|
| **n** | `subtree.length` |
| **active** | `lifecycle === 'open' && effectiveRuntimeActivity === 'running'` |
| **need you** | `lifecycle === 'open' && activity ∈ {waiting_user, needs_recovery, awaiting_outcome}` |

Never count `running` as attention. Do not use `currentTurnActivity.state` (`waiting_you`).

---

## 3. Data

### Owning-root subtree

`owningRootId = walk parentId to null` (cycle guard).  
`snapshot.subtree = DFS preorder of owning root` (siblings: createdAt then id).  
Transcript/queue/ask stay focused-scoped.

### Live projection

- Membership change under owning root → rebuild full subtree projection  
- Child status change → reproject child + ancestors (childOrchestration)  
- Client: no invent structure from single-id patches alone

### Select atomicity

Prefer deferred focus until snapshot; or clear task-scoped UI on switch.  
No previous transcript under new task header.

Single post: `focusTask` only (no double hydrateSubtree).

---

## 4. Increments

### I1 — Foundation

- Owning-root snapshot + tests  
- Structural invalidation / ancestor reproject + tests  
- Atomic selectTask + single focusTask  
- Parent control; remove badge strip  
- **Minimal interactive tree** (root→child in I1)  
- E2E/unit: isolation, membership, aggregate  

### I2 — Panel polish

- task-tree helpers + §2.5 counts  
- Overlay, inert, Escape  
- Draft + **scroll** e2e  

### I3 — Optional polish

- Breadcrumb when wide  
- Collapse deep nodes  
- Role icons  

---

## 5. Acceptance (product)

1. Root→child transcript isolation  
2. Child→parent via Parent control  
3. Sibling via tree  
4. Nested depth indent  
5. Focused highlight  
6. Keyboard parent + tree  
7. No auto-focus attention  
8. Density: no wrap badges  
9. No TaskSummary bloat  
10. Draft preserve panel open/close + hop  
11. Scroll preserve panel open/close  
12. Atomic focus  
13. Live membership + parent aggregate  

---

## 6. Verification

```bash
npx vitest run src/host/snapshot.test.ts webview/src/lib/task-tree.test.ts
npx playwright test e2e --grep "task tree|subtree|parent|owning"
```
