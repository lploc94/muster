# Muster audit và lộ trình cải tiến tương lai

## Tóm tắt điều hành

M001 là milestone audit và lập lộ trình, không phải milestone sửa hành vi production của extension. Kết quả chính là báo cáo tiếng Việt này và verifier `scripts/verify-muster-audit-report.test.mjs` để giữ cấu trúc báo cáo ổn định.

Muster hiện là VS Code extension MVP để điều phối nhiều AI CLI. Claude backend đã có streaming cơ bản; webview chat, session resume và runner đã có nền tảng ban đầu; MCP bridge và các backend Grok/Codex/Antigravity còn đang ở mức thiết kế hoặc spike. Hướng ưu tiên an toàn nhất là tạo regression tests trước, rồi harden Claude/session/runtime, harden MCP bridge và bảo mật, bật CI/package readiness, đồng bộ tài liệu, sau đó mới mở rộng multi-backend.

## Chú giải mức độ tin cậy

- [Bằng chứng] Sự kiện đọc trực tiếp từ repository, ví dụ `package.json`, `.github/workflows/ci.yml`, `src/backends/claude.ts` hoặc tài liệu trong `docs/`.
- [Suy luận] Rủi ro hợp lý được suy ra từ code/config hiện có nhưng chưa được kiểm chứng runtime.
- [Nghiên cứu] Khuyến nghị dựa trên thực hành phổ biến cho VS Code extension, child process runner, CI, packaging và local security boundary.
- [Chưa rõ] Hành vi cần chạy thử với VS Code, CLI hoặc người dùng thật trước khi kết luận.

## Phạm vi và nguồn bằng chứng

- [Bằng chứng] `README.md` ghi Muster là "Early MVP": Claude backend và webview chat cơ bản đã có; Grok, Codex, Antigravity, MCP context engine injection và Muster Bridge vẫn là planned.
- [Bằng chứng] `package.json` khai báo extension VS Code, entrypoint `./dist/src/extension.js`, scripts `compile`, `watch`, `mvp:claude`, `test:agy-ask`; chưa có `npm test` tổng hợp hoặc script package/release.
- [Bằng chứng] `.github/workflows/ci.yml` hiện chỉ chạy bằng `workflow_dispatch` và chỉ thực hiện `npm ci` + `npm run compile`.
- [Bằng chứng] `tsconfig.json` bật `strict: true`, dùng CommonJS, `rootDir: "."`, include cả `src/**/*` và `scripts/**/*`.
- [Bằng chứng] `src/extension.ts` dựng webview bằng inline HTML/CSS/JS, nhận `send`/`newSession`, gọi `ClaudeBackend`, và tự đọc/ghi `.muster-sessions.json`.
- [Bằng chứng] `src/backends/claude.ts` spawn `claude -p`, dùng stream-json, resume session, parse JSON lines, gom stderr và yield normalized events.
- [Bằng chứng] `src/session-store.ts` có helper session store, nhưng `src/extension.ts` đang lặp lại logic persistence riêng.
- [Bằng chứng] `mcp/muster-ask-server.mjs` là stdio MCP spike dùng file IPC dưới `MUSTER_RUNTIME_DIR`, có `pending/`, `answers/`, polling 200 ms và timeout mặc định 120 giây.
- [Bằng chứng] `scripts/test-agy-ask-mcp.mjs` tạm sửa `~/.gemini/config/mcp_config.json`, spawn `agy` với `--dangerously-skip-permissions`, rồi restore config theo best effort; đây là spike có rủi ro đụng cấu hình user.
- [Bằng chứng] Các tài liệu `docs/SESSION-MANAGEMENT.md`, `docs/MUSTER-BRIDGE.md`, `docs/MCP-INJECTION.md`, `docs/DESIGN.md` mô tả kiến trúc mục tiêu chi tiết hơn implementation hiện tại.

## Hiện trạng Muster theo miền cải tiến

### Kiểm thử và hồi quy

- [Bằng chứng] Repository có compile script và vài spike runner, nhưng chưa có `npm test` tổng hợp.
- [Bằng chứng] Verifier hiện tại chỉ kiểm tra báo cáo audit, không kiểm thử runtime của extension.
- [Suy luận] Thiếu tests cho adapter parse stream-json, error event, cancellation, session store, webview message handling và MCP timeout làm rủi ro regression cao khi sửa runtime.
- [Nghiên cứu] Nên ưu tiên `node:test` với JSONL fixtures và fake child process trước khi refactor runtime.

