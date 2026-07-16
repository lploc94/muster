# Plan: Sửa orchestration liveness và hợp nhất Runtime & Storage settings

## Trạng thái

**IMPLEMENTED — source/gates đã hoàn tất; còn manual Extension Host UAT/đóng gói VSIX**  
Ngày lập và triển khai: 2026-07-16

Plan này xử lý hai nhóm việc đã được audit:

1. Sửa bug/protocol sai khiến compound wait báo lỗi dư thừa, coordinator busy-poll và bị watchdog 5 phút ngắt.
2. Hợp nhất execution/resource caps về một nguồn sự thật, rồi mở đúng một setting runtime cần thiết trong khu vực Settings hiện là `Retention` mà không làm người dùng bị ngợp.

## 1. Kết quả sản phẩm mong muốn

- `delegate_task({ waitForCompletion: true })`, `delegate_tasks({ waitForLocalIds })`, `release_tasks({ waitForTaskIds })` và `continue_child({ waitForCompletion: true })` có wait semantics idempotent, tích lũy và không xung đột với standalone `wait_for_tasks` gọi dư.
- Sau khi barrier đã stage, tool response và host context nói rõ coordinator phải kết thúc turn; `get_task_status` không khuyến khích busy-poll.
- Timeout được hiển thị đúng là timeout, không còn generic forced interrupt / “Could not finish” không có nguyên nhân.
- Root task và delegated child dùng cùng một execution-policy resolver; không còn hai bản `DEFAULT_POLICY`.
- User chỉ thấy một runtime control: **Maximum uninterrupted agent run**. Không lộ milliseconds, lease TTL, bridge token TTL, ACP request timeout hoặc graph safety caps.
- Topic id `retention` được giữ để không phá webview state, nhưng label đổi thành **Runtime & Storage** và có hai section rõ nghĩa:
  - Agent runtime
  - History storage (advanced)
- Một task có thể tồn tại qua nhiều turn/wait trong thời gian dài; không có total task-lifetime watchdog giả danh `taskTimeoutMs`.

## 2. Bằng chứng và vấn đề hiện tại

### 2.1 Double-wait protocol bug

Chuỗi lỗi hiện tại:

```text
compound delegate/continue/release với wait field
  → stage { kind: 'wait_tasks', taskIds }
  → coordinator gọi standalone wait_for_tasks với opId khác
  → stageDisposition từ chối: disposition already staged with a different opId
  → agent hiểu nhầm wait chưa thành công và busy-poll get_task_status
  → backend turn không phát turnCompleted
  → turnTimeoutMs=300_000 abort turn
  → forced interrupted / needs_recovery / Could not finish
```

Các điểm source hiện tại:

- `stageCompoundWait` và các compound entry point: `src/task/engine-graph.ts`.
- Standalone `wait_for_tasks` gọi lại `stageDisposition`: `src/task/engine-graph.ts`.
- `stageDisposition` chỉ cho một disposition/opId: `src/task/transitions.ts`.
- Watchdog cố định 5 phút: `src/task/engine.ts`.

### 2.2 Execution policy bị duplicate và lệch tầng

- `DEFAULT_POLICY` được khai báo độc lập trong `engine.ts` và `engine-graph.ts`.
- Root và child có thể lệch behavior nếu một nơi được sửa mà nơi kia không được sửa.
- `DEFAULT_RESOURCE_LIMITS.maxTurnsPerTask=50` làm `ExecutionPolicyBounds.maxTurns=500` gần như không thể đạt trong production.
- `taskTimeoutMs` có tên như total task lifetime nhưng code chỉ kiểm tra live turn hiện tại.
- ACP prompt timeout, lease age, bridge credential TTL và run timeout là các con số độc lập; tăng một cap dễ làm cap khác hết hạn trước.

### 2.3 Content/result limit có nhiều nguồn

Các giá trị 16 KiB hiện xuất hiện ở:

