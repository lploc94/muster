# Muster audit va lo trinh cai tien tuong lai

## Executive summary / Tom tat dieu hanh

Tai M001, cong viec chi tao bao cao va cong cu kiem chung cau truc; khong co thay doi hanh vi production nao cua extension. Tai lieu nay bien backlog ky thuat cua Muster thanh lo trinh milestone co the thuc thi, phan biet ro dau la bang chung doc truc tiep trong repository va dau la rui ro suy luan hoac khuyen nghi theo thuc hanh tot.

Muster hien la VS Code extension MVP dieu phoi CLI AI, voi Claude backend co streaming co ban, webview chat toi thieu, session resume dang o muc ban dau, MCP bridge dang la thiet ke/spike va nhieu backend khac con duoc lap ke hoach. Lo trinh de xuat uu tien giam rui ro theo thu tu: khoa hoi quy bang automated tests, cung co Claude/session/runtime, harden MCP bridge va bao mat, bat CI/package readiness, dong bo tai lieu/report, sau do moi mo rong maintainability cho nhieu backend.

## Legend / Chu giai muc do tin cay

- [Evidence] Su kien doc truc tiep tu file trong repository, vi du `package.json`, `src/backends/claude.ts`, `docs/MUSTER-BRIDGE.md`.
- [Inferred] Rui ro hop ly duoc suy ra tu code/config hien co nhung chua duoc runtime kiem chung.
- [Research] Khuyen nghi dua tren thuc hanh pho bien cho VS Code extension, child process runner, CI va packaging.
- [Unknown] Hanh vi can chay thu voi VS Code/CLI/nguoi dung that de ket luan.

## Pham vi va nguon bang chung

- [Evidence] `README.md` mo ta trang thai "Early MVP", hien co Claude backend + webview chat co ban; Grok, Codex, Antigravity, MCP context engine injection va Muster Bridge con la ke hoach.
- [Evidence] `package.json` khai bao extension VS Code, entrypoint `./dist/src/extension.js`, script `compile`, `watch`, `mvp:claude`, `test:agy-ask`; chua co script `test` tong hop hay script packaging/release.
- [Evidence] `.github/workflows/ci.yml` chi chay tren `workflow_dispatch` va chi thuc hien `npm ci` + `npm run compile`.
- [Evidence] `tsconfig.json` bat `strict: true`, dung CommonJS, `rootDir: "."`, include ca `src/**/*` va `scripts/**/*`.
- [Evidence] `src/extension.ts` dung webview co inline HTML/CSS/JS, nhan `send`/`newSession`, goi `ClaudeBackend`, luu session vao `.muster-sessions.json` bang sync filesystem.
- [Evidence] Webview dung `postMessage` cho `send`/`newSession`; extension host can schema validation, CSP/nonce hardening, va malformed-message tests truoc khi coi trust boundary nay la on dinh.
- [Evidence] `src/backends/claude.ts` spawn `claude -p`, them `--resume`, `--output-format stream-json`, `--include-partial-messages`, `--verbose`, tuy chon `--mcp-config`/`--strict-mcp-config`, parse JSON line va bubble stderr/exit code thanh normalized events.
- [Evidence] `src/types.ts` dinh nghia normalized event model gom session, assistant/reasoning/tool/usage/error/raw events; `src/runner.ts` chi uy quyen `yield* backend.run(options)`.
- [Evidence] `src/session-store.ts` co helper doc/ghi `.muster-sessions.json`, nhung `src/extension.ts` dang lap lai logic rieng thay vi import helper.
- [Evidence] `mcp/muster-ask-server.mjs` la stdio MCP spike dung file IPC qua `MUSTER_RUNTIME_DIR`, `pending/`, `answers/`, polling 200 ms va timeout mac dinh 120 giay.
- [Evidence] `scripts/test-agy-ask-mcp.mjs` tam thoi thay `~/.gemini/config/mcp_config.json`, spawn `agy` voi `--dangerously-skip-permissions`, tu dong tra loi pending asks, va restore config theo best effort; day la live/config-mutating spike, khong phai unit test an toan.
- [Evidence] Cac duong smoke CLI (`claude`, `agy`) ke thua `process.env`, cwd va MCP config cua tien trinh goi, nen env/cwd/config la trust boundary can opt-in, sandbox policy va telemetry ro rang truoc khi mo rong.
- [Evidence] `docs/SESSION-MANAGEMENT.md`, `docs/MUSTER-BRIDGE.md`, `docs/MCP-INJECTION.md`, `docs/DESIGN.md`, `docs/MVP-SCAFFOLD-PLAN.md` mo ta kien truc muc tieu: per-turn spawn, explicit session ID, MCP injection, AskBridge HTTP/fallback, va roadmap MVP.

