# Plan: Chuyển toàn bộ dữ liệu Muster sang SQLite global storage

## Trạng thái

**IN PROGRESS — chưa cutover production.**
Cập nhật: 2026-07-17

- Phase 1: **đã qua gate** — worker/RPC, schema migration, global-storage registry,
  lock/crash/concurrent-migration checks, packaged desktop smoke trên minimum/current
  host, old-host refusal và Remote SSH evidence đều xanh.
- Phase 2: **đã hoàn tất** — host/engine/scheduler/lifecycle/graph/handoff/retention
  đi qua repository boundary và named commands; direct runtime commit ngoài JSON
  compatibility adapter bằng 0.
- Phase 3: **đã qua parity gate** — dual-adapter behavior suites, contention/replay/
  conflict/orphan/retention checks, bounded snapshot query, source-boundary audit và
  transcript benchmark đã chạy; entity/command matrices phản ánh trạng thái thực tế.
- Phase 4 chưa bắt đầu. Phase 5/6 chưa bắt đầu; JSON vẫn là compatibility/source path
  cho đến migration/cutover có chủ đích. Kết quả Wave 10 được ghi tại
  [`sqlite-phase3-gate-evidence.vi.md`](./sqlite-phase3-gate-evidence.vi.md).

## 1. Kết quả sản phẩm mong muốn

- Muster dùng **một database SQLite chung trong cùng VS Code profile + extension host authority** cho mọi workspace và cửa sổ thuộc authority đó.
- Database nằm dưới `context.globalStorageUri`, không tạo file dữ liệu trong repository.
- Ngoại trừ cấu hình trong VS Code Settings và credential trong VS Code SecretStorage, dữ liệu bền vững của Muster nằm trong SQLite.
- Conversation/task dài không còn làm mỗi commit clone, parse và ghi lại toàn bộ store.
- Mở workspace chỉ đọc metadata cần thiết; transcript được phân trang.
- Streaming dùng batch write và incremental UI patch, không rebuild/gửi lại toàn bộ snapshot cho mỗi chunk.
- Có migration an toàn từ `.muster-tasks.json`, có backup và có thể retry; không mất dữ liệu khi upgrade bị gián đoạn.

## 2. Hiện trạng và bottleneck

Hiện tại extension chọn store tại:

```text
<workspace>/.muster-tasks.json
```

hoặc `context.globalStorageUri/.muster-tasks.json` khi không có workspace folder.

`TaskStore.commit()` hiện:

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
| Session/runtime bindings, asks, handoffs, migration state | SQLite |
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
- Mọi migration schema dùng `PRAGMA user_version` và transaction.
- Set/verify một `PRAGMA application_id` riêng của Muster trước khi đọc schema. Schema
  migration được serialize bằng exclusive migration transaction; process thua race phải
  reopen/verify version, không chạy lại DDL dựa trên state cũ.
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
- không thêm fallback `better-sqlite3`/`sql.js`: hai driver production làm tăng matrix,
  migration risk và behavior drift.

## 4. Schema v1 đề xuất

Các cột payload ít query có thể là JSON text có version; state/query keys phải là cột
chuẩn. Một field chỉ có **một source of truth**: field đã promote thành column không được
lặp lại trong `payload_json`. Mỗi payload có codec/version validator và migration test;
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

Các bảng tiếp theo giữ parity với `TaskStoreFile`: `operations`, `cancel_requests`,
`send_receipts`, pending asks/handoff state, turn inputs và artifact BLOB metadata. Không
gom operation ledger hoặc input bindings vào một JSON workspace-wide nếu chúng tham gia
query, foreign key, idempotency hay scheduler decisions.

`TaskEngine.createTask` cho phép caller cung cấp task ID; vì vậy ID không được giả định
unique giữa các JSON store cũ. Schema chốt composite identity
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

`TaskStoreFile` được giữ tạm làm compatibility DTO trong migration, tests và export; không còn là runtime source of truth.

Repository phải có hai implementation trong giai đoạn chuyển tiếp:

- `JsonTaskStoreAdapter`: bọc behavior hiện tại để characterization test.
- `SqliteTaskRepository`: implementation production mới.

## 6. Transcript và webview contract

### 6.1 Pagination

