/**
 * API Phase 05 checks using scripts/.verify-tokens.json (A/B owners from earlier phases).
 * Does not claim Resend delivery. Does not open a browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(import.meta.dirname, '..');
const tokensPath = path.join(root, 'scripts', '.verify-tokens.json');
const apiBase = process.env.API_BASE || 'http://localhost:4000';
const results = [];

function loadEnv(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
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

if (!fs.existsSync(tokensPath)) {
  console.log('api_team_pass=false');
  console.log('error=missing_tokens_file');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
const stamp = Date.now();

try {
  const sb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const key of ['a', 'b']) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: tokens[key].email,
      password: 'VerifyPass1!',
    });
    if (error) throw new Error(key + ' signin failed: ' + error.message);
    tokens[key].token = data.session.access_token;
    tokens[key].userId = data.user.id;
  }
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessA = listA.json.data?.[0]?.id;
  const businessB = listB.json.data?.[0]?.id;
  if (!businessA || !businessB) throw new Error('missing businesses for A/B');

  const permsA = await api(
    'GET',
    `/api/v1/businesses/${businessA}/members/permissions`,
    tokens.a.token,
  );
  results.push(`perms_a=${permsA.status}`);
  results.push(`can_invite_manager=${Boolean(permsA.json.data?.canInviteManager)}`);

  const membersA = await api('GET', `/api/v1/businesses/${businessA}/members`, tokens.a.token);
  results.push(`list_members_a=${membersA.status}`);
  results.push(
    `members_a_count=${Array.isArray(membersA.json.data) ? membersA.json.data.length : 0}`,
  );

  const crossList = await api('GET', `/api/v1/businesses/${businessB}/members`, tokens.a.token);
  results.push(`cross_tenant_list=${crossList.status}`);

  const inviteEmail = `phase05+staff.${stamp}@example.com`;
  const invite = await api('POST', `/api/v1/businesses/${businessA}/invitations`, tokens.a.token, {
    email: inviteEmail,
    role: 'staff',
    displayName: `Invitee ${stamp}`,
  });
  results.push(`create_invite=${invite.status}`);
  results.push(`email_skipped=${Boolean(invite.json.data?.emailSkipped)}`);
  results.push(`invite_id=${invite.json.data?.invitation?.id ?? 'none'}`);

  const crossInvite = await api(
    'POST',
    `/api/v1/businesses/${businessA}/invitations`,
    tokens.b.token,
    { email: `phase05+x.${stamp}@example.com`, role: 'staff' },
  );
  results.push(`cross_tenant_invite=${crossInvite.status}`);

  const listInvites = await api(
    'GET',
    `/api/v1/businesses/${businessA}/invitations`,
    tokens.a.token,
  );
  results.push(`list_invites=${listInvites.status}`);

  const fakeToken = randomBytes(32).toString('base64url');
  const acceptWrong = await api('POST', '/api/v1/invitations/accept', tokens.b.token, {
    token: fakeToken,
  });
  results.push(`accept_unknown_token=${acceptWrong.status}`);

  const ownerMembership = (membersA.json.data ?? []).find((m) => m.role === 'owner');
  let suspendSelfStatus = 'skipped';
  if (ownerMembership) {
    const suspendSelf = await api(
      'PATCH',
      `/api/v1/businesses/${businessA}/members/${ownerMembership.membershipId}/status`,
      tokens.a.token,
      { action: 'suspend' },
    );
    suspendSelfStatus = String(suspendSelf.status);
  }
  results.push(`suspend_self_owner=${suspendSelfStatus}`);

  const inviteBody = JSON.stringify(invite.json);
  results.push(`response_has_raw_token_field=${/"token"\s*:/.test(inviteBody)}`);

  const pass =
    permsA.status === 200 &&
    membersA.status === 200 &&
    (crossList.status === 403 || crossList.status === 404) &&
    invite.status === 201 &&
    (crossInvite.status === 403 || crossInvite.status === 404) &&
    listInvites.status === 200 &&
    (acceptWrong.status === 404 || acceptWrong.status === 422 || acceptWrong.status === 409) &&
    (suspendSelfStatus === 'skipped' ||
      suspendSelfStatus === '403' ||
      suspendSelfStatus === '422') &&
    !/"token"\s*:/.test(inviteBody);

  console.log(results.join('\n'));
  console.log(`api_team_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log('api_team_pass=false');
  console.error(String(error.message || error).slice(0, 500));
  process.exitCode = 1;
}
