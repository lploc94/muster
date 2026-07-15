# Presentation review panel enrichment

**Status:** plan — APPROVED (codex-plan-review 20260715-005, 4 rounds; ISSUE-1…10 fixed)  
**Audience:** implementer (host + presentation webview; additive protocol)  
**Evidence date:** 2026-07-15  
**Depends on:** existing presentation surface (`docs/WEBVIEW.md` §13)  
**Product intent:** Enrich the **read-only** presentation review tab (chrome + body) into a dense, VS Code-native document-review surface without becoming an editor or second chat.

**Think-about consensus locks (normative):** primary-row chrome always; secondary row when host metadata present; host-owned path/time; optional `summary`/`changeSummary` with display rules; inline collapsible Contents in P1; Mermaid pan/zoom evidence-led only; workspace-file owner binding fixed in P0.

**Plan-review fixes (ISSUE-1…10):** persisted envelope + `rootId` round-trip; separate coordinator/host/persisted shapes; collision-safe workspace IDs; full body-link route + fragment; canonical containment; legacy child-owner migration; producer guidance for kind/summary; secondary-row rule aligned with host-stamped `updatedAt`; multi-root `sourceFolderUri` binding; **phase gates aligned so Open source E2E is P1-only** (ISSUE-10).

---

## 1. Purpose and non-goals

### Purpose

1. Make presentation chrome **clear, dense, and review-oriented** (identity, revision, primary feedback CTA, secondary utilities).  
2. Make long plans/specs **navigable** (heading anchors + Contents, find, code copy).  
3. Complete **host-mediated** workspace markdown link and source-path behaviors already partial in chat.  
4. Add **optional additive fields** with **clear provenance** (coordinator vs host) without breaking restore or monotonic revision.  
5. Ship in **phased increments** with acceptance matrices and security invariants.

### Problem (current)

| Area | Today | Issue |
|------|-------|--------|
| Chrome | Title + `Revision N` + Open linked chat + status string | Sparse; no kind/context; status text noisy; not aligned with task-chrome density |
| Body | Markdown + bounded Mermaid | No TOC/anchors; no code copy; presentation body does not open workspace `.md` links |
| Model | Flat document + exact-key allowlists | No kind/source/freshness/summary; host vs agent ownership unclear |
| Persist | Webview `setState(document)` lacks `rootId`; host restore requires `rootId` | Round-trip broken / independent tests hide gap |
| Workspace open | Owner = focused child; path-derived IDs can collide | Linked chat fails; wrong panel reuse |
| Find | Not enabled | Users lack in-document search |

### Non-goals

- Inline edit, `contenteditable`, selection-to-edit, “Edit with Claude”.  
- Second conversation / composer inside presentation.  
- GitHub-style Approve / Request changes / durable Viewed.  
- Claude-style multi-version selector or full revision history store.  
- Computed diffs of previous markdown.  
- Raw HTML, scripts, images policy relaxation, CSP relaxation.  
- Raising Mermaid bounds without separate security review.  
- Side-by-side source editor (use **Open source** to VS Code editor instead).

---

## 2. Product contract (inherits WEBVIEW §13)

| Rule | Normative |
|------|-----------|
| Surface | Dedicated editor-column webview; **read-only review artifact** |
| Feedback | **Only** via **Open linked chat** → existing owner task; newer `upsert_presentation` refreshes same panel |
| Identity | `presentationId` + `ownerTaskId` immutable per panel binding (after migration applied at restore) |
| Updates | Accept only same identity + **strictly newer** `revision` |
| Isolation | Keyed by `(rootId, presentationId)` |
| Security | Strict CSP; sanitized markdown; host-mediated external links; bounded Mermaid + visible fallback; **canonical** path containment |
| Persistence | Webview state + host serializer share a defined **persisted envelope** including `rootId` |

This plan **extends** chrome/body/UX and optional fields; it does **not** replace §13.

---

## 3. Target UX