- Snapshot đầu chỉ chứa 100 transcript items gần nhất của focused task.
- Response có `beforeCursor`, `hasMoreBefore`.
- Khi scroll lên, webview gửi `loadTranscriptPage`.
- Cursor opaque, versioned và dựa trên canonical transcript sort key
  `(turn.sequence, kind_rank, ordering, created_at, entity_id)`; `kind_rank` và fallback
  ordering phải khớp chính xác `buildTranscript()` hiện tại. Không dùng offset.
- Page query chạy trong read transaction/snapshot nhất quán; response mang
  `workspaceRevision` để reducer phát hiện gap.

### 6.2 Incremental patches

Tách bootstrap snapshot khỏi cập nhật runtime:

- `taskUpserted`
- `turnActivityChanged`
- `transcriptItemsAppended`
- `transcriptItemPatched`
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

## 7. Migration từ JSON

### 7.1 State machine

SQLite lưu migration record:

```text
not_started → importing → verified → active
                         ↘ failed
```

Quy trình:

1. Tạo/migrate schema trong transaction.
2. Với workspace đang mở, lazy-discover `<workspace>/.muster-tasks.json`; một global DB
   không thể tự tìm mọi repository từng tồn tại trên máy.
3. Đọc và validate bằng loader schema-v6 hiện tại.
4. Import toàn bộ envelope trong một transaction idempotent.
5. So sánh count, IDs và content digest theo từng entity.
6. Commit `verified`, sau đó mới chọn SQLite làm active source.
7. Sau khi SQLite commit `active`, rename JSON thành
   `.muster-tasks.json.migrated-<timestamp>`; không xóa tự động trong release đầu.

Store legacy ở `globalStorageUri/.muster-tasks.json` (empty-window fallback) được import
vào logical empty workspace riêng. Không gán nó tùy tiện cho workspace folder đầu tiên.

Nếu crash trước bước 6, lần activate sau rollback/retry import. Composite identity +
migration source digest ngăn import trùng.

Import không được giữ nguyên timestamp string hoặc enum không hợp lệ chỉ vì JSON parse
thành công: luôn đi qua sanitizer/migrator hiện tại trước khi insert. Với reasoning hiện
tại là một record mỗi turn, importer tạo đúng một segment có canonical ordering.

### 7.2 Không dual-write dài hạn

Không duy trì JSON và SQLite song song sau cutover vì dễ split-brain. Có thể dùng shadow-read trong development để so projection, nhưng production phải có một source of truth sau `active`.

### 7.3 Rollback

- Trước `active`: tiếp tục dùng JSON.
- Sau `active`: rollback extension không tự ghi đè JSON backup.
- Cung cấp command export SQLite workspace thành JSON/Markdown để recovery.
- Corrupt DB: đóng connection, copy DB/WAL/SHM cùng một recovery set vào quarantine,
  hiển thị recovery UI; không copy riêng main DB khi còn committed WAL và không tạo DB
  rỗng rồi ghi đè âm thầm.
- Backup/export DB live dùng SQLite backup API hoặc checkpoint + coordinated copy, không
  dùng `fs.copyFile(muster.sqlite3)` đơn lẻ.

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
- Tạo DB worker/RPC, connection manager, pragmas, schema migrations và workspace registry.
- Test WAL multi-connection, busy timeout, crash transaction và foreign keys.

**Gate:** VSIX chạy `node:sqlite` trên minimum/current desktop + Remote host; VS Code cũ
bị từ chối đúng bởi engine compatibility; artificial 5-second DB lock không block
extension-host heartbeat/UI command.

### Phase 2 — Repository boundary

- Tách engine/snapshot/export khỏi `TaskStoreFile` mutation API.
- Chuyển call chain liên quan sang async named commands/query API; không bọc sync API bằng
  fire-and-forget.
- Chạy cùng contract suite trên JSON adapter và SQLite repository.

**Gate:** scheduler/lifecycle tests pass trên cả hai implementations.

### Phase 3 — SQLite parity

- Implement CRUD/transactions cho toàn bộ entities.
- Atomic scheduler promotion, operation idempotency và session/resource claims.
- Retention chuyển thành indexed DELETE theo workspace/task.

**Gate:** SQLite đạt behavior parity và không full-table/full-database rewrite khi stream.

#### Kế hoạch khép Phase 1–3 theo 10 wave

