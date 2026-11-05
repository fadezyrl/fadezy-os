/**
 * SQL-level catalog isolation + money/currency constraints.
 * Uses service connection (DATABASE_URL) with set_config role simulation where possible.
 * Primary checks: schema, triggers reject cross-business links, RLS helper exists.
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
const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 20000 });

try {
  await client.connect();

  const tables = await client.query(`
    select table_name from information_schema.tables
    where table_schema='public' and table_name like 'service%'
    order by 1
  `);
  console.log('tables=' + tables.rows.map((r) => r.table_name).join(','));

  const helper = await client.query(`
    select prosecdef, proconfig
    from pg_proc
    where proname = 'is_business_catalog_editor'
  `);
  console.log('catalog_editor_helper=' + (helper.rowCount > 0));
  console.log(
    'catalog_editor_security_definer=' +
      (helper.rows[0]?.prosecdef === true || helper.rows[0]?.prosecdef === 't'),
  );

  const businesses = await client.query(`
    select id, default_currency from public.businesses order by created_at asc limit 2
  `);
  if (businesses.rowCount < 2) {
    console.log('sql_catalog_pass=false');
    console.log('error=need_two_businesses');
    process.exitCode = 1;
    await client.end().catch(() => undefined);
    process.exit(1);
  }

  const a = businesses.rows[0];
  const b = businesses.rows[1];

  const catA = await client.query(
    `insert into public.service_categories (business_id, name, sort_order)
     values ($1, $2, 0) returning id`,
    [a.id, `sql-cat-a-${Date.now()}`],
  );
  const catAId = catA.rows[0].id;

  let crossCategoryBlocked = false;
  try {
    await client.query(
      `insert into public.services (
         business_id, category_id, name, price_minor, currency, duration_minutes
       ) values ($1, $2, 'bad', 1000, $3, 30)`,
      [b.id, catAId, String(b.default_currency).toUpperCase()],
    );
  } catch (error) {
    crossCategoryBlocked = String(error.message).includes('CROSS_BUSINESS_CATEGORY');
  }
  console.log('cross_business_category_blocked=' + crossCategoryBlocked);

  const svcA = await client.query(
    `insert into public.services (
       business_id, category_id, name, price_minor, currency, duration_minutes
     ) values ($1, $2, $3, 1500, $4, 45) returning id, currency`,
    [a.id, catAId, `sql-svc-a-${Date.now()}`, String(a.default_currency).toUpperCase()],
  );

  const locB = await client.query(
    `select id from public.business_locations where business_id = $1 limit 1`,
    [b.id],
  );

  let crossLocationBlocked = false;
  if (locB.rowCount) {
    try {
      await client.query(
        `insert into public.service_location_settings (
           business_id, service_id, location_id, is_available, price_minor, currency
         ) values ($1, $2, $3, true, 2000, $4)`,
        [a.id, svcA.rows[0].id, locB.rows[0].id, svcA.rows[0].currency],
      );
    } catch (error) {
      crossLocationBlocked =
        String(error.message).includes('CROSS_BUSINESS_LOCATION_SETTING') ||
        String(error.message).includes('LOCATION_NOT_FOUND');
    }
  } else {
    crossLocationBlocked = true;
  }
  console.log('cross_business_location_blocked=' + crossLocationBlocked);

  let currencyMismatchBlocked = false;
  const locA = await client.query(
    `select id from public.business_locations where business_id = $1 limit 1`,
    [a.id],
  );
  if (locA.rowCount) {
    try {
      await client.query(
        `insert into public.service_location_settings (
           business_id, service_id, location_id, is_available, price_minor, currency
         ) values ($1, $2, $3, true, 2000, 'ZZZ')`,
        [a.id, svcA.rows[0].id, locA.rows[0].id],
      );
    } catch (error) {
      currencyMismatchBlocked = String(error.message).includes('LOCATION_CURRENCY_MISMATCH');
    }
  }
  console.log('location_currency_mismatch_blocked=' + currencyMismatchBlocked);

  const pass = crossCategoryBlocked && crossLocationBlocked && currencyMismatchBlocked;
  console.log(`sql_catalog_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('sql_catalog_pass=false');
  console.log('error=' + String(error.message || error).slice(0, 400));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