### 3.1 Chrome layout (normative)

**Primary row — always**

```
[Kind] Title…                    [vN]  [Copy]  [Open linked chat]
```

| Element | Behavior |
|---------|----------|
| Kind badge | `Plan` \| `Spec` \| `Document` from `kind` (default `Document`) |
| Title | Truncate + tooltip full title; panel tab title stays in sync |
| Revision pill | `v{n}` or `Revision {n}`; tooltip explains monotonic revision; flash/announce on accept of newer revision |
| Copy Markdown | Icon button; copies **markdown body only** (not hidden task ids) |
| Open linked chat | **Sole primary CTA**; short label ok; pending disables re-entry; success transient; failure visible until retry |

**Secondary row — when host `updatedAt` is present (always after P0 stamp) and/or `sourcePath` is present**

Normative density (ISSUE-8):

- **Coordinator upsert:** secondary row shows **Updated …** only (no source).  
- **Workspace file:** secondary row shows **relative path + Open source + Updated …**.

```
# generated
Updated just now

# workspace
docs/plans/foo.md  [Open source]     Updated 2m ago
```

| Element | Behavior |
|---------|----------|
| Source path | Workspace-**relative** display; host-owned only |
| Open source | Host opens editor for **panel-bound** source; **no path in webview payload** |
| Updated | Relative label + ISO tooltip; host-owned; refresh relative text without mutating persisted ISO |

**Narrow (≤~320–480px):** wrap actions; **title + revision + linked chat** remain visible.

**Status region:** compact live region (linked-chat pending/success/failure; “Updated to revision N”).

### 3.2 Body features

| Feature | Phase | Notes |
|---------|-------|-------|
| Typography / reading measure | P0 | ~760–820px prose comfort; shell scroll; tables/code horizontal scroll |
| Native find | P0 | `enableFindWidget: true` on presentation panel options |
| Copy whole markdown | P0 | Chrome action |
| Heading IDs + same-doc anchors | P1 | Deterministic, collision-safe |
| Contents outline | P1 | **Inline collapsible** only; `aria-expanded` / `aria-controls`; keyboard links; active section not color-only |
| Per-fence code copy | P1 | Button on each code block |
| Workspace `.md` links in body | P1 | Full route §5.2; fragment support §5.2 |
| Open source for workspace artifacts | P1 | Host-bound path only |
| Scroll retention on revision | P2 | Nearest matching heading anchor → proportional fallback |
| Optional `summary` lead | P0–P1 | Render only if present; no empty placeholder |
| Optional `changeSummary` UI | P2 or P3 | Only if brief/tool docs instruct producers; never invent diff |
| Mermaid pan/zoom | P3 evidence | Keep bounds + sanitize + fallback |
| Persistent wide TOC rail | P3 evidence | Only if long-spec usage proves need |

### 3.3 Explicit exclusions (UI)

- Inline comments / selection feedback boxes  
- Approve / Request changes  
- Viewed checkbox without durable coordinator-visible state  
- Version dropdown / history browser  
- Chat composer in presentation  
- Theme toggle (use VS Code theme)

---

## 4. Data model and trust boundaries (ISSUE-2)

Three **distinct** shapes. Do not collapse into one allowlist.

### 4.1 Coordinator upsert input (agent-facing)

Validated at: bridge `upsert_presentation` schema + coordinator tool dispatcher.

```ts
interface PresentationUpsertRequest {
  presentationId: string;
  ownerTaskId: string;   // must equal caller task; root coordinator policy unchanged
  opId: string;
  revision: number;
  title: string;
  markdown: string;
  kind?: 'plan' | 'spec' | 'document';
  summary?: string;        // ≤600 plain text
  changeSummary?: string;  // bounded; optional; may plumb before UI
}
```

**Reject** if request contains `sourcePath`, `sourceFolderUri`, `updatedAt`, `rootId`, or any unknown key.

### 4.2 Host-enriched document (webview-facing)