## Hien trang Muster theo mien cai tien

### Kiem thu va hoi quy

- [Evidence] Repository co script compile va spike runner, nhung `package.json` chua co script `test` tong hop; CI hien chi compile.
- [Evidence] T01 cua M001 them `scripts/verify-muster-audit-report.test.mjs`, day la verifier cho artifact bao cao nay, khong phai test runtime cua extension.
- [Inferred] Thieu automated tests cho adapter parse stream-json, error event, cancellation, session store, webview message handling va MCP timeout lam rui ro regression cao khi bat dau hardening.
- [Research] Nen uu tien node:test unit/integration tests voi fixtures JSONL va fake child process truoc khi sua runtime, de moi thay doi co canh bao ngay trong CI.

### CI va chat luong build

- [Evidence] `.github/workflows/ci.yml` bi gioi han boi `workflow_dispatch`; push/PR khong tu dong chay.
- [Evidence] CI chi chay `npm ci` va `npm run compile`, chua chay verifier tai lieu, unit tests, packaging smoke hay artifact checks.
- [Inferred] Khi PR khong bat buoc chay compile/test, loi type hoặc contract co the vao main muon hon moi bi phat hien.
- [Research] Bat `push`/`pull_request`, them `npm test`, `npm run package:check` hoac `vsce package --no-dependencies` smoke neu duoc la buoc can thiet truoc release.

### Type safety va contract su kien

- [Evidence] `tsconfig.json` bat `strict: true`, day la nen tang tot.
- [Evidence] `src/extension.ts` su dung `any` o duong fallback `event as any` va catch `err: any`; session JSON trong extension va `src/session-store.ts` parse khong validate shape.
- [Inferred] Type strict hien chua du bao ve ranh gioi du lieu den tu webview, filesystem session store, JSONL stdout cua Claude, va MCP answer file.
- [Research] Nen them schema guards nho, discriminated helpers va fixtures de tranh silent failure khi CLI hoac webview payload doi shape.

### Kien truc, operability va runtime reliability

- [Evidence] `docs/DESIGN.md` chon kien truc per-turn spawn, khong giu process lau dai, normalized streaming events va explicit session IDs; day la nen tang operability/observability cua runner MVP.
- [Evidence] `src/backends/claude.ts` co cancellation bang AbortSignal -> `SIGTERM`, gom stderr, va yield `error` khi exit code khac 0.
- [Evidence] `src/extension.ts` post `done` sau ca success va catch error; no chua co gate mot turn dang chay, queue, hoac cancellation UI.
- [Inferred] Hai prompt dong thoi tren cung backend/workspace co the ghi de session store hoac tao lich su CLI khong mong muon, phu hop voi canh bao concurrency trong `docs/SESSION-MANAGEMENT.md`.
- [Unknown] Chua co bang chung runtime trong VS Code Extension Development Host ve scroll, cancellation, long stderr, malformed JSONL, hoac khi `claude` khong ton tai tren PATH.

### Session management va persistence

- [Evidence] `docs/SESSION-MANAGEMENT.md` yeu cau commit session ID sau terminal event thanh cong, khong commit khi error/cancel, va khuyen nghi atomic write.
- [Evidence] `src/session-store.ts` doc/ghi sync `.muster-sessions.json`, bo qua JSON parse loi bang cach tra `undefined` hoac data rong; `src/extension.ts` co logic tuong tu rieng.
- [Inferred] Viec duplicate logic lam tang nguy co lech hanh vi giua runner va extension; ghi file khong atomic co the hong file khi co nhieu cua so/turn.
- [Research] Nen tap trung hoa session store, them atomic write, validation, lock/queue mot in-flight turn moi backend/workspace, va test corrupted JSON.

### MCP bridge, bao mat va trust boundary

