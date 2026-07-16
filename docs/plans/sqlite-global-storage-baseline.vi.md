# Phase 0 baseline — JSON TaskStore (before SQLite refactor)

Tham chiếu "before" cho refactor SQLite (xem `sqlite-global-storage-refactor.vi.md`).
Đo bằng harness tái lập `scripts/bench-store-baseline.ts`. Số phụ thuộc máy — chạy lại
trên máy khác sẽ khác; luôn so trên cùng máy/mode.

## Cách chạy lại

```bash
npx tsx scripts/bench-store-baseline.ts --sizes 10,100,1000 --iterations 40
```

## Kết quả baseline

- **machine:** darwin arm64 Apple M4
- **node:** v26.0.0
- **mode:** tsx (dev, KHÔNG phải release build)
- **iterations:** 40 commits/size
- **ngày đo:** 2026-07-16

| tasks | store (KiB) | commit p50 | commit p95 | snapshot (KiB) | cold load | cold snapshot |
|------:|------------:|-----------:|-----------:|---------------:|----------:|--------------:|
| 10    |     1.113,4 |   13,99 ms |   16,99 ms |           94,7 |   3,32 ms |       7,30 ms |
| 100   |    11.173,4 |   76,27 ms |   81,73 ms |          116,8 |  39,73 ms |     105,35 ms |
| 1.000 |   112.189,6 | 1.842,80ms | 1.906,92ms |          339,1 |1.447,65ms |  15.994,49ms  |

## Bottleneck xác nhận

Commit cost scale **tuyến tính theo tổng store size** (full read + clone + stringify mỗi
commit). Ở 1.000 tasks (~112 MB store): commit p95 ≈ 1,9 giây; cold snapshot ≈ 16 giây.
Đây chính là bottleneck plan §2/§9 nhắm loại bỏ.

## Performance budget mục tiêu (plan §9) để so sau Phase 3/4

- Commit một streaming batch: p95 < 20 ms, không phụ thuộc tuyến tính tổng DB size.
- Focus task + load 100 items gần nhất: p95 < 100 ms.
- Bootstrap task snapshot: < 500 KiB thông thường.
- Activation với 100k messages toàn DB: p95 < 300 ms trước backend discovery.