Validated at: webview protocol parsers + host → webview `presentationUpdate`.

```ts
interface PresentationDocument {
  presentationId: string;
  ownerTaskId: string;
  revision: number;
  title: string;
  markdown: string;
  kind?: 'plan' | 'spec' | 'document';
  summary?: string;
  changeSummary?: string;
  sourcePath?: string;       // host-only, workspace-relative (posix)
  sourceFolderUri?: string;  // host-only; vscode.Uri.toString() of workspace folder that owns sourcePath
  updatedAt?: string;        // host-only ISO-8601
}
```

Host stamps `updatedAt` **after** op authorization + idempotency fingerprint (exclude `updatedAt` from fingerprint).  
Host sets `sourcePath` + `sourceFolderUri` only on workspace-file path (never from agent).  
**Display** uses `sourcePath` only; `sourceFolderUri` is for host resolve/Open source (may still be present in webview state for restore fidelity — do not show raw URI in chrome).

### 4.3 Persisted envelope (serializer / restore) (ISSUE-1, ISSUE-9)

```ts
interface PersistedPresentationState {
  rootId: string;
  document: PresentationDocument;
  // Optional host-side mirror if webview document is stripped of URIs in future;
  // for P0, document.sourceFolderUri is the normative persisted folder binding.
}
```

| Layer | Responsibility |
|-------|----------------|
| Webview `setState` | Persist **envelope** (`rootId` + document including `sourceFolderUri` when workspace-backed). Host posts `rootId` with first update or dedicated init. |
| Host serializer | Restore only if envelope validates; unknown keys reject. |
| Multi-root restore (ISSUE-9) | Resolve Open source / relative body links by joining **`sourceFolderUri` + `sourcePath`**, not “first workspace folder that has that relative path.” If folder URI no longer in workspace → fail closed (open unavailable / dispose source actions; do not guess another root). |
| Legacy migration | If state is document-only (no `rootId`): attempt host re-bind using live panel map / presentationId → root; if impossible → dispose + empty waiting (fail closed). Legacy workspace docs without `sourceFolderUri`: attempt single-match rebind; if ambiguous multi-root → fail closed on Open source / relative resolve. |
| E2E | (1) Actual setState shape → serializer restore. (2) **Two workspace folders, same basename optional, same relative path** → distinct presentation ids; restore each; Open source hits the correct folder file. |

### 4.4 Field ownership summary

| Field | Owner | Where accepted |
|-------|--------|----------------|
| `kind`, `summary`, `changeSummary` | Coordinator | Upsert request only |
| `sourcePath`, `sourceFolderUri`, `updatedAt` | Host | Never in upsert; host-enriched document + persist |
| `rootId` | Host | Persisted envelope only; never agent |

### 4.5 Idempotency

Fingerprint uses coordinator request fields only. Stamp `updatedAt` after accept.

---

## 5. Host / protocol messages

### 5.1 Existing + chrome utilities

| Direction | Type | Purpose |
|-----------|------|---------|
| Host → webview | `presentationUpdate` | Host-enriched document (+ ensure webview has `rootId` for setState) |
| Webview → host | `revealLinkedChat` | Existing |
| Host → webview | `revealLinkedChatResult` | Existing |
| Webview → host | `openExternal` | Existing allowlisted URLs |
| Webview → host | `openPresentationSource` | Open **panel-bound** source in editor — **empty payload / panel id only** |

### 5.2 Body workspace markdown route (ISSUE-4) — P1 normative

**Webview → host**

```ts
// Prefer relative href + optional fragment; host resolves.
{ type: 'openWorkspaceMarkdown', href: string }
// href examples: "docs/a.md", "./other.md#section", "/workspace-relative.md#frag"
```

**Host resolution algorithm (normative)**