### CI và chất lượng build

- [Bằng chứng] CI chỉ chạy thủ công bằng `workflow_dispatch`; push/PR không tự động chạy.
- [Bằng chứng] CI hiện chỉ compile, chưa chạy tests, verifier tài liệu, package smoke hoặc artifact checks.
- [Suy luận] Lỗi type, contract hoặc tài liệu có thể vào main rồi mới bị phát hiện muộn.
- [Nghiên cứu] Nên bật `push`/`pull_request`, thêm `npm test`, và thêm package smoke bằng `vsce` khi phù hợp.

### Type safety và contract sự kiện

- [Bằng chứng] `strict: true` là nền tảng tốt.
- [Bằng chứng] `src/extension.ts` vẫn có fallback kiểu `any`; session JSON parse chưa validate schema rõ ràng.
- [Suy luận] Type strict chưa bảo vệ đủ các ranh giới dữ liệu từ webview, filesystem, stdout JSONL của Claude và MCP answer files.
- [Nghiên cứu] Nên thêm schema guards, discriminated helpers và fixtures để tránh silent failure khi payload đổi shape.

### Kiến trúc, vận hành và runtime reliability

- [Bằng chứng] Thiết kế hiện chọn per-turn spawn, normalized streaming events và explicit session IDs.
- [Bằng chứng] Claude backend có AbortSignal -> `SIGTERM`, gom stderr và yield `error` khi exit code khác 0.
- [Bằng chứng] Webview/extension chưa có gate rõ cho một turn đang chạy, queue hoặc cancellation UI.
- [Suy luận] Hai prompt đồng thời trên cùng workspace có thể ghi đè session store hoặc tạo lịch sử CLI ngoài ý muốn.
- [Chưa rõ] Chưa có runtime proof trong VS Code Extension Development Host cho long stream, malformed JSONL, missing `claude` PATH, cancel hoặc stderr lớn.

### Session management và persistence

- [Bằng chứng] `docs/SESSION-MANAGEMENT.md` yêu cầu chỉ commit session ID sau terminal success, không commit khi error/cancel, và khuyến nghị atomic write.
- [Bằng chứng] `src/session-store.ts` và `src/extension.ts` đang có logic persistence trùng nhau.
- [Suy luận] Duplicate logic làm tăng nguy cơ lệch hành vi; ghi không atomic có thể làm hỏng `.muster-sessions.json` khi có nhiều turn/cửa sổ.
- [Nghiên cứu] Nên tập trung hóa session store, thêm atomic write, validation, lock/queue và test corrupted JSON.

### MCP bridge, bảo mật và trust boundary

- [Bằng chứng] `docs/MUSTER-BRIDGE.md` định hướng production bridge nên là HTTP MCP trong extension; file IPC chỉ là spike.
- [Bằng chứng] MCP spike hiện dựa vào runtime dir, pending/answers files, polling và timeout.
- [Bằng chứng] Agy spike có thể sửa cấu hình MCP cấp user và dùng bypass permissions; không nên xem là test an toàn mặc định.
- [Suy luận] File IPC cần validate id/path traversal, quyền thư mục, cleanup stale files, answer schema và timeout nếu còn dùng.
- [Nghiên cứu] Production bridge nên bind `127.0.0.1`, dùng token, validate Host/Origin, gắn lifecycle theo turn và không expose file/shell proxy.

### Tài liệu, report alignment và developer experience

- [Bằng chứng] README và docs có nhiều claim planned/target architecture đi trước source code hiện tại.
- [Suy luận] Contributor có thể nhầm giữa thứ đã ship và thứ mới là thiết kế.
- [Nghiên cứu] Nên duy trì ma trận claim -> evidence -> status để tránh drift.

### Packaging và release readiness

- [Bằng chứng] `package.json` có metadata VS Code extension và dependency `@vscode/vsce`, nhưng chưa có script package/publish.
- [Suy luận] Trước release cần smoke test VSIX, bundled `dist`, `.vscodeignore`, icon, changelog và extension host.
- [Chưa rõ] Chưa có bằng chứng VSIX hiện tại được tạo/cài/chạy trong VS Code thật.

