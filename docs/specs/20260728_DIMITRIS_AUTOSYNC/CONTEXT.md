# CONTEXT — Dimitris skill auto-sync into `dimitris-claw`

Research phase. Goal: `git pull` the skills dir and have the `dimitris` skill auto-sync into the
`dimitris-claw` group, **without clobbering** the per-group `crm-access.md` container override.

> **HEADLINE / PREMISE CHANGE — read first.** The prior cycle's hard constraint said
> `crm-access.md` "does NOT exist in the source skill `~/prj/skills/dimitris`." **That is no longer
> true.** The source skill now contains its own committed `crm-access.md` (12,902 bytes, an
> SSH-based recipe) that **differs** from the container override (13,209 bytes, an MCP-tools doc).
> Because the sync uses `fs.cpSync` (overwrites files present in *both* src and dst), a naive
> symlink/copy of the source skill **WILL overwrite and destroy the override.** The "extra file
> survives" assumption the prior cycle relied on only holds for filenames that are *absent* from
> source — and `crm-access.md` is no longer absent. This reshapes every recommendation below.

---

## 1. The existing spawn-sync mechanism

**Location:** `src/container-runner.ts:171-190`, inside `buildVolumeMounts()`.

```
171  // Sync skills from container/skills/ into each group's .claude/skills/
172  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
173  const skillsDst = path.join(groupSessionsDir, 'skills');   // data/sessions/{group}/.claude/skills
174  if (fs.existsSync(skillsSrc)) {
175    for (const skillDir of fs.readdirSync(skillsSrc)) {
176      const srcDir = path.join(skillsSrc, skillDir);
178      if (!fs.statSync(srcDir).isDirectory()) continue;      // stat, not lstat -> follows symlinks
179      const dstDir = path.join(skillsDst, skillDir);
183      fs.cpSync(srcDir, dstDir, { recursive: true, dereference: true });
184    }
185  }
```

- **FROM:** `container/skills/` (project root). **TO:** `data/sessions/{group.folder}/.claude/skills/`
  (`groupSessionsDir` is built at `container-runner.ts:132-137` as `DATA_DIR/sessions/{folder}/.claude`).
  This dir is then bind-mounted into the container at `/home/node/.claude` (`:186-190`).
- **Copy semantics — copy, not symlink/overlay.** `fs.cpSync(..., {recursive, dereference})`.
  `dereference: true` resolves symlinked source skills and copies their **real files** (comment at
  `:180-182` explains this avoids `ERR_FS_CP_EINVAL` on repeat runs).