1. **Owner inheritance:** Use the **originating presentation panel’s** bound `ownerTaskId` / `rootId` — **not** currently focused chat task.  
2. **Parse** `href` into path + fragment (`#…`); validate fragment as safe heading-id charset (reject `javascript:`, etc.).  
3. **Base path (ISSUE-9):**  
   - If originating panel has bound `sourceFolderUri` + `sourcePath` → resolve relative path against **directory of that absolute source** (folder URI + relative path).  
   - Else if only `sourceFolderUri` → resolve against that folder root.  
   - Else (generated artifact, no source) → resolve against a **defined** single-folder policy: the workspace folder of the **originating panel’s last known source** if any; otherwise **reject relative links** (do not silently pick `workspaceFolders[0]` for multi-root). Absolute workspace-relative hrefs still require a chosen folder only when uniquely resolvable under canonical containment.  
4. **Containment (ISSUE-5):** After resolve, `fs.realpath` (or equivalent) both target and the **bound** workspace folder root; require target realpath is **inside** that folder realpath. Reject symlink escape.  
5. **Open:** Read markdown (clamp size), build host-enriched document with collision-safe id (§6.2), root owner, `sourcePath`, `sourceFolderUri`, `updatedAt`.  
6. **Fragment delivery:** After `presentationUpdate` / reveal panel, host posts:

```ts
{ type: 'navigatePresentationFragment', fragment: string }
```

Webview scrolls to matching heading id (after render tick). If fragment missing → no-op (no throw).

**Tests:** open `./other.md#section` while **another task is focused**; assert owner = origin root; fragment scrolls; symlink escape rejected.

### 5.3 Open source

Webview sends `openPresentationSource` with **no path**. Host reconstructs absolute path from **panel-bound `sourceFolderUri` + `sourcePath`** (not a search across all roots); re-check **canonical** containment; open in editor. If folder missing from workspace → fail closed (status/error), do not open a same-relative-path file from another root.

---

## 6. Workspace identity, owner, migration (ISSUE-3, ISSUE-6)

### 6.1 Owner binding (P0)

When creating/updating a **workspace** presentation:

- `ownerTaskId` = **owning root coordinator** for the context that opened the file (chat root of the requesting surface), never focused child.  
- If **no real root coordinator** exists: **fail closed** — open file in normal VS Code editor / markdown preview; **do not** create a presentation panel with synthetic owner (e.g. `"workspace"`).  
- Linked chat remains the only feedback path; without a real owner, presentation review is unavailable.

### 6.2 Collision-safe presentation IDs (P0 prerequisite)

Replace hyphen-colliding path slug as sole identity.

**Normative:** derive stable id within existing `STABLE_ID_PATTERN` + max length from:

- **collision-resistant folder key** = stable hash (or full encode) of `workspaceFolder.uri.toString()` — **not** bare folder basename (ISSUE-9)  
- normalized posix relative path within that folder  

Example approach (implementer may refine, tests lock behavior):

```
md.<hash(folderUri)>.<base64url-sha256(relativePath)[0..N]>
```

within max 128 chars and allowed charset. Same relative path under two roots → **two** presentation ids.

**Acceptance cases:**

- [ ] `docs/a-b.md` and `docs/a/b.md` → **different** ids  
- [ ] Very long paths → still unique (hash), not truncated collision  
- [ ] Reopening same file reuses same id/panel  
- [ ] Two workspace folders (same basename ok) both containing `notes/plan.md` → two panels; restore + Open source each hits correct root file  


### 6.3 Legacy migration (P0)

| Snapshot | Behavior |
|----------|----------|
| Valid envelope + root owner | Restore as today |
| Valid envelope + **child** owner (legacy workspace) | On restore: if root of that child still exists, **one-time migrate** owner → root before binding immutability for session; if root gone → dispose panel / empty |
| Document-only (no `rootId`) | Host attempts reattach via live registry; else dispose |
| Synthetic owner / no coordinator | Do not restore as review panel; dispose |

**Acceptance:** restored child-owned panel either migrates to working linked chat or fails closed — never permanent dead Chat button with immutable wrong owner.

