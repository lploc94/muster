# Engine → repository command matrix

Đây là inventory bắt buộc để hoàn tất Phase 2/3. Không call site runtime nào được giữ
`TaskStore.commit(draft => …)` khi SQLite trở thành source of truth. Mỗi dòng dưới đây
phải trở thành một command bất biến, transaction worker-owned, và được chạy trong contract
suite trên `JsonTaskRepository` lẫn `SqliteTaskRepository`.

| Luồng hiện tại | Call sites chính | Command đích | Trạng thái thực tế | Atomicity/invariant |
|---|---|---|---|---|
| Tạo root + first prompt | `startNewTask` | `createRootAndInitialTurn` | Đã implement + webview route dùng async repository | Task, message, turn, receipt cùng transaction; receipt idempotent. |
| Send / FIFO follow-up | `send`, `reserveQueuedFollowUp`, `continueTask` | `enqueueMessageTurn` | Đã implement + webview route dùng `sendAsync`; legacy sync paths còn lại | Reopen/release nếu cần, cap turn, message+turn+receipt cùng transaction. |
| Queue edit/delete/resume/retry | `editQueuedTurn`, `deleteQueuedTurn`, `resumeQueuedTurn`, `retryTurn` | `editQueuedMessage`, `deleteQueuedTurn`, `clearTurnHold`, `retryTurn` | Webview edit/delete/resume/retry đã async repository | Chỉ queued/current task; xóa transcript bound theo FK. |
| Scheduler promotion | `scheduleTurn`, `tryPromoteTurn`, `executeTurn` | `claimTurn` | Command + contention tests đã có; runtime chưa dùng | Readiness, FIFO, limits, session/path/git claims ở worker transaction. |
| Dispatch pin/start | `executeTurn` start commit | `prepareDispatch` | Đã migrate runtime | Runtime epoch, input pins, prompt freeze, deadline, running transition và session/resource claim cùng transaction. |
| Stream transcript | normalized event cases | `appendTranscriptBatch`, `replaceLiveTurn` | Đã migrate row-level runtime; coalescer 50–100 ms chưa có | Coalesce batch; chỉ row touched; một revision/feed. |
| Settle/recovery | success/fail/interrupt/timeout paths | `settleTurnAndApplyEffects` | Success/fail/interrupt đã migrate runtime; dependency/graph wake còn ở engine-graph | Release claims, terminal state, task result, retry/hold/dependency wake atomically. |
| Ask/cancel | elicitation, `processCancelRequests` | `recordAsk`, `answerAsk`, `putCancelRequest`, `consumeCancelRequest` | Ask/answer và ghi cancel request đã migrate; consumer cancel trong graph còn dùng legacy store | Request keyed by turn; no lost abort/cancel. |
| Graph/coordinator tools | `engine-graph.ts` | `delegate`, `delegateBatch`, `release`, `wait`, `seal`, `cancelDescendants` | Chưa migrate runtime | Ownership/capabilities, operation ledger and graph mutation in one transaction. |
| Handoff/verification/remediation | handoff, verdict/recovery helpers | `applyRuntimeHandoff`, `applyVerificationResult`, `createRemediation` | Chưa migrate runtime | Epoch fence and continuation are durable before side effects. |
| Retention | `applyRetentionToStore` | `applyRetentionPolicy` | SQLite row-level policy đã có + parity tests; JSON runtime giữ compatibility | Indexed row deletes/truncates; never copy/rewrite workspace envelope. |

## Migration rule

Trong giai đoạn chuyển tiếp, JSON adapter có thể dùng state DTO nội bộ để giữ behavior,
nhưng engine/host chỉ gọi command/query interface async. SQLite adapter không được nhận
whole `TaskStoreFile`, callback mutation, hay `before/after` envelope diff từ runtime.
