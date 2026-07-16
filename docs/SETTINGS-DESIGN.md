# Settings design

**Status:** Proposed target design; not the current implementation contract  
**Last updated:** 2026-07-16  
**Scope:** Muster Settings information architecture, naming, navigation, and responsive presentation

Related documents:

- [SETTINGS.md](SETTINGS.md) documents the current host-backed implementation contract and five-topic shell.
- [WEBVIEW.md](WEBVIEW.md) documents the surrounding chat webview.
- [MCP-INJECTION.md](MCP-INJECTION.md) documents the current and planned MCP/context-engine integration.

## Reader and intended outcome

This document is for contributors designing or reviewing a Muster setting. After reading it, a contributor should be able to:

- place a setting in a stable product domain instead of creating a new top-level tab by default;
- choose a label with the same conceptual breadth as its siblings;
- decide whether a setting belongs in native VS Code Settings, the custom Muster surface, or both;
- preserve the narrow-layout and accessibility properties of the existing webview.

## Decision summary

The target Settings taxonomy has four top-level domains:

1. **Agents**
2. **Execution**
3. **Connections**
4. **Data**

Only domains with actionable configuration are rendered. With today's implemented settings, the visible tabs should therefore be **Agents**, **Execution**, and **Data**. **Connections** appears only after at least one context-engine or MCP setting has a real host-backed contract.

The design reserves a maximum of five top-level tabs, but a fifth tab must represent a genuinely new product domain that cannot fit one of the four domains above. A feature, object type, implementation technology, or roadmap placeholder is not enough reason to add a top-level tab.

This taxonomy is an ownership contract. Every level has a defined job, and every top-level domain states what it owns, what it does not own, and the question a contributor must answer before placing a new setting there.

## Goals

- Keep the number of major tabs at five or fewer.
- Give siblings comparable conceptual breadth and detail.
- Group settings by the user concern they affect, not by the file, protocol, or configuration namespace that implements them.
- Keep navigation no deeper than two levels: domain, then settings group/detail.
- Make every visible navigation destination actionable; do not use empty `Coming soon` tabs.
- Keep all major tabs visible in one row at a 320-pixel webview width.
- Preserve keyboard navigation, screen-reader relationships, host-backed persistence, and topic-local feedback.
- Leave room for planned backend/model and context/MCP configuration without another taxonomy rewrite.

## Non-goals

This proposal does not by itself:

- rename public protocol fields, `muster.*` setting IDs, or task-management API fields;
- change which configuration scope owns a setting;
- replace the current five-topic shell before its implementation, tests, state migration, and documentation are updated together;
- turn roadmap ideas into durable settings without a host-owned read/write contract.

## Current-state audit

The current webview presents five peer tabs:

| Current tab | Actual content | Granularity issue |
|---|---|---|
| **Task Types** | A repeated-item editor for task presets | A large configuration object is treated as a top-level product domain. |
| **Permissions** | One default tool-permission policy | A single policy is placed beside much broader compound domains. |
| **Runtime & Storage** | One run limit plus two retention/output limits | Two unrelated product concerns are combined to save a tab. |
| **Models and CLIs** | Non-actionable placeholder | Two future resource groups occupy a top-level destination before they exist. |
| **Context and MCP** | Non-actionable placeholder | Two future connection groups occupy another top-level destination. |

Additional observations:

- `muster.verification.hostRun` exists in contributed VS Code configuration but has no custom-webview home.
- History retention is hidden under **History storage (Advanced)** even though it is a first-class data concern.
- Long labels and text badges cause the five-tab row to scroll horizontally at narrow widths. The current implementation handles containment correctly, but discoverability still depends on horizontal scrolling.
- The current ARIA tab roles, roving `tabindex`, ArrowLeft/ArrowRight wrapping, Home/End behavior, and topic-local state indicators are sound and should be retained.

## Design principles

### 1. Prefer product domains over configuration namespaces

Users should not need to know whether a value comes from `muster.execution`, `muster.permissions`, or `muster.retention`. The navigation answers user questions instead:

- Who performs the work? **Agents**
- How is the work allowed to run? **Execution**
- What external systems are attached? **Connections**
- What local information is kept? **Data**

Configuration namespaces remain implementation details and do not have to match the navigation one-for-one.

### 2. Keep peer labels parallel

Top-level labels are short plural or mass nouns naming broad product domains. Child labels name one concrete concern within that domain.

Prefer:

- `Agents`, `Execution`, `Connections`, `Data`
- `Run limits`, `Tool access`, `Verification`
- `History`, `Outputs`

Avoid:

- mixing one setting with a domain, such as `Permissions` beside `Runtime & Storage`;
- conjunction-heavy top-level labels such as `Models and CLIs`;
- redundant suffixes such as `Agent settings` or `Data configuration`;
- vague buckets such as `General`, `Other`, or `Advanced` at the top level.

### 3. Keep settings shallow and contextual

Use stacked sections when a domain contains a few scalar controls. Use an overview and child detail/list-detail view for repeated or extensive objects such as task profiles and MCP servers. Do not add a third navigation level.

Frequently changed task-specific choices should remain near the task workflow. Settings owns infrequently changed defaults and policies, not every contextual model/backend selection.

### 4. Progressive disclosure is not taxonomy

An expander may hide rare sub-options of a visible setting group. It must not hide an entire first-class domain merely because the page is long. In particular, History and Outputs belong visibly under Data; they are not collectively an `Advanced` group.

### 5. Native VS Code Settings remains canonical

VS Code's extension UX guidance recommends contributed configuration instead of a custom settings webview. Muster keeps a custom surface only where it adds meaningful product value, such as editing repeated task profiles, showing backend/model relationships, validating MCP connections, or explaining security-sensitive policies.

Every durable value still follows the host-backed contract in [SETTINGS.md](SETTINGS.md):

- contributed configuration defines the durable setting;
- the extension host owns reads, validation, and writes;
- the webview renders typed snapshots and waits for confirmed results;
- native VS Code Settings remains a supported inspection/editing path.

## Target information architecture

```text
Settings
├── Agents
│   ├── Task profiles
│   ├── Backends
│   └── Models
├── Execution
│   ├── Run limits
│   ├── Tool access
│   └── Verification
├── Connections
│   ├── Context engine
│   └── MCP servers
└── Data
    ├── History
    └── Outputs
```

## Taxonomy levels and responsibilities

Settings uses three conceptual levels. Only the first two are navigation; the third is the actual configurable value.

| Level | Function | Required breadth | Examples |
|---|---|---|---|
| **Domain** | Answers one broad product question and owns several related capabilities. This is a top-level tab. | Broad enough to remain stable as the product grows; normally contains two or more child groups over its lifetime. | Agents, Execution, Connections, Data |
| **Group** | Answers one concrete user question within a domain. This is a section or child detail. | One concern, object family, or policy family; comparable in scope to sibling groups. | Task profiles, Run limits, MCP servers, History |
| **Setting** | Changes one durable behavior or bound. This is a control, not navigation. | One value or one cohesive structured value with a single save contract. | Run limit, permission mode, maximum retained turns |

Do not promote a setting to a group merely to make it easier to find, and do not promote a group to a domain merely because its editor is large. Editor size affects presentation; it does not determine conceptual level.

### Level rules

**A domain must:**

- have one sentence that describes its product goal;
- own a distinct stage or concern in the Muster lifecycle;
- be understandable without knowing implementation terms;
- remain useful when individual settings are added, renamed, or removed;
- have a scope comparable to every other top-level domain.

**A group must:**

- own one user-recognizable concern inside its parent domain;
- contain related controls or one cohesive repeated-object editor;
- have a label that can also serve as the child page title;
- keep its save, reset, validation, and feedback contract local.

**A setting must:**

- have one observable effect;
- state its default, scope, constraints, and when a new value takes effect;
- be backed by contributed configuration and host validation before becoming mutable in the webview;
- remain a control inside a group instead of creating another navigation level.

## Domain ownership contract

Use this table as the first placement test for every new setting.