---

## 7. Producer guidance (ISSUE-7)

### P0 — required for kind/summary to appear on generated plans

Update **in P0** (not deferred to changeSummary):

- Bridge tool description / JSON schema: optional `kind`, `summary`; document allowed values; **explicitly forbid** `sourcePath`/`sourceFolderUri`/`updatedAt`.  
- Coordinator brief / host-context: when calling `upsert_presentation` for plans/specs, set `kind: "plan"` or `"spec"` and optional one-line `summary`.  
- Tests or scripted fixture that coordinator-shaped upsert with `kind: "plan"` renders Plan badge.

### P2+ — changeSummary

Only when brief + schema already document the field and UI is ready; otherwise plumb silent.

---

## 8. Phased ship plan

### P0 — Review-ready foundation

1. **Persisted envelope** with `rootId` + webview setState migration + E2E setState→serializer.  
2. **Separate shapes** + atomic allowlists per boundary (upsert vs document vs envelope).  
3. **Collision-safe workspace ids** (folderUri hash + path hash) + legacy id compatibility tests.  
4. Persist **`sourceFolderUri` + `sourcePath`** for workspace-backed panels; multi-root restore/open uses that pair only (ISSUE-9).  
5. **Root-owner bind** + no-root fail-closed + **legacy child-owner restore migration**.  
6. Host stamp `updatedAt` on accept / workspace open; secondary row per §3.1.  
7. Compact chrome primary + secondary rules.  
8. Copy Markdown; `enableFindWidget`; typography/sticky density.  
9. **Producer guidance** for `kind`/`summary` (brief + tool schema).  
10. Optional `summary` lead if present.

**Acceptance**

- [ ] Actual webview setState shape restores via serializer (ISSUE-1).  
- [ ] Upsert rejecting host-only fields (incl. `sourceFolderUri`); document accepting host-only fields.  
- [ ] `docs/a-b.md` ≠ `docs/a/b.md` panel identity.  
- [ ] Two-root same relative path: distinct ids; restore preserves exact `sourceFolderUri`+`sourcePath` pair per panel (ISSUE-9; Open source E2E is P1).  
- [ ] Workspace open from focused child → root owner; reveal works when root exists.  
- [ ] No root coordinator → editor open, no presentation panel.  
- [ ] Legacy child-owned snapshot migrates or fails closed.  
- [ ] Generated upsert shows Updated secondary row; Plan badge when `kind` provided.  
- [ ] 280px: title+revision+chat visible; no horizontal page overflow.  
- [ ] Keyboard + high-contrast smoke.  
- [ ] Presentation integration tests green.

### P1 — Navigable artifact

1. Deterministic collision-safe heading IDs.  
2. Same-document anchors.  
3. Inline collapsible Contents + active section.  
4. Per-code-block Copy.  
5. Body workspace links per **§5.2** (owner inherit, base path, fragment message, **canonical containment**).  
6. Open source (bound path + canonical containment).  

**Acceptance**

- [ ] Duplicate headings unique IDs.  
- [ ] Contents keyboard + ARIA.  
- [ ] `./other.md#section` from source-backed presentation opens correct file with origin root owner while another task focused; fragment navigates.  
- [ ] Two-root same relative path: restored panels **Open source** each hits the correct folder file (ISSUE-9/10).  
- [ ] Two-root: relative body link from panel A does not open panel B’s folder copy.  
- [ ] Lexical `..` **and symlink escape** rejected (ISSUE-5).  
- [ ] No CSP change.  
- [ ] Long-doc + narrow Playwright pass.  
- [ ] `src/extension.ts` integration covered (touch set).

### P2 — Revision-aware review

1. Announce “Updated to revision N”.  
2. Anchor-aware scroll retention.  
3. `changeSummary` UI only if producer docs ready; else silent.  
4. Relative time refresh without mutating ISO.

**Acceptance**