- [Evidence] `docs/MUSTER-BRIDGE.md` quyet dinh production bridge nen la HTTP MCP trong extension voi AskBridge Promise; file IPC chi la spike.
- [Evidence] `mcp/muster-ask-server.mjs` yeu cau `MUSTER_RUNTIME_DIR`, tao `pending`/`answers`, ghi pending JSON, poll answers JSON va tra `isError` khi timeout/loi parse.
- [Evidence] `scripts/test-agy-ask-mcp.mjs` sua config MCP cap user cua Antigravity va dung `--dangerously-skip-permissions`; neu bi ngat hoac restore loi co the de lai cau hinh nguoi dung sai trang thai.
- [Evidence] Cac subprocess CLI ke thua `process.env`; report khong nen coi smoke scripts la an toan neu chua co opt-in, masking/redaction, va huong dan permission policy.
- [Evidence] `docs/MCP-INJECTION.md` nhac security/trust note cho per-turn MCP config, context_engine va muster_bridge.
- [Inferred] File IPC spike can hardening neu con duoc dung: validate id, gioi han path traversal, cleanup pending/answers, quyen runtime dir, timeout config va answer schema.
- [Inferred] Webview message boundary can hardening bang schema validation cho `postMessage`, CSP/nonce cho HTML inline, va negative tests cho payload la/khong hop le.
- [Research] Truoc production nen dung extension-owned local server voi token, bind `127.0.0.1`, cap vong doi theo turn, Host/Origin validation, va khong mo rong bridge thanh file/shell proxy.

### Tai lieu, report alignment va developer experience

- [Evidence] README noi `MCP context engine injection` va `MCP ask_user` la planned; docs thiet ke chi tiet hon source code hien co.
- [Evidence] `docs/README.md` la index tai lieu; `docs/MVP-SCAFFOLD-PLAN.md` ghi cac phase va thanh cong cua console MVP/webview.
- [Inferred] Co khoang cach giua docs muc tieu va implementation hien tai; nguoi dong gop co the nham lan cai da ship voi cai moi la design.
- [Research] Nen duy tri ma tran "doc claim -> repo evidence -> status" va verifier cho tai lieu quan trong de tranh drift.

### Packaging va release readiness

- [Evidence] `package.json` co metadata publisher/license/repository, engine VS Code va dependency `@vscode/vsce`, nhung chua co script package/publish.
- [Evidence] Extension activation la `onStartupFinished`, webview view va commands da khai bao.
- [Inferred] Truoc release can smoke test `vsce package`, kiem tra bundled dist, activation footprint, `.vscodeignore`, icon, changelog va extension host test.
- [Unknown] Chua co bang chung package VSIX duoc tao/cai/chay trong Extension Development Host hoac VS Code that.

### Maintainability va mo rong multi-backend

- [Evidence] README va design nham toi nhieu CLI: Claude hien co, Grok/Codex/Antigravity planned.
- [Evidence] `src/types.ts` da co `Backend` interface va event union co du cho tool/usage/error.
- [Inferred] Neu them backend truoc khi adapter contract co tests, moi CLI se co cach parse/session/MCP rieng va lam no chi phi maintainability.
- [Research] Nen dong bang adapter contract, conformance fixtures va shared runner behavior truoc khi them backend thu hai/thu ba.

## Nguyen tac sap xep milestone tuong lai

1. Giam rui ro khong thay bang mat thuong truoc: tests va CI phai di truoc runtime refactor.
2. Tach bang chung repo khoi gia dinh runtime: moi claim can co file, command, hoac manual UAT ro rang.
3. Khong mo rong backend khi ranh gioi session/MCP/security chua on dinh.
4. Moi milestone phai co tieu chi chap nhan va ky vong xac minh de GSD hoac developer co the thi hanh sau nay.
5. Khong xem M001 la da sua runtime; M001 chi tao audit/report va verifier cau truc cho report.

## Milestone 1: Nen tang automated regression tests

**Muc dich**  
Khoa cac contract hien co truoc khi sua runtime: Claude stream-json adapter, normalized events, session store, runner delegation, MCP ask spike timeout, va verifier tai lieu.

**Phu thuoc / Dependency**  
Khong phu thuoc milestone tuong lai nao. Dung code hien co trong `src/*`, `mcp/*`, `scripts/*` va fixtures inline/git-tracked.

**Rui ro / Risk**  
Neu test fake qua muc, chung chi xac nhan mock thay vi contract thuc. Neu test can `claude` that, CI se mong manh. Can uu tien fixtures JSONL va fake child process co kiem soat.

**Tieu chi chap nhan / Acceptance criteria**

- Co `npm test` chay node:test cho adapter/session/MCP/report verifier.
- Test Claude adapter bao gom JSONL hop le, line malformed -> `raw`, stderr capture, non-zero exit -> `error`, cancellation -> cancellation event.
- Test session store bao gom missing file, corrupted JSON, save/load backend rieng.
- Test MCP ask spike bao gom missing env, timeout, malformed answer JSON, unknown tool.
- CI hoac local command co the chay compile + tests trong mot lenh tai lap.