Không bắt đầu Phase 4 chỉ vì các SQLite primitive đã tồn tại. Audit ngày 2026-07-17
ghi nhận **44 runtime mutation sites** còn gọi `TaskStore.commit()` ngoài JSON adapter:
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
- Test engine compatibility từ chối VS Code 1.100 trở xuống.
- Test lock contention thật bằng hai DB workers: một connection giữ write lock khoảng
  5 giây, connection còn lại chờ `busy_timeout`, trong khi extension-host heartbeat vẫn
  đáp ứng.
- Test terminate worker/process giữa transaction rồi reopen DB để xác nhận rollback và
  WAL recovery; test concurrent schema migration/open.
- Chạy Remote Extension Host test/UAT. Không có evidence Remote thì Phase 1 chưa qua gate.
- Ghi rõ policy: probe có thể advisory khi JSON còn là production source; nó trở thành
  hard gate ở Phase 5 ngay trước khi SQLite là writable source duy nhất. Không được fallback
  sang JSON sau cutover.

##### Wave 2 — Extension/provider boundary

- Thay bốn direct commits của host bằng named commands:
  `clearHistory`, `deleteTaskSubtreeIfIdle`, `renameTask`, `applyRetentionPolicy`.
- Các lệnh clear/delete phải kiểm tra toàn subtree và live-turn safety trong cùng
  transaction, không quyết định trên snapshot cũ rồi mới delete.
- Dựng snapshot bằng repository queries; `postSnapshot()` không được gọi
  `readEnvelopeForMigration()` hoặc materialize toàn workspace.
- Export chỉ đọc qua repository; bỏ `getStoreFile` fallback. Export/migration là hai
  nơi duy nhất được phép materialize compatibility envelope.
- Chạy cùng host/snapshot/export contract tests trên JSON và SQLite adapters.

##### Wave 3 — Engine queue và user-facing mutations

- Chuyển reserve queued follow-up, resume queued turn, create task, send/enqueue,
  edit/delete queued message, start/continue task và interrupt turn sang async named
  commands.
- Loại runtime sync mutation paths và mọi fire-and-forget persistence liên quan; caller
  phải await kết quả durable trước khi ACK, schedule hoặc phát side effect.
- Mỗi command có task revision, turn status/epoch, FIFO và idempotent receipt guards phù hợp.
- Chạy cùng ingress/queue behavior suite trên JSON và SQLite adapters.

##### Wave 4 — Engine lifecycle và reconciliation

- Chuyển `stageDisposition`, `setTaskLifecycle`, `skipTask`, `cancelTask`, reload
  reconciliation, child-wait reconciliation, dependency-terminal propagation và verdict
  remediation sang named commands.
- Dependency/wait/lifecycle effects liên quan phải commit atomically; không để một task
  terminal nhưng dependent/wait state ở revision cũ.
- Mỗi operation phải có ownership, revision và runtime-epoch fence; chạy cùng contract
  suite trên cả hai adapters.

##### Wave 5 — Scheduler, settlement, handoff và engine boundary

- Chuyển runtime handoff, verdict revalidation, post-settlement follow-up draining,
  missing-input attention và disposition repair sang named commands.
- Xóa compatibility bridge đang clone full `TaskStoreFile` để chuẩn bị dispatch hoặc
  settlement; chỉ query và persist các aggregate/rows thực sự liên quan.
- Thay filesystem `.lease.<turnId>` bằng repository-owned runtime claim có owner,
  expiry/heartbeat và stale-claim recovery.
- Scheduler database transaction tự suy ra owning root từ candidate task; không tin
  `rootTaskId` do caller truyền để enforce `maxConcurrentPerRoot`.
- Bỏ `store: TaskStore` bắt buộc khỏi `TaskEngineConfig`; engine phải chạy hoàn toàn trên
  `JsonTaskRepository` hoặc `SqliteTaskRepository`.
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
- Chạy behavior suite tương ứng trên JSON và SQLite adapters, gồm contention/replay.

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
- Sau wave này direct `TaskStore.commit()` ngoài `JsonTaskRepository` phải bằng 0. Chạy
  full test suite và source-boundary audit.

##### Wave 10 — Phase 3 parity audit và gate cuối

- Enforce source-boundary checks: engine/graph/snapshot không import `TaskStore`;
  `readEnvelopeForMigration()` chỉ xuất hiện trong migration/export; không còn direct
  commit ngoài JSON adapter/legacy store implementation.
- Cập nhật entity matrix cho runtime owner/lease, expiry và stale-claim recovery; audit
  mọi domain field/aggregate qua codec hoặc promoted column.