| Domain | Product goal | Owns | Does not own | Placement question |
|---|---|---|---|---|
| **Agents** | Define who can perform a task and the reusable defaults used to select that agent. | Task profiles/types, execution backends, installed agent CLIs, available models, agent-selection defaults. | Time budgets, tool approval policy, auxiliary MCP/context services, retained data. | Does this setting change **which agent/backend/model is selected** or the reusable profile used to select it? |
| **Execution** | Define how a selected agent run is constrained, authorized, and verified. | Run/time limits, tool access policy, host verification policy, future retry/concurrency policies that directly govern a run. | Agent identity/model choice, external service endpoints, history/output retention. | Does this setting change **how a run proceeds or what it is allowed to do** after an agent has been selected? |
| **Connections** | Define auxiliary external services made available to Muster or injected into a run. | Context-engine endpoints, external MCP servers, transports, enablement, health checks, connection-specific credentials references. | Agent CLIs/models that execute the task, runtime permission decisions, local retention. | Does this setting configure **an external supporting service or endpoint**, rather than the agent executor itself? |
| **Data** | Define what task/turn information Muster stores, retains, truncates, or removes. | History retention, stored outputs, future cache/log retention and persisted artifact limits. | Run duration, live transcript presentation, external connections, task export commands used contextually. | Does this setting change **what local information survives, for how long, or at what size**? |

The boundary between Agents and Connections is intentional:

- A backend/model that performs the task belongs to **Agents**.
- An MCP or context service that assists the selected agent belongs to **Connections**.

The boundary between Execution and Data is also intentional:

- A limit that stops or changes a running operation belongs to **Execution**.
- A limit that only changes what is retained after or between operations belongs to **Data**.

If one proposed control appears to affect two domains, identify its primary observable effect. Split it into separate settings when it actually represents two independently meaningful decisions. Do not create a compound top-level label to avoid choosing an owner.

### Agents

Purpose: configure reusable agent/task presets and the AI runtimes they can use.

Success condition: a user can determine and configure which agent implementation and model Muster will select for a kind of task.

Entry test: changing the value changes agent selection or a reusable selection profile; it does not change live-run policy.

| Child group | Content |
|---|---|
| **Task profiles** | Current task-type rows: ID, backend, optional model, role, brief kind, and description. |
| **Backends** | Future CLI discovery, installed/available status, executable selection, and backend defaults. |
| **Models** | Future model catalog, preferred/default model, and backend-specific availability. |

**Task profiles** is the preferred display name because the rows behave as reusable presets. Internal identifiers such as `task-types`, `taskType`, and `muster.taskTypes` can remain stable. If the product keeps **Task types** as the visible term, it must use that same term consistently in the overview, child title, actions, and help text.

Backends and Models belong here because they are inputs to the profile editor. They should not become separate top-level tabs unless their product scope grows beyond agent configuration.

### Execution

Purpose: control how an agent run proceeds and what it is allowed to do.

Success condition: a user can understand the limits, authorization policy, and verification behavior applied to a newly started run.

Entry test: changing the value affects a run after its agent/backend/model has already been resolved.

| Child group | Content |
|---|---|
| **Run limits** | `muster.execution.runLimit` and future run-budget controls. |
| **Tool access** | `muster.permissions.mode`; runtime approval cards remain in-session UI, not Settings. |
| **Verification** | `muster.verification.hostRun` and future verification-execution policies. |

**Tool access** is more precise than **Permissions** because the current policy affects agent tool requests, not VS Code permissions, account roles, or all security behavior.

### Connections

Purpose: configure external systems injected into or consulted by an agent run.

Success condition: a user can configure and validate auxiliary services without confusing them with the agent backend that performs the task.

Entry test: the configured object has an endpoint, transport, enablement, or health lifecycle and provides supporting capabilities to Muster or an agent.

| Child group | Content |
|---|---|
| **Context engine** | Planned endpoint, port/URL, availability, and connection test. |
| **MCP servers** | Planned external MCP server definitions, enablement, transport, and health. |

The extension-owned Muster Bridge is internal infrastructure. It should appear only if users have a meaningful and safe configuration or diagnostic action. Implementation details alone do not justify a visible setting.

