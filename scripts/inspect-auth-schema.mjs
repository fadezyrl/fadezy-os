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
const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 15000 });

await client.connect();
const cols = await client.query(`
  select column_name
  from information_schema.columns
  where table_schema='auth' and table_name='users'
  order by ordinal_position
`);
console.log(`auth_users_cols=${cols.rows.map((r) => r.column_name).join(',')}`);

const idents = await client.query(`
  select column_name
  from information_schema.columns
  where table_schema='auth' and table_name='identities'
  order by ordinal_position
`);
console.log(`identities_cols=${idents.rows.map((r) => r.column_name).join(',')}`);

try {
  const jwt = await client.query(`select current_setting('app.settings.jwt_secret', true) as v`);
  console.log(`jwt_secret_setting=${jwt.rows[0].v ? `present_len_${String(jwt.rows[0].v).length}` : 'null'}`);
} catch {
  console.log('jwt_secret_setting=error');
}

try {
  const vault = await client.query(`select name from vault.secrets limit 10`);
  console.log(`vault_secrets=${vault.rows.map((r) => r.name).join(',') || 'none'}`);
} catch {
  console.log('vault_secrets=unavailable');
}

const recent = await client.query(`
  select email, (email_confirmed_at is not null) as confirmed
  from auth.users
  order by created_at desc nulls last
  limit 10
`);
console.log(
  `recent_users=${recent.rows.map((r) => `${r.email || 'null'}:${r.confirmed}`).join('|')}`,
);

await client.end();