**Ky vong xac minh / Verification expectations**

- `npm run compile`
- `npm test`
- `node --test scripts/verify-muster-audit-report.test.mjs`
- Fixture files nam trong repo, khong phu thuoc `.gsd/`, `.planning/`, hoac state local.

## Milestone 2: Claude, session va runtime hardening

**Muc dich**  
Lam duong chay Claude va session resume dang tin cay hon truoc khi them bridge production hoac backend khac.

**Phu thuoc / Dependency**  
Phu thuoc Milestone 1 de co regression net cho adapter, session store va error paths.

**Rui ro / Risk**  
Thay doi session timing co the lam mat kha nang resume hoac commit session sai khi turn loi. Thay doi spawn/cancel co the tao child process mo coi neu khong test ky.

**Tieu chi chap nhan / Acceptance criteria**

- `src/extension.ts` dung chung `src/session-store.ts` hoac service tuong duong thay vi duplicate logic.
- Session ID chi duoc commit sau terminal success theo `docs/SESSION-MANAGEMENT.md`; cancel/error khong ghi session moi.
- Co queue/reject mot in-flight turn moi backend/workspace, voi UI message ro rang.
- Claude backend co timeout/cancellation handling ro hon, error event giu du context an toan, va parser duoc test bang fixtures.
- Webview co trang thai running/done/error nhat quan; khong gui `done` gay hieu nham khi flow bi loi neu UX yeu cau phan biet.

**Ky vong xac minh / Verification expectations**

- `npm test`
- `npm run compile`
- Manual UAT trong VS Code Extension Development Host: prompt moi, continue last, new session, missing `claude` PATH, cancel/abort neu UI da co.
- Kiem tra `.muster-sessions.json` khong bi ghi khi turn loi/cancel va duoc ghi khi turn thanh cong.

## Milestone 3: MCP bridge va security hardening

**Muc dich**  
Bien thiet ke `muster_bridge.ask_user` thanh implementation an toan, mong, co timeout, va phu hop trust boundary extension-host/webview/CLI.

**Phu thuoc / Dependency**  
Phu thuoc Milestone 1 cho negative tests va Milestone 2 cho turn lifecycle on dinh. Co the song song mot phan voi Milestone 2 neu chi lam spike hardening, nhung production bridge nen doi runtime lifecycle ro.

**Rui ro / Risk**  
Bridge co the thanh be mat tan cong neu mo file/shell proxy, khong bind localhost/token, hoac chap nhan payload khong validate. Blocking ask_user co the treo CLI neu timeout/cancel khong duoc bubble dung.

**Tieu chi chap nhan / Acceptance criteria**

- Production path uu tien AskBridge trong extension va local MCP endpoint/callback theo `docs/MUSTER-BRIDGE.md`; file IPC spike duoc danh dau dev-only hoac thay the.
- MCP config injection tao per-turn config an toan, dung `--strict-mcp-config` voi Claude khi ho tro.
- `ask_user` validate input/output schema, timeout, cancel, duplicate id va malformed payload.
- File/spike path neu con ton tai phai validate `MUSTER_RUNTIME_DIR`, id/path traversal, pending/answers cleanup, answer size/schema va stale-file behavior.
- Agy/Grok config mutation neu con can dung phai opt-in, atomic backup/restore, khong hardcode bypass permissions, va ghi ro failure telemetry.
- Webview chi postMessage toi extension; extension host validate payload schema, CSP/nonce khong de inline trust boundary mo, va khong noi truc tiep MCP.
- Local MCP endpoint dung token, bind localhost, Host/Origin validation, cancellation lifecycle va khong expose file/shell proxy.
- Tai lieu security/trust note trong `docs/MCP-INJECTION.md` va `docs/MUSTER-BRIDGE.md` khop voi code.

**Ky vong xac minh / Verification expectations**

- `npm test` voi negative cases cho timeout, malformed answer, duplicate id, cancellation va unknown tool.
- `npm run compile`
- Manual UAT: agent goi `ask_user`, webview hien question card, submit answer tiep tuc cung turn, timeout/cancel tra error thay vi treo.
- Neu van giu file IPC spike, kiem tra path traversal/id validation va cleanup runtime dir.