### Data

Purpose: control locally retained task and turn information.

Success condition: a user can predict which information remains available and the storage bounds applied to it.

Entry test: changing the value affects persistence, retention, truncation, or cleanup without changing whether a live run may proceed.

| Child group | Content |
|---|---|
| **History** | `muster.retention.maxRetainedTurnsPerTask`. |
| **Outputs** | `muster.retention.maxStoredOutputChars`. |

Deprecated compatibility settings, including `muster.retention.maxTurnsPerTask`, remain migration details and do not receive controls in the custom surface.

## Current-to-target mapping

| Current location | Target location |
|---|---|
| Task Types | Agents → Task profiles |
| Models and CLIs → CLI discovery | Agents → Backends |
| Models and CLIs → preferred/catalog models | Agents → Models |
| Permissions | Execution → Tool access |
| Runtime & Storage → Agent runtime | Execution → Run limits |
| Native-only `verification.hostRun` | Execution → Verification |
| Context and MCP → context-engine configuration | Connections → Context engine |
| Context and MCP → external MCP configuration | Connections → MCP servers |
| Runtime & Storage → retained task history | Data → History |
| Runtime & Storage → stored output limit | Data → Outputs |

## Rendering by product maturity

Do not render navigation for unavailable domains or child groups.

### Current actionable shape

```text
Agents | Execution | Data
```

- Agents renders Task profiles.
- Execution renders Run limits and Tool access; Verification is added when the custom surface gains a host-backed snapshot/update path, or it links to the native setting until then.
- Data renders History and Outputs.

If a domain has only one actionable child, skip a redundant child navigator and render the child section directly.

### Planned shape

```text
Agents | Execution | Connections | Data
```

- Backends and Models appear inside Agents only when their persisted settings exist.
- Connections appears only when Context engine or MCP servers has a real control.
- A roadmap or release-notes surface, not primary Settings navigation, communicates future work.

## Layout and responsive behavior

### Shell

- Keep the Settings header and Back action fixed.
- Keep the major tab row fixed above the scrollable content region.
- Restore the most recently viewed valid domain and child group.
- Use equal-width top-level tabs when all labels fit; four short labels should fit in one row at 320 pixels.
- Do not rely on horizontal tab scrolling. If a future label cannot fit, improve the label or change the navigation presentation rather than hiding destinations off-screen.

### Domain page

Each domain page contains:

1. domain title;
2. one short description;
3. optional scope/status metadata;
4. child groups in priority order;
5. topic-local feedback and actions.

Do not repeat the selected domain label as both the tab label and an otherwise empty section heading. The headings below the domain title should be child groups such as **Run limits** or **History**.

### Child presentation

- Two or three small groups: stack them in a single scrollable column with section separators.
- Repeated objects or long editors: show a compact overview/list and open one child detail at a time.
- Wide editor/panel: a list-detail layout may use a narrow child navigation column and a detail pane.
- Sidebar/narrow editor: collapse list-detail into an overview followed by a child detail screen; keep the depth at two levels.
- The overview label that opens a child must exactly match the child page title.

### Status indicators

The top-level tab aggregates the most important state from its active children using this priority:

1. Saving
2. Error
3. Unsaved
4. Needs attention
5. Saved

At narrow widths, render a compact dot or icon instead of a text pill. Preserve the full text equivalent in `aria-label` and inside the owning panel. An inactive child must never render its detailed error inside another child.

## Controls and save behavior

- Use a toggle for a boolean setting such as host verification.
- Use radio choices when the descriptions and risk differences between a small set of mutually exclusive modes matter, as with Tool access.
- Use a select for compact enumerations such as Run limit.
- Use numeric input only when arbitrary values are valid and host bounds are visible.
- Use an explicit **Save changes** action for multi-field or repeated-object drafts such as Task profiles.
- Scalar settings may save on change if the host round trip is fast and failure feedback preserves the attempted value. Do not present a scalar as saved until the host confirms it.
- Keep Reset scoped to the owning child group and state clearly whether it restores product defaults or the last saved value.
- Show configuration scope as concise metadata such as `Workspace`; do not turn scope into a navigation category.

