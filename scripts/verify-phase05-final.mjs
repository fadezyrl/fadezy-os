/**
 * Phase 05 final verification (API + SQL).
 * Never prints raw invitation tokens or API keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';

const root = path.resolve(import.meta.dirname, '..');
const tokensPath = path.join(root, 'scripts', '.verify-tokens.json');
const apiBase = process.env.API_BASE || 'http://localhost:4000';
const stamp = Date.now();
const results = [];
const passed = [];
const failed = [];
const blocked = [];

function loadEnv(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function note(key, value) {
  results.push(`${key}=${value}`);
}

function markPass(id, detail) {
  passed.push(id);
  note(id, `PASS:${detail}`);
}

function markFail(id, detail) {
  failed.push(id);
  note(id, `FAIL:${detail}`);
}

function markBlocked(id, detail) {
  blocked.push(id);
  note(id, `BLOCKED:${detail}`);
}

async function api(method, pathName, token, body) {
  const response = await fetch(`${apiBase}${pathName}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function assertStatus(id, actual, expected, detail = '') {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  if (ok) markPass(id, `${actual}${detail ? ` ${detail}` : ''}`);
  else markFail(id, `got ${actual} expected ${expected}${detail ? ` ${detail}` : ''}`);
}

if (!fs.existsSync(tokensPath)) {
  console.log('fatal=missing_tokens_file');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
const resendConfigured = Boolean(backendEnv.RESEND_API_KEY?.trim());

if (!resendConfigured) {
  markBlocked(
    'resend_delivery',
    'RESEND_API_KEY empty in backend/.env — cannot verify live email delivery',
  );
} else {
  note('resend_delivery', 'CONFIGURED_WILL_ATTEMPT');
}

const sb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const pg = new Client({
  connectionString: backendEnv.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await pg.connect();

  for (const key of ['a', 'b']) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: tokens[key].email,
      password: 'VerifyPass1!',
    });
    if (error) throw new Error(`${key} signin failed: ${error.message}`);
    tokens[key].token = data.session.access_token;
    tokens[key].userId = data.user.id;
    tokens[key].emailConfirmed = Boolean(data.user.email_confirmed_at);
  }
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

  note('a_email_verified', tokens.a.emailConfirmed);
  note('b_email_verified', tokens.b.emailConfirmed);
  if (!tokens.a.emailConfirmed || !tokens.b.emailConfirmed) {
    markFail('verified_accounts', 'one or both verify accounts lack email_confirmed_at');
  } else {
    markPass('verified_accounts', 'A and B both email-confirmed');
  }

  const authUsersBefore = await pg.query(
    `select count(*)::int as c from auth.users where lower(email) = lower($1)`,
    [tokens.b.email],
  );
  note('auth_users_for_b_before', authUsersBefore.rows[0].c);

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessA = listA.json.data?.[0];
  const businessB = listB.json.data?.[0];
  if (!businessA?.id || !businessB?.id) throw new Error('missing A/B businesses');
  note('business_a', businessA.id);
  note('business_b', businessB.id);

  // Phase 01–04 smoke
  const health = await api('GET', '/api/v1/health');
  assertStatus('phase01_health', health.status, 200);
  const ready = await api('GET', '/api/v1/health/ready');
  assertStatus('phase01_ready', ready.status, 200);
  assertStatus('phase03_list_businesses', listA.status, 200);
  const services = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/services?status=active&limit=5`,
    tokens.a.token,
  );
  assertStatus('phase04_list_services', services.status, 200);

  const locs = await api('GET', `/api/v1/businesses/${businessA.id}/locations`, tokens.a.token);
  const locationId = locs.json.data?.[0]?.id ?? null;
  note('location_a', locationId ?? 'none');

  // Ensure B is not already an active member of A (cleanup prior runs)
  const existing = await pg.query(
    `select id, membership_status, deactivated_at, role
     from public.business_members
     where business_id = $1 and user_id = $2`,
    [businessA.id, tokens.b.userId],
  );
  if (existing.rowCount) {
    await pg.query(`delete from public.staff_service_assignments where membership_id = $1`, [
      existing.rows[0].id,
    ]);
    await pg.query(`delete from public.staff_location_assignments where membership_id = $1`, [
      existing.rows[0].id,
    ]);
    await pg.query(`delete from public.staff_profiles where membership_id = $1`, [
      existing.rows[0].id,
    ]);
    await pg.query(`delete from public.business_members where id = $1`, [existing.rows[0].id]);
    note('cleanup_prior_b_membership', true);
  }

  // Cancel any pending invites for B on A
  await pg.query(
    `update public.business_invitations
     set status = 'cancelled', cancelled_at = timezone('utc', now())
     where business_id = $1 and lower(email) = lower($2) and status = 'pending'`,
    [businessA.id, tokens.b.email],
  );

  // --- API create invitation (email path) ---
  const apiInvite = await api('POST', `/api/v1/businesses/${businessA.id}/invitations`, tokens.a.token, {
    email: tokens.b.email,
    role: 'staff',
    displayName: `Verify B ${stamp}`,
    locationIds: locationId ? [locationId] : [],
  });
  assertStatus('owner_create_invite_api', apiInvite.status, 201);
  note('api_invite_email_sent', Boolean(apiInvite.json.data?.emailSent));
  note('api_invite_email_skipped', Boolean(apiInvite.json.data?.emailSkipped));
  if (apiInvite.json.data?.emailSent) {
    markPass('resend_delivery', 'API reported emailSent=true');
  } else if (!resendConfigured) {
    // already blocked
  } else {
    markFail('resend_delivery', 'key present but emailSent=false');
  }

  // Cancel API invite — accept path will use RPC with known token (no email required)
  if (apiInvite.json.data?.invitation?.id) {
    await api(
      'POST',
      `/api/v1/businesses/${businessA.id}/invitations/${apiInvite.json.data.invitation.id}/cancel`,
      tokens.a.token,
    );
  }

  // --- Accept path with known hashed token (does not print raw token) ---
  const rawAcceptToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawAcceptToken);
  const sbA = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${tokens.a.token}` } },
  });
  const { data: rpcInvite, error: rpcErr } = await sbA.rpc('create_business_invitation', {
    payload: {
      business_id: businessA.id,
      email: tokens.b.email,
      role: 'staff',
      display_name: `Accept Verify ${stamp}`,
      token_hash: tokenHash,
      location_ids: locationId ? [locationId] : [],
    },
  });
  if (rpcErr) markFail('rpc_create_invite', rpcErr.message.slice(0, 120));
  else markPass('rpc_create_invite', rpcInvite?.id ? 'created' : 'ok');

  const accept1 = await api('POST', '/api/v1/invitations/accept', tokens.b.token, {
    token: rawAcceptToken,
  });
  assertStatus('accept_invite', accept1.status, 200);
  note('accept_business_id_match', accept1.json.data?.businessId === businessA.id);
  note('accept_membership_id_present', Boolean(accept1.json.data?.membershipId));
  if (accept1.json.data?.businessId !== businessA.id) {
    markFail('accept_business_match', 'businessId mismatch');
  } else {
    markPass('accept_business_match', 'joined business A');
  }

  const membershipId = accept1.json.data?.membershipId;
  const memberRow = membershipId
    ? await pg.query(
        `select membership_status, role, deactivated_at, user_id
         from public.business_members where id = $1`,
        [membershipId],
      )
    : { rows: [] };
  const m = memberRow.rows[0];
  if (m?.membership_status === 'active' && !m.deactivated_at && m.role === 'staff') {
    markPass('membership_active_staff', m.membership_status);
  } else {
    markFail('membership_active_staff', JSON.stringify(m ?? null));
  }

  const profile = membershipId
    ? await pg.query(
        `select display_name, email, user_id from public.staff_profiles where membership_id = $1`,
        [membershipId],
      )
    : { rows: [] };
  const p = profile.rows[0];
  if (
    p &&
    p.user_id === tokens.b.userId &&
    String(p.email || '').toLowerCase() === tokens.b.email.toLowerCase()
  ) {
    markPass('staff_profile_created', p.display_name || 'named');
  } else {
    markFail('staff_profile_created', JSON.stringify(p ?? null));
  }

  if (locationId && membershipId) {
    const locAssign = await pg.query(
      `select 1 from public.staff_location_assignments
       where membership_id = $1 and location_id = $2`,
      [membershipId, locationId],
    );
    if (locAssign.rowCount === 1) markPass('location_assignment', 'present');
    else markFail('location_assignment', `count=${locAssign.rowCount}`);
  } else {
    markBlocked('location_assignment', 'no location on business A');
  }

  const authUsersAfter = await pg.query(
    `select count(*)::int as c from auth.users where lower(email) = lower($1)`,
    [tokens.b.email],
  );
  note('auth_users_for_b_after', authUsersAfter.rows[0].c);
  if (authUsersAfter.rows[0].c === authUsersBefore.rows[0].c && authUsersAfter.rows[0].c === 1) {
    markPass('no_duplicate_auth_user', `count=${authUsersAfter.rows[0].c}`);
  } else {
    markFail(
      'no_duplicate_auth_user',
      `before=${authUsersBefore.rows[0].c} after=${authUsersAfter.rows[0].c}`,
    );
  }

  // Token replay
  const acceptReplay = await api('POST', '/api/v1/invitations/accept', tokens.b.token, {
    token: rawAcceptToken,
  });
  // Idempotent replay may return 200 with idempotentReplay, or 409 if already used by design
  if (acceptReplay.status === 200 && acceptReplay.json.data?.idempotentReplay === true) {
    markPass('token_replay', 'idempotent_replay=true');
  } else if ([409, 422, 404].includes(acceptReplay.status)) {
    markPass('token_replay', `rejected status=${acceptReplay.status}`);
  } else {
    markFail('token_replay', `unexpected status=${acceptReplay.status}`);
  }

  // Cancelled invite rejection
  const cancelToken = randomBytes(32).toString('base64url');
  const { error: cancelCreateErr } = await sbA.rpc('create_business_invitation', {
    payload: {
      business_id: businessA.id,
      email: `cancel.${stamp}@example.com`,
      role: 'staff',
      display_name: 'Cancel Me',
      token_hash: hashToken(cancelToken),
      location_ids: [],
    },
  });
  if (cancelCreateErr) markFail('cancel_invite_setup', cancelCreateErr.message.slice(0, 80));
  const pendingCancel = await pg.query(
    `select id from public.business_invitations
     where business_id = $1 and token_hash = $2`,
    [businessA.id, hashToken(cancelToken)],
  );
  const cancelId = pendingCancel.rows[0]?.id;
  if (cancelId) {
    const cancelled = await api(
      'POST',
      `/api/v1/businesses/${businessA.id}/invitations/${cancelId}/cancel`,
      tokens.a.token,
    );
    assertStatus('cancel_invite', cancelled.status, 200);
    const acceptCancelled = await api('POST', '/api/v1/invitations/accept', tokens.a.token, {
      token: cancelToken,
    });
    assertStatus('accept_cancelled_rejected', acceptCancelled.status, [409, 422, 404]);
  } else {
    markFail('cancel_invite_setup', 'invite row missing');
  }

  // Expired invite rejection
  const expiredToken = randomBytes(32).toString('base64url');
  const expiredHash = hashToken(expiredToken);
  await pg.query(
    `insert into public.business_invitations
      (business_id, email, role, invited_by, display_name, token_hash, status, expires_at, location_ids)
     values ($1, $2, 'staff', $3, 'Expired', $4, 'pending', timezone('utc', now()) - interval '1 day', '{}')`,
    [businessA.id, `expired.${stamp}@example.com`, tokens.a.userId, expiredHash],
  );
  const acceptExpired = await api('POST', '/api/v1/invitations/accept', tokens.a.token, {
    token: expiredToken,
  });
  assertStatus('accept_expired_rejected', acceptExpired.status, [409, 422, 404]);

  // --- Security regression ---
  const crossMembers = await api(
    'GET',
    `/api/v1/businesses/${businessB.id}/members`,
    tokens.a.token,
  );
  assertStatus('cross_tenant_members', crossMembers.status, [403, 404]);

  const crossInvite = await api(
    'POST',
    `/api/v1/businesses/${businessB.id}/invitations`,
    tokens.a.token,
    { email: `x.${stamp}@example.com`, role: 'staff' },
  );
  assertStatus('cross_tenant_invite', crossInvite.status, [403, 404]);

  // Staff cannot invite
  const staffInvite = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/invitations`,
    tokens.b.token,
    { email: `staff.invite.${stamp}@example.com`, role: 'staff' },
  );
  assertStatus('staff_cannot_invite', staffInvite.status, [403, 404]);

  // Promote B to manager then try invite manager
  const promote = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/members/${membershipId}/role`,
    tokens.a.token,
    { role: 'manager' },
  );
  assertStatus('promote_b_manager', promote.status, 200);

  const managerInviteManager = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/invitations`,
    tokens.b.token,
    { email: `mgr.${stamp}@example.com`, role: 'manager' },
  );
  assertStatus('manager_cannot_invite_manager', managerInviteManager.status, [403, 404]);

  const managerInviteStaff = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/invitations`,
    tokens.b.token,
    { email: `okstaff.${stamp}@example.com`, role: 'staff' },
  );
  assertStatus('manager_can_invite_staff', managerInviteStaff.status, 201);

  // Manager cannot modify owner
  const membersA = await api('GET', `/api/v1/businesses/${businessA.id}/members`, tokens.a.token);
  const ownerMembership = (membersA.json.data ?? []).find((m) => m.role === 'owner');
  if (ownerMembership) {
    const suspendOwner = await api(
      'PATCH',
      `/api/v1/businesses/${businessA.id}/members/${ownerMembership.membershipId}/status`,
      tokens.b.token,
      { action: 'suspend' },
    );
    assertStatus('manager_cannot_suspend_owner', suspendOwner.status, [403, 404]);

    const demoteOwner = await api(
      'PATCH',
      `/api/v1/businesses/${businessA.id}/members/${ownerMembership.membershipId}/role`,
      tokens.b.token,
      { role: 'staff' },
    );
    assertStatus('manager_cannot_demote_owner', demoteOwner.status, [403, 404]);

    const ownerSelfSuspend = await api(
      'PATCH',
      `/api/v1/businesses/${businessA.id}/members/${ownerMembership.membershipId}/status`,
      tokens.a.token,
      { action: 'suspend' },
    );
    assertStatus('last_owner_cannot_suspend_self', ownerSelfSuspend.status, [403, 422]);

    const ownerSelfDemote = await api(
      'PATCH',
      `/api/v1/businesses/${businessA.id}/members/${ownerMembership.membershipId}/role`,
      tokens.a.token,
      { role: 'staff' },
    );
    assertStatus('last_owner_cannot_demote_self', ownerSelfDemote.status, [403, 422]);
  } else {
    markFail('owner_membership_lookup', 'missing');
  }

  // Internal notes privacy: owner sets notes, staff/manager B reads as staff again
  await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/members/${membershipId}/role`,
    tokens.a.token,
    { role: 'staff' },
  );
  await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership.membershipId}/profile`,
    tokens.a.token,
    { internalNotes: `secret-note-${stamp}` },
  );
  const staffViewOwner = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership.membershipId}`,
    tokens.b.token,
  );
  assertStatus('staff_get_owner_detail', staffViewOwner.status, 200);
  const notes = staffViewOwner.json.data?.internalNotes;
  if (notes === null || notes === undefined || notes === '') {
    markPass('staff_cannot_see_internal_notes', `notes=${notes === null ? 'null' : 'empty'}`);
  } else {
    markFail('staff_cannot_see_internal_notes', 'notes leaked to staff');
  }

  // Assignments as owner
  const svcList = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/services?status=active&limit=5`,
    tokens.a.token,
  );
  const serviceId = svcList.json.data?.items?.[0]?.id;
  if (serviceId && membershipId) {
    const setSvc = await api(
      'PUT',
      `/api/v1/businesses/${businessA.id}/members/${membershipId}/services`,
      tokens.a.token,
      { serviceIds: [serviceId] },
    );
    assertStatus('assign_services', setSvc.status, 200);
  } else {
    markBlocked('assign_services', 'no active service on A');
  }

  if (locationId && membershipId) {
    const setLoc = await api(
      'PUT',
      `/api/v1/businesses/${businessA.id}/members/${membershipId}/locations`,
      tokens.a.token,
      { locationIds: [locationId] },
    );
    assertStatus('assign_locations_api', setLoc.status, 200);
  }

  // Suspend / reactivate staff (not last owner)
  const suspendStaff = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/members/${membershipId}/status`,
    tokens.a.token,
    { action: 'suspend' },
  );
  assertStatus('suspend_staff', suspendStaff.status, 200);
  const reactivateStaff = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/members/${membershipId}/status`,
    tokens.a.token,
    { action: 'reactivate' },
  );
  assertStatus('reactivate_staff', reactivateStaff.status, 200);

  // Token hash only in DB
  const rawCols = await pg.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='business_invitations'
      and column_name in ('token','raw_token','token_plaintext')
  `);
  if (rawCols.rowCount === 0) markPass('no_raw_token_column', 'ok');
  else markFail('no_raw_token_column', rawCols.rows.map((r) => r.column_name).join(','));

  // Ensure invite API response never echoed a token field
  const body = JSON.stringify(apiInvite.json);
  if (/"token"\s*:/.test(body)) markFail('invite_response_no_token', 'token field present');
  else markPass('invite_response_no_token', 'ok');
} catch (error) {
  markFail('fatal', String(error.message || error).slice(0, 300));
} finally {
  await pg.end().catch(() => undefined);
}

console.log('--- evidence ---');
for (const line of results) console.log(line);
console.log('--- summary ---');
console.log(`passed_count=${passed.length}`);
console.log(`failed_count=${failed.length}`);
console.log(`blocked_count=${blocked.length}`);
console.log(`passed=${passed.join(',')}`);
console.log(`failed=${failed.join(',')}`);
console.log(`blocked=${blocked.join(',')}`);
console.log(`final_api_sql_pass=${failed.length === 0}`);
if (failed.length) process.exitCode = 1;
