import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock the heavy, side-effectful deps that container-runner pulls in at import
// time (config reads .env, OneCLI opens a client). fs is intentionally NOT
// mocked — syncSkills is exercised against real temp-dir fixtures.
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
  },
}));

import { syncSkills } from './container-runner.js';

const SOURCE_CRM = '# CRM access recipes\nSSH/psql recipe (source skill).\n';
const OVERRIDE_CRM =
  '# CRM access recipes — DimitrisClaw container\nHTTP-MCP recipe (override).\n';
const GLOBAL_SKILL = '# Capabilities skill\n';
const SKILL_MD = '# Dimitris skill\n';
const BUSINESS_MD = '# Business\n';

let tmp: string;
let globalSkills: string;
let groupSkills: string;
let groupOverrides: string;
let dst: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-skills-'));
  globalSkills = path.join(tmp, 'global');
  groupSkills = path.join(tmp, 'group-skills');
  groupOverrides = path.join(tmp, 'group-overrides');
  dst = path.join(tmp, 'dst');

  // Global skill (present for every group).
  write(path.join(globalSkills, 'capabilities', 'SKILL.md'), GLOBAL_SKILL);

  // Per-group source skill: dimitris with a colliding crm-access.md.
  write(path.join(groupSkills, 'dimitris', 'SKILL.md'), SKILL_MD);
  write(path.join(groupSkills, 'dimitris', 'business.md'), BUSINESS_MD);
  write(path.join(groupSkills, 'dimitris', 'crm-access.md'), SOURCE_CRM);

  // Per-group override overlay: only crm-access.md, distinct content.
  write(path.join(groupOverrides, 'dimitris', 'crm-access.md'), OVERRIDE_CRM);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('syncSkills', () => {
  it('copies global skills into every group', () => {
    syncSkills(dst, 'dimitris-claw', { globalSkills, groupSkills, groupOverrides });
    expect(fs.readFileSync(path.join(dst, 'capabilities', 'SKILL.md'), 'utf8')).toBe(
      GLOBAL_SKILL,
    );
  });

  it('copies per-group source files through verbatim', () => {
    syncSkills(dst, 'dimitris-claw', { globalSkills, groupSkills, groupOverrides });
    expect(fs.readFileSync(path.join(dst, 'dimitris', 'SKILL.md'), 'utf8')).toBe(
      SKILL_MD,
    );
    expect(fs.readFileSync(path.join(dst, 'dimitris', 'business.md'), 'utf8')).toBe(
      BUSINESS_MD,
    );
  });

  it('override wins over the source crm-access.md (override copied last)', () => {
    syncSkills(dst, 'dimitris-claw', { globalSkills, groupSkills, groupOverrides });
    expect(
      fs.readFileSync(path.join(dst, 'dimitris', 'crm-access.md'), 'utf8'),
    ).toBe(OVERRIDE_CRM);
  });

  it('is scoped: a group without per-group roots gets no dimitris dir', () => {
    // Simulate a different group with no per-group skills/overrides present.
    const otherGroupSkills = path.join(tmp, 'nope-skills');
    const otherOverrides = path.join(tmp, 'nope-overrides');
    syncSkills(dst, 'other', {
      globalSkills,
      groupSkills: otherGroupSkills,
      groupOverrides: otherOverrides,
    });
    expect(fs.existsSync(path.join(dst, 'dimitris'))).toBe(false);
    // Global skill still lands (regression: legacy behavior preserved).
    expect(fs.existsSync(path.join(dst, 'capabilities', 'SKILL.md'))).toBe(true);
  });

  it('is idempotent across repeated runs (no ERR_FS_CP_EINVAL)', () => {
    const run = () =>
      syncSkills(dst, 'dimitris-claw', {
        globalSkills,
        groupSkills,
        groupOverrides,
      });
    expect(() => {
      run();
      run();
    }).not.toThrow();
    expect(
      fs.readFileSync(path.join(dst, 'dimitris', 'crm-access.md'), 'utf8'),
    ).toBe(OVERRIDE_CRM);
  });

  it('is a no-op when all roots are absent', () => {
    expect(() =>
      syncSkills(dst, 'ghost', {
        globalSkills: path.join(tmp, 'x'),
        groupSkills: path.join(tmp, 'y'),
        groupOverrides: path.join(tmp, 'z'),
      }),
    ).not.toThrow();
    expect(fs.existsSync(dst)).toBe(false);
  });
});
