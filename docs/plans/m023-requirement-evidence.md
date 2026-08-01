# M023 requirement evidence

This map synchronizes the M023 storage requirements to the two tracked packaged Extension Host evidence artifacts. Both artifacts are numeric/enum-only and have independent schema verifiers; paths below are repository-relative artifact references, not runtime storage locations.

## R040

- Evidence: `docs/plans/m023-s05-storage-lifecycle-evidence.json`
- Verification: `npm run test:m023-s05-storage-evidence`
- The live two-host lifecycle report records database, WAL, and SHM bytes; page and freelist counts; page size; `autoVacuum`; and `dbstat` per-table byte totals before growth, after seed, and after retention.

## R041

- Evidence: `docs/plans/m023-s05-storage-lifecycle-evidence.json`
- Verification: `npm run test:m023-s05-storage-evidence`
- The seeded `tool_calls` table grows to 6,127,616 bytes and is 819,200 bytes after retention; the evidence records four retention truncations while the run retains its durable row counts.

## R042

- Evidence: `docs/plans/m023-s05-storage-lifecycle-evidence.json`
- Verification: `npm run test:m023-s05-storage-evidence`
- Within one continuous host session and without a restart, `retention.completedPasses` advances from 18 before seeding to 20 after retention, with `failedPasses` staying 0 and `latestPassOrdinal` tracking `completedPasses`; the peer host remains attached and observes the post-retention state.

## R043

- Evidence: `docs/plans/m023-s05-storage-lifecycle-evidence.json`
- Verification: `npm run test:m023-s05-storage-evidence`
- The live store reports incremental auto-vacuum (`autoVacuum: 2`) and shrinks from 6,811,648 to 1,507,328 database bytes after retention, with no full-VACUUM temporary-copy claim.

## R044

- Evidence: `docs/plans/m023-s05-storage-lifecycle-evidence.json`
- Verification: `npm run test:m023-s05-storage-evidence`
- After retention, the seeded task, turn, and message counts remain 8, 12, and 14 respectively while four heavy entries are truncated, proving retention does not delete durable history rows.

## R045

- Evidence: `docs/plans/m023-s08-orphan-lifecycle-evidence.json`
- Verification: `npm run test:m023-s08-orphan-evidence`
- The classified explicit cleanup removes exactly two orphan files and seven bytes with zero failures. The subsequent classification is empty, while the SQLite trio and one active lease remain present; database-byte reclamation remains separately reported in the same continuous two-host lifecycle run.
