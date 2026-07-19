# Engine → repository command matrix

Đây là inventory bắt buộc để hoàn tất Phase 2/3. Không call site runtime nào được giữ
`TaskStore.commit(draft => …)` khi SQLite trở thành source of truth. Mỗi dòng dưới đây
phải trở thành một command bất biến, transaction worker-owned, và được chạy trong contract
suite trên `JsonTaskRepository` lẫn `SqliteTaskRepository`.

| Luồng hiện tại | Call sites chính | Command đích | Trạng thái thực tế | Atomicity/invariant |
|---|---|---|---|---|
| Tạo root + first prompt | `startNewTask` | `createRootAndInitialTurn` | Đã implement; webview route dùng async repository | Task, message, turn, receipt cùng transaction; receipt idempotent. |
| Send / FIFO follow-up | `send`, `reserveQueuedFollowUp`, `continueTask` | `enqueueMessageTurn`, `drainPendingSends`, `queueTaskTurn` | Đã implement; production send path await repository; sync selectors chỉ là compatibility projection | Reopen/release nếu cần, cap turn, message+turn+receipt cùng transaction. |
| Queue edit/delete/resume/retry | `editQueuedTurn`, `deleteQueuedTurn`, `resumeQueuedTurn`, `retryTurn` | `editQueuedMessage`, `deleteQueuedTurnAndMessages`, `clearQueuedTurnHold`, `retryTurn` | Đã implement + JSON/SQLite contract tests | Chỉ queued/current task; xóa transcript bound theo FK. |
| Scheduler promotion | `scheduleTurn`, `tryPromoteTurn`, `executeTurn` | `claimTurn` | Đã migrate runtime; contention tests chạy trên cả adapters | Readiness, FIFO, limits, session/path/git claims ở worker transaction. |
| Dispatch pin/start | `executeTurn` start commit | `prepareDispatch` | Đã migrate runtime | Runtime epoch, input pins, prompt freeze, deadline, running transition và session/resource claim cùng transaction. |
| Stream transcript | normalized event cases | `appendTranscriptBatch`, `replaceLiveTurn` | Đã migrate row-level runtime; benchmark chứng minh focused-row write | Coalesce ở caller; repository chỉ chạm row liên quan và một revision/feed. |
| Settle/recovery | success/fail/interrupt/timeout paths | `settleTurnAndApplyEffects`, `reconcileOrphanTurn`, `applyDependencyTerminals` | Đã migrate runtime; dependency/graph wake có named commands | Release claims, terminal state, task result, retry/hold/dependency wake atomically. |
| Ask/cancel | elicitation, `processCancelRequests` | `recordAsk`, `answerAsk`, `putCancelRequest`, `consumeCancelRequest` | Đã migrate; consumer có owner + request fence và projection hydration | Request keyed by turn; không mất abort/cancel. |
| Graph/coordinator tools | `engine-graph.ts` | `createChildTask`, `delegateChildTask`, `createChildTaskBatch`, `delegateChildTaskBatch`, `releaseChildTasks`, `continueChildTask`, `waitForChildTasks`, `completeGraphTask`, `failGraphTask`, `cancelChildTasks`, `interruptChildTask`, `cancelChildTask`, `setChildTaskLifecycle` | Đã migrate; không còn command generic `applyGraphMutation`; SQLite/JSON parity + replay/conflict tests | Ownership/capabilities, graph rows và operation ledger trong một worker transaction với revision/turn/claim fences. |
| Handoff/verification/remediation | handoff, verdict/recovery helpers | `requestRuntimeHandoff`, `applyVerdictRemediation`, `enqueueDispositionRepair` | Đã migrate runtime | Epoch fence và continuation durable trước side effect. |
| Retention | `applyRetentionToStore` | `applyRetentionPolicy` | Đã implement row-level + parity tests; JSON chỉ compatibility | Indexed row deletes/truncates; không copy/rewrite workspace envelope. |

## Migration rule

Trong giai đoạn chuyển tiếp, JSON adapter có thể dùng state DTO nội bộ để giữ behavior,
nhưng engine/host chỉ gọi command/query interface async. SQLite adapter không được nhận
whole `TaskStoreFile`, callback mutation, hay `before/after` envelope diff từ runtime.
Các graph command có payload delta chung bên trong adapter để tránh nhân đôi SQL; caller
vẫn gửi discriminant domain-specific và validator kiểm tra fence/invariant theo command.