## Milestone 4: CI, package va release readiness

**Muc dich**  
Bien MVP tu code co the compile thanh artifact co the kiem chung tren PR va dong goi VSIX mot cach lap lai.

**Phu thuoc / Dependency**  
Phu thuoc Milestone 1 de co `npm test`; nen sau Milestone 2/3 neu release muon gom runtime/bridge hardening dau tien.

**Rui ro / Risk**  
Bat CI day du co the lam lo cac loi ton dong ve test flake, dependency cache, dist/outDir hoac VS Code extension packaging. Neu packaging khong kiem tra runtime, VSIX co the tao duoc nhung extension khong chay.

**Tieu chi chap nhan / Acceptance criteria**

- CI chay tren `push` va `pull_request` cho main/default branch, khong chi `workflow_dispatch`.
- CI chay `npm ci`, `npm run compile`, `npm test`, verifier tai lieu va package smoke.
- `package.json` co script ro rang cho `test`, `package:check` va neu can `prepublish`/`vscode:prepublish`.
- Release checklist bao gom VS Code engine, bundled dist, `.vscodeignore`, CHANGELOG, license, icon/metadata va smoke install.
- CI output phan biet loi compile/test/package de developer sua nhanh.

**Ky vong xac minh / Verification expectations**

- Local: `npm ci` neu can tai moi dependency, `npm run compile`, `npm test`, `npm run package:check`.
- GitHub Actions: PR mau pass voi cung command.
- Manual smoke: cai VSIX vao Extension Development Host hoac VS Code profile sach va mo Muster view.

## Milestone 5: Tai lieu, report alignment va developer experience

**Muc dich**  
Giu README, design docs, scaffold plan, bridge/session docs va report audit khop voi implementation sau cac milestone hardening.

**Phu thuoc / Dependency**  
Phu thuoc Milestone 2/3/4 de tai lieu phan anh code moi. Co the cap nhat nho song song, nhung alignment day du nen chay sau khi runtime/CI on dinh.

**Rui ro / Risk**  
Tai lieu co the tiep tuc noi qua muc "planned" vs "implemented" neu khong co verifier. Qua nhieu tai lieu trung lap se tao drift.

**Tieu chi chap nhan / Acceptance criteria**

- README feature matrix tach ro implemented, partial, planned va experimental.
- `docs/SESSION-MANAGEMENT.md`, `docs/MUSTER-BRIDGE.md`, `docs/MCP-INJECTION.md`, `docs/DESIGN.md` co status khop code.
- `docs/README.md` index dung ten va pham vi tai lieu.
- Bao cao `docs/MUSTER-AUDIT-ROADMAP.vi.md` duoc cap nhat neu sequence thay doi, van giu confidence labels.
- Co verifier hoac checklist cho heading bat buoc, status labels va command verification.

**Ky vong xac minh / Verification expectations**

- `node --test scripts/verify-muster-audit-report.test.mjs`
- `npm test` neu verifier tai lieu nam trong suite chung.
- Review doc claim matrix: moi claim quan trong co citation den code/config/doc hoac duoc gan [Unknown].
- Manual doc walkthrough cho contributor moi: tu README -> development -> run extension -> test/package.

## Milestone 6: Multi-backend maintainability va adapter conformance

**Muc dich**  
Chuan hoa cach them Grok, Codex, Antigravity va cac backend sau nay ma khong nhan doi logic session/MCP/error parsing.

**Phu thuoc / Dependency**  
Phu thuoc Milestone 1 cho contract tests, Milestone 2 cho runner/session lifecycle, Milestone 3 cho MCP injection/bridge, va Milestone 5 cho docs alignment.

**Rui ro / Risk**  
Moi CLI co flags/session/streaming khac nhau; neu interface qua chung chung se che mat edge cases, neu qua rieng le se kho maintain. Antigravity streaming/session dang [Unknown] theo docs nen can spike co kiem chung.

**Tieu chi chap nhan / Acceptance criteria**

- Co adapter conformance suite dung chung cho backend: session start/resume, assistant deltas, tool events neu co, usage/error/raw, cancellation.
- Backend capability matrix duoc doc va test: reasoning, detailed tool events, MCP, session ownership, streaming format.
- Grok/Codex/Antigravity chi duoc bat UI neu dat smoke tests toi thieu va status docs khop.
- Shared helpers cho spawn, env, MCP config, stderr handling va cancellation giam duplicate code.
- Experimental backend co flag/status ro, khong lam suy yeu Claude path da on dinh.

