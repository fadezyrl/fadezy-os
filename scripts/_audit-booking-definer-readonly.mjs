/**
 * Read-only SECURITY DEFINER audit evidence collector.
 * Does not modify schema, grants, roles, or data.
 */
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
const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

const names = [
  'assert_can_manage_booking_location',
  'create_workspace_booking',
  'reschedule_booking_times',
  'guest_get_booking_slot_context',
  'create_guest_booking',
];

await client.connect();

console.log('=== FUNCTION CATALOG ===');
const fns = await client.query(
  `
  select p.oid,
         n.nspname as schema,
         p.proname,
         pg_get_userbyid(p.proowner) as owner,
         p.prosecdef as security_definer,
         p.proconfig,
         p.provolatile,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any($1::text[])
  order by p.proname
`,
  [names],
);
for (const row of fns.rows) {
  console.log(
    JSON.stringify({
      schema: row.schema,
      proname: row.proname,
      owner: row.owner,
      security_definer: row.security_definer,
      proconfig: row.proconfig,
      args: row.args,
    }),
  );
}

console.log('=== EXECUTE PRIVILEGES ===');
const roles = ['anon', 'authenticated', 'service_role', 'postgres', 'public'];
for (const row of fns.rows) {
  for (const role of roles) {
    const r = await client.query(
      `select has_function_privilege($1::text, $2::oid, 'EXECUTE') as can_execute`,
      [role, row.oid],
    );
    console.log(`${row.proname}|role=${role}|execute=${r.rows[0].can_execute}`);
  }
  const acl = await client.query(
    `
    select coalesce(
      (
        select json_agg(json_build_object(
          'grantee', case when ae.grantee = 0 then 'PUBLIC' else pg_get_userbyid(ae.grantee) end,
          'privilege', ae.privilege_type,
          'is_grantable', ae.is_grantable
        ) order by 1)
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ae
      ),
      '[]'::json
    ) as acl
    from pg_proc p where p.oid = $1
  `,
    [row.oid],
  );
  console.log(`${row.proname}|acl=${JSON.stringify(acl.rows[0].acl)}`);
}

console.log('=== PUBLIC SCHEMA PRIVILEGES ===');
const schemaPrivs = await client.query(`
  select r.rolname as grantee, p.privilege_type
  from information_schema.usage_privileges u
  right join (
    select grantee, privilege_type
    from information_schema.role_usage_grants
    where object_schema = 'public' and object_type = 'SCHEMA'
  ) x on false
`);
// Prefer catalog query for schema ACL
const schemaAcl = await client.query(`
  select n.nspname,
         pg_catalog.has_schema_privilege('anon', n.oid, 'CREATE') as anon_create,
         pg_catalog.has_schema_privilege('authenticated', n.oid, 'CREATE') as auth_create,
         pg_catalog.has_schema_privilege('anon', n.oid, 'USAGE') as anon_usage,
         pg_catalog.has_schema_privilege('authenticated', n.oid, 'USAGE') as auth_usage,
         pg_catalog.has_schema_privilege('public', n.oid, 'CREATE') as public_create,
         pg_catalog.has_schema_privilege('public', n.oid, 'USAGE') as public_usage,
         n.nspacl::text as nspacl
  from pg_namespace n
  where n.nspname in ('public', 'auth', 'extensions', 'pg_catalog')
  order by 1
`);
for (const row of schemaAcl.rows) {
  console.log(JSON.stringify(row));
}

console.log('=== AUTH.UID RESOLUTION ===');
const authUid = await client.query(`
  select n.nspname as schema, p.proname, pg_get_userbyid(p.proowner) as owner,
         p.prosecdef as security_definer, p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'uid'
  order by 1
`);
for (const row of authUid.rows) console.log(JSON.stringify(row));

const searchPath = await client.query(`show search_path`);
console.log(`session_search_path=${searchPath.rows[0].search_path}`);

console.log('=== ANON/AUTH TABLE GRANTS (booking-related) ===');
const tableGrants = await client.query(`
  select grantee, table_schema, table_name, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (
      'customers','bookings','booking_services','booking_addons','booking_status_events',
      'businesses','business_locations','services','business_members'
    )
    and grantee in ('anon','authenticated','PUBLIC','public')
  order by table_name, grantee, privilege_type
`);
console.log(`grant_rows=${tableGrants.rows.length}`);
for (const row of tableGrants.rows) {
  console.log(
    `${row.table_name}|${row.grantee}|${row.privilege_type}`,
  );
}

console.log('=== RLS FLAGS ===');
const rls = await client.query(`
  select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
         (select rolbypassrls from pg_roles where rolname = current_user) as current_bypass
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('customers','bookings','booking_services','booking_addons','booking_status_events')
  order by 1
`);
for (const row of rls.rows) console.log(JSON.stringify(row));

console.log('=== CURRENT CONNECTION ROLE ===');
const role = await client.query(`
  select current_user, session_user,
         (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
         (select rolbypassrls from pg_roles where rolname = current_user) as rolbypassrls
`);
console.log(JSON.stringify(role.rows[0]));

console.log('=== FUNCTION BODY MARKERS ===');
for (const row of fns.rows) {
  const def = row.def;
  const markers = {
    has_auth_uid_unqualified: /\bauth\.uid\s*\(/.test(def) === false && /\buid\s*\(/.test(def),
    has_auth_uid_qualified: /auth\.uid\s*\(/.test(def),
    has_set_search_path: /search_path/i.test(String(row.proconfig)),
    has_execute_dynamic: /\bEXECUTE\s+/i.test(def) && !/EXECUTE ON FUNCTION/i.test(def),
    has_format_dynamic: /\bformat\s*\(/i.test(def),
    unqualified_from: Array.from(def.matchAll(/\bfrom\s+([a-z_][a-z0-9_]*)\b/gi))
      .map((m) => m[1])
      .filter((t) => !['public', 'auth', 'pg_catalog', 'information_schema'].includes(t.toLowerCase()))
      .slice(0, 30),
  };
  // Better: find FROM/JOIN/INTO/UPDATE/INSERT INTO without schema prefix
  const refs = Array.from(
    def.matchAll(
      /\b(?:from|join|into|update|table)\s+(?!public\.|auth\.|pg_catalog\.|information_schema\.)([a-z_][a-z0-9_]*)/gi,
    ),
  ).map((m) => m[1].toLowerCase());
  const uniqueUnqualified = [...new Set(refs)].filter(
    (t) =>
      ![
        'v_existing',
        'v_location',
        'v_service',
        'v_member',
        'v_addon',
        'v_exception',
        'v_schedule',
        'v_row',
        'v_public',
        'v_actor_membership',
        'found',
        'strict',
      ].includes(t),
  );
  console.log(
    JSON.stringify({
      proname: row.proname,
      has_auth_uid_qualified: /auth\.uid\s*\(/.test(def),
      auth_uid_count: (def.match(/auth\.uid\s*\(/g) || []).length,
      has_execute_dynamic: /\bEXECUTE\s+(?!ON\b)/i.test(def),
      unqualified_relation_candidates: uniqueUnqualified,
      body_length: def.length,
    }),
  );
}

await client.end();
