# Plan: Chuyển toàn bộ dữ liệu Muster sang SQLite global storage

## Trạng thái

**COMPLETE — Phase 4 W1–W11 đã qua SQLite-only cutover, paging/patching,
multi-window convergence và release/UAT gates. Phase 5 được chốt thành 7 wave,
thực thi theo 3 batch hardening.**
Cập nhật: 2026-07-18

- Phase 1: **đã qua gate** — worker/RPC, schema bootstrap, global-storage registry,
  lock/crash/concurrent-open checks, packaged desktop smoke trên minimum/current
  host, old-host refusal và Remote SSH evidence đều xanh.
- Phase 2: **đã hoàn tất** — host/engine/scheduler/lifecycle/graph/handoff/retention
  đi qua repository boundary và named commands; direct runtime commit bằng 0.
- Phase 3: **đã qua parity gate** — SQLite behavior suites, contention/replay/
  conflict/orphan/retention checks, bounded snapshot query, source-boundary audit và
  transcript benchmark đã chạy; entity/command matrices phản ánh trạng thái thực tế.
- Phase 4 dev-phase: **SQLite-only, no migration/no backward compatibility.**
  - **P4-W1 ✅** SQLite-only activation cutover.
  - **P4-W2 ✅** legacy storage/runtime API removed (JSON store, sync engine,
    full-envelope migration/export, dual adapters). Current schema bootstrap only;
    incompatible `user_version` fails closed with developer reset guidance.
    **Validation-before-mutation:** foreign / unclaimed-incompatible / non-empty
    unclaimed DBs are rejected without durable side effects (no WAL switch, no
    application_id stamp, no schema/data rewrite). Only a truly blank DB is claimed.
  - **P4-W3–W11 ✅** transcript keyset paging, bounded bootstrap, load-older UX,
    revisioned patches, local routing, stream batching, bounded change feed,
    multi-window reconciliation và release benchmark/UAT đều đã đóng gate.
  Kết quả Wave 10 được ghi tại
  [`sqlite-phase3-gate-evidence.vi.md`](./sqlite-phase3-gate-evidence.vi.md).

### Quyết định dev-phase: SQLite-only, không chuyển dữ liệu cũ

- `globalStorageUri/muster.sqlite3` là writable source duy nhất ngay từ wave đầu Phase 4.
- Không discover, đọc, import, shadow-verify, backup hay ghi `.muster-tasks.json`.
- Không giữ `JsonTaskRepository`, filesystem `TaskStore`, sync engine constructor hoặc
  dual-adapter test matrix sau wave cleanup.
- Không hỗ trợ protocol cũ: host và webview chỉ chấp nhận đúng protocol version hiện tại.
  Mismatch vẫn hiện reload banner để xử lý stale webview asset, không có downgrade path.
- Không chuyển dữ liệu dev đã tồn tại. Khi schema dev không tương thích, fail rõ và yêu
  cầu reset database; tuyệt đối không silently reinterpret row cũ.
- Schema versioning/transactional DDL vẫn được giữ cho correctness của database hiện tại;
  nó không phải cam kết chuyển dữ liệu của release cũ.

## 1. Kết quả sản phẩm mong muốn

- Muster dùng **một database SQLite chung trong cùng VS Code profile + extension host authority** cho mọi workspace và cửa sổ thuộc authority đó.
- Database nằm dưới `context.globalStorageUri`, không tạo file dữ liệu trong repository.
- Ngoại trừ cấu hình trong VS Code Settings và credential trong VS Code SecretStorage, dữ liệu bền vững của Muster nằm trong SQLite.
- Conversation/task dài không còn làm mỗi commit clone, parse và ghi lại toàn bộ store.
- Mở workspace chỉ đọc metadata cần thiết; transcript được phân trang.
- Streaming dùng batch write và incremental UI patch, không rebuild/gửi lại toàn bộ snapshot cho mỗi chunk.
- Không có storage sidecar/legacy path: runtime chỉ đọc và ghi SQLite.

## 2. Hiện trạng và bottleneck

Trước refactor extension từng chọn store tại:

```text
<workspace>/.muster-tasks.json
```

hoặc `context.globalStorageUri/.muster-tasks.json` khi không có workspace folder.

Filesystem `TaskStore.commit()` cũ từng:

1. lấy cross-process file lock;
2. đọc và parse toàn bộ JSON từ disk;
3. clone toàn bộ envelope bằng `JSON.stringify/JSON.parse`;
4. mutate draft;
5. stringify và ghi lại toàn bộ file synchronously;
6. rebuild indexes và snapshot.

`buildSnapshot()` tiếp tục dựng root summaries, full owning subtree và toàn bộ transcript của focused task. Vì vậy chỉ thay SQLite mà giữ nguyên projection/wire contract vẫn chưa đủ.

## 3. Quyết định thiết kế

### 3.1 Một database chung

Đường dẫn canonical:

```ts
const dbUri = vscode.Uri.joinPath(context.globalStorageUri, 'muster.sqlite3');
```

Không hard-code đường dẫn macOS/Windows/Linux. VS Code, Insiders, Cursor và các host khác tự cung cấp `globalStorageUri` riêng.

SQLite files hợp lệ gồm:

```text
muster.sqlite3
muster.sqlite3-wal
muster.sqlite3-shm
```

### 3.2 Ranh giới lưu trữ

| Loại dữ liệu | Nơi lưu |
|---|---|
| Tasks, dependencies, turns, messages, queue | SQLite |
| Reasoning, tool calls/results, operations, receipts | SQLite |
| Session/runtime bindings, asks, handoffs | SQLite |
| User configuration | VS Code Settings |
| API keys, access tokens, credentials | VS Code SecretStorage |
| Binary/file artifact do Muster sở hữu | SQLite BLOB + metadata; không tạo sidecar data store |

SecretStorage là ngoại lệ bắt buộc về bảo mật, không đưa secret plaintext vào SQLite.

“Một database chung” không có nghĩa một file vật lý được share xuyên local VS Code,
Remote SSH, Dev Container, Codespaces, Cursor hoặc VS Code profile khác. Mỗi extension
host authority/profile có `globalStorageUri` riêng. Không đặt SQLite trên filesystem của
repository hoặc cố đồng bộ database qua network mount.

### 3.3 Workspace identity

`workspace_id` là UUID do Muster tạo, không dùng folder name. Identity và location phải
tách riêng: một workspace có thể được move/rename nhưng vẫn relink về cùng dữ liệu.

- single-root: URI của workspace folder;
- multi-root: URI workspace file nếu có; nếu không có thì digest ổn định của danh sách folder URI đã normalize/sort;
- empty window: dùng một logical workspace cố định `empty:<profile/authority>`, không tạo
  UUID mới mỗi lần activate.

`workspaces.identity_key` là key lookup hiện tại; `workspace_locations` giữ URI aliases
đã thấy. Không dùng absolute path làm primary key và không tự merge hai workspace chỉ vì
chúng có cùng basename. Relink là thao tác explicit có preview/count trước khi commit.

### 3.4 SQLite runtime policy

Mỗi extension-host process mở connection riêng:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

- Transaction ghi phải ngắn.
- Không giữ transaction trong lúc gọi backend hoặc chờ user.
- Scheduler claim/promote dùng transaction có điều kiện, không dùng read-then-write ngoài transaction.
- Schema bootstrap/version check dùng `PRAGMA user_version` và transaction.
- Set/verify một `PRAGMA application_id` riêng của Muster trước khi đọc schema. DDL được
  serialize bằng exclusive transaction; process thua race phải reopen/verify version,
  không chạy lại DDL dựa trên state cũ.
- Mọi SQL value dùng bound parameter; không nội suy content/path vào SQL.
- Checkpoint WAL chỉ chạy khi connection idle; không `VACUUM` trong activation path.

Driver SQLite synchronous không được chạy trên extension-host main thread: lock contention
với `busy_timeout=5000` có thể freeze toàn bộ UI năm giây. Mỗi extension-host dùng một DB
worker thread sở hữu connection; host giao tiếp qua typed request/response RPC. Worker có
write queue FIFO cục bộ, còn SQLite WAL điều phối giữa các process. Timeout/busy xảy ra
trong worker và trả structured error; không chặn VS Code event loop.

### 3.5 Driver chốt: `node:sqlite`

