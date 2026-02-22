import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CLAUDE_MODEL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL || envConfig.CLAUDE_MODEL || 'sonnet';
export const POLL_INTERVAL = 2000;

export interface ModelEntry {
  id: string;
  alias: string;
  display: string;
  note: string;
}

export const AVAILABLE_MODELS: ModelEntry[] = [
  { id: 'claude-opus-4-6', alias: 'opus', display: 'Opus 4.6', note: 'Most capable' },
  { id: 'claude-opus-4-5', alias: 'opus-4-5', display: 'Opus 4.5', note: '' },
  { id: 'claude-sonnet-4-6', alias: 'sonnet', display: 'Sonnet 4.6', note: 'Default' },
  { id: 'claude-sonnet-4-5', alias: 'sonnet-4-5', display: 'Sonnet 4.5', note: '' },
  { id: 'claude-haiku-4-5', alias: 'haiku', display: 'Haiku 4.5', note: 'Fastest' },
];

/** Resolve a model alias or full ID to a valid model ID. Returns undefined if not found. */
export function resolveModelId(input: string): string | undefined {
  const lower = input.toLowerCase().trim();
  const entry = AVAILABLE_MODELS.find(
    (m) => m.alias === lower || m.id === lower || m.display.toLowerCase() === lower,
  );
  return entry?.id;
}

/** Get the display name for a model ID or alias. */
export function getModelDisplay(modelIdOrAlias: string): string {
  const lower = modelIdOrAlias.toLowerCase().trim();
  const entry = AVAILABLE_MODELS.find(
    (m) => m.alias === lower || m.id === lower,
  );
  return entry?.display || modelIdOrAlias;
}
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