**Ky vong xac minh / Verification expectations**

- `npm test` voi conformance fixtures cho tung backend duoc ho tro.
- `npm run compile`
- Manual smoke cho moi backend da bat: prompt moi, resume, MCP config injection neu backend ho tro, error khi CLI missing.
- Documentation matrix cap nhat truoc khi danh dau backend la implemented.

## Ma tran uu tien mien cai tien

| Mien | Muc uu tien | Ly do | Milestone chinh |
|---|---:|---|---|
| Kiem thu tu dong | Rat cao | La day an toan cho moi refactor runtime | Milestone 1 |
| Claude/session/runtime reliability | Rat cao | La user loop hien co cua MVP | Milestone 2 |
| Bao mat/MCP bridge | Cao | Tao trust boundary va human-in-the-loop production | Milestone 3 |
| CI/package readiness | Cao | Bien chat luong thanh bat buoc tren PR/release | Milestone 4 |
| Tai lieu/report alignment | Trung binh-cao | Giam drift giua design va code | Milestone 5 |
| Developer experience | Trung binh-cao | Giup contributor chay/test/package nhanh | Milestone 4-5 |
| Architecture maintainability | Trung binh | Can truoc khi them nhieu backend | Milestone 6 |
| Multi-backend expansion | Sau | Chi nen lam sau khi contract va security on dinh | Milestone 6 |

## Cac dieu chua ro can kiem chung bang UAT/runtime

- [Unknown] Claude CLI version thuc te co ho tro day du flags dang dung trong `src/backends/claude.ts` tren moi moi truong khong.
- [Unknown] Webview UX khi stream dai, error stderr lon, malformed event, hoac user bam lien tiep nhieu prompt.
- [Unknown] Session resume trong VS Code that co khop voi `docs/SESSION-MANAGEMENT.md` khi CLI tao/tra session ID khac ky vong.
- [Unknown] `muster_bridge` production nen dung HTTP MCP truc tiep hay fallback stdio callback cho tung CLI sau khi thu nghiem compatibility.
- [Unknown] Packaging VSIX hien tai co gom dung dist va chay duoc sau install hay chua.


## Failure Modes

- External dependency: repo source files and documentation inputs (`README.md`, `package.json`, `tsconfig.json`, `.github/workflows/ci.yml`, `src/*`, `mcp/*`, `docs/*`). Failure path: missing or stale file would weaken the report evidence. Handling: this task inspected the planned inputs before writing and labeled unverified runtime behavior as [Unknown] instead of claiming production facts.
- External dependency: filesystem write to `docs/MUSTER-AUDIT-ROADMAP.vi.md`. Failure path: missing parent directory or write failure would leave the artifact absent. Handling: final verification uses `test -s docs/MUSTER-AUDIT-ROADMAP.vi.md` and the node:test verifier reads the same path.
- External dependency: Node verifier `scripts/verify-muster-audit-report.test.mjs`. Failure path: missing headings, missing confidence labels, or incomplete milestone sections fail the structural test. Handling: the report includes the required legend, domains, future milestone sections, dependencies, risks, acceptance criteria, and verification expectations.

## Load Profile

- Bao cao nay khong chay load test; cac breakpoint duoc ghi nhan nhu rui ro can kiem chung sau: subprocess count khi nhieu prompt dong thoi, stderr buffering, polling file IPC 200 ms moi pending ask, va stale pending/answer files neu spike MCP chay lau.

## Negative Tests

- `scripts/verify-muster-audit-report.test.mjs` has a negative missing-report assertion: if `docs/MUSTER-AUDIT-ROADMAP.vi.md` is absent, the verifier fails with an explicit message.
- The same verifier fails when the report lacks a Vietnamese title/summary, lacks the confidence-label legend, omits any required improvement domain, or leaves future milestones without dependency, risk, acceptance, and verification language.
- The T02 red-test run (`node --test scripts/verify-muster-audit-report.test.mjs`) failed before the artifact existed, proving the missing-artifact negative path was active before implementation.

## Ket luan

Huong di an toan nhat cho Muster la khong them ngay nhieu backend hay UI lon, ma truoc het tao regression net va harden duong Claude/session dang co. Sau do bridge/security va CI/package readiness bien MVP thanh nen tang co the release. Tai lieu va multi-backend maintainability nen di sau cac bang chung runtime, de moi milestone tuong lai khong chi la y tuong ma co acceptance criteria va verification expectations ro rang.
