/**
 * Register the Prueba tech acc WhatsApp group (locksmith accounting agent — Aldo Cavanna trial).
 *
 * Usage:
 *   1. Ensure NanoClaw is running.
 *   2. JID is already known: 120363408992576888@g.us
 *   3. Run: npx tsx scripts/register-prueba-tech-acc.ts
 *   4. Restart NanoClaw to pick up the registration.
 */
import { setRegisteredGroup, initDatabase } from '../src/db.js';
import type { RegisteredGroup } from '../src/types.js';

const jid = '120363408992576888@g.us';

initDatabase();

const group: RegisteredGroup = {
  name: 'Prueba tech acc',
  folder: 'prueba-tech-acc',
  trigger: '@Jarvis', // ignored because requiresTrigger=false
  added_at: new Date().toISOString(),
  requiresTrigger: false, // auto-process every message
  isMain: false,
  containerConfig: {
    additionalMounts: [
      { hostPath: '/home/sborit/locksmiths', containerPath: 'locksmiths', readonly: false },
    ],
  },
};

setRegisteredGroup(jid, group);

console.log('Registered Prueba tech acc group:');
console.log(`  JID: ${jid}`);
console.log(`  Folder: groups/${group.folder}/`);
console.log(`  Trigger: auto (requiresTrigger=false)`);
console.log(`  Model: claude-sonnet-4-6`);
console.log(`  Mount: /home/sborit/locksmiths -> /workspace/extra/locksmiths (rw)`);