- `DEFAULT_RESOURCE_LIMITS.maxResultBytes`
- `DEFAULT_LIMITS.maxResult`
- `TASK_RESULT_SUMMARY_MAX`
- default `projectPrompt(... maxChildResultBytes)`

Một số đường kiểm tra UTF-8 bytes bằng `Buffer.byteLength`, trong khi đường truncate dùng JS character count. Đây vừa là duplication vừa là semantic mismatch.

### 2.4 Settings hiện tại gây nhầm tên

- `muster.retention.maxTurnsPerTask=200` là số turn **được giữ lại** trên terminal task.
- `DEFAULT_RESOURCE_LIMITS.maxTurnsPerTask=50` là runtime/lifetime allocation cap.
- Hai field cùng tên nhưng khác nghĩa hoàn toàn.
- Custom Settings hiện có topic id `retention`; persisted view state lưu id này.

### 2.5 Claim HTTP 401 cần kiểm chứng riêng

Parent turn timeout hiện chỉ revoke credential theo đúng parent `turnId`; source không chứng minh timeout tự cascade revoke child token. Plan không coi 401 là root cause. Thay vào đó phải có regression test và audit metadata để xác nhận hoặc bác bỏ từng đường revoke.

## 3. Quyết định thiết kế đã chốt

### 3.1 Wait là disposition tích lũy theo kiểu monotonic union

Một helper chung xử lý mọi wait entry point:

```ts
mergeWaitDisposition(turn, requestedTaskIds):
  no disposition
    -> stage wait_tasks(requestedTaskIds)

  existing wait_tasks
    -> union stable/dedup(existing, requested)
    -> success, never shrink the barrier

  existing complete | fail | idle
    -> disposition conflict
```

Quy tắc:

- Cùng tập taskIds → success với `alreadyStaged: true`.
- Superset/subset/overlap → stable union, giữ thứ tự cũ rồi append id mới.
- Không cho một wait call xóa child đã được barrier chờ.
- Ownership validation vẫn chạy trước merge.
- Mỗi mutating op vẫn ghi operation ledger riêng để replay cùng `opId` giữ kết quả ổn định.
- `complete`/`fail`/`idle` vẫn là disposition loại trừ; không được wait merge đè lên.

### 3.2 Compound và standalone phải dùng cùng helper

Không chỉ vá `case 'wait_for_tasks'`. Helper phải được dùng bởi:

- `stageCompoundWait`
- `delegate_task(waitForCompletion)`
- `delegate_tasks(waitForLocalIds)`
- `release_tasks(waitForTaskIds)`
- `continue_child(waitForCompletion)`
- standalone `wait_for_tasks`

Điều này cũng cho phép hai singular `delegate_task(waitForCompletion: true)` trong cùng coordinator turn tích lũy hai child thay vì operation thứ hai rollback vì disposition conflict.

### 3.3 Wait vẫn commit khi backend turn kết thúc thành công

Plan không đổi invariant “staged disposition chỉ được apply khi turn thành công”. Không auto-abort backend ngay sau MCP wait vì cancellation hiện sẽ discard disposition.

Thay vào đó mọi successful wait response phải trả instruction máy đọc được:

```json
{
  "staged": true,
  "alreadyStaged": false,
  "waitTaskIds": ["task-..."],
  "nextAction": "end_current_turn",
  "doNotPoll": true
}
```

`get_task_status` khi caller turn đã có `wait_tasks` phải kèm:

```json
{
  "callerWaitStaged": true,
  "nextAction": "end_current_turn",
  "doNotPoll": true
}
```

### 3.4 Chỉ một user-facing runtime setting

Config mới:

```text
muster.execution.runLimit
```

Giá trị enum đề xuất:

```text
15m | 30m | 1h | 2h | 4h | 8h
```