Chọn built-in `node:sqlite` (`DatabaseSync`) và nâng `engines.vscode` từ `^1.94.0` lên
`^1.101.0`. Lý do: VS Code 1.101 nâng Node extension host từ v20 lên v22; `node:sqlite`
đã có từ Node 22.5 và từ Node 22.13 không còn cần flag. Node người dùng cài trong terminal
không quyết định runtime extension — desktop/remote extension host mới là runtime thật.

Lợi ích so với `better-sqlite3`:

- không native dependency trong VSIX;
- không Electron/Node ABI matrix;
- không cần platform-specific package chỉ vì SQLite;
- desktop và Remote host dùng module built-in của chính runtime đang chạy;
- giảm supply-chain và release maintenance.

Điều kiện bắt buộc:

- cập nhật `package.json.engines.vscode` và test install refusal trên VS Code cũ;
- activation feature-probe bằng `require('node:sqlite')`; fork/host khai tương thích nhưng
  thiếu module phải fail rõ với hướng dẫn upgrade, không fallback im lặng sang JSON;
- DB vẫn chạy trong worker thread vì `DatabaseSync` là synchronous;
- CI/Extension Host test chạy trên minimum VS Code 1.101 và stable VS Code hiện hành;
- test cả desktop và Remote extension host;
- không thêm driver thứ hai như `better-sqlite3`/`sql.js`.

## 4. Schema v1 đề xuất

Các cột payload ít query có thể là JSON text có version; state/query keys phải là cột
chuẩn. Một field chỉ có **một source of truth**: field đã promote thành column không được
lặp lại trong `payload_json`. Mỗi payload có codec/version validator;
không `JSON.parse` rồi cast thẳng sang domain type.

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

CREATE TABLE workspace_locations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_uri TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, canonical_uri),
  UNIQUE (canonical_uri)
);