- **Delete-or-not — DOES NOT DELETE; overwrites shared files; keeps dst-only extras.**
  Verified empirically on this box (Node v22.20.0):
  - file in **both** src & dst → **dst overwritten** by src (cpSync default `force: true`).
  - file **only in dst** (e.g. today's `crm-access.md` override) → **left untouched / survives.**
  - No `--delete`-style pruning. Confidence: **certain** (ran the actual `cpSync` call).
  → **Implication:** the override survives *only while its filename is absent from the source dir.*
  Since source now has `crm-access.md`, the override would be overwritten. See §5.
- **Scope — EVERY skill dir → EVERY group, unconditionally.** The loop iterates every entry in
  `container/skills/`; `buildVolumeMounts()` runs on **every container spawn** (called from
  `runContainerAgent` at `container-runner.ts:319`). There is **no per-group filtering** of skills.
  Both `isMain` and non-main paths reach this block (the `if/else` at `:81-128` only affects
  workspace mounts; the skills sync at `:171` is common to both).
- **When — every container spawn** (not startup-only). Confidence: **certain**.

## 2. `container/skills/` inventory (the pattern to follow)

| Entry | Type | Target |
|---|---|---|
| `agent-browser` | real dir | — |
| `asdlc` | real dir | — |
| `capabilities` | real dir | — |
| `locksmith-ledger` | real dir | — |
| `obsidian-vault-ops` | **symlink** | `/home/sborit/prj/skills/obsidian-vault-ops/` |
| `project-status` | **symlink** | `/home/sborit/prj/skills/project-status/` |
| `sales` | real dir | — |
| `slack-formatting` | real dir | — |
| `status` | real dir | — |

- **There is NO `dimitris` entry today** → nothing syncs it → the copy in
  `data/sessions/dimitris-claw/.claude/skills/dimitris/` is a stale manual copy that drifts. Confirmed.
- **Established symlink pattern:** `container/skills/<name>` → `/home/sborit/prj/skills/<name>`.
  The sync loop dereferences these, so a `git pull` in `~/prj/skills` propagates on the next spawn.

## 3. Group scoping

- **No per-group skill mechanism exists.** `RegisteredGroup.containerConfig` (`src/types.ts:30-40`)
  supports only `additionalMounts` (+ `model`). Persisted as `container_config` JSON in
  `store/messages.db` (`src/db.ts:76-82,623-645`). There is **no skills allowlist / per-group skill
  selection** anywhere.
- **Adding `container/skills/dimitris` pushes it to ALL ~13 registered groups** (main, jarvis-agenda,
  dmitris-2, ventas-dimitris, dimitris-claw, vice-city-2, purpl-bot, yonita-trolls, zellyt-bot,
  prueba-tech-acc, cencoclaw, zog). Each group's container would then be able to read the dimitris
  business docs + CRM recipes. This is a **data-isolation concern** the plan must address (the skill
  only *activates* on its trigger, but the files are *readable* by every group's agent).
- **`additionalMounts` cannot be repurposed as a skill overlay.** `mount-security.ts` forces every
  additional mount under `/workspace/extra/<name>` (`:357`) and **rejects absolute container paths**
  (`isValidContainerPath`, `:202-214`). So you cannot bind-mount a skill onto
  `/home/node/.claude/skills/dimitris`. Rules out the "just mount the source skill in" idea.
- **`dimitris-claw`'s existing `additionalMount`** is unrelated to skills: it mounts
  `/home/sborit/dimitris-claw-config` (SSH `id_key`, `known_hosts`, `ssh_config`, README) →
  `/workspace/extra/dimitris`, read-only. Not a skill surface.

## 4. Source of truth for "pull the skills dir"

- **Two clones of `git@github.com:salvaborit/skills.git`, both at `bdc5753`:**
  - `~/prj/skills` — **this is what `container/skills/` symlinks point at.** A `git pull` here
    propagates to containers. **This is the "skills dir" to pull.**
  - `~/.claude/skills` — a **separate** clone used by the **host** Claude Code (this session).
    Containers do **not** read it. A pull here does NOT reach containers.
- `~/prj/skills/dimitris` is the skill. Git-tracked files include `SKILL.md`, `business.md`,
  `crm-access.md`, `funnel.md`, `schema.md`, `brand/…`, `playbooks/…`. Confidence: **certain**.
- → Any new symlink for auto-sync must point at **`/home/sborit/prj/skills/dimitris`** to match the
  established pattern and make `git pull ~/prj/skills` the propagation trigger.

## 5. `crm-access.md` preservation — the crux

**Current reality (drift since last cycle):**
- `~/prj/skills/dimitris/crm-access.md` — **12,902 bytes, git-committed** (`git log`: commit
  `4b9d06e` "add KpiGoals table"). Title: `# CRM access recipes`. Documents the **SSH/psql** path
  (`ssh h-dmi-a … docker compose exec … psql`) — correct for the user's dev box, **wrong inside the
  container**.
- `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` — **13,209 bytes**, the
  override. Title: `# CRM access recipes — DimitrisClaw container`. Explicitly says *"This file
  replaces the upstream dimitris skill's crm-access.md"* and documents the **CRM HTTP-MCP surface**
  (`crm.*` tools, `DIMITRIS_CRM_MCP_URL`) that only exists in the container.

Because both files share the name `crm-access.md`, `cpSync` overwrites the override with the source
version → **the container would silently switch to the wrong (SSH) instructions.**

### Would adding `container/skills/dimitris` today…
- **(a) auto-sync on pull?** ✅ **YES.** Symlink → `~/prj/skills/dimitris`; the sync loop
  dereferences + re-copies every spawn, so `git pull ~/prj/skills` shows up on the next container run.
- **(b) preserve `crm-access.md`?** ❌ **NO — the override would be destroyed**, because source now
  contains a colliding `crm-access.md`. (It *would* have survived if the source file were still
  absent, per the keep-dst-only behavior in §1.)

### Viable preservation strategies
- ✅ **Rename the override to a non-colliding filename** (e.g. `crm-access.container.md`) so it lands
  in the keep-dst-only bucket. BUT: source's own `crm-access.md` still syncs in, so the container
  ends up with **both** files (correct MCP doc + wrong SSH doc) → confusing/harmful unless
  `SKILL.md` is edited to point only at the container file and the source file is removed/neutralized.
  Fragile: any future source file whose name matches a future override re-triggers the clobber.
- ✅ **Add a sync-exclude / preserve rule to the loop** (`container-runner.ts:171-185`) — e.g. skip
  paths listed in a `.syncignore` inside the dst skill dir, or never overwrite files matching a
  per-group override manifest. Clean; syncs everything else; keeps override in place. Needs code.
- ✅ **Post-sync overlay** — after `cpSync`, copy per-group override files from a stable, git-trackable
  location (e.g. `groups/{group}/skill-overrides/dimitris/crm-access.md`) over the freshly synced
  skill. Override lives in one canonical place, survives every sync, and is scoped per group. Needs code.
- ✅ **Reconcile upstream** — fold the MCP recipe into the source `crm-access.md` (document both SSH +
  MCP paths, as the override already partly does) so no override is needed and a plain symlink
  auto-syncs cleanly. Design decision; changes host-side skill too.
- ❌ **Naive symlink `container/skills/dimitris` → source, no other change** — BREAKS the override
  (see (b)) *and* pushes dimitris to all groups.
- ❌ **`additionalMounts` overlay** — impossible (§3; lands under `/workspace/extra`, no absolute path).

## Shortlist for the planner (rated)

| # | Approach | Auto-sync on pull | Preserves override | Scoped to dimitris-claw only | Complexity |
|---|---|---|---|---|---|
| A | Symlink `container/skills/dimitris` → source; rename override to non-colliding name; edit SKILL.md; remove/neutralize source `crm-access.md` | ✅ | ⚠️ only after rename+source cleanup; fragile to future name collisions | ❌ (all groups) | Low (no code) |
| B | Add sync-exclude/preserve rule to the loop (`.syncignore` or override manifest) + symlink source | ✅ | ✅ | ❌ unless combined with gating | Medium (code) |
| C | Post-sync overlay: symlink source + copy `groups/{group}/skill-overrides/**` over synced skills | ✅ | ✅ | ⚠️ override is per-group, but skill files still land in all groups | Medium (code) |
| D | Add per-group `skills` allowlist to `containerConfig`; gate the sync loop by group; combine with B or C for the override | ✅ | ✅ (via B/C) | ✅ | High (code + schema + register script) |
| E | Reconcile: make source `crm-access.md` container-correct; plain symlink, no override | ✅ | ✅ (no override needed) | ❌ (all groups) | Low-Med (content merge, affects host skill) |

**Recommended combo:** **D + C** (per-group gating so only `dimitris-claw` gets the skill, plus a
post-sync overlay so the CRM override is preserved). If a low-effort stopgap is acceptable and pushing
dimitris to every group is tolerated for now, **B** (or **A** with the source-cleanup caveats) is the
minimal path — but note the all-groups data-exposure and, for A, the fragility.

## Sources
- `src/container-runner.ts:132-190` (sync loop, dst path, cpSync), `:319` (per-spawn call).
- `src/mount-security.ts:202-214,357` (container path rules), `~/.config/nanoclaw/mount-allowlist.json`.
- `src/types.ts:30-40`, `src/db.ts:76-82,623-645`, `store/messages.db` (group configs).
- Filesystem: `container/skills/` inventory + symlink targets; `~/prj/skills` & `~/.claude/skills`
  remotes/HEAD; `diff` of the two `crm-access.md`; `git log -- dimitris/crm-access.md`.
- Empirical `fs.cpSync` overwrite/keep-extra test (Node v22.20.0).

## Gaps / flags
- **Premise change (high-impact):** the prior cycle's "override absent from source" assumption is
  stale — source now ships its own `crm-access.md`. All planning must start from this.
- **Owner intent on scope unknown:** is pushing the dimitris skill (business + CRM docs) to *all*
  groups acceptable, or must it be gated to `dimitris-claw`? The user asked for dimitris "at least"
  into dimitris-claw — implies scoping matters. **Needs user confirmation.**
- **Divergent content:** the override and source `crm-access.md` differ beyond environment (override
  documents 35 `crm.*` MCP tools not in source). Auto-syncing source would lose that MCP doc unless
  preserved. Whether the two should be reconciled upstream is a product decision, not determinable
  from code.
