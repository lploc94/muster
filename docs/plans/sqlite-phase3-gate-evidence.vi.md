# Evidence gate SQLite Phase 1–3

Cập nhật: **2026-07-17**

Phạm vi: Wave 1–10 của kế hoạch chuyển repository sang SQLite.

Tài liệu này là evidence lịch sử tại gate cuối Phase 3. Quyết định dev-phase sau đó đã
cutover SQLite-only ở Phase 4 và bỏ JSON adapter/data migration; các số liệu bên dưới
không phải trạng thái suite hiện tại.

## Runtime/packaging matrix

| Host | Runtime được kiểm tra | Kết quả |
|---|---|---|
| VS Code 1.101.0 desktop (minimum) | Node 22.15.1 | pass — packaged extension-host smoke, `node:sqlite` worker |
| VS Code 1.129.0 desktop (stable hiện hành trong fixture) | Node 24.18.0 | pass — packaged extension-host smoke |
| VS Code 1.129.0 Remote SSH | Node 24.18.0, remote extension host | pass — smoke chạy trong remote host thật |
| VS Code 1.100.0 | host cũ | pass — bị từ chối đúng vì `engines.vscode: ^1.101.0` |

Các smoke test desktop/remote dùng VSIX đã compile và đóng gói với dependencies. Remote
case xác nhận extension được discover và activation diễn ra ở SSH extension host, không
chỉ chạy test ở local host.

## Automated gates

| Gate | Lệnh/kết quả |
|---|---|
| Full unit/integration suite | `npm test` — **114 files, 1671 tests passed** |
| Repository/engine parity suite | targeted suite — **10 files, 120 tests passed** |
| TypeScript | `npx tsc -p . --noEmit` — pass |
| Extension + webview build | `npm run compile` — pass (tsc + Vite) |
| Svelte diagnostics | `npm run check:svelte` — 0 errors, 1 existing accessibility warning |
| Source boundary | `npm run test:source-boundary` — **22 checks passed**; repository boundary pass |
| Boundary fixtures | `npm run test:source-boundary:fixtures` — **13/13 passed** |
| Concurrent first-open stress | 100 fresh databases × 4 DB workers — **100/100 rounds passed** |

Targeted parity suite khi đó gồm repository, engine-repository, scheduler,
main-thread-nonblocking, crash-recovery, connection, workspace-registry và retention.

## SQLite correctness coverage

- Worker/RPC và allowlisted pragmas; `node:sqlite` feature probe; foreign keys/WAL,
  busy-timeout và connection lifecycle.
- Hai worker tranh chấp write lock trong khi heartbeat/UI loop vẫn đáp ứng; crash giữa
  transaction rồi reopen để kiểm tra rollback/WAL recovery; concurrent first-open schema
  migration.
- Atomic scheduler promotion, runtime claims/expiry/stale recovery, revision/epoch
  fences, operation replay với cùng fingerprint, conflict với fingerprint khác, orphan
  recovery và cancel/settlement paths.
- Retention chỉ xóa row đủ điều kiện, không xóa live turn hoặc row còn được reference;
  transcript append dùng bounded query/row-level update.
- Source scan hiện cấm mọi `TaskStore`, `.commit()` và `readEnvelopeForMigration()`;
  named graph commands được kiểm tra trong repository boundary script.

Entity mapping và command/invariant mapping:

- [`sqlite-entity-matrix.vi.md`](./sqlite-entity-matrix.vi.md)
- [`sqlite-engine-command-matrix.vi.md`](./sqlite-engine-command-matrix.vi.md)

## Transcript benchmark

Lệnh đã chạy:

```text
npm run bench:sqlite-transcript -- --sizes 100,1000,10000 --iterations 20 --json
```

Đây là phép đo development bằng `tsx` trên Apple M4 (darwin arm64), Node v26.0.0,
20 iterations; không phải release-build performance gate. Mỗi lần append kiểm tra
`feedRevisions/feedRows` và xác nhận unrelated rows unchanged.

| Transcript size | SQLite p50 / p95 (ms) | JSON legacy p50 / p95 (ms) | SQLite DB bytes |
|---:|---:|---:|---:|
| 100 | 0.084917 / 0.183833 | 8.034666 / 13.827084 | 1,033,936 |
| 1,000 | 0.093459 / 0.189209 | 11.008083 / 12.042750 | 1,693,136 |
| 10,000 | 0.069125 / 0.509875 | 40.000500 / 45.020125 | 12,381,712 |

Kết quả chứng minh benchmark path chỉ tạo một feed revision/batch và không rewrite
toàn bộ database theo tổng transcript size. Các performance budget release (activation,
bootstrap, paging) vẫn là gate của Phase 4/5 và chưa được tuyên bố đạt ở đây.

## Giới hạn và diễn giải

- Đây là evidence chạy local trên workspace này; chưa có hosted CI result mới được tuyên
  bố trong tài liệu này. Workflow CI vẫn là verifier cần chạy trên môi trường CI của repo.
- Svelte/Vite/VSIX chỉ còn các warning đã nêu; không có TypeScript/Svelte error.
- SQLite probe/open hiện là hard gate và SQLite là writable source duy nhất.
- Không claim encryption at rest hoặc hosted CI evidence ngoài những artifact đã ghi.
