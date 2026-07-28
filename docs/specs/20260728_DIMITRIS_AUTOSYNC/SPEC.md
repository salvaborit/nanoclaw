# Implementation Plan: Dimitris skill auto-sync into `dimitris-claw` only

Scope: standard

> Modifies the core container-spawn path (`buildVolumeMounts`, runs on every spawn for every
> group) with a correctness-critical override-ordering guarantee and a data-isolation-sensitive
> per-group gate. Blast radius is one function plus new tracked config dirs — not architectural,
> but not a one-liner. Hence **standard**, and the quality/verification gate applies.

---

## Goal

`git pull` in `~/prj/skills` propagates the `dimitris` skill into the **`dimitris-claw` group
only** on the next container spawn, while the per-group `crm-access.md` container override
(MCP-tools doc) always wins over the source skill's own `crm-access.md` (SSH recipe). No manual
copying; no leakage of the dimitris skill to the other ~12 groups.

## Design decision (differs from the sketch — see Assumptions)

Per-group skill sources and overrides live under **`container/`** (already git-tracked, never
mounted into the agent workspace), NOT under `groups/{group}/`:

| Purpose | Path | Type |
|---|---|---|
| Per-group skill sources | `container/group-skills/{folder}/{skill}` | symlink → `~/prj/skills/{skill}` |
| Per-group override overlay | `container/group-skill-overrides/{folder}/{skill}/{file}` | tracked real file |

For this feature, `{folder}` = `dimitris-claw`, `{skill}` = `dimitris`.

**Why not `groups/dimitris-claw/skills/…` as sketched:** verified `groups/*` is gitignored
(`.gitignore:13-19`, only `groups/main/CLAUDE.md` + `groups/global/CLAUDE.md` tracked) → that
location is NOT git-tracked, violating the "tracked, spawn-stable" requirement. Also
`resolveGroupFolderPath('dimitris-claw')` → `groups/dimitris-claw`, which is bind-mounted writable
into the container as `/workspace/group` (`container-runner.ts:79,105-116`) — so skill symlinks
placed there would pollute the agent's working dir and appear as broken host-path symlinks inside
the container. `container/` avoids both problems and mirrors the existing tracked-symlink pattern
(`container/skills/obsidian-vault-ops` → `~/prj/skills/obsidian-vault-ops`, tracked as a git
symlink object, confirmed `git ls-files -s`).

## Mechanism: one added block, three ordered phases

Steps 2 and 3 collapse into **one mechanism** — a single skills-sync helper that copies in a fixed
order so the last write wins:

1. **Global skills** — `container/skills/*` → `skillsDst` (existing loop, unchanged).
2. **Per-group skills** — `container/group-skills/{folder}/*` → `skillsDst` (new, same cpSync
   semantics; brings in `dimitris`).