- Default: `2h`.
- Không hỗ trợ `none` trong milestone đầu để vẫn có bound cho hung process.
- UI hiển thị label **Maximum uninterrupted agent run**; không dùng từ “turn” hoặc milliseconds.
- Đây là host ceiling và default cho root/child. Agent có thể yêu cầu ngắn hơn, không được vượt ceiling user chọn.
- Budget là wall-clock từ lúc turn promote, gồm backend init/tool execution và các prompt chờ trong cùng live turn; `waiting_children` không bị tính vì parent backend turn phải kết thúc trước khi task được park.
- Setting đổi chỉ áp dụng cho turn chưa promote. Running turn giữ deadline đã freeze.

### 3.5 Bỏ total task timeout giả

- Deprecate `taskTimeoutMs` khỏi public/coordinator schema.
- Dừng dùng `reconcileTaskTimeouts()` như một live-turn watchdog thứ hai.
- Task lifetime không bị giới hạn khi đang idle, chờ dependencies, chờ children hoặc qua nhiều turn.
- Nếu sau này cần tổng active-compute budget, thêm một concept mới có tên và accounting rõ ràng; không tái dùng `taskTimeoutMs`.

### 3.6 Timeout phụ phải derive từ effective run deadline

Khi turn promote, persist effective policy/deadline trên `TaskTurn`:

```ts
effectiveRunLimitMs: number;
runDeadlineAt: string;
```

Các resource phụ derive từ deadline đó:

- Engine watchdog: `runDeadlineAt`.
- ACP `session/prompt`: deadline + cancel grace + transport buffer.
- Bridge credential expiry: deadline + credential buffer; revoke sớm khi turn settle.
- Lease record: persist `expiresAt` theo deadline + cleanup buffer, thay cho global `MAX_LEASE_AGE_MS` cố định.
- Cancel grace và process kill escalation vẫn là hidden safety constants.

### 3.7 Giữ topic id, đổi presentation

- Giữ `SettingsTopicId = 'retention'` để persisted `activeTopicId` không cần migration.
- Đổi label `Retention` → `Runtime & Storage`.
- Không thêm tab mới.
- Runtime setting là section đầu; retention fields nằm trong section History storage và đánh dấu Advanced.

### 3.8 Rename retention setting gây nhầm

Config mới:

```text
muster.retention.maxRetainedTurnsPerTask
```

Thay cho:

```text
muster.retention.maxTurnsPerTask
```

Migration đọc setting:

1. Nếu key mới được user cấu hình rõ ràng → dùng key mới.
2. Nếu key mới chưa cấu hình nhưng key cũ có explicit value → dùng value cũ và best-effort persist sang key mới.
3. Nếu cả hai absent → default 200.
4. Key cũ được giữ deprecated một release rồi loại khỏi custom UI.

Label UI:

```text
Retained turns per completed task
Stored output per turn
```

## 4. Phạm vi và non-goals

### Trong phạm vi

- Wait idempotency/union, structured tool results và prompt prevention.
- Timeout classification/UX.
- Canonical execution policy và derived timeout/resource lifetimes.
- Runtime & Storage Settings, config migration và webview protocol/state migration.
- Rename retention setting để hết nhập nhằng.
- Consolidate result/content limit và max-turn layers có semantic trùng.
- Regression tests cho credential isolation/401.

### Ngoài phạm vi

- Cho user chỉnh depth, fan-out, batch size, retry count hoặc backend concurrency.
- Cho user chỉnh bridge token TTL, lease timeout, ACP timeout, lock wait hoặc cancel grace.
- Inactivity/heartbeat timeout dựa trên streaming event; có thể là milestone sau.
- Thiết kế “unlimited/no timeout”.
- Thay đổi outcome authority, permission mode hoặc task-type routing.
- Tối ưu toàn bộ Settings framework thành generic registry.

## 5. Workstream 1 — Orchestration correctness và liveness

### W1.1 — Viết red tests tái hiện lỗi

**Files:** `src/task/engine-graph.test.ts`, `src/task/lifecycle-runtime.test.ts`, có thể thêm fixture ACP nhỏ.

Test bắt buộc:

1. `delegate_task(waitForCompletion)` → standalone `wait_for_tasks` cùng child/opId khác → success, không đổi barrier.
2. Compound wait → standalone thêm child → union đúng.
3. Hai singular `delegate_task(waitForCompletion)` cùng parent turn → cả hai child tồn tại và barrier chờ cả hai.
4. `continue_child(waitForCompletion)` → redundant standalone wait → success.
5. `delegate_tasks(waitForLocalIds)` và `release_tasks(waitForTaskIds)` dùng cùng merge semantics.
6. Existing `complete`/`fail`/`idle` → wait vẫn conflict.
7. Replay từng opId trả ledger result cũ; không duplicate child/turn.
8. Stable order và dedupe taskIds.

### W1.2 — Thêm canonical wait merge helper

**Files:** `src/task/transitions.ts` hoặc module pure mới `src/task/wait-disposition.ts`; `src/task/engine-graph.ts`.

- Helper pure, không I/O.
- Tách ownership validation khỏi merge.
- Không dùng `canCreateTurn(parent)` cho standalone wait nếu operation không tạo turn mới; giữ cap check ở nơi thực sự allocate continuation.
- Trả metadata: `addedTaskIds`, `alreadyStaged`, `waitTaskIds`.

### W1.3 — Cải thiện tool contract

**Files:** `src/bridge/server.ts`, `src/task/engine-graph.ts`, coordinator tool docs/tests.

- Tool descriptions nói rõ compound wait đã arm barrier.
- Mọi wait success trả `nextAction=end_current_turn` và `doNotPoll=true`.
- Redundant wait là success, không phải generic MCP error.
- Conflict với complete/fail có structured code `disposition_conflict` và current disposition kind.

### W1.4 — Ngăn busy-poll bằng context và status hint

**Files:** `src/task/host-context.ts`, `src/task/engine-graph.ts` (`get_task_status` projection), tests.

Coordinator rule cần nói rõ:

> Nếu compound response có `waitStaged: true`, barrier đã arm. Không gọi thêm `wait_for_tasks`, không loop `get_task_status`; kết thúc turn để host park task sang waiting_children.

Không hard-block `get_task_status` vì nó vẫn hữu ích cho chẩn đoán; response phải lặp lại `end_current_turn` hint khi wait đã stage.

### W1.5 — Timeout có nguyên nhân rõ

**Files:** `src/task/types.ts`, `src/task/engine.ts`, `src/task/derived-status.ts`, host snapshot/webview rendering.

Thêm additive metadata thay vì mở rộng status union ngay:

```ts
termination?: {
  kind: 'run_timeout';
  limitMs: number;
  deadlineAt: string;
};
```

- Timeout vẫn settle turn theo recovery-compatible path, nhưng UI hiện “Agent run reached the configured 2-hour limit”.
- Không gắn `interruptConfidence='forced'` như thể đây là user interrupt.
- Pending follow-ups vẫn freeze theo failure-safety hiện tại.
- Log `turn.settle.timeout` có taskId/turnId/backend/limit, không log token/prompt.

### W1.6 — Credential isolation audit

**Files:** `src/bridge/credentials.test.ts`, `src/task/engine*.test.ts`, logging ở bridge/engine nếu cần.

- Parent run timeout revoke parent credential, child credential vẫn verify được.
- Cancel/skip cascade revoke đúng child live turns.
- Extension deactivate là path duy nhất trong scope này được `revokeAll()`.
- 401 log chỉ ghi `credentialId`, callerTaskId, turnId và reason (`missing`, `expired`, `revoked`), tuyệt đối không ghi bearer token.
- Nếu test chứng minh timeout thật sự cascade revoke child, sửa như một bug riêng trong cùng workstream.

## 6. Workstream 2 — Hợp nhất cap và Runtime & Storage Settings

### W2.1 — Một nguồn sự thật cho execution policy

**Files:** module mới đề xuất `src/task/execution-policy.ts`, `engine.ts`, `engine-graph.ts`, `limits.ts`.