- Chạy toàn bộ scheduler/lifecycle/graph behavior suite trên cả JSON và SQLite, gồm
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

**Gate trước Phase 4:** Wave 1–10 đều hoàn tất; 44 runtime mutation sites đã về 0 ngoài
JSON compatibility adapter; engine/graph/snapshot chạy qua repository boundary; dual-adapter
scheduler/lifecycle/graph suites xanh; Phase 1 VSIX/lock/crash/Remote evidence đầy đủ; và
SQLite đạt row-level behavior parity dưới contention.

### Phase 4 — Pagination và incremental wire protocol

- Transcript cursor API, load-older action, patches và stream batching.
- Webview reducer idempotent; protocol-version fallback/reload banner.
- Cross-process revision polling + `change_log` gap recovery.

**Gate:** task 10k transcript items mở nhanh, bootstrap size bounded và hai window hội tụ
về cùng UI state mà không reload thủ công.

### Phase 5 — Migration/cutover

- Import validator, digest verification, backup rename và recovery command.
- Feature flag nội bộ để dogfood; telemetry chỉ dùng timing/count, không gửi content/path.
- Rollout theo `json → sqlite_shadow_verify → sqlite`; flag là host-internal, không tạo
  hai writable sources. `sqlite_shadow_verify` chỉ import/read/compare projection.
- Cutover production sang `globalStorageUri/muster.sqlite3`.

**Gate:** test crash ở từng migration boundary, UAT với store thật đã sao lưu và mọi
performance budget pass trước khi feature flag mặc định chuyển sang SQLite.

### Phase 6 — Virtualization và cleanup

- Virtualize chat/tree nếu profiling chứng minh cần thiết.
- Xóa JSON runtime adapter sau một compatibility window.
- Giữ import/export tooling và migration backup policy có thời hạn rõ ràng.

**Gate:** không còn code path production ghi `.muster-tasks.json`.

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
- Import schema-v1…v6 JSON; corrupt/truncated JSON; duplicate import retry.
- Hai VS Code windows ghi cùng DB; hai workspace chạy agent đồng thời.
- 10 concurrent backend turns stream vào các task khác nhau.
- Dependency promotion và operation idempotency dưới transaction contention.
- Clear history/retention không xóa task đang live hoặc artifact còn được tham chiếu.
- Transcript paging trong lúc turn đang append; không duplicate/mất item.
- Database/WAL crash recovery và disk-full behavior.
- Export Markdown/JSON parity trước và sau migration.
- Secret canary không xuất hiện trong SQLite, logs, migration backup ngoài dữ liệu conversation mà user chủ động lưu.

## 11. Rủi ro cần chốt trước Phase 1

1. Xác nhận product chấp nhận bỏ support VS Code 1.94–1.100 khi nâng minimum lên 1.101.
2. Empty-window identity và cách relink khi workspace folder được rename/move.
3. Retention của reasoning/tool payload và artifact files.
4. Mức backward compatibility khi downgrade extension.
5. Có mã hóa database at rest hay dựa vào OS/user-profile protection; không tuyên bố SQLite là encrypted nếu chưa dùng SQLCipher.

## 12. Definition of done

- Một `muster.sqlite3` chung dưới `globalStorageUri` là production source of truth.
- Không tạo hoặc cập nhật `.muster-tasks.json` trong workspace mới.
- Store JSON cũ được import idempotent, verify và backup trước cutover.
- Settings vẫn ở VS Code configuration; credentials vẫn ở SecretStorage.
- Engine mutation là row-level transaction; không full-store clone/write.
- Transcript được cursor-page và UI nhận incremental patches.
- Multi-window/WAL, crash recovery, migration và performance gates đều pass.
- Documentation mô tả location, backup/export, privacy và recovery workflow.

## 13. Handoff rules cho implementer

- Không bắt đầu bằng việc thay `storePath` rồi giữ nguyên `TaskStoreFile`; đó chỉ chuyển
  full-envelope JSON vào một SQLite cell và không đạt mục tiêu.
- Không ship schema minh họa thiếu bảng parity. Trước Phase 3 gate phải có entity matrix:
  mỗi field của `TaskStoreFile`/domain type map tới column, payload codec hoặc derived-only.
- Không thay toàn bộ engine trong một commit. Mỗi phase có tests và compatibility seam;
  JSON production path chỉ bị tắt sau migration + pagination gates.
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