3. **Per-group override overlay** — `container/group-skill-overrides/{folder}/` merged onto
   `skillsDst` (new, copied LAST → `crm-access.md` override overwrites the source's version).

The overlay is **generic** (`container/group-skill-overrides/{folder}/**`, any group, any skill,
any file), not dimitris-specific — smallest generic mechanism that satisfies the constraint. For
groups without these dirs, `fs.existsSync` guards make phases 2–3 a no-op, so the sync stays
global-skill-agnostic and scoped.

`skillsDst` = `data/sessions/{folder}/.claude/skills` (unchanged, `container-runner.ts:172-173`).

---

## Steps

1. **Relocate the override to its canonical tracked home (do FIRST — it's the only copy).**
   Copy `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` (13,209 B,
   gitignored, title `# CRM access recipes — DimitrisClaw container`) to
   `container/group-skill-overrides/dimitris-claw/dimitris/crm-access.md`. `git add` it (under
   `container/`, tracked — no `.gitignore` change needed).
   - Acceptance: `git ls-files` lists `container/group-skill-overrides/dimitris-claw/dimitris/crm-access.md`;
     its bytes equal the current `data/sessions/...` override (`cmp` clean, 13,209 B); it contains
     the string `DimitrisClaw container`.

2. **Create the per-group skill source symlink.**
   `container/group-skills/dimitris-claw/dimitris` → `/home/sborit/prj/skills/dimitris` (matches the
   `container/skills/*` symlink convention; `git pull ~/prj/skills` then propagates automatically).
   `git add` it (stored as a git symlink object, mode 120000, like the existing ones).
   - Acceptance: `readlink container/group-skills/dimitris-claw/dimitris` == `/home/sborit/prj/skills/dimitris`;
     `git ls-files -s container/group-skills/dimitris-claw/dimitris` shows mode `120000`;
     `stat -L` on it resolves to the real source dir (contains `SKILL.md`, `crm-access.md`).

3. **Extract the skills sync into an exported, testable helper in `container-runner.ts`.**
   Replace the inline loop at `container-runner.ts:171-185` with a call to a new exported function,
   e.g.:
   ```
   export function syncSkills(
     skillsDst: string,
     groupFolder: string,
     roots: { globalSkills?: string; groupSkills?: string; groupOverrides?: string } = {},
   ): void
   ```
   Defaults (when `roots` omitted): `globalSkills = container/skills`,
   `groupSkills = container/group-skills/{groupFolder}`,
   `groupOverrides = container/group-skill-overrides/{groupFolder}` (all under `process.cwd()`).
   Injectable `roots` exist solely so the vitest test can point at fixtures + a temp dst without a
   container spawn. `buildVolumeMounts` calls `syncSkills(skillsDst, group.folder)` where the old
   loop was (~line 171), before pushing the `/home/node/.claude` mount (`:186-190`).
   - Acceptance: `syncSkills` is exported; `buildVolumeMounts` no longer contains an inline
     `readdirSync(container/skills)` loop; `npm run build` and `npm run lint` pass.

4. **Implement the three phases inside `syncSkills`.**
   - Phase 1 (global): iterate `globalSkills` dir; for each entry, `statSync` (follow symlinks,
     skip non-dirs) then `fs.cpSync(src, path.join(skillsDst, name), {recursive:true, dereference:true})`
     — identical semantics to today's loop.
   - Phase 2 (per-group skills): if `existsSync(groupSkills)`, same loop over `groupSkills`.
   - Phase 3 (override overlay): if `existsSync(groupOverrides)`,
     `fs.cpSync(groupOverrides, skillsDst, {recursive:true, dereference:true, force:true})` — merges
     the override tree onto the freshly synced skills; `force:true` (cpSync default) overwrites
     colliding files (i.e. `dimitris/crm-access.md`) while leaving every non-overridden file intact.
   - Each phase guarded by `existsSync`; missing dirs → no-op. Keep code style consistent with the
     existing block (same comment density, `dereference:true` rationale comment retained).
   - Acceptance: for `groupFolder='dimitris-claw'`, after `syncSkills`, `skillsDst/dimitris/` exists,
     `skillsDst/dimitris/crm-access.md` == the override (13,209 B, contains `DimitrisClaw container`),
     and `skillsDst/dimitris/SKILL.md`/`business.md`/`schema.md`/`funnel.md` byte-match
     `~/prj/skills/dimitris/*`. For a group without per-group dirs (e.g. `'main'`), no `dimitris/`
     dir is created.
   - Depends on: Step 3.

5. **Add the regression test `src/container-runner.test.ts` (vitest).**
   Build a temp fixture: a fake `globalSkills` dir (one trivial skill), a fake `groupSkills` dir
   containing a `dimitris/` with a source-style `crm-access.md` + a couple other files, and a fake
   `groupOverrides` dir containing `dimitris/crm-access.md` with distinct override content. Call
   `syncSkills(tmpDst, 'dimitris-claw', {globalSkills, groupSkills, groupOverrides})` and assert:
   (a) global skill copied; (b) dimitris source files copied verbatim; (c)
   `tmpDst/dimitris/crm-access.md` == the OVERRIDE content, not the source; (d) a second call with
   `groupFolder='other'` and no per-group roots produces no `dimitris/` dir (scoping); (e) calling
   `syncSkills` twice is idempotent (no throw, same result — guards against the historical
   `ERR_FS_CP_EINVAL` on repeat symlink copies).
   - Acceptance: `npm test` passes with the new test; the crm-access assertion fails if phases are
     reordered (proves override-last ordering is load-bearing).
   - Depends on: Step 4.

6. **Clean-refresh the live destination (optional, for immediate effect).**
   The next real `dimitris-claw` spawn will refresh `data/sessions/dimitris-claw/.claude/skills/dimitris/`
   from source + overlay automatically. No manual copy needed. (The pre-existing stale manual copy
   there is harmless; it gets overwritten on next spawn.)
   - Acceptance: after one `dimitris-claw` container spawn (or running the sync against the real
     dst), `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` is still the 13,209 B
     override, and the other files match current `~/prj/skills/dimitris`.

---

## Test Criteria

- [ ] `npm run build` (tsc) passes; `npm run lint` clean.
- [ ] `npm test` green, including new `src/container-runner.test.ts`.
- [ ] `syncSkills(dst,'dimitris-claw')` against real roots → `dst/dimitris/crm-access.md` is the
      13,209 B override (contains `DimitrisClaw container`), NOT the 12,902 B SSH source.
- [ ] Same run → `dst/dimitris/SKILL.md`, `business.md`, `schema.md`, `funnel.md`, `brand/**`,
      `playbooks/**` byte-match `~/prj/skills/dimitris/*` (source content flows through).
- [ ] `syncSkills(dst,'main')` (no per-group dirs) → no `dimitris/` directory created (scoping /
      no leakage to other groups).
- [ ] Idempotency: two consecutive `syncSkills` calls succeed, no `ERR_FS_CP_EINVAL`, identical dst.
- [ ] Regression: existing global-skills behavior unchanged (an existing skill, e.g. `capabilities`,
      still lands in `dst` for any group).
- [ ] `git ls-files` shows both new tracked paths (override file + symlink); `git check-ignore`
      returns nothing for them.

## Verification Plan (no DEPLOY.md — long-running service, not a request/response app)

No API surface, so no endpoint tiers. Verification is a build + a direct exercise of the sync
function — **no actual container spawn required** (the sync is pure filesystem work; `syncSkills` is
callable in isolation with injected roots):

- **Build gate:** `npm run build`, `npm run lint`.
- **Unit/behavior gate:** `npm test` (the new vitest file drives phases 1–3 against fixtures and
  asserts override-wins, source-flows-through, scoping, idempotency).
- **Integration smoke (manual, optional):** run `syncSkills` once against the real
  `data/sessions/dimitris-claw/.claude/skills` dst with default roots and confirm the four
  assertions in Step 6; then confirm a non-dimitris group's dst has no `dimitris/`.
- A full container spawn is NOT needed to prove correctness; it only confirms the agent reads the
  files, which is unchanged behavior.

## Risks

- **cpSync symlink dereference:** `dereference:true` is retained on all phases — required so the
  `container/group-skills/dimitris-claw/dimitris` symlink and any symlinked source subdirs copy real
  files (and to avoid the historical `ERR_FS_CP_EINVAL` on repeat runs, per the existing comment at
  `:180-182`). Test (e) exercises the repeat-run path.
- **Override is the only copy:** Step 1 (relocate + `git add`) runs FIRST and is verified by `cmp`
  before any code lands, so the 13,209 B override cannot be lost. Do not delete the `data/sessions`
  copy until the tracked copy is confirmed committed.
- **gitignore interactions:** `groups/*` is gitignored (only main/global CLAUDE.md tracked) →
  reason we place config under `container/` (tracked, no `.gitignore` edits). `data/sessions/**` is
  fully ignored → the live dst is derived state, never the source of truth. Verify with
  `git check-ignore` on the two new paths (must return empty).
- **Idempotency across spawns:** `buildVolumeMounts` runs every spawn; `syncSkills` must be safe to
  re-run. Guaranteed by cpSync `force`+`dereference` and `existsSync` guards; covered by test (e).
- **Absolute symlink target:** `container/group-skills/dimitris-claw/dimitris` →
  `/home/sborit/prj/skills/dimitris` is host-absolute and would dangle on another machine — but this
  exactly matches the existing `container/skills/*` symlinks and this is a single personal install.
  Accepted, not mitigated.
- **SKILL.md self-description drift (minor, out of scope):** the source `SKILL.md` still describes
  `crm-access.md` as "SSH recipe" (`SKILL.md:87`) while the container gets the MCP override. The
  override file's own header explains it replaces upstream, so the agent is not misled. Reconciling
  the source SKILL.md text is a separate content decision, deliberately not included here (no
  unsolicited scope creep).

---

## Assumptions made (reversible — recorded, flag for a nod)

1. **Location moved from the sketched `groups/dimitris-claw/skills/…` to `container/group-skills/…`
   and `container/group-skill-overrides/…`.** Forced by two verified facts: `groups/*` is gitignored
   (sketch location wouldn't be tracked) and `groups/dimitris-claw` is the agent's writable workspace
   mount (sketch location would pollute the workspace with dangling host-path symlinks). This is a
   reversible naming/placement choice; if the owner prefers the `groups/` mental model, the
   alternative is adding `.gitignore` exceptions (`!groups/*/skills/`, `!groups/*/skill-overrides/`)
   and accepting workspace-visible symlinks — more moving parts for the same result. Recommend the
   `container/` placement.
2. **Steps 2 (per-group skills) and 3 (override overlay) implemented as one helper, two phases**,
   with the overlay kept **generic** (`container/group-skill-overrides/{folder}/**`), not
   dimitris-specific — smallest generic mechanism satisfying the constraint.
3. **A small, tightly-scoped extraction** of the existing inline sync into an exported `syncSkills`
   is included purely to make the behavior directly testable (endorsed by the task's "exercise the
   sync function directly" note). Not a broader refactor.