Tạo:

```ts
DEFAULT_TASK_EXECUTION_POLICY
TASK_EXECUTION_HARD_BOUNDS
resolveTaskExecutionPolicy(...)
resolveTurnRunDeadline(...)
```

- Xóa hai `DEFAULT_POLICY` local.
- Root create và child create gọi cùng resolver.
- Resolver nhận user `runLimit`, optional coordinator override và hidden hard bounds.
- Tool result create/delegate trả effective run limit để coordinator biết policy thực.

### W2.2 — Sửa max-turn layering

- `TaskExecutionPolicy.maxTurns=50` là default per-task budget.
- Một hard bound duy nhất, đề xuất 500, bảo vệ agent-supplied value.
- Loại `DEFAULT_RESOURCE_LIMITS.maxTurnsPerTask=50` hoặc đổi nó thành chính hard bound duy nhất; không để `min(50, requestedUpTo500)`.
- Turn count vẫn tính queued reservations để không oversubscribe.
- Tách vấn đề lịch sử: terminal/open retained rows không nên làm một reopened task bị brick vĩnh viễn; allocation cap phải dựa trên policy lifetime được định nghĩa rõ hoặc reset epoch khi reopen.

Quyết định milestone này: thêm `executionEpoch` trên task/turn và cap số turns trong epoch hiện tại; reopen bắt đầu epoch mới. Retention vẫn là storage concern độc lập.

### W2.3 — Hợp nhất result/content cap

**Files:** `limits.ts`, `dataflow.ts`, `engine.ts`, `transitions.ts`.

Tạo một canonical cap:

```ts
TASK_RESULT_MAX_BYTES = 16_384
TASK_ERROR_MAX_BYTES = 4_096
```

- Dùng UTF-8 byte-aware truncate helper.
- `complete_task`, `fail_task`, persisted TaskResult, child-result prompt projection và disposition clamp dùng cùng helper/cap.
- Compact handoff continuation có budget riêng ở prompt projection; không có source-agent summary hay hidden model call.
- Khi truncate, persist/project `truncated: true` hoặc marker; không cắt âm thầm.

### W2.4 — Hợp nhất user-interaction timeout nội bộ

Tạo hidden:

```ts
USER_INTERACTION_TIMEOUT_MS = 120_000
```

Dùng cho permission prompt, Grok ask, form elicitation và URL consent. Outcome semantics giữ riêng:

- permission → safe deny;
- ask → reject/cancel;
- elicitation → cancel.

Verification command timeout 120 giây không dùng constant này vì khác nghĩa.

### W2.5 — Freeze effective deadline khi promote

**Files:** task types/store migration, scheduler/promotion, `executeTurn`, ACP run options, credentials, lease.

Trong cùng durable promotion boundary:

1. Đọc live workspace `muster.execution.runLimit`.
2. Resolve optional task override, clamp không vượt user ceiling.
3. Persist `effectiveRunLimitMs` và `runDeadlineAt` lên turn.
4. Sau đó mới dispatch backend.

Reload dùng deadline đã persist, không recompute theo setting mới.

### W2.6 — Derive ACP/token/lease

- Thêm optional prompt deadline/timeout vào `RunOptions` và `AcpClient.prompt`.
- Bỏ hard-coded `session/prompt=1_800_000` khi engine đã cung cấp deadline.
- Credential expiry lấy từ persisted turn deadline + buffer; cleanup vẫn revoke ngay khi settle.
- Lease record thêm `expiresAt`; bỏ `MAX_LEASE_AGE_MS` cố định cho lease mới.
- Legacy lease thiếu `expiresAt` dùng compatibility fallback và PID liveness.
- Invariant test: không resource phụ nào hết hạn trước run deadline + cancel grace.

### W2.7 — Package configuration

**Files:** `package.json`, host configuration reader/tests, docs.

Thêm:

```json
"muster.execution.runLimit": {
  "type": "string",
  "enum": ["15m", "30m", "1h", "2h", "4h", "8h"],
  "default": "2h",
  "scope": "resource"
}
```

Rename/deprecate retention key theo §3.8.

Không expose:

- task timeout riêng;
- maxTurns/retries;
- depth/children/batch;
- concurrency;
- token/lease/ACP timeout;
- content/prompt sizes.

### W2.8 — Custom Settings UI

**Files:** `settings-topics.ts`, `SettingsPanel.svelte`, `settings-view-state.ts`, protocol/App/host settings helpers và tests.

- Giữ id `retention`; đổi label `Runtime & Storage`.
- Section Agent runtime: dropdown run limit, mô tả “Applies to new agent runs; running turns keep their current deadline”.
- Section History storage: hai field retention; collapsed/Advanced mặc định.
- Không cho nhập milliseconds.
- Draft state version bump; restore fail-closed.
- Refactor type/protocol name từ retention-only sang `RuntimeStorageSettingsSnapshot` hoặc thêm một contract domain rõ ràng; không nhét execution field vào type tên Retention.
- Bump host/webview protocol version nếu wire shape thay đổi.

## 7. Store và configuration migration

### 7.1 Store schema

Bump schema v5 → v6.

Đề xuất shape:

```ts
interface TaskExecutionPolicyV2 {
  maxTurns: number;
  maxAutomaticRetries: number;
  runTimeoutOverrideMs?: number; // absent => live host default at promotion
}

interface MusterTask {
  executionEpoch?: number;
}

interface TaskTurn {
  effectiveRunLimitMs?: number;
  runDeadlineAt?: string;
  executionEpoch?: number;
  termination?: { kind: 'run_timeout'; limitMs: number; deadlineAt: string };
}
```

Migration:

- Legacy exact default `turnTimeoutMs=300_000` + `taskTimeoutMs=1_800_000` → bỏ override, dùng host default cho future turns.
- Legacy non-default `turnTimeoutMs` → `runTimeoutOverrideMs`, sau đó vẫn clamp theo user ceiling khi promote.
- `taskTimeoutMs` không copy sang V2.
- Existing running turns khi migrate phải được xử lý an toàn:
  - nếu có live lease và thiếu frozen deadline, freeze theo legacy `turnTimeoutMs` để không đổi deadline giữa turn;
  - queued/future turns dùng setting mới.
- Missing `executionEpoch` → 1; reopen increment epoch.

### 7.2 VS Code configuration

- Dùng `configuration.inspect()` để phân biệt explicit value và default.
- Migrate retention key cũ best-effort ở workspace/resource scope tương ứng.
- Không tự ghi `muster.execution.runLimit` nếu user chưa cấu hình; package default là source of truth.
- Setting save thành công phải refresh authoritative snapshot như retention flow hiện tại.

### 7.3 Webview persisted state

- Giữ `activeTopicId='retention'` hợp lệ.
- Bump `SETTINGS_VIEW_STATE_VERSION`.
- Migrate/restore retention drafts cũ vào History section.
- Run-limit draft absent → hydrate từ host snapshot.

## 8. Thứ tự triển khai/landing

### PR A — Protocol bug và observability

1. Red tests double-wait.
2. Shared wait merge helper cho compound + standalone.
3. Structured tool result + host-context/status hint.
4. Timeout termination metadata và UI copy dựa trên legacy 5 phút.
5. Credential-isolation regression test.

PR A phải độc lập, không chờ Settings redesign. Nó cắt nguyên nhân gây busy-poll ngay.

### PR B — Canonical policies và cap consolidation

1. Tạo execution-policy module, xóa duplicate defaults nhưng giữ behavior trước refactor.
2. Hợp nhất max-turn layers và execution epoch.
3. Hợp nhất task result/error byte caps.
4. Hợp nhất hidden user-interaction timeout.
5. Thêm store v6 migration tests.

### PR C — Dynamic run deadline và dependent resources

