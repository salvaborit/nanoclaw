/**
 * Register the ZOG group once JID is known.
 *
 * Usage:
 *   1. Start NanoClaw: npm run dev
 *   2. Send a message to the "The ZOG" WhatsApp group
 *   3. Check logs for the group JID (looks like: 120363...@g.us)
 *   4. Run: npx tsx scripts/register-zog.ts <JID>
 */
import { setRegisteredGroup, initDatabase } from '../src/db.js';
import type { RegisteredGroup } from '../src/types.js';

const jid = process.argv[2];
if (!jid) {
  console.error('Usage: npx tsx scripts/register-zog.ts <JID>');
  console.error('Example: npx tsx scripts/register-zog.ts 120363123456789@g.us');
  process.exit(1);
}

initDatabase();

const group: RegisteredGroup = {
  name: 'The ZOG',
  folder: 'zog',
  trigger: '@Jarvis',
  added_at: new Date().toISOString(),
  requiresTrigger: true,
  containerConfig: {
    additionalMounts: [
      { hostPath: '/home/sborit/zog', containerPath: 'zog', readonly: false },
    ],
  },
};

setRegisteredGroup(jid, group);

console.log('Registered The ZOG group:');
console.log(`  JID: ${jid}`);
console.log(`  Folder: groups/${group.folder}/`);
console.log(`  Trigger: ${group.trigger}`);
console.log(`  Mounts: zog`);