### Maintainability và mở rộng multi-backend

- [Bằng chứng] `src/types.ts` đã có `Backend` interface và event union cho assistant/tool/usage/error/raw.
- [Suy luận] Nếu thêm backend trước khi có adapter contract tests, mỗi CLI sẽ nhân đôi logic parse/session/MCP riêng.
- [Nghiên cứu] Nên đóng băng adapter contract và conformance fixtures trước khi thêm backend thứ hai/thứ ba.

## Nguyên tắc sắp xếp milestone tương lai

1. Tests và CI đi trước runtime refactor.
2. Mỗi claim phải tách rõ bằng chứng repo, suy luận, nghiên cứu hoặc phần chưa rõ.
3. Không mở rộng backend khi session/MCP/security chưa ổn định.
4. Mỗi milestone phải có dependency, risk, acceptance criteria và verification expectations.
5. M001 chỉ tạo audit/report và verifier, chưa sửa runtime production.

## Mốc 1: Nền tảng automated regression tests

**Mục đích**  
Khóa các contract hiện có trước khi sửa runtime: Claude stream-json adapter, normalized events, session store, runner delegation, MCP ask spike timeout và verifier tài liệu.

**Phụ thuộc / Dependency**  
Không phụ thuộc milestone tương lai nào. Dùng code hiện có trong `src/*`, `mcp/*`, `scripts/*` và fixtures tracked trong repo.

**Rủi ro / Risk**  
Nếu test fake quá mức, test chỉ xác nhận mock thay vì contract thật. Nếu test cần CLI thật, CI sẽ mong manh.

**Tiêu chí chấp nhận / Acceptance criteria**

- Có `npm test` chạy `node:test` cho adapter/session/MCP/report verifier.
- Test Claude adapter bao gồm JSONL hợp lệ, malformed line -> `raw`, stderr capture, non-zero exit -> `error`, cancellation.
- Test session store bao gồm missing file, corrupted JSON, save/load theo backend riêng.
- Test MCP ask spike bao gồm missing env, timeout, malformed answer JSON và unknown tool.
- CI hoặc local command có thể chạy compile + tests trong một lệnh tái lập.

**Kỳ vọng xác minh / Verification expectations**

- `npm run compile`
- `npm test`
- `node --test scripts/verify-muster-audit-report.test.mjs`

## Mốc 2: Claude, session và runtime hardening

**Mục đích**  
Làm đường chạy Claude và session resume đáng tin cậy hơn trước khi thêm bridge production hoặc backend khác.

**Phụ thuộc / Dependency**  
Phụ thuộc Mốc 1 để có regression net cho adapter, session store và error paths.

**Rủi ro / Risk**  
Thay đổi session timing có thể commit session sai khi turn lỗi. Thay đổi spawn/cancel có thể tạo child process mồ côi nếu không test kỹ.

**Tiêu chí chấp nhận / Acceptance criteria**

- `src/extension.ts` dùng chung `src/session-store.ts` hoặc service tương đương thay vì duplicate logic.
- Session ID chỉ được commit sau terminal success; cancel/error không ghi session mới.
- Có queue/reject một in-flight turn mỗi backend/workspace, với UI message rõ ràng.
- Claude backend có timeout/cancellation handling rõ hơn và parser được test bằng fixtures.
- Webview có trạng thái running/done/error nhất quán.

**Kỳ vọng xác minh / Verification expectations**

- `npm test`
- `npm run compile`
- Manual UAT trong VS Code Extension Development Host: prompt mới, continue last, new session, missing `claude` PATH, cancel/abort nếu UI đã có.
- Kiểm tra `.muster-sessions.json` không bị ghi khi turn lỗi/cancel và được ghi khi turn thành công.

## Mốc 3: MCP bridge và security hardening

**Mục đích**  
Biến thiết kế `muster_bridge.ask_user` thành implementation an toàn, có timeout, có cancel và phù hợp trust boundary extension-host/webview/CLI.

**Phụ thuộc / Dependency**  
Phụ thuộc Mốc 1 cho negative tests và Mốc 2 cho turn lifecycle ổn định.

**Rủi ro / Risk**  
Bridge có thể thành bề mặt tấn công nếu mở file/shell proxy, không bind localhost/token hoặc chấp nhận payload không validate. Blocking `ask_user` có thể treo CLI nếu timeout/cancel không được bubble đúng.