## Accessibility contract

The major-domain tabs continue to follow the WAI-ARIA tabs pattern:

- `role="tablist"`, `role="tab"`, and `role="tabpanel"`;
- `aria-controls`, `aria-labelledby`, and `aria-selected` relationships;
- one roving `tabindex="0"` on the selected tab;
- ArrowLeft/ArrowRight navigation with wraparound;
- Home/End navigation;
- Tab leaves the tablist for the active panel;
- automatic activation only while panels can appear without noticeable latency.

Child overview/detail navigation is ordinary navigation, not another ARIA tablist by default. Use buttons or links with clear current-state semantics and predictable focus restoration when returning from a child detail.

Color is never the only status signal. Dirty, error, saving, saved, risk, and diagnostic states retain text equivalents for assistive technology.

## Naming checklist

Before accepting a label, verify:

- Does it name a user concern rather than an implementation mechanism?
- Is it approximately as broad as its siblings?
- Is it understandable without the word `Settings`?
- Is it short enough for a narrow webview?
- Does it avoid `General`, `Other`, and top-level `Advanced`?
- Does a child label exactly match the child page title?
- Does the description explain effect and scope without repeating the label?
- Does the visible product term remain compatible with public API terminology, or is the difference explained?

## Placement decision for a new setting

Apply these questions in order. A setting proposal should record the answers in its plan or pull request.

### Step 1: Is it actually a setting?

- Is it a durable user preference, default, policy, or bound?
- Is it changed infrequently compared with the workflow it affects?
- Can its observable effect and effective scope be described in one sentence?

If not, place it in the contextual workflow, a command, a status/diagnostic surface, or product documentation instead of Settings.

Examples:

- Choosing a model for the task being composed is contextual UI.
- Choosing the default model used by reusable task profiles is a setting.
- `Test connection` is an action inside a Connections group, not a setting or top-level tab.
- A backend health result is status inside Agents → Backends, not durable configuration.

### Step 2: Which product question does it answer?

Use the first matching answer:

1. **Who performs the task, or which reusable profile selects them?** → Agents
2. **How may the selected agent run, and how is it constrained or verified?** → Execution
3. **Which auxiliary external service is attached or injected?** → Connections
4. **What local information is kept, truncated, cached, or removed?** → Data

If none fits, write the setting's user goal and primary observable effect before proposing a new domain. Do not use `General`, `Other`, or `Advanced` as a fallback.

### Step 3: Which group owns it?

- Reuse a group when the new setting answers the same concrete question as its controls.
- Add a group when at least two related controls are expected, or when one structured/repeated object needs a cohesive editor and save contract.
- Keep a single isolated scalar in the closest valid group; do not create a child navigator for one small control unless the separation is necessary for safety or comprehension.
- If two groups would both be plausible, choose the group containing the setting's primary effect and cross-link related settings where useful.

### Step 4: Which surface should render it?

- Use native VS Code Settings for every contributed scalar, enum, boolean, and otherwise natively editable configuration.
- Add it to the custom Muster surface only when the webview supplies material value: structured editing, relationships between values, connection validation, risk explanation, or coordinated draft/save behavior.
- Never create webview-only durable state for a product setting.
- Keep secrets in the appropriate VS Code secret/provider mechanism; a Settings control may select or reference a credential but must not persist raw secrets in ordinary configuration or webview state.

### Step 5: Does it justify new navigation?

A new child group requires:

- a distinct user question from its siblings;
- a stable name and clear owner;
- enough content for a cohesive section or structured editor;
- no need for a third navigation level.

A fifth top-level domain additionally requires:

- a broad product goal distinct from Agents, Execution, Connections, and Data;
- at least two credible child groups over the known roadmap;
- evidence that placing it in every existing domain would mislead users;
- confirmation that all five labels remain visible at 320 pixels;
- coordinated review of this design document and migration contract.

### Step 6: Define the setting contract

Before implementation, record:

| Required field | Question to answer |
|---|---|
| **User goal** | What outcome is the user trying to control? |
| **Observable effect** | What behavior changes when the value changes? |
| **Owner** | Which domain and group own it, and why? |
| **Non-owner** | Which plausible neighboring domain was rejected, and why? |
| **Scope** | User, machine, workspace, folder/resource, or another explicit scope? |
| **Effective time** | Immediately, next turn, next promoted run, next session, or after reload? |
| **Default and reset** | What is the safe default, and what does Reset restore? |
| **Validation** | Which types, bounds, dependencies, and failure cases apply? |
| **Surface** | Native Settings only, or native plus custom Muster UI? |
| **Persistence** | Which contributed setting and host snapshot/update contract own it? |

Only after these answers are stable should the setting receive a control in the custom webview.

### Step 7: Verify the placement

- Compare its breadth with every sibling group.
- Verify 320-pixel layout, keyboard navigation, state restoration, and topic-local errors.
- Verify that a hidden/unavailable future control does not create an empty navigation destination.
- Update this design document, [SETTINGS.md](SETTINGS.md), tests, and evidence claims together when the implemented taxonomy changes.

## Migration considerations

Changing the current shell requires a coordinated migration rather than label-only edits:

- map old topic IDs to new domain and child IDs;
- migrate `muster.settingsView.v1` active-topic state and preserve valid drafts;
- aggregate existing Task Types, Permissions, and Retention indicators at the new parent-domain level;
- keep host save contracts topic-local even when several topics share a domain page;
- update Playwright selectors and keyboard-order expectations;
- update the current five-topic contract in [SETTINGS.md](SETTINGS.md), documentation verifiers, and live-host evidence scenarios;
- preserve zero mutation for anything still unavailable during a staged rollout.

Suggested migration mapping:

| Old active topic | New domain | New child |
|---|---|---|
| `task-types` | `agents` | `task-profiles` |
| `permissions` | `execution` | `tool-access` |
| `retention` | `data` | `history` or the last active Data child |
| `models-and-clis` | `agents` | first actionable Backends/Models child; otherwise `task-profiles` |
| `context-and-mcp` | `connections` when actionable; otherwise `agents` | first actionable connection child or safe fallback |

Stable public setting IDs do not need to change with this navigation migration.

## Acceptance criteria for the redesign

- No more than four top-level tabs are needed for the currently known roadmap; the hard maximum remains five.
- Every visible top-level tab contains at least one actionable host-backed group.
- Top-level siblings are broad product domains; child siblings are concrete concerns.
- Runtime and storage no longer share a group.
- Task profiles, backends, and models share the Agents domain.
- Tool access and verification have an explicit Execution home.
- History and Outputs are visible Data children rather than one hidden Advanced bucket.
- All major tabs are visible without horizontal scrolling at 320 pixels.
- Current ARIA and keyboard behavior remains covered.
- Draft, error, saving, saved, and diagnostic states remain local to their owning child and aggregate truthfully to the parent domain.
- Native VS Code contributed configuration remains the durable source of truth.

## External references

- [VS Code extension Settings UX](https://code.visualstudio.com/api/ux-guidelines/settings) — use contributed settings, defaults, clear descriptions, and links instead of duplicating native Settings without need.
- [VS Code configuration contribution point](https://code.visualstudio.com/api/references/contribution-points#contributes.configuration) — categories, ordering, descriptions, scopes, enums, and native rendering behavior.
- [Android Settings pattern](https://developer.android.com/design/ui/mobile/guides/patterns/settings) — clear language, smaller related groups, overview/list-detail, shallow subscreens, and matching overview/detail labels.
- [Windows app settings guidance](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings) — minimize settings, group related controls, use a single-column layout, and use progressive disclosure sparingly.
- [Apple Human Interface Guidelines: Settings](https://developer.apple.com/design/human-interface-guidelines/settings) — minimize options, keep task-specific choices in context, use stable related panes, and restore the most recently viewed pane.
- [WAI-ARIA Authoring Practices: Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) — tab roles, relationships, focus, and keyboard behavior.