1. Freeze effective deadline at promotion.
2. Dynamic ACP prompt deadline.
3. Credential expiry derive từ turn deadline.
4. Lease `expiresAt` derive từ turn deadline.
5. Bỏ enforcement `taskTimeoutMs` cũ.
6. Timeout/reload/invariant tests.

### PR D — Runtime & Storage Settings

1. `package.json` execution config + retention key migration.
2. Host snapshot/save contract.
3. Webview protocol/state migration.
4. Rename tab label + Runtime/History sections.
5. Docs, compile/dist và manual UAT.

Không gộp PR A vào refactor Settings lớn để bug fix có thể ship/review sớm.

## 9. Test matrix và verification gates

### Unit/contract tests

- Wait merge matrix ở W1.1.
- `stageDisposition` idempotency cũ không bị nới cho complete/fail/idle.
- Root và child resolve cùng default.
- Coordinator override ngắn hơn được giữ; dài hơn user ceiling bị clamp.
- Setting đổi không thay running deadline; queued turn dùng setting mới khi promote.
- Reload giữ persisted deadline.
- Timeout metadata, derived status và snapshot copy đúng.
- ACP timeout > run deadline; credential/lease không expire sớm.
- Parent timeout không revoke child credential.
- Reopen task tạo execution epoch mới và không bị lịch sử 50 turn brick.
- UTF-8 multibyte result/error clamp đúng byte cap.
- Old/new retention config migration precedence.
- Settings view state v1 → v2 restore drafts an toàn.

### Required commands

```bash
npm test
npm run compile
npm run check:svelte
npm run test:source-boundary
npm run test:settings-docs
npm run test:settings-webview
```

Chạy các evidence/settings gates bổ sung nếu touched contract yêu cầu.

### Manual UAT

1. Coordinator delegate child với `waitForCompletion`; agent gọi dư standalone wait → tool success, coordinator kết thúc turn, parent hiện `waiting_children`.
2. Hai singular compound delegates trong cùng turn → barrier chờ cả hai.
3. Chọn run limit 15m ở Settings; new turn snapshot/log hiển thị 15m, running turn cũ không đổi.
4. Chọn 2h; task chạy quá 5 phút không bị abort.
5. Force run-limit timeout ngắn trong test/dev config → UI hiện nguyên nhân timeout cụ thể.
6. Reload Extension Development Host giữa queued/running turns → deadline behavior đúng.
7. Retention key cũ có explicit value → UI mới hiển thị/migrate đúng.

## 10. Files dự kiến chạm

| Khu vực | Files |
|---|---|
| Wait protocol | `src/task/engine-graph.ts`, `src/task/transitions.ts` hoặc module wait mới, coordinator/graph/idempotency tests |
| Execution policy | `src/task/limits.ts`, module `execution-policy.ts` mới, `engine.ts`, `engine-graph.ts`, scheduler/types/store |
| ACP/credential/lease | `src/types.ts`, `src/backends/acp-client.ts`, `src/backends/acp-run.ts`, `src/bridge/credentials.ts`, engine lease helpers |
| Settings host | `package.json`, `src/host/retention-settings.ts` (refactor/rename), `src/extension.ts`, settings tests |
| Settings webview | `settings-topics.ts`, `settings-view-state.ts`, `protocol.ts`, `SettingsPanel.svelte`, `App.svelte`, e2e/tests |
| UX/status | host snapshot, derived status, task workspace/status components |
| Docs | `docs/SETTINGS.md`, `docs/TASK-MANAGEMENT.md`, `docs/CLI-COMMANDS.md` nếu timeout claim liên quan, contributor/evidence docs |

## 11. Acceptance criteria

### Orchestration bug

