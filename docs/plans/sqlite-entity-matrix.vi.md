# SQLite entity matrix — Phase 3

Tài liệu này chốt mapping từ `TaskStoreFile` sang SQLite trước khi bật migration/cutover.
`payload_json` luôn là object có `payloadVersion: 1` đối với row mới. Các row Phase 2/legacy
chưa có version vẫn chỉ được đọc để migration/export; writer Phase 3 không tạo field promoted
trong payload.

| Aggregate | Source of truth SQLite | Payload low-query | Ghi chú |
|---|---|---|---|
| Workspace | `workspaces` | Không | `identity_key` là lookup key; không suy từ tên folder. |
| Workspace location | `workspace_locations` | Không | URI aliases, unique theo URI. |
| Task | `tasks` | Mô tả, brief, wait, handoff, policy, result, attention, capability… | Không lặp `id`, parent, role, lifecycle, release, goal, backend/model, revision hay timestamps. |
| Dependency | `task_dependencies` | Không | Không lặp `MusterTask.dependencies`. |
| Turn | `turns` | Retry/disposition/runtime/dispatch/pin/error… | Không lặp identity, task, sequence, status/trigger hay timestamps. |
| Turn input | `turn_inputs` | Payload typed theo input kind | Canonical ordering, không lặp `TaskTurn.inputs`. |
| Message | `messages` | `agentContent` và field display low-query | Không lặp identity/task/turn/role/state/content/order/timestamp. |
| Tool call | `tool_calls` | kind/input/output/error | Query/render fields là columns. |
| Reasoning | `reasoning_segments` | Không | Một segment/turn hiện tại có `ordering=0`, schema cho phép mở rộng. |
| Operation ledger | `operations` | `result_json` versioned | `claimOperation` insert-once; fingerprint khác là conflict. |
| Cancel request | `turn_cancel_requests` | sealedBy/reason | Bảng `cancel_requests` v1 giữ compatibility-only vì key v1 sai theo task; runtime mới không ghi vào đó. |
| Send receipt | `send_receipts` | Không | Key là `(workspace_id, client_request_id)`. |
| Scheduler session claim | `session_claims` | Không | Ephemeral; xóa cùng settlement. |
| Scheduler resource claim | `resource_claims` | Không | Key `git`, `unscoped`, `path:<normalized>`; ephemeral. |
| Revision/feed | `workspace_revisions`, `change_log` | Không | Mỗi mutation transaction thành công tăng revision đúng một lần. |
| Migration state | `migration_state` | detail giới hạn | Chỉ Phase 5 importer/cutover dùng. |

## Invariants Phase 3

- Mọi identity domain là composite `(workspace_id, entity_id)`; không giả định UUID cũ unique toàn DB.
- Tất cả write của repository chạy trong một worker-owned `BEGIN IMMEDIATE` transaction.
- `claimTurn` là gate cuối cùng: check FIFO, dependency terminal/verdict, concurrent limits,
  session claim và git/path claim trong cùng transaction; scheduler host có thể pre-check UI/readiness
  nhưng không được coi pre-check là claim.
- Streaming dùng `appendTranscriptBatch`: chỉ upsert message/tool/reasoning trong batch và một revision,
  không materialize hay rewrite `TaskStoreFile`/toàn database.
- `readEnvelopeForMigration` là đường compatibility/export duy nhất được phép materialize đầy đủ envelope.