**Tiêu chí chấp nhận / Acceptance criteria**

- Production path ưu tiên AskBridge trong extension và local MCP endpoint/callback theo `docs/MUSTER-BRIDGE.md`; file IPC spike được đánh dấu dev-only hoặc thay thế.
- MCP config injection tạo per-turn config an toàn, dùng `--strict-mcp-config` với Claude khi hỗ trợ.
- `ask_user` validate input/output schema, timeout, cancel, duplicate id và malformed payload.
- File/spike path nếu còn tồn tại phải validate `MUSTER_RUNTIME_DIR`, id/path traversal, cleanup, answer size/schema và stale-file behavior.
- Local MCP endpoint dùng token, bind localhost, Host/Origin validation và không expose file/shell proxy.

**Kỳ vọng xác minh / Verification expectations**

- `npm test` với negative cases cho timeout, malformed answer, duplicate id, cancellation và unknown tool.
- `npm run compile`
- Manual UAT: agent gọi `ask_user`, webview hiện question card, submit answer tiếp tục cùng turn, timeout/cancel trả error thay vì treo.

## Mốc 4: CI, package và release readiness

**Mục đích**  
Biến MVP từ code có thể compile thành artifact có thể kiểm chứng trên PR và đóng gói VSIX một cách lặp lại.

**Phụ thuộc / Dependency**  
Phụ thuộc Mốc 1 để có `npm test`; nên sau Mốc 2/3 nếu release muốn gom runtime/bridge hardening đầu tiên.

**Rủi ro / Risk**  
Bật CI đầy đủ có thể làm lộ lỗi tồn đọng về test flake, dependency cache, dist/outDir hoặc packaging. VSIX có thể tạo được nhưng extension vẫn chưa chạy nếu không smoke runtime.

**Tiêu chí chấp nhận / Acceptance criteria**

- CI chạy trên `push` và `pull_request`, không chỉ `workflow_dispatch`.
- CI chạy `npm ci`, `npm run compile`, `npm test`, verifier tài liệu và package smoke.
- `package.json` có script `test`, `package:check` và nếu cần `vscode:prepublish`.
- Release checklist bao gồm VS Code engine, bundled `dist`, `.vscodeignore`, CHANGELOG, license, icon/metadata và smoke install.

**Kỳ vọng xác minh / Verification expectations**

- Local: `npm ci`, `npm run compile`, `npm test`, `npm run package:check`.
- GitHub Actions: PR mẫu pass với cùng command.
- Manual smoke: cài VSIX vào Extension Development Host hoặc VS Code profile sạch và mở Muster view.

## Mốc 5: Tài liệu, report alignment và developer experience

**Mục đích**  
Giữ README, design docs, bridge/session docs và report audit khớp với implementation sau các milestone hardening.

**Phụ thuộc / Dependency**  
Phụ thuộc Mốc 2/3/4 để tài liệu phản ánh code mới.

**Rủi ro / Risk**  
Tài liệu có thể tiếp tục nói quá mức planned vs implemented nếu không có verifier. Quá nhiều tài liệu trùng lặp sẽ tạo drift.

**Tiêu chí chấp nhận / Acceptance criteria**

- README feature matrix tách rõ implemented, partial, planned và experimental.
- `docs/SESSION-MANAGEMENT.md`, `docs/MUSTER-BRIDGE.md`, `docs/MCP-INJECTION.md`, `docs/DESIGN.md` có status khớp code.
- `docs/README.md` index đúng tên và phạm vi tài liệu.
- Báo cáo audit được cập nhật nếu sequence thay đổi, vẫn giữ confidence labels.

**Kỳ vọng xác minh / Verification expectations**

- `node --test scripts/verify-muster-audit-report.test.mjs`
- `npm test` nếu verifier tài liệu nằm trong suite chung.
- Review doc claim matrix: mỗi claim quan trọng có citation đến code/config/doc hoặc được gắn [Chưa rõ].

## Mốc 6: Multi-backend maintainability và adapter conformance

**Mục đích**  
Chuẩn hóa cách thêm Grok, Codex, Antigravity và các backend sau này mà không nhân đôi logic session/MCP/error parsing.

**Phụ thuộc / Dependency**  
Phụ thuộc Mốc 1 cho contract tests, Mốc 2 cho runner/session lifecycle, Mốc 3 cho MCP injection/bridge, và Mốc 5 cho docs alignment.

