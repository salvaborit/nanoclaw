## Changes Implemented

Make the `dimitris` skill auto-sync into the **`dimitris-claw` group only** on every
container spawn (sourced from `~/prj/skills/dimitris`, so `git pull ~/prj/skills`
propagates it), while a per-group override overlay keeps the group's working
`crm-access.md` (the container HTTP-MCP doc) winning over the source skill's own
`crm-access.md` (the SSH recipe).

### Files Modified
- `src/container-runner.ts` — extracted the inline `container/skills/*` sync loop
  (was lines 171–185) into a new **exported** `syncSkills(...)` function; `buildVolumeMounts`
  now calls `syncSkills(skillsDst, group.folder)` at the same call site.

### Files Added (tracked under `container/**`)
- `container/group-skill-overrides/dimitris-claw/dimitris/crm-access.md` — the rescued
  per-group override (13,209 B, contains `DimitrisClaw container`; `cmp`-clean copy of the
  only prior instance under gitignored `data/sessions/…`). `git add`ed.
- `container/group-skills/dimitris-claw/dimitris` — **symlink** →
  `/home/sborit/prj/skills/dimitris`, stored by git as a symlink object (mode `120000`,
  verified via `git ls-files -s`), matching the existing `container/skills/*` symlink pattern.
- `src/sync-skills.test.ts` — vitest coverage for `syncSkills` (see Deviations for why this
  file, not `container-runner.test.ts`).

### `syncSkills` design
```
export function syncSkills(
  skillsDst: string,
  groupFolder: string,
  roots: { globalSkills?: string; groupSkills?: string; groupOverrides?: string } = {},
): void
```
Three ordered phases, each guarded by `existsSync` (no-op when the dir is absent, so every
other group is unaffected):
1. **Global** — `container/skills/*` → `skillsDst` (unchanged legacy behavior/semantics:
   `statSync` follows symlinks, `fs.cpSync(src, dst, {recursive, dereference})`).
2. **Per-group skills** — `container/group-skills/{groupFolder}/*` → `skillsDst` (same
   copy semantics; brings in `dimitris` for `dimitris-claw`).
3. **Per-group override overlay** — `container/group-skill-overrides/{groupFolder}/` copied
   LAST with `{recursive, dereference, force}` so colliding files (`dimitris/crm-access.md`)
   overwrite the synced source version while non-overridden files stay intact.

The overlay is generic (`{groupFolder}/**`, any group/skill/file), not dimitris-specific.
`roots` is injectable purely so the unit test can point phases at temp fixtures without a
container spawn; production callers omit it (defaults resolve under `process.cwd()`).

### Models/Schemas Affected
- None.

### Endpoints Affected
- None (long-running service, no HTTP surface).

### Deviations from Plan
- **Step 5 — test file location.** The plan named `src/container-runner.test.ts`, but that
  file already exists and mocks `fs` globally (`vi.mock('fs', …)` returning
  `existsSync: () => false`, `readdirSync: () => []`, etc.), which makes real-filesystem
  `syncSkills` tests impossible there without per-test un-mocking hacks. Put the coverage in a
  dedicated **`src/sync-skills.test.ts`** instead — it mocks only the heavy import-time deps
  (config/logger/OneCLI/mount-security) and leaves `fs` real, exercising `syncSkills` against
  `mkdtempSync` temp fixtures. Same verification intent, cleaner isolation (vitest isolates
  module registries per file, so the two files' mocks don't collide). Covers: global-copy,
  source-flows-through, override-wins (fails if phases are reordered), scoping (a group with
  no per-group roots gets no `dimitris/`), idempotency (two runs, no `ERR_FS_CP_EINVAL`), and
  all-roots-absent no-op.
- **Cleanup pass (`/simplify`):** single-pass inline review (Agent fan-out unavailable);
  reviewed reuse/simplification/efficiency/altitude — diff already clean, **no changes
  adopted**. Considered collapsing phases 1+2 into a loop but skipped: the SPEC wants explicit,
  individually-commented ordered phases; collapsing would trade documented intent for two lines.

### Verification Results
- `npm run build` (tsc): **pass**, no errors.
- `npm run lint`: changed files (`container-runner.ts`, `sync-skills.test.ts`) have **0 errors**
  (3 pre-existing catch-all warnings in `container-runner.ts`, unrelated to this diff). The 4
  repo-wide lint errors are all pre-existing in `src/whatsapp-auth.ts` (`no-empty`), untouched.
- `npm test` (vitest): **273 passed / 273**, including the 6 new `sync-skills` tests and the 3
  pre-existing `container-runner` timeout tests.
- **Integration smoke** (real roots, `dist/`): `syncSkills(dst,'dimitris-claw')` →
  `dimitris/crm-access.md` is the 13,209 B override containing `DimitrisClaw container`;
  `SKILL.md`/`business.md`/`schema.md`/`funnel.md` byte-match `~/prj/skills/dimitris/*`; global
  skills present. `syncSkills(dst,'main')` → **no** `dimitris/` dir created, global skills still
  land (scoping + no regression).
- `git check-ignore` on both new tracked paths returns nothing (not ignored).