- [ ] Stale revisions cannot alter metadata/scroll.  
- [ ] Newer revision same panel + announce.  
- [ ] Mermaid bounds/unsafe tests unchanged.  
- [ ] No synthetic diffs.

### P3 — Evidence-led backlog

- Previous-revision comparison (history bounds required).  
- Wide Contents rail.  
- Mermaid pan/zoom.  
- Read-progress.  
- Soft “Request changes” → prefill linked chat only.

---

## 9. Wireframes

### Generated plan (host stamps updatedAt; no sourcePath)

```
┌──────────────────────────────────────────────────────────┐
│ [Plan] Auth migration plan…          v3  [⎘] [Open chat] │
│ Updated just now                                         │
├──────────────────────────────────────────────────────────┤
│ (optional summary lead)                                  │
│ [Contents ▾]  1. Goals  2. Steps  …                      │
│ # Auth migration plan                                    │
│ … markdown …                                             │
└──────────────────────────────────────────────────────────┘
```

### Workspace file

```
┌──────────────────────────────────────────────────────────┐
│ [Document] plan.md…                  v2  [⎘] [Open chat] │
│ docs/plans/foo.md [Open source]           Updated 2m ago │
├──────────────────────────────────────────────────────────┤
│ …                                                        │
└──────────────────────────────────────────────────────────┘
```

---

## 10. Security invariants

| Invariant | Check |
|-----------|--------|
| CSP | Unchanged strict presentation CSP |
| Sanitization | No new raw HTML path |
| Links | External allowlist; workspace **canonical** containment before read/open |
| Paths | No webview-trusted absolute paths; Open source uses `sourceFolderUri`+`sourcePath` |
| Multi-root | Never resolve by scanning all roots for relative path alone |
| Symlinks | realpath inside **bound** workspace folder required |
| Mermaid | Bounds; sanitize SVG; fallback visible |
| Secrets | Copy only markdown body |
| Capabilities | `upsert_presentation` coordinator-gated; host fields not agent-writable |
| Provenance | Upsert schema rejects `sourcePath`/`sourceFolderUri`/`updatedAt` |

---

## 11. Files (expected touch set)

| Area | Paths |
|------|--------|
| Webview UI | `webview/src/Presentation.svelte`, `webview/src/app.css` |
| Protocol | `webview/src/lib/presentation-protocol.ts` (+ tests) |
| Markdown | `webview/src/lib/presentation-markdown.ts`, `webview/src/lib/markdown.ts` |
| Host manager | `src/host/presentation-manager.ts` (envelope, restore migration) |
| Panel | `src/host/presentation-panel-adapter.ts` (find, messages, setState rootId) |
| Chat link | `src/host/presentation-chat-link.ts` |
| Workspace md | `src/host/markdown-file-presentation.ts` (ids, resolve, realpath) |
| Extension wire | **`src/extension.ts`** (workspace open owner, body-link route, open source) |
| Tool/bridge | `src/bridge/server.ts`, `src/task/coordinator-tools.ts` |
| Producer docs | coordinator brief / host-context (`kind`, `summary`; later `changeSummary`) |
| Security | `src/host/webview-security.ts` only if needed (no CSP relax) |
| Tests | host presentation `*.test.ts`, protocol/markdown tests, `e2e/muster-presentation.spec.ts`, symlink + setState→restore |
| Product docs | `docs/WEBVIEW.md` §13 after ship |

---

## 12. Verification

**Iterate**

```bash
npx vitest run webview/src/lib/presentation-protocol.test.ts webview/src/lib/presentation-markdown.test.ts
npx vitest run src/host/presentation-manager.test.ts src/host/presentation-panel-adapter.test.ts src/host/presentation-chat-link.test.ts src/host/markdown-file-presentation.test.ts
npm run test:presentation-integration
```

**Final gate (each phase)**

```bash
# use project-equivalent if check:svelte name differs
npm run check:svelte || npx svelte-check --threshold error
npx playwright test e2e/muster-presentation.spec.ts
```