**Rủi ro / Risk**  
Mỗi CLI có flags/session/streaming khác nhau; interface quá chung sẽ che edge cases, interface quá riêng sẽ kh
ó maintain.

**Tiêu chí chấp nhận / Acceptance criteria**

- Có adapter conformance suite dùng chung cho backend: session start/resume, assistant deltas, tool events nếu có, usage/error/raw, cancellation.
- Backend capability matrix được doc và test: reasoning, detailed tool events, MCP, session ownership, streaming format.
- Grok/Codex/Antigravity chỉ được bật UI nếu đạt smoke tests tối thiểu và status docs khớp.
- Shared helpers cho spawn, env, MCP config, stderr handling và cancellation giảm duplicate code.

**Kỳ vọng xác minh / Verification expectations**

- `npm test` với conformance fixtures cho từng backend được hỗ trợ.
- `npm run compile`
- Manual smoke cho mỗi backend đã bật: prompt mới, resume, MCP config injection nếu backend hỗ trợ, error khi CLI missing.

## Ma trận ưu tiên miền cải tiến

| Miền | Mức ưu tiên | Lý do | Mốc chính |
|---|---:|---|---|
| Kiểm thử tự động | Rất cao | Dây an toàn cho mọi refactor runtime | Mốc 1 |
| Claude/session/runtime reliability | Rất cao | User loop hiện có của MVP | Mốc 2 |
| Bảo mật/MCP bridge | Cao | Trust boundary và human-in-the-loop production | Mốc 3 |
| CI/package readiness | Cao | Chất lượng bắt buộc trên PR/release | Mốc 4 |
| Tài liệu/report alignment | Trung bình-cao | Giảm drift giữa design và code | Mốc 5 |
| Multi-backend expansion | Sau | Chỉ nên làm sau khi contract và security ổn định | Mốc 6 |

## Các điều chưa rõ cần kiểm chứng bằng UAT/runtime

- [Chưa rõ] Claude CLI version thực tế có hỗ trợ đầy đủ flags đang dùng trong `src/backends/claude.ts` trên mọi môi trường không.
- [Chưa rõ] Webview UX khi stream dài, stderr lớn, malformed event hoặc user bấm liên tiếp nhiều prompt.
- [Chưa rõ] Session resume trong VS Code thật có khớp với `docs/SESSION-MANAGEMENT.md` không.
- [Chưa rõ] `muster_bridge` production nên dùng HTTP MCP trực tiếp hay fallback stdio callback cho từng CLI.
- [Chưa rõ] Packaging VSIX hiện tại có gom đúng `dist` và chạy được sau install hay chưa.

## Failure Modes

- Nếu source/docs đầu vào thiếu hoặc stale, report evidence sẽ yếu; cách xử lý là gắn [Chưa rõ] thay vì khẳng định production fact.
- Nếu `docs/MUSTER-AUDIT-ROADMAP.vi.md` vắng mặt hoặc thiếu cấu trúc, verifier sẽ fail.
- Nếu future milestone thiếu dependency, risk, acceptance criteria hoặc verification expectations, verifier sẽ fail.

## Load Profile

Báo cáo này không chạy load test. Các breakpoint cần kiểm chứng sau gồm số lượng subprocess khi nhiều prompt đồng thời, stderr buffering, polling file IPC 200 ms mỗi pending ask, và stale pending/answer files nếu spike MCP chạy lâu.

## Negative Tests

- `scripts/verify-muster-audit-report.test.mjs` fail nếu missing report.
- Verifier fail nếu thiếu title/summary tiếng Việt, thiếu chú giải confidence labels, thiếu miền cải tiến bắt buộc, hoặc milestone thiếu dependency/risk/acceptance/verification.

## Kết luận

Hướng đi an toàn nhất cho Muster là không thêm ngay nhiều backend hoặc UI lớn. Trước hết nên tạo regression net và harden đường Claude/session hiện có. Sau đó bridge/security và CI/package readiness mới biến MVP thành nền tảng có thể release. Tài liệu và multi-backend maintainability nên đi sau bằng chứng runtime, để mỗi milestone tương lai không chỉ là ý tưởng mà có tiêu chí chấp nhận và kỳ vọng xác minh rõ ràng.
