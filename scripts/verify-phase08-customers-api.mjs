import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';

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
  console.log('api_customers_pass=false');
  console.log('error=missing_tokens_file');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));

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
  }
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessA = listA.json.data?.[0];
  const businessB = listB.json.data?.[0];
  const locationA = businessA?.primaryLocation?.id;
  if (!businessA?.id || !businessB?.id || !locationA) throw new Error('missing businesses/locations');

  const stamp = Date.now();
  const created = await api('POST', `/api/v1/businesses/${businessA.id}/customers`, tokens.a.token, {
    fullName: `CRM Verify ${stamp}`,
    email: `crm-verify-${stamp}@example.com`,
    phone: '+15550001111',
    notes: 'phase08',
  });
  results.push(`create=${created.status}`);
  const customerId = created.json.data?.id;
  if (!customerId) throw new Error('customer create failed');

  const listed = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/customers?q=CRM%20Verify%20${stamp}&status=active&limit=10&offset=0`,
    tokens.a.token,
  );
  results.push(`list=${listed.status}`);
  results.push(`list_has_meta=${Boolean(listed.json.data?.meta)}`);
  results.push(
    `list_contains=${(listed.json.data?.items ?? []).some((c) => c.id === customerId)}`,
  );

  const detail = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}`,
    tokens.a.token,
  );
  results.push(`detail=${detail.status}`);

  const crossGet = await api(
    'GET',
    `/api/v1/businesses/${businessB.id}/customers/${customerId}`,
    tokens.b.token,
  );
  results.push(`cross_business_get=${crossGet.status}`);

  const patched = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}`,
    tokens.a.token,
    {
      fullName: `CRM Verify Edited ${stamp}`,
      notes: 'edited-notes',
    },
  );
  results.push(`patch=${patched.status}`);
  results.push(`patch_name=${patched.json.data?.fullName === `CRM Verify Edited ${stamp}`}`);

  // Seed booking for snapshot + history tests
  const members = await api('GET', `/api/v1/businesses/${businessA.id}/members`, tokens.a.token);
  const ownerMembership = (members.json.data ?? []).find((m) => m.role === 'owner')?.membershipId;
  let services = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/services?status=active&limit=1`,
    tokens.a.token,
  );
  let serviceId = services.json.data?.items?.[0]?.id;
  if (!serviceId) {
    const createdService = await api(
      'POST',
      `/api/v1/businesses/${businessA.id}/services`,
      tokens.a.token,
      {
        name: `CRM Verify Cut ${stamp}`,
        durationMinutes: 30,
        processingMinutes: 0,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceMinor: 2000,
        currency: businessA.defaultCurrency || 'USD',
        isActive: true,
        isBookableOnline: true,
      },
    );
    serviceId = createdService.json.data?.id;
  }
  if (!ownerMembership || !serviceId) throw new Error('missing staff/service');

  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/locations`,
    tokens.a.token,
    { locationIds: [locationA] },
  );
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/services`,
    tokens.a.token,
    { serviceIds: [serviceId] },
  );

  const timezone = businessA.primaryLocation?.timezone || 'UTC';
  // Isolated from Phase 07 (+9) and Phase 09 (+4) shared-calendar verifies.
  const date = DateTime.now().setZone(timezone).plus({ days: 11 }).toISODate();
  const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
  await api('PUT', `/api/v1/businesses/${businessA.id}/operating-hours`, tokens.a.token, {
    intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
  });
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/locations/${locationA}/operating-hours`,
    tokens.a.token,
    {
      hoursMode: 'custom',
      intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
    },
  );
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/schedules`,
    tokens.a.token,
    {
      effectiveFrom: date,
      intervals: [
        { weekday, locationId: locationA, startMinute: 540, endMinute: 1200, sortOrder: 0 },
      ],
      breaks: [],
    },
  );

  const existing = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/bookings?date=${date}&locationId=${locationA}&staffMembershipId=${ownerMembership}&status=confirmed&limit=100`,
    tokens.a.token,
  );
  for (const booking of existing.json.data ?? []) {
    if (!booking?.id) continue;
    await api(
      'POST',
      `/api/v1/businesses/${businessA.id}/bookings/${booking.id}/cancel`,
      tokens.a.token,
      { reason: 'phase08-verify-cleanup' },
    );
  }

  const slots = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  const firstSlot = slots.json.data?.slots?.[0]?.startsAt;
  if (!firstSlot) throw new Error('no_slots_for_crm_booking');

  const booking = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, {
    locationId: locationA,
    staffMembershipId: ownerMembership,
    serviceId,
    addonIds: [],
    startsAt: firstSlot,
    customerId,
    notes: null,
    idempotencyKey: `crm-book-${stamp}`,
    channel: 'workspace',
  });
  results.push(`booking_create=${booking.status}`);
  const snapshotName = booking.json.data?.customerName;
  const bookingId = booking.json.data?.id;

  const rename = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}`,
    tokens.a.token,
    { fullName: `CRM Snapshot Guard ${stamp}` },
  );
  results.push(`rename_after_booking=${rename.status}`);

  const bookingAfter = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/bookings/${bookingId}`,
    tokens.a.token,
  );
  results.push(
    `snapshot_unchanged=${bookingAfter.json.data?.customerName === snapshotName}`,
  );

  const history = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}/bookings?limit=10&offset=0`,
    tokens.a.token,
  );
  results.push(`history=${history.status}`);
  results.push(
    `history_contains=${(history.json.data?.items ?? []).some((b) => b.id === bookingId)}`,
  );
  results.push(`history_has_meta=${Boolean(history.json.data?.meta)}`);

  const archived = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}/archive`,
    tokens.a.token,
  );
  results.push(`archive=${archived.status}`);
  results.push(`archive_flag=${Boolean(archived.json.data?.archivedAt)}`);

  const archivedAgain = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}/archive`,
    tokens.a.token,
  );
  results.push(`archive_idempotent=${archivedAgain.status === 200}`);

  const activeList = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/customers?status=active&q=CRM%20Snapshot%20Guard%20${stamp}`,
    tokens.a.token,
  );
  results.push(
    `active_excludes_archived=${!(activeList.json.data?.items ?? []).some(
      (c) => c.id === customerId,
    )}`,
  );

  const archivedDetail = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}`,
    tokens.a.token,
  );
  results.push(`archived_detail=${archivedDetail.status}`);

  const slotsAfterArchive = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  const archivedSlot = slotsAfterArchive.json.data?.slots?.[0]?.startsAt;
  if (!archivedSlot) throw new Error('no_slots_for_archived_booking_attempt');
  const archivedBook = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/bookings`,
    tokens.a.token,
    {
      locationId: locationA,
      staffMembershipId: ownerMembership,
      serviceId,
      addonIds: [],
      startsAt: archivedSlot,
      customerId,
      notes: null,
      idempotencyKey: `crm-archived-book-${stamp}`,
      channel: 'workspace',
    },
  );
  results.push(`archived_book_status=${archivedBook.status}`);
  results.push(`archived_book_code=${archivedBook.json.error?.code}`);
  results.push(`archived_book_message=${archivedBook.json.error?.message}`);

  const restored = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}/restore`,
    tokens.a.token,
  );
  results.push(`restore=${restored.status}`);
  results.push(`restore_cleared=${restored.json.data?.archivedAt == null}`);

  const restoredAgain = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/customers/${customerId}/restore`,
    tokens.a.token,
  );
  results.push(`restore_idempotent=${restoredAgain.status === 200}`);

  const slotsAfterRestore = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  const restoredSlot = slotsAfterRestore.json.data?.slots?.[0]?.startsAt;
  if (restoredSlot) {
    const restoredBook = await api(
      'POST',
      `/api/v1/businesses/${businessA.id}/bookings`,
      tokens.a.token,
      {
        locationId: locationA,
        staffMembershipId: ownerMembership,
        serviceId,
        addonIds: [],
        startsAt: restoredSlot,
        customerId,
        notes: null,
        idempotencyKey: `crm-restored-book-${stamp}`,
        channel: 'workspace',
      },
    );
    results.push(`restored_book=${restoredBook.status}`);
  } else {
    results.push('restored_book=skipped_no_slot');
  }

  // Guest booking regression
  const slug = businessA.slug;
  const guestSlots = await api(
    'GET',
    `/api/v1/public/booking/slots?businessSlug=${encodeURIComponent(slug)}&date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
  );
  results.push(`guest_slots=${guestSlots.status}`);
  const guestStart =
    guestSlots.json.data?.slots?.find((s) => s.startsAt !== firstSlot)?.startsAt ??
    guestSlots.json.data?.slots?.[0]?.startsAt;
  if (guestStart) {
    const guestCreate = await api('POST', '/api/v1/public/booking/bookings', null, {
      businessSlug: slug,
      locationId: locationA,
      staffMembershipId: ownerMembership,
      serviceId,
      addonIds: [],
      startsAt: guestStart,
      customer: {
        fullName: `Guest CRM ${stamp}`,
        email: `guest-crm-${stamp}@example.com`,
      },
      notes: null,
      idempotencyKey: `guest-crm-${stamp}`,
    });
    results.push(`guest_create=${guestCreate.status}`);
  } else {
    results.push('guest_create=skipped_no_slot');
  }

  const pass =
    created.status === 201 &&
    listed.status === 200 &&
    listed.json.data?.meta &&
    (listed.json.data?.items ?? []).some((c) => c.id === customerId) &&
    detail.status === 200 &&
    crossGet.status === 404 &&
    patched.status === 200 &&
    booking.status === 201 &&
    bookingAfter.json.data?.customerName === snapshotName &&
    history.status === 200 &&
    (history.json.data?.items ?? []).some((b) => b.id === bookingId) &&
    archived.status === 200 &&
    archivedDetail.status === 200 &&
    archivedBook.status === 422 &&
    archivedBook.json.error?.code === 'CUSTOMER_ARCHIVED' &&
    restored.status === 200 &&
    restored.json.data?.archivedAt == null &&
    (results.includes('restored_book=201') ||
      results.includes('restored_book=200') ||
      results.includes('restored_book=skipped_no_slot')) &&
    (results.includes('guest_create=201') ||
      results.includes('guest_create=200') ||
      results.includes('guest_create=skipped_no_slot'));

  for (const line of results) console.log(line);
  console.log(`api_customers_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('api_customers_pass=false');
  console.log('error=' + String(error.message || error).slice(0, 500));
  for (const line of results) console.log(line);
  process.exitCode = 1;
}