**Mandatory new cases**

**P0 cases**

- setState envelope → host serializer restore  
- id collision `a-b` vs `a/b`  
- multi-root two folders same relative path: distinct ids + restore preserves `sourceFolderUri`/`sourcePath`  
- child-focused open → root owner  
- no-root fail closed  
- legacy child-owner restore migration  
- upsert rejects host-only fields (incl. `sourceFolderUri`)  

**P1 cases**

- multi-root restore + Open source each correct root  
- multi-root relative body link stays in origin folder  
- body link + fragment with other task focused  
- symlink escape rejected

**Manual EDH**

- Coordinator upsert with `kind: plan` → Plan badge + Updated row.  
- Feedback → newer revision announce.  
- Workspace `.md` from chat → path + Open source.  
- Body link to sibling md#heading.  
- Narrow + Contents.

---

## 13. Risks

| Risk | Mitigation |
|------|------------|
| setState/host restore mismatch | Envelope + E2E ISSUE-1 |
| Host fields spoofed via tool | Separate upsert shape; reject host keys |
| Path id collision | Hash-based id + tests |
| Multi-root wrong file | Persist `sourceFolderUri`; never basename-only folder key |
| Symlink read outside workspace | realpath containment vs bound folder |
| Legacy dead Chat button | Migration or dispose |
| Kind always Document | P0 producer brief/schema |

---

## 14. Checklist

### P0

- [ ] Persisted envelope + setState/rootId  
- [ ] Three shapes + per-boundary allowlists  
- [ ] Collision-safe workspace ids (folderUri hash)  
- [ ] `sourceFolderUri` + multi-root restore/open  
- [ ] Root-owner + no-root fail-closed  
- [ ] Legacy child-owner migration  
- [ ] Host `updatedAt` + secondary row rules  
- [ ] Compact chrome + Copy + find + typography  
- [ ] Producer kind/summary guidance  
- [ ] Integration + unit + new cases green  

### P1

- [ ] Heading IDs + Contents  
- [ ] Code fence copy  
- [ ] Body workspace route §5.2 + fragment  
- [ ] Canonical containment + symlink test  
- [ ] Open source  
- [ ] extension.ts wiring  

### P2

- [ ] Revision announce  
- [ ] Scroll retention  
- [ ] changeSummary UI **or** explicit defer  

### Docs

- [ ] WEBVIEW §13 after ship  
- [ ] Plan status APPROVED after plan-review  

---

## 15. Patterns (sources)

| Pattern | Take | Leave |
|---------|------|-------|
| VS Code Markdown preview | Outline, find, secure preview | Live edit as primary loop |
| VS Code webview UX | Theme tokens, a11y, contextual actions | Wizards/promo |
| Claude Artifacts | Dedicated pane, version badge, copy | In-place edit, version explorer default |
| GitHub PR review | Context + navigation | Line comments, Approve, Viewed-without-store |
| Muster task chrome | Dense sticky bar | Hierarchy tree |

---

## 16. Out of scope

- Version history store / side-by-side old revision  
- Math/KaTeX  
- PDF/HTML export  
- Images in markdown  
- Raising Mermaid limits  
- Multi-artifact switcher UI  

---

## 17. Implementation constants

- `summary` max: 600  
- `changeSummary` max: 500–1000  
- Relative-time refresh: 30–60s or on visibility  
- Contents depth: H1–H3  
- Heading IDs: slug + numeric disambiguator  
- Workspace id: hash(folderUri) + hash(relativePath) within 128 / charset  
- `sourceFolderUri`: `vscode.Uri.toString()` of workspace folder  

---

## 18. Review trail

| Session | Outcome |
|---------|---------|
| codex-think-about-20260715-004 | CONSENSUS product direction |
| codex-plan-review-20260715-005 | APPROVE after R4; ISSUE-1…10 fixed |

Ready for P0 implementation.