- [x] Compound wait + redundant standalone wait không trả disposition conflict.
- [x] Wait calls cùng turn tạo monotonic union và không bao giờ thu hẹp barrier.
- [x] Hai singular compound delegate operations cùng turn đều commit và barrier chờ đủ child.
- [x] Complete/fail/idle conflict behavior vẫn fail-closed.
- [x] Wait tool/status response luôn hướng coordinator `end_current_turn`, `doNotPoll=true`.
- [x] Parent turn kết thúc rồi chuyển `waiting_children`; không giữ ACP prompt chỉ để poll child.
- [x] Timeout có metadata/copy rõ, không bị trình bày như user interrupt chung chung.
- [x] Parent timeout không làm child MCP token 401 nếu không có cancel/deactivate path hợp lệ.

### Cap consolidation

- [x] Chỉ còn một canonical default execution policy được root và child dùng chung.
- [x] Không còn effective hard cap 50 vô hiệu hóa policy bound 500.
- [x] `taskTimeoutMs` không còn enforce live turn hoặc xuất hiện trong public/coordinator schema mới.
- [x] Task result/error/prompt projection dùng cùng UTF-8 byte caps/helper.
- [x] ACP prompt, bridge credential và lease lifetime không hết hạn trước frozen run deadline.
- [x] Reopen task không bị historical turn rows làm brick vĩnh viễn.

### Settings

- [x] Không thêm Settings tab; topic id `retention` vẫn restore được.
- [x] Tab label là `Runtime & Storage` với Runtime và History sections rõ ràng.
- [x] Custom UI chỉ expose một runtime control dạng enum, không milliseconds.
- [x] Default run limit 2h áp dụng cho cả root và delegated child future turns.
- [x] Running turn không bị setting change thay deadline giữa chừng.
- [x] Retention key/label mới phân biệt rõ retained history với execution max turns.
- [x] Graph, concurrency, token, lease, ACP, retries và content safety caps vẫn hidden.

### Release hygiene

- [x] Source tests, compile, Svelte check và settings/webview gates đều xanh.
- [ ] `dist`/VSIX được build từ đúng source và Extension Development Host đã reload trước UAT.
- [x] Docs không còn nói mặc định 5 phút hoặc mô tả `taskTimeoutMs` như total task lifetime.

## 12. Rủi ro và mitigation

| Rủi ro | Mitigation |
|---|---|
| Wait union vô tình che complete/fail conflict | Chỉ merge khi existing kind là `wait_tasks`; table tests exhaustive. |
| Operation ledger replay lệch disposition union hiện tại | Ledger giữ result per op; tool status trả current union; test replay theo nhiều thứ tự. |
| Timeout dài làm token sống lâu | Token scoped root/task/turn/actions, revoke ngay khi settle; expiry derive từ deadline. |
| Lease dài làm PID reuse giữ stale work | Persist `expiresAt`, check PID liveness và deadline; không dùng age constant mơ hồ. |
| Setting đổi làm behavior không deterministic | Freeze effective limit/deadline trong durable promotion commit. |
| Migration không biết legacy 5m là explicit hay default | Chỉ exact legacy default pair được coi là default; non-default giữ override; document edge case. |
| Rename retention config mất user value | `inspect()` old/new precedence + migration tests + one-release deprecated fallback. |
| Settings UI phình | Một dropdown runtime; History fields nằm Advanced; mọi safety cap khác hidden. |
| PR quá lớn | Landing thành PR A/B/C/D với PR A ship độc lập trước. |

## 13. Các cap cố ý không đưa vào Settings

Các giá trị sau là engine invariants, chỉ log effective diagnostics khi cần:

- graph depth/fan-out/batch;
- hard max turns và automatic retries;
- global/root/backend concurrency;
- result/error/prompt/context sizes;
- ACP transport buffer;
- bridge credential lifetime/buffer;
- lease expiry/cleanup buffer;
- cancel grace/kill escalation;
- store lock wait/retry;
- permission/elicitation timeout;
- verification/model/git probe timeouts (model switch tự thân không có model-call timeout);
- ID, path, presentation và file-import bounds.

User không cần hiểu các biến này để làm task chạy lâu. Chúng phải tự nhất quán từ canonical policy hoặc giữ tách biệt khi thật sự khác semantics.
