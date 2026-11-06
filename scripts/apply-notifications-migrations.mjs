import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

function loadEnv(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

const root = path.resolve(import.meta.dirname, '..');
const env = loadEnv(path.join(root, 'backend', '.env'));
const files = [
  '20261108100000_notifications_foundation.sql',
  '20261108110000_notifications_emit.sql',
  '20261108120000_notifications_hooks_booking_pos.sql',
  '20261108130000_notifications_time_off.sql',
  '20261108140000_notifications_worker.sql',
  '20261108150000_notifications_worker_payload.sql',
  '20261108160000_notifications_reminder_reschedule_fix.sql',
  '20261108170000_notifications_lease_owner_and_reminder_fanout.sql',
];

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', file), 'utf8');
    await client.query(sql);
    console.log(`${file}=ok`);
  }
  console.log('notifications_migrations_applied=true');
} catch (error) {
  console.error('notifications_migrations_applied=false');
  console.error(String(error.message || error).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