CREATE TABLE tasks (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT,
  role TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  release_state TEXT,
  goal TEXT NOT NULL,
  backend TEXT NOT NULL,
  model TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE task_dependencies (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  required_outcome TEXT NOT NULL,
  on_unsatisfied TEXT NOT NULL,
  required_verdict TEXT,
  PRIMARY KEY (workspace_id, task_id, dependency_task_id),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dependency_task_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE turns (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  settled_at TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, task_id, sequence),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  ordering INTEGER,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES turns(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE reasoning_segments (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordering INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES turns(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE tool_calls (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordering INTEGER NOT NULL,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES turns(workspace_id, id) ON DELETE CASCADE
);
```

Các bảng tiếp theo lưu các aggregate domain: `operations`, `cancel_requests`,
`send_receipts`, pending asks/handoff state, turn inputs và artifact BLOB metadata. Không
gom operation ledger hoặc input bindings vào một JSON workspace-wide nếu chúng tham gia
query, foreign key, idempotency hay scheduler decisions.

`TaskEngine.createTask` cho phép caller cung cấp task ID; vì vậy ID không được giả định
unique toàn database. Schema chốt composite identity
`(workspace_id, entity_id)` cho mọi entity và FK. Các bảng parity bổ sung phải tuân theo
cùng quy tắc; không được quay lại `id TEXT PRIMARY KEY` global.

Thêm bảng revision/change feed để đồng bộ nhiều extension-host process:

```sql
CREATE TABLE workspace_revisions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL
);

CREATE TABLE change_log (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id TEXT,
  change_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, revision, entity_kind, entity_id)
);
```

Mỗi write transaction tăng workspace revision đúng một lần và ghi affected entities.
`change_log` là bounded feed, không phải audit log vĩnh viễn; chỉ prune sau khi consumer
đã có thể fallback về full refresh.

Index tối thiểu:

```sql
CREATE INDEX idx_tasks_workspace_parent ON tasks(workspace_id, parent_id);
CREATE INDEX idx_tasks_workspace_lifecycle ON tasks(workspace_id, lifecycle, updated_at);
CREATE INDEX idx_turns_task_sequence ON turns(workspace_id, task_id, sequence);
CREATE INDEX idx_turns_workspace_status ON turns(workspace_id, status, created_at);
CREATE INDEX idx_messages_task_created ON messages(workspace_id, task_id, created_at, id);
CREATE INDEX idx_messages_turn ON messages(workspace_id, turn_id, ordering);
CREATE INDEX idx_reasoning_turn_order ON reasoning_segments(workspace_id, turn_id, ordering);
CREATE INDEX idx_tool_calls_turn_order ON tool_calls(workspace_id, turn_id, ordering);
```

## 5. Storage API mới

Không cho engine phụ thuộc trực tiếp driver SQLite. Tạo interface theo use case:

```ts
interface TaskRepository {
  getTask(taskId: string): Promise<MusterTask | undefined>;
  listRootTasks(workspaceId: string, page: Page): Promise<PageResult<MusterTask>>;
  listSubtree(rootTaskId: string): Promise<MusterTask[]>;
  listTurns(taskId: string): Promise<TaskTurn[]>;
  getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage>;
  listQueuedTurns(taskId: string): Promise<TaskTurn[]>;
  execute(command: RepositoryCommand): Promise<RepositoryCommandResult>;
}
```

Không expose callback kiểu `commit(draft => mutate arbitrary graph)` trong API cuối;
callback đó bắt buộc materialize toàn store và phá row-level persistence. Engine phải
dùng named transactional commands (`createTurn`, `promoteTurnIfEligible`,
`settleTurn`, `appendTranscriptBatch`, `applyRetention`, …) với invariant rõ ràng.
Transaction callback không đi qua worker RPC; mỗi named command tự chạy trọn transaction
trong DB worker.

Query trả domain DTO immutable. Repository không trả mutable object cache có thể bị code
ngoài transaction thay đổi mà không persist.

`TaskStoreFile`, filesystem `TaskStore` và JSON repository adapter bị xóa sau SQLite-only
cutover. Test dùng SQLite repository hoặc purpose-built in-memory fixture, không dùng lại
production JSON storage dưới tên khác.

## 6. Transcript và webview contract

### 6.1 Pagination

- Snapshot đầu chỉ chứa 100 transcript items gần nhất của focused task.
- Response có `beforeCursor`, `hasMoreBefore`.
- Khi scroll lên, webview gửi `loadTranscriptPage`.
- Cursor opaque, versioned và dựa trên canonical transcript sort key
  `(turn.sequence, kind_rank, ordering, created_at, entity_id)`; `kind_rank` và default
  ordering phải khớp chính xác `buildTranscript()` hiện tại. Không dùng offset.
- Page query chạy trong read transaction/snapshot nhất quán; response mang
  `workspaceRevision` để reducer phát hiện gap.

### 6.2 Incremental patches

Tách bootstrap snapshot khỏi cập nhật runtime:

- `taskUpserted`
- `turnActivityChanged`
- `transcriptItemsAppended`
- `transcriptItemPatched`
- `transcriptItemsRemoved`
- `queuedTurnsChanged`
- `taskRemoved`

Full snapshot chỉ dùng khi bootstrap, focus workspace/task thay đổi hoặc protocol recovery. Streaming assistant/reasoning được coalesce 50–100 ms trước khi persist/post patch.

SQLite update hooks chỉ thấy write trên cùng connection. Để nhận thay đổi từ VS Code
window/process khác, provider poll `PRAGMA data_version`/workspace revision với backoff
khi panel visible (và ngay khi window regain focus). Khi revision tăng, đọc `change_log`;
nếu có gap/pruned range thì rebuild snapshot. Không dựa vào file watcher của `-wal` làm
correctness mechanism.

### 6.3 Render

- ChatThread dùng virtualization/windowing.
- Giữ DOM khoảng vài trăm rows thay vì toàn bộ history.
- Stable item IDs để patch không remount cả transcript.
- Queue/tree updates không kéo theo transcript rebuild nếu focused task không bị ảnh hưởng.

## 7. Dev reset và recovery

- Runtime không đọc hoặc ghi `.muster-tasks.json`; file cũ nếu còn trên disk bị bỏ qua.
- Không import data từ schema/application version cũ. Version không tương thích phải fail
  rõ với đường dẫn database và hướng dẫn reset dành cho developer.
- Corrupt DB: đóng connection và báo lỗi; không tự tạo database rỗng đè lên file lỗi.
- Markdown export vẫn là tính năng người dùng, nhưng projector phải đọc named repository
  queries. Không materialize một workspace envelope chỉ để export một task.
- Backup database live (nếu bổ sung sau này) phải dùng SQLite backup API hoặc checkpoint
  có phối hợp; không copy riêng file main khi còn WAL.

## 8. Các phase triển khai

### Phase 0 — Đo baseline và characterization

- Fixture 10, 100, 1.000 tasks; transcript 1k/10k items; tool output lớn.
- Đo activation, commit p50/p95, focus task, snapshot bytes, webview render.
- Characterization tests cho scheduler, recovery, retention, export và multi-window locking.
- Lập inventory mọi call site của `TaskStore.getFile()`, `commit()`, `reload()` và
  `computeAffectedTaskIds`; mỗi call site phải được map sang query/command mới trước Phase 2.

**Gate:** có baseline reproducible và không thay behavior.

### Phase 1 — SQLite foundation

- Nâng minimum VS Code lên `^1.101.0`, thêm runtime feature-probe cho `node:sqlite`.
- Tạo DB worker/RPC, connection manager, pragmas, schema bootstrap và workspace registry.
- Test WAL multi-connection, busy timeout, crash transaction và foreign keys.

**Gate:** VSIX chạy `node:sqlite` trên minimum/current desktop + Remote host; VS Code cũ
bị từ chối đúng bởi minimum-version gate; artificial 5-second DB lock không block
extension-host heartbeat/UI command.

### Phase 2 — Repository boundary

- Tách engine/snapshot/export khỏi `TaskStoreFile` mutation API.
- Chuyển call chain liên quan sang async named commands/query API; không bọc sync API bằng
  fire-and-forget.
- Chạy contract suite trên SQLite repository.

**Gate:** scheduler/lifecycle tests pass trên SQLite repository.

### Phase 3 — SQLite parity

- Implement CRUD/transactions cho toàn bộ entities.
- Atomic scheduler promotion, operation idempotency và session/resource claims.
- Retention chuyển thành indexed DELETE theo workspace/task.

**Gate:** SQLite đạt behavior parity và không full-table/full-database rewrite khi stream.

#### Kế hoạch khép Phase 1–3 theo 10 wave

Không bắt đầu Phase 4 chỉ vì các SQLite primitive đã tồn tại. Audit ngày 2026-07-17
ghi nhận **44 runtime mutation sites** còn gọi `TaskStore.commit()`:
23 trong `engine.ts`, 17 trong `engine-graph.ts` và 4 trong `extension.ts`. Mười wave
dưới đây là execution plan bắt buộc để đưa con số đó về 0 và khép đầy đủ gate của
Phase 1–3.

Mỗi wave là một change set/commit độc lập, có targeted tests và typecheck. Full suite
chạy ở các milestone được nêu dưới đây. Không dùng command tổng quát kiểu
`applyGraphMutation(TaskStoreFile)` để giảm số call site giả tạo: mọi mutation phải là
named command với invariant, revision/epoch fence và worker-owned transaction rõ ràng.
Các wave được tiếp tục tuần tự; chỉ dừng khi có blocker thực sự. Phase 4 chỉ được bắt đầu
sau khi Wave 10 qua toàn bộ gate.

| Wave | Phạm vi | Runtime mutation sites dự kiến loại bỏ |
|---|---|---:|
| 1 | Khép Phase 1 infrastructure gate | 0 |
| 2 | Host mutations, snapshot và export boundary | 4 |
| 3 | Engine queue và user-facing mutations | 9 |
| 4 | Engine lifecycle và reconciliation | 8 |
| 5 | Scheduler, settlement, handoff và bỏ `TaskStore` khỏi engine | 6 |
| 6 | Graph delegate đơn và batch | 2 |
| 7 | Graph release, continue, wait, complete và fail | 5 |
| 8 | Graph cancellation và lifecycle cascade | 7 |
| 9 | Graph questions và cancel consumer | 3 |
| 10 | Phase 3 parity audit và gate cuối | 0 |

##### Wave 1 — Khép Phase 1 infrastructure gate

- Dựng Extension Host/packaged VSIX smoke test trên minimum VS Code 1.101 và stable
  hiện hành; xác nhận packaged `worker.js` chạy thật với `node:sqlite`.
- Test minimum-version gate từ chối VS Code 1.100 trở xuống.
- Test lock contention thật bằng hai DB workers: một connection giữ write lock khoảng
  5 giây, connection còn lại chờ `busy_timeout`, trong khi extension-host heartbeat vẫn
  đáp ứng.
- Test terminate worker/process giữa transaction rồi reopen DB để xác nhận rollback và
  WAL recovery; test concurrent schema bootstrap/open.
- Chạy Remote Extension Host test/UAT. Không có evidence Remote thì Phase 1 chưa qua gate.
- Packaged probe evidence phải xanh; Phase 4 chuyển probe thành hard gate.

##### Wave 2 — Extension/provider boundary

- Thay bốn direct commits của host bằng named commands:
  `clearHistory`, `deleteTaskSubtreeIfIdle`, `renameTask`, `applyRetentionPolicy`.
- Các lệnh clear/delete phải kiểm tra toàn subtree và live-turn safety trong cùng
  transaction, không quyết định trên snapshot cũ rồi mới delete.
- Dựng snapshot bằng repository queries; `postSnapshot()` không được materialize toàn workspace.
- Export chỉ đọc qua repository queries; không có full-workspace envelope fallback.
- Chạy host/snapshot/export contract tests trên SQLite.

##### Wave 3 — Engine queue và user-facing mutations

- Chuyển reserve queued follow-up, resume queued turn, create task, send/enqueue,
  edit/delete queued message, start/continue task và interrupt turn sang async named
  commands.
- Loại runtime sync mutation paths và mọi fire-and-forget persistence liên quan; caller
  phải await kết quả durable trước khi ACK, schedule hoặc phát side effect.
- Mỗi command có task revision, turn status/epoch, FIFO và idempotent receipt guards phù hợp.
- Chạy ingress/queue behavior suite trên SQLite.

##### Wave 4 — Engine lifecycle và reconciliation

- Chuyển `stageDisposition`, `setTaskLifecycle`, `skipTask`, `cancelTask`, reload
  reconciliation, child-wait reconciliation, dependency-terminal propagation và verdict
  remediation sang named commands.
- Dependency/wait/lifecycle effects liên quan phải commit atomically; không để một task
  terminal nhưng dependent/wait state ở revision cũ.
- Mỗi operation phải có ownership, revision và runtime-epoch fence; chạy contract suite
  trên SQLite.

##### Wave 5 — Scheduler, settlement, handoff và engine boundary

- Chuyển runtime handoff, verdict revalidation, post-settlement follow-up draining,
  missing-input attention và disposition repair sang named commands.
- Xóa bridge đang clone full `TaskStoreFile` để chuẩn bị dispatch hoặc
  settlement; chỉ query và persist các aggregate/rows thực sự liên quan.
- Thay filesystem `.lease.<turnId>` bằng repository-owned runtime claim có owner,
  expiry/heartbeat và stale-claim recovery.
- Scheduler database transaction tự suy ra owning root từ candidate task; không tin
  `rootTaskId` do caller truyền để enforce `maxConcurrentPerRoot`.
- Bỏ `store: TaskStore` bắt buộc khỏi `TaskEngineConfig`; engine chạy trên
  `SqliteTaskRepository`.
- Sau wave này `engine.ts` không còn direct `TaskStore.commit()`. Chạy full test suite.

##### Wave 6 — Graph delegate đơn và batch

- Implement transactional commands cho `create_task`/`delegate_task` và
  `create_tasks`/`delegate_tasks`.
- Task, dependencies, input bindings, initial turns, limits, ownership/capabilities và
  operation-ledger result phải cùng transaction.
- Same operation id + fingerprint replay kết quả cũ; fingerprint khác conflict và không
  để lại partial graph.

##### Wave 7 — Graph release và completion

- Implement transactional commands cho `release_tasks`, `continue_child`,
  `wait_for_tasks`, `complete_task` và `fail_task`.
- Release/readiness, wait state, task/turn result, continuation turn và operation ledger
  phải atomically visible.
- Chạy behavior suite tương ứng trên SQLite, gồm contention/replay.

##### Wave 8 — Graph cancellation và lifecycle cascade

- Implement transactional commands cho `cancel_tasks`, `interrupt_task`, `cancel_task`,
  `set_task_lifecycle` và descendant cancellation/cascade.
- Remote-owned live turn chỉ nhận durable cancel request; local backend abort chỉ diễn ra
  sau khi transaction thành công.
- Terminal state, queued descendant handling, task sealing, claim release và operation
  ledger phải nhất quán trong cùng transaction hoặc một protocol có owner fence rõ ràng.

##### Wave 9 — Graph questions và cancel consumer

- Implement transactional commands cho `ask_parent`, `answer_child_question` và
  `consumeCancelRequest`.
- `consumeCancelRequest` phải atomically claim đúng request/owner, settle hoặc cancel
  turn/task, áp dụng follow-up hold/cancel policy, release session/resource/runtime claims,
  xóa request và ghi đúng một workspace revision/change-log batch.
- Sau wave này direct `TaskStore.commit()` phải bằng 0. Chạy
  full test suite và source-boundary audit.

##### Wave 10 — Phase 3 parity audit và gate cuối

- Enforce source-boundary checks: engine/graph/snapshot không import `TaskStore`; không
  còn direct commit hoặc full-workspace envelope runtime.
- Cập nhật entity matrix cho runtime owner/lease, expiry và stale-claim recovery; audit
  mọi domain field/aggregate qua codec hoặc promoted column.
- Chạy toàn bộ scheduler/lifecycle/graph behavior suite trên SQLite, gồm
  multi-worker contention, operation replay/conflict, orphan recovery và retention
  không xóa live/reference data.
- Benchmark database lớn để chứng minh `appendTranscriptBatch` chỉ chạm các row liên quan,
  tạo một revision/feed batch và không tăng tuyến tính theo tổng database size.
- Chạy full `npm test`, TypeScript/webview build, packaged Extension Host smoke và Remote
  evidence; cập nhật command/entity matrices theo trạng thái thực tế.

Entity matrix được chốt tại [`sqlite-entity-matrix.vi.md`](./sqlite-entity-matrix.vi.md),
bao gồm runtime owner/lease, expiry, stale-claim recovery và codec của từng domain
field. Command matrix được chốt tại [`sqlite-engine-command-matrix.vi.md`](./sqlite-engine-command-matrix.vi.md).
Evidence cuối Wave 10: [`sqlite-phase3-gate-evidence.vi.md`](./sqlite-phase3-gate-evidence.vi.md).

**Gate trước Phase 4:** Wave 1–10 đều hoàn tất; 44 runtime mutation sites đã về 0;
engine/graph/snapshot chạy qua repository boundary; SQLite scheduler/lifecycle/graph suites
xanh; Phase 1 VSIX/lock/crash/Remote evidence đầy đủ; và
SQLite đạt row-level behavior parity dưới contention.

### Phase 4 — Pagination và incremental wire protocol

- Cutover runtime sang SQLite-only và xóa filesystem JSON path trước khi đổi wire protocol.
- Transcript cursor API, load-older action, patches và stream batching.
- Webview reducer idempotent; exact protocol-version gate + reload banner cho stale asset.
- Cross-process revision polling + `change_log` gap recovery.

**Gate:** task 10k transcript items mở nhanh, bootstrap size bounded và hai window hội tụ
về cùng UI state mà không reload thủ công.

#### Kế hoạch Phase 4 theo 11 wave

Mỗi wave là một commit độc lập. Targeted tests + typecheck phải xanh trước commit; wave
sau bắt đầu ngay khi wave trước đạt gate, chỉ dừng khi có blocker thật.

| Wave | Phạm vi | Gate chính |
|---|---|---|
| P4-W1 ✅ | SQLite-only activation cutover | Không tạo/đọc/ghi/watch `.muster-tasks.json`; probe là hard gate |
| P4-W2 ✅ | Xóa legacy storage/runtime API | Không còn `JsonTaskRepository`, filesystem `TaskStore`, sync engine constructor hoặc full-envelope export; **no migration/no backward compatibility** |
| P4-W3 ✅ | Canonical cursor + SQL keyset page | SQLite query bounded `limit + 1`, không load full transcript |
| P4-W4 ✅ | Bounded bootstrap | Snapshot focused task chỉ chứa 100 item + page metadata |
| P4-W5 ✅ | Load older UX | Typed request/response, prepend idempotent, giữ scroll anchor |
| P4-W6 ✅ | Revisioned patch reducer | Duplicate/stale patch là no-op; revision gap yêu cầu recovery |
| P4-W7 ✅ | Local patch routing | Queue/tree/transcript update không kéo theo focused full snapshot |
| P4-W8 ✅ | Stream batching | Assistant/reasoning persist + post coalesce 50–100 ms, flush ở tool/terminal boundary |
| P4-W9 ✅ | Change-feed contract | Bounded feed, prune watermark, explicit gap result |
| P4-W10 ✅ | Multi-window polling | Visible/focus polling + backoff; hai process hội tụ hoặc full-recover khi gap |
| P4-W11 ✅ | Performance/UAT gate | Compiled 100k fixture + retained heap + packaged Extension Host smoke đều pass |

##### P4-W1 — SQLite-only activation cutover

**Hoàn tất:** activation dùng `SqliteTaskRepository` + `TaskEngine.loadAsync`, probe/open
database là hard gate và filesystem JSON watcher/path đã bị loại khỏi runtime host.

- Activation bắt buộc mở `globalStorageUri/muster.sqlite3`, resolve workspace và tạo
  `SqliteTaskRepository`; lỗi probe/open làm task engine fail rõ.
- `TaskEngine.loadAsync()` là constructor runtime duy nhất.
- Bỏ filesystem watcher và mọi runtime reference tới workspace JSON file.

##### P4-W2 — Xóa legacy storage/runtime API

**Hoàn tất (2026-07-17): no migration / no backward compatibility.**

- Đã xóa `JsonTaskRepository`, filesystem `TaskStore`, `LegacyStorePort`, sync
  execute/load, session/data importer, `readEnvelopeForMigration`, full-envelope export.
- Host reads/export đi qua named repository queries hoặc repository projection.
- Schema hiện tại bootstrap trực tiếp; DB `user_version` khác bị reject và yêu cầu reset.
- `releaseState` bắt buộc `draft | released`; outcome chỉ qua `taskResult`.
- Presentation restore chỉ nhận opaque handle `{ rootId, presentationId }`; markdown roots chỉ
  `WorkspaceFolderRoot`; host/webview protocol chỉ shape hiện tại.
- Test runtime dùng SQLite repository/current contract; coverage quan trọng đã port
  sang `engine-repository` SQLite integration tests.
- **Open-path validation-before-mutation (follow-up):** `openStoreDatabase` preflight
  `application_id` + `user_version` + `sqlite_schema` trước mọi durable write. Foreign DB,
  unclaimed incompatible version, unclaimed non-empty file, và incomplete owned Muster DB
  (application_id=Muster nhưng user_version ≠ current, kể cả 0) đều reject ngay với reset
  guidance, không đổi journal mode / stamp / schema, không retry. Chỉ blank DB được claim
  + bootstrap trong `BEGIN EXCLUSIVE`; WAL/runtime pragmas chỉ sau ownership confirmed.
  Concurrent first-open: peer chờ exclusive lock hoặc thấy post-commit current markers —
  không quan sát partial claim bền vững.

##### P4-W3 — Canonical cursor + SQL keyset page ✅

- **Canonical ordering contract.** Sort key `(turn_sequence, kind_rank, ordering,
  created_at, entity_id)`, so sánh lexicographic ascending, mọi trường non-null sau
  normalize. Hai trường TEXT (`created_at`, `entity_id`) so **bytewise UTF-8** qua
  `compareBinary` (`Buffer.compare`) — khớp đúng SQLite default `BINARY` collation, độc
  lập locale/máy (KHÔNG dùng `localeCompare`, vốn phụ thuộc ICU host). Chốt tại
  `src/task/transcript-order.ts` (constants + `compareBinary` + `compareTranscriptKeys`)
  và dùng chung cho `buildTranscript()`, cursor, và SQL query (ORDER BY + `<` tuple đều
  chạy trên cột TEXT với BINARY collation nên khớp exact):

  | Item | kind_rank | ordering |
  |---|---:|---:|
  | user message | 0 | `message.order ?? -2` |
  | reasoning | 1 | `-1` |
  | assistant message | 2 | `message.order ?? 0` |
  | tool call | 2 | `tool.order` |

  `turn_sequence = -1` nếu item không gắn được turn; system message bị loại; assistant +
  tool cùng rank 2 để interleave theo shared `ordering`. `kind_rank` là axis riêng giữa
  `turn_sequence` và `ordering` (thay cho magic -2/-1/0 gộp vào order trước đây).

- **Cursor version 2.** `src/task/transcript-cursor.ts`: payload opaque self-contained
  `{version:2, workspaceId, taskId, turnSequence, kindRank, ordering, createdAt, entityId}`,
  encode `v2.<base64url(JSON)>`. Validate prefix/base64url-canonical/size-cap/JSON-shape/
  field-types/finite-integer + scope (workspace+task). Không hỗ trợ cursor v1. Sai →
  `InvalidTranscriptCursorError` (message cố định, không echo raw cursor/content). Keyset
  thuần: không cần anchor entity còn tồn tại.

- **SQL keyset limit + 1, không full hydration.** `getTranscriptPage` dùng một `db.all`
  duy nhất: CTE `rev` + `task_turns` (scope turns của task qua `idx_turns_task_sequence`) +
  `turn_count` + `input_bindings` (resolve user message → turn qua `turn_inputs`,
  last-write-wins theo `sequence DESC, ordering DESC` parity `msgTurn` của projector) +
  `items` (UNION ALL 4 nhánh; reasoning/tool **drive từ `task_turns`** nên seek turn-index
  thay vì scan workspace; queued visibility quyết định trong SQL) + `page`
  (`WHERE (…) < (?,?,?,?,?)` strict, ORDER BY DESC, `LIMIT bounded+1`) + outer `ORDER BY`
  ổn định thứ tự sau `LEFT JOIN rev`. Default limit 100, clamp 1..500. Row thứ limit+1 chỉ
  để tính `hasMoreBefore`; decode tối đa `limit` item; reverse về ascending render order.
  `beforeCursor` chỉ trả khi `hasMoreBefore`, encode key item cũ nhất trong page. Đã xóa
  `composeTranscript`/`pageTranscript`/cursor string cũ/full-array lookup — không còn
  fallback load toàn transcript.

- **User message unbound vẫn hiện.** Nhánh user dùng điều kiện "keep" 3-vế NULL-safe:
  `bt.id IS NULL` (unbound: `turn_sequence = -1`, luôn hiện) ∨ `status <> 'queued'` ∨
  (queued nhưng là sole opening user turn). Trước đây `NOT (queued AND …)` vô tình loại
  user message không gắn turn — nay đã sửa, parity với projector.

- **Tách `sort_ordering` khỏi raw `order`.** `items` output cả hai cột: `sort_ordering`
  (normalized: user `COALESCE(order,-2)`, assistant `COALESCE(order,0)`, reasoning `-1`,
  tool `ordering`) dùng cho ORDER BY + keyset + cursor; và `ordering` (raw source, nullable
  cho user/assistant, NULL cho reasoning) để decode DTO đúng — user/assistant không có
  `order` ⇒ property `order` absent (không phải fallback -2/0).

- **Read snapshot + revision.** Một statement = một implicit read snapshot: transcript rows
  và `workspaceRevision` đọc nhất quán, không còn `Promise.all` nhiều query độc lập. CTE
  `rev` cross-join `LEFT JOIN page ON 1=1` giữ sentinel row nên revision luôn có kể cả page
  rỗng.

- **Index/schema (task-scoped plan).** Sau khi rewrite CTE, `EXPLAIN QUERY PLAN` cho thấy
  mọi nhánh drive từ `task_turns` (seek `idx_turns_task_sequence`) rồi seek turn-index cho
  detail tables — **không còn `SCAN reasoning_segments` / `SCAN tool_calls` /
  `SCAN turn_inputs`**. Cụ thể: user/assistant qua `idx_messages_task_created`, reasoning qua
  `idx_reasoning_turn_order`, tool qua `idx_tool_calls_turn_order`, binding qua
  `idx_turn_inputs_turn_order`, join turns qua `sqlite_autoindex_turns_1`. `USE TEMP B-TREE
  FOR ORDER BY` inherent cho UNION+composite sort, bounded theo task size. Test
  `EXPLAIN QUERY PLAN` + fixture sibling-task assert không leak row task khác. **Không thêm
  index, không đổi schema — `SQLITE_SCHEMA_VERSION` giữ 4.**

- **10k fixture.** Seed 10.000 message rows bằng batched `client.transaction` (không 10k
  named command). Assert: SQL trả ≤ limit+1 rows; public result = limit (100);
  hasMoreBefore/beforeCursor đúng; không gọi `listTurns`/`listMessages`/`listToolCalls`/
  `listReasoning`; không materialize 10k DTO. Elapsed/query-plan ghi làm evidence (perf gate
  ở W11).

- Test khác: cursor validation đầy đủ, pagination correctness (empty/single/multi-page
  limit 1 & 100, no dup/gap, ascending trong page, default/clamp, anchor deleted),
  deterministic ordering parity với `buildTranscript()`, queued visibility (opening
  visible / follow-up hidden / running visible / multi-queued hidden), concurrent mutation.

##### P4-W4 — Bounded bootstrap ✅

- **Projection activation bounded.** `RepositoryProjection.refreshAll` /
  `refreshTask` chỉ load `listTurnActivityForTasks` + `listActiveTurnInputMessages`;
  `toolCalls`/`reasoning` luôn `{}`. `refreshTask` reload coordination
  (ops/cancel/claims) cho active turns còn sống — không mất claim/cancel sau
  `appendTranscriptBatch` / `replaceLiveTurn`.
- **loadAsync activation bounded.** Orphan reconcile dùng `listQueuedTurns`; retry
  depth dùng `countRetryDepth` (recursive CTE); child-wait dùng
  `countTurnsForTaskEpoch` + `getMaxTurnSequence` + `getTurn` +
  `listEngineChildResultsAfter` — **zero** `listTurns`/`listMessages`/
  `listToolCalls`/`listReasoning` trên path activation. Graph fences ephemeral
  ngoài activation giữ nguyên nơi correctness yêu cầu.
- **listActiveTurnInputMessages plan.** Drive từ active turns (MATERIALIZED) →
  `turn_inputs` seek `(workspace_id, turn_id)` → messages PK. Không scan history.
- **Bootstrap snapshot v6.** Focus chỉ khi task tồn tại; deleted/stale focus →
  no-focus hợp lệ (không `focusedTaskId`/`transcript`/`transcriptPage`). Focused
  luôn có cả hai; `getTranscriptPage(..., 100)` một lần; active inputs chỉ cho
  focused task. `buildSnapshot` enforce invariant; `TaskThread.reset()` clear
  page metadata.
- **Tests.** Projection coord preserve; activation 10k fixtures (orphan/child-wait/
  safe-retry); active-input EXPLAIN; snapshot deleted-focus + fixture budget
  evidence; protocol v6 page guards; full suite green.

##### P4-W5 — Load older UX ✅

**Hoàn tất:** protocol **v7** `loadTranscriptPage` / `transcriptPageResult`; host pure
route validate focus/task/cursor + focus-generation race; webview stable-ID reducer
prepend idempotent (reasoning ownership); ChatThread scroll anchor + single in-flight
request; fixed page limit 100; **no W6 recovery**.

- **Protocol v7.** Webview `PROTOCOL_VERSION = 7` + host mirror; request
  `{ type:'loadTranscriptPage', requestId, taskId, beforeCursor }`; response union
  success (`items` ≤100 + `transcriptPage`) / failure fixed codes only
  (`invalidRequest`|`staleFocus`|`taskNotFound`|`invalidCursor`|`unavailable`).
  No free-form message/stack/SQL/cursor echo; no `loadHistory`/`historyChunk` aliases.
- **Host route.** `src/host/transcript-page-route.ts` runtime-validates correlation,
  captures focus+`snapshotGeneration`, refuses wrong focus with zero page queries,
  `getTask` then exactly `getTranscriptPage(taskId, beforeCursor, 100)`, maps
  `InvalidTranscriptCursorError`→`invalidCursor`, re-checks focus generation after
  await (A→B and A→B→A reject stale success). Reuses exported `toHostTranscriptItem`.
- **Reducer.** Pure `transcript-page-reducer.ts`: existing item/reasoning IDs win;
  replay/stale request/task are no-ops; success prepends + advances cursor/hasMore;
  revision uses `max(current, response)`; matching error clears loading for Retry;
  hydrate/focus/reset invalidates pending. No revision-gap/`needsRecovery` (W6).
- **Scroll anchor.** ChatThread top control + edge-triggered near-top auto-load;
  `data-transcript-id` rows; capture stable row top before request; restore after
  matching success via top delta (height fallback); suppress auto-scroll-to-bottom
  while restoring; one in-flight request; no load when `scrollLocked`/no cursor.
- **Tests.** Protocol v7 guards; host route focus-race + multi-page ~300 item walk;
  reducer ownership/replay; scroll helpers; boundary smoke requires route
  `getTranscriptPage` and bans full hydration/aliases.

##### P4-W6 — Revisioned patch reducer

- Wire messages: atomic `workspacePatchBatch` envelope (protocol v9) carrying
  `taskUpserted`, `turnActivityChanged`, `transcriptItemsAppended`,
  `transcriptItemPatched`, `transcriptItemsRemoved`, `queuedTurnsChanged`, `taskRemoved`.
- Envelope `revision` is the effective workspace revision of the whole batch;
  empty `patches: []` still advances revision. Never coalesce two workspace
  revisions into one envelope.
- Mỗi patch có stable entity identity. Reducer là idempotent; stale/duplicate
  là no-op, gap/invariant chuyển state sang `needsRecovery` (atomic, no partial).
- Recovery via exact `requestWorkspaceRecovery` → bounded snapshot hydrate.
- Exact protocol mismatch chỉ hiện reload banner; không parse/translate protocol cũ.
- Runtime guard kiểm tra exact-key cả envelope lẫn nested task/turn/queue/transcript,
  giới hạn tổng payload và stable identity. Malformed revision hiện tại đi vào recovery
  single-flight; malformed stale replay là no-op. Snapshot cũ hơn revision đã apply không
  được phép ghi đè task/thread state.

##### P4-W7 — Local patch routing

- Host mutation nội bộ phát atomic `workspacePatchBatch` sau durable commit + projection
  refresh (`onAfterCommit` trên `withRepositoryProjection`).
- Full snapshot chỉ dùng bootstrap, focus change hoặc recovery; queue/tree change không
  rebuild transcript nếu focused task không bị ảnh hưởng.
- Loại `transcriptAppend`/`taskUpdated` one-off messages sau khi mọi caller chuyển xong.
- Wrapper serialize trọn `execute → bounded projection refresh → publish`, nên hai local
  writer đồng thời vẫn phát đúng N rồi N+1. Bounded snapshot chạy qua cùng read barrier;
  raw repository còn có start/end revision fence và retry để không trộn row từ hai revision.

##### P4-W8 — Stream batching

- Coalesce assistant/reasoning updates trong cửa sổ cố định **75 ms** trước một
  `appendTranscriptBatch` transaction và một `workspacePatchBatch` (via onAfterCommit).
- Flush trước tool boundary, turn done/error/cancel, focus teardown và deactivate
  (`flushPendingTranscriptForTask` / `flushAllPendingTranscript`; deactivate awaitable).
- Lỗi persist không được ACK/post như durable; ordering và partial-segment IDs giữ ổn định.
- Durable-before-visible: no raw assistant/reasoning durable UI post before commit.
- Timer persist failure được report một lần và settle turn failed, không retry storm/ACK giả;
  buffer chỉ retry ở explicit boundary. Graph transition, interrupt, lifecycle cascade,
  handoff và timeout đều flush trước durable cancel/physical abort. `deactivate()` await
  engine shutdown: chặn dispatch mới, flush, abort adapter, chờ settle rồi final flush.
- SQLite integration tests chốt thứ tự `appendTranscriptBatch → putCancelRequest`, injected
  disk-full chỉ một attempt/một failed turn, và shutdown giữ last pre-abort window.

##### P4-W9 — Change-feed contract ✅

- Repository expose current revision + changes-since query theo revision boundary. Toàn bộ
  revision/watermark/page metadata được đọc bằng **một SQL statement / một read snapshot**;
  writer append/prune giữa các RPC không thể tạo false gap hoặc partial page.
- Feed có retention bound/watermark (`CHANGE_FEED_RETAIN_REVISIONS=4096`, explicit
  `change_feed_watermarks`). Consumer nhận explicit `gap` khi revision cần thiết
  đã bị prune; không đoán từ danh sách rỗng.
- Page bị chặn ở tối đa 512 revisions và 4096 metadata rows; revision quá lớn fail bounded
  sang snapshot recovery, không materialize vô hạn và không bao giờ cắt đôi revision.
- Feed chỉ chứa metadata IDs/change kind, không chứa prompt/tool payload/path. Workspace
  location dùng opaque workspace ID (không canonical URI); turn changes mang task scope;
  delete cascade dùng explicit recovery marker.
- Schema v5 current-bootstrap only.

##### P4-W10 — Multi-window polling ✅

- Khi view visible, poll `data_version`/workspace revision với adaptive backoff; poll ngay
  khi view hoặc VS Code window regain focus; hidden view dừng timer.
- Poller chỉ bắt đầu sau authoritative snapshot của focus hiện tại; focus/visibility hydrate
  dừng polling, stale generation không thể clear anchor/cursor mới. Revision chỉ advance sau
  batch thật sự được post; hidden/unhydrated view không silently skip durable changes.
- Reconciler drain feed → hydrate bounded projection → đọc end-revision fence; writer commit
  giữa hydrate làm vòng lặp mở rộng feed (tối đa 8 stability attempts/1024 revisions/16384
  metadata rows), không stamp projection bằng revision cũ. Gap/corrupt/delete không biểu diễn
  được thì rebuild bounded snapshot.
- Queued follow-up vẫn ẩn đến khi promote dù user message bind qua `turn_inputs`; coordination-
  only revision advance không ép full refresh. Focused entity delete có stable ID dùng
  `transcriptItemsRemoved`; cascade/retention không liệt kê đủ entity vẫn dùng bounded recovery.
- Test hai independent DB clients/workers ghi xen kẽ, concurrent-writer-during-hydrate và
  reducer hội tụ không N+1/full transcript hydration.

##### P4-W11 — Performance/UAT gate ✅

- `bench:phase4-release:assert` compile trước rồi chạy worker JS trong `dist` với 100k
  persisted messages (10k focused), 12 iterations trên Apple M4/Node 26. Kết quả: activation
  p95 **0.39 ms**, retained heap delta **0.01 MiB**, focus latest-100 p95 **11.51 ms**,
  older-page-100 p95 **12.13 ms**, stream batch p95 **0.45 ms**, bootstrap **12.6 KiB**;
  10 concurrent stream commits đều durable. Mọi budget đều pass.
- Packaged VSIX smoke chạy trong VS Code 1.129 Extension Host/Node 24.18: activation,
  built-in `node:sqlite`, compiled worker/client/schema, WAL/FK, schema 7 và durable
  tables/trigger đều pass.
- UAT tự động: two-client feed convergence/gap prune/concurrent hydrate; strict outbox
  reload/reject/delete/capacity; root-scoped presentation restart/idempotency/conflict.
- **Live two-window UAT ✅:** `npm run test:sqlite-two-window-live-uat` packages a
  fresh VSIX and runs scenarios A–I on **two real VS Code Extension Hosts** sharing
  one `muster.sqlite3` (symlinked globalStorage, same workspace identity). Redacted
  evidence: `sqlite-phase4-two-window-live-uat-evidence.json`. This is distinct from
  dual-`DbClient` unit tests.
- Composer → VS Code Settings `muster.composerSelection`; send outbox → SQLite
  `send_outbox` (strict payload, max 32); presentation → root-scoped SQLite
  `presentations` + durable `presentation_operations` (serializer opaque IDs only).
- Schema v7 current-bootstrap only; no migration/backward-compatible path.
- Final gates: TypeScript, Svelte (0 errors), webview build, unit tests,
  source/repository boundaries, 100k benchmark, packaged Extension Host smoke,
  live two-window UAT và `git diff --check` đều xanh. Chi tiết ở
  `sqlite-phase4-gate-evidence.vi.md`.

##### Cleanup trước P4-W11 ✅

- Composer backend/model: VS Code Settings `muster.composerSelection` (không globalState).
- Send outbox: SQLite durable `send_outbox`; webview memory-only (không setState text).
- Presentation: SQLite `presentations`; webview setState chỉ opaque rootId/presentationId.

### Phase 5 — SQLite hardening

Phase này chỉ harden **behavior của Muster tại SQLite boundary**; không viết test để chứng
minh lại correctness nội tại của `node:sqlite`/SQLite. Không thêm migration, backward
compatibility, JSON fallback, telemetry framework, activation `VACUUM`, full-history
hydration hoặc raw-copy file main trong lúc WAL hoạt động. Các test Phase 4 còn đúng phải
được reuse/strengthen, không nhân đôi chỉ để tăng số test.

#### Cách thực thi: 7 wave trong 3 batch

- **Batch A:** P5-W1 → P5-W3. Agent chạy liên tục cả ba wave, tạo **một commit riêng cho
  từng wave**, chạy targeted gate sau mỗi commit và full gate ở cuối batch; không dừng hỏi
  giữa wave nếu không có blocker correctness thật.
- **Batch B:** P5-W4 → P5-W5, cùng quy tắc hai commit riêng + full gate cuối batch.
- **Batch C:** P5-W6 → P5-W7, cùng quy tắc hai commit riêng + full gate cuối batch.
- Mỗi batch bắt đầu từ parent sạch, không amend/squash commit của batch trước và dừng sau
  báo cáo cuối batch. Không tự bắt đầu batch kế tiếp.

#### P5-W1 — Safe error contract và fault-injection boundary ✅

- Inventory error path từ `node:sqlite` worker/RPC → client/repository → activation/engine/
  command UI; chốt một structured error taxonomy tối thiểu cho corrupt/not-a-database,
  full, readonly, I/O, busy/locked timeout, incompatible/foreign database và unknown.
- Error qua RPC chỉ mang fixed code + safe operation class; user-facing message/action được
  map ở host. Không serialize raw SQL, bound params, prompt/tool output, cursor, credential,
  stack hoặc filesystem path vào RPC/log/telemetry/evidence. Path chỉ được hiện trực tiếp
  trong recovery UI khi user cần tìm database, không đi qua diagnostic payload dùng chung.
- Tạo deterministic fault-injection seam tại Muster DB boundary, chỉ bật trong test/UAT và
  không có production setting/command. Nó inject lỗi trước commit/backup theo operation
  class; không monkey-patch để kiểm thử implementation nội tại của SQLite.
- Giữ programmer/invariant errors phân biệt với operational SQLite errors; không biến mọi
  exception thành `unavailable` và không swallow `SQLITE_BUSY`.

**Gate P5-W1:** mapping/error guards/fault seam có targeted tests; invalid payload fail
closed; production build không expose fault control; source boundary cấm raw SQLite error
hoặc params vượt khỏi DB boundary.

#### P5-W2 — Corrupt database fail-closed và recovery diagnostics ✅

- Open/read path nhận diện corrupt/not-a-database và owned-but-incompatible state trước mọi
  durable mutation. Không tự rename, delete, stamp, reset, bootstrap đè hoặc fallback sang
  database/JSON rỗng.
- Khi DB không dùng được: đóng connection, không khởi động scheduler/poller/writer trên
  partial state, giữ Extension Host responsive và hiện diagnostic ổn định với recovery
  action. Không chạy full `integrity_check` trên mọi activation nếu không có evidence cần.
- Phân biệt foreign DB, schema dev không tương thích và physical corruption để hướng dẫn
  đúng; tất cả vẫn fail closed. Malformed durable row tiếp tục là invariant error, không
  silently skip.
- Fault fixtures tối thiểu gồm garbage/not-a-database, truncated/corrupt owned DB, foreign
  `application_id`, incompatible `user_version` và valid reopen. Reject case phải chứng
  minh journal/application/schema/source bytes không bị Muster sửa ngoài side effect do
  chính SQLite open không thể tránh.

**Gate P5-W2:** activation/runtime corrupt cases báo rõ nhưng redacted, zero silent reset,
zero empty-store continuation, không mutate file bị reject và valid database vẫn mở bình
thường.

#### P5-W3 — Durable write failure: full/readonly/I/O/busy ✅

- Normalize `SQLITE_FULL`, `SQLITE_READONLY`, relevant `SQLITE_IOERR`, và exhausted
  `SQLITE_BUSY`/`SQLITE_LOCKED` thành contract W1; retry chỉ bounded ở nơi policy cho phép,
  không retry storm hoặc biến lỗi thành success.
- Transaction failure phải rollback atomically. Host không ACK/post patch/revision hoặc
  cập nhật projection như durable trước commit; streaming buffer không được làm mất hoặc
  nhân đôi segment khi explicit boundary xử lý lỗi.
- Engine/command UI đi vào trạng thái lỗi recoverable/fail rõ theo operation thay vì tiếp
  tục trên projection giả. Extension-host main thread vẫn không bị busy timeout block.
- Reuse test durable-before-visible và injected disk-full của P4-W8; mở rộng vào repository
  transaction, revision/change feed, outbox và một representative command path. Assert row/
  revision trước lỗi không đổi và reopen đọc được state cũ.

**Gate P5-W3 / Batch A:** fault tests full/readonly/I/O/busy đều rollback và redacted;
không ACK giả, không mất row âm thầm; TypeScript, Svelte, webview build, full unit suite và
source/repository boundaries xanh; ba commit W1/W2/W3 riêng, worktree sạch.

#### P5-W4 — SQLite-aware live backup primitive ✅

**Hoàn tất (2026-07-18):** live backup primitive qua DB worker RPC (`DbClient.backup` →
`worker` → `backupOpenDatabase`). Runtime probe `node:sqlite.backup` (API, Node ≥22.16 /
current stable EH); fallback `VACUUM INTO` trên minimum VS Code 1.101 (Node 22.15.1).
Không raw-copy live main; temp sibling + atomic publish; verify read-only
(`application_id`, `user_version`, schema fingerprint, `quick_check`, workspace revision);
reject destination alias của live main/WAL/SHM; cancellation qua request-scoped
`SharedArrayBuffer` Int32 (publication-safe sau snapshot cho VACUUM).

- Spike API thực tế trên minimum/current VS Code Extension Host rồi chọn mechanism được
  runtime support: ưu tiên SQLite backup API; fallback chỉ được là SQLite-coordinated
  snapshot/checkpoint mechanism có correctness test. Tuyệt đối không `copyFile` riêng
  `muster.sqlite3` khi WAL có thể chứa committed rows.
- Backup chạy qua DB worker/lifecycle boundary, tạo consistent snapshot trong khi writer
  khác có thể hoạt động, không block extension-host main thread và không giữ write
  transaction suốt lúc user chọn destination.
- Ghi vào temporary sibling của destination rồi publish atomically khi thành công; failure/
  cancel dọn partial artifact nhưng không đụng source hay backup tốt có sẵn. Destination
  overwrite phải explicit.
- Verify artifact bằng reopen + Muster `application_id`/current schema và SQLite-aware
  consistency check phù hợp. Kết quả API chỉ trả metadata cần cho UI; log/evidence không
  chứa conversation content, raw path hoặc SQL params.
- Test backup khi WAL có committed-but-not-checkpointed row và concurrent writer; artifact
  phải là một snapshot hợp lệ (không yêu cầu chứa write commit sau snapshot), source tiếp
  tục usable và backup mở độc lập được.

**Gate P5-W4:** WAL/concurrent/failure/cancel/overwrite tests xanh; không có raw-copy live
DB path; backup mở và đọc được consistent revision; source bytes/data không bị reset hay
mất row.

#### P5-W5 — Backup command và explicit developer reset

- Contribute hai command rõ nghĩa: backup database và **developer reset global database**.
  Backup dùng Save dialog và primitive W4; UI được phép hiện user-selected path nhưng path
  đó không được log/telemetry hóa.
- Reset modal phải nói rõ phạm vi: xóa toàn bộ Muster conversation/task/data của mọi
  workspace trong cùng VS Code profile + extension-host authority. Cancel là strict no-op;
  không có auto-reset khi activation/open/write lỗi.
- Cho lựa chọn backup-before-reset; nếu user chọn backup mà backup fail/cancel thì reset
  abort. Không giả vờ backup thành công trước khi artifact W4 đã verify/publish.
- Reset quiesce local scheduler, poller, stream timers, writers và DB worker trước khi thay
  state, rồi bootstrap đúng current schema và rebuild bounded empty UI. Failure phải để lại
  source recoverable hoặc fail closed, không half-reset.
- Vì database dùng chung nhiều cửa sổ/process, reset phải có cross-process safety được test:
  ưu tiên exclusive in-database reset/maintenance protocol. Nếu implementation thay file
  vật lý, nó phải chứng minh không có peer đang mở/ghi; nếu không chứng minh được thì abort
  với hướng dẫn đóng các Muster window khác. Không unlink file đang mở để tạo split-brain;
  `muster.sqlite3`, `-wal`, `-shm` chỉ được xử lý như một coordinated unit.
- Không thêm migration/backward-compatible reset/import path. Markdown export tiếp tục là
  named repository feature, không bị đổi thành full-database backup trá hình.

**Gate P5-W5 / Batch B:** command registration/UI guards, backup-before-reset, cancel,
success, injected failure và two-client/process contention tests xanh; không split-brain;
hai commit W4/W5 riêng; full gates xanh và worktree sạch.

#### P5-W6 — Privacy/redaction và recovery documentation

- Audit toàn bộ SQLite error, backup/reset, command notification, output channel, UAT và
  evidence path theo contract W1. Secret canary chỉ được tồn tại trong durable conversation
  mà user chủ động lưu và backup user chủ động tạo; không xuất hiện trong log, diagnostic,
  telemetry, exception payload, snapshot metadata hoặc test evidence.
- Không thêm telemetry framework. Nếu repo đã có metric hook liên quan thì chỉ timing/count/
  fixed error code; không content, workspace/task ID, URI/path, SQL hoặc raw exception.
- Viết tài liệu người dùng/developer về vị trí theo `globalStorageUri` authority/profile,
  global scope, WAL, backup/export khác nhau thế nào, backup/restore thủ công được support,
  reset workflow, corrupt/disk-full/read-only recovery và privacy limitations. Không tuyên
  bố SQLite encrypted at rest.
- Source-boundary/static guard chặn regression log raw SQLite params/path/content và chặn
  filesystem JSON/legacy importer quay lại.

**Gate P5-W6:** secret-canary/redaction tests và docs assertions xanh; tài liệu khớp command
ID/behavior thật; không thêm telemetry/content sink hoặc compatibility path.

#### P5-W7 — Packaged fault UAT và Phase 5 closeout

- Chạy packaged Extension Host UAT trên minimum supported VS Code và current stable cho:
  corrupt open, incompatible/foreign reject, disk-full/readonly write rollback, busy worker
  responsiveness, backup với WAL writer, backup reopen/consistency, reset cancel/success và
  cross-window reset contention.
- Evidence chỉ ghi runtime/version, scenario, fixed result code, duration/count và hash/size
  không nhạy cảm khi thật sự cần; không ghi DB path, workspace URI, prompt/tool output,
  cursor, SQL, stack hoặc secret canary.
- Chạy lại Phase 4 release benchmark/smoke ở mức regression gate cần thiết, không dựng lại
  benchmark hay test SQLite internals. Backup/reset không được làm activation/focus/stream
  vượt budget đã chốt.
- Re-audit production source: không silent reset, malformed-row skip, swallowed busy,
  raw-copy live WAL DB, legacy JSON/migration/backcompat hoặc unbounded hydration.
- Cập nhật evidence và đánh dấu P5-W1…W7/Phase 5 hoàn tất chỉ sau khi mọi gate thật sự xanh.

**Gate P5-W7 / Batch C / Phase 5:** TypeScript, Svelte 0 errors, webview build, full tests,
source/repository boundaries, packaged Extension Host fault UAT, relevant Phase 4 regression
gate và `git diff --check` đều xanh; hai commit W6/W7 riêng, worktree sạch. Mọi lỗi fault
injection fail rõ, redacted, không auto-reset và không mất row âm thầm.

### Phase 6 — Virtualization và cleanup

- Virtualize chat/tree nếu profiling chứng minh cần thiết.
- Xóa projection/cache nào profiling chứng minh thừa sau incremental protocol.
- Giữ Markdown export và SQLite recovery tooling tối thiểu.

**Gate:** DOM/heap bounded trên history lớn và không còn dead storage/protocol path.

## 9. Performance budgets

Đo trên fixture release build, không dùng dev HMR:

- Activation với 100k messages toàn DB: p95 < 300 ms trước backend discovery.
- Commit một streaming batch: p95 < 20 ms, không phụ thuộc tuyến tính vào tổng DB size.
- Focus task và load 100 items gần nhất: p95 < 100 ms.
- Bootstrap task snapshot: < 500 KiB trong trường hợp thông thường.
- Scroll/load page 100 items: p95 < 100 ms query + projection.
- Không block extension-host main thread bằng file lock sleep hoặc full JSON stringify.

## 10. Test/UAT bắt buộc

- Fresh install, empty window, single-root và multi-root.
- Hai VS Code windows ghi cùng DB; hai workspace chạy agent đồng thời.
- 10 concurrent backend turns stream vào các task khác nhau.
- Dependency promotion và operation idempotency dưới transaction contention.
- Clear history/retention không xóa task đang live hoặc artifact còn được tham chiếu.
- Transcript paging trong lúc turn đang append; không duplicate/mất item.
- Database/WAL crash recovery và disk-full behavior.
- Export Markdown parity từ repository projection.
- Secret canary không xuất hiện trong SQLite hoặc logs ngoài dữ liệu conversation mà user chủ động lưu.

## 11. Rủi ro cần chốt trước Phase 1

1. Xác nhận product chấp nhận bỏ support VS Code 1.94–1.100 khi nâng minimum lên 1.101.
2. Empty-window identity và cách relink khi workspace folder được rename/move.
3. Retention của reasoning/tool payload và artifact files.
4. Có mã hóa database at rest hay dựa vào OS/user-profile protection; không tuyên bố SQLite là encrypted nếu chưa dùng SQLCipher.

## 12. Definition of done

- Một `muster.sqlite3` chung dưới `globalStorageUri` là production source of truth.
- Không có runtime filesystem JSON store hoặc data importer.
- Settings vẫn ở VS Code configuration; credentials vẫn ở SecretStorage.
- Engine mutation là row-level transaction; không full-store clone/write.
- Transcript được cursor-page và UI nhận incremental patches.
- Multi-window/WAL, crash recovery và performance gates đều pass.
- Documentation mô tả location, backup/export, privacy và recovery workflow.

## 13. Handoff rules cho implementer

- Không bắt đầu bằng việc thay `storePath` rồi giữ nguyên `TaskStoreFile`; đó chỉ chuyển
  full-envelope JSON vào một SQLite cell và không đạt mục tiêu.
- Không ship schema minh họa thiếu bảng parity. Trước Phase 3 gate phải có entity matrix:
  mỗi field của `TaskStoreFile`/domain type map tới column, payload codec hoặc derived-only.
- Không thay toàn bộ engine trong một commit; đi theo wave/gate ở trên.
- Không silently reset DB, silently skip malformed rows hoặc swallow `SQLITE_BUSY`.
- Không log SQL parameters chứa prompt, tool result, path hoặc credential.
- Mọi benchmark phải ghi fixture size, release/debug mode, machine và before/after; không
  tuyên bố nhanh hơn chỉ dựa trên unit-test duration.

## 14. Tài liệu kỹ thuật tham chiếu

- VS Code 1.101 release notes (Node extension host v22):
  https://code.visualstudio.com/updates/v1_101
- Node built-in SQLite version history/API:
  https://nodejs.org/api/sqlite.html
- VS Code Remote extension host behavior:
  https://code.visualstudio.com/api/advanced-topics/remote-extensions
