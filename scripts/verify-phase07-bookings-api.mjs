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
  console.log('api_bookings_pass=false');
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

  const members = await api('GET', `/api/v1/businesses/${businessA.id}/members`, tokens.a.token);
  const ownerMembership = (members.json.data ?? []).find((m) => m.role === 'owner')?.membershipId;
  if (!ownerMembership) throw new Error('missing owner membership');

  let services = await api('GET', `/api/v1/businesses/${businessA.id}/services`, tokens.a.token);
  let serviceId = services.json.data?.items?.[0]?.id;
  if (!serviceId) {
    const createdService = await api('POST', `/api/v1/businesses/${businessA.id}/services`, tokens.a.token, {
      name: `Booking Verify Cut ${Date.now()}`,
      durationMinutes: 30,
      processingMinutes: 0,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 5,
      priceMinor: 2500,
      currency: businessA.defaultCurrency || 'USD',
      isActive: true,
      isBookableOnline: true,
    });
    results.push(`service_create=${createdService.status}`);
    serviceId = createdService.json.data?.id;
  }
  if (!serviceId) throw new Error('missing service');

  // Ensure staff can perform service at location
  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/locations`, tokens.a.token, {
    locationIds: [locationA],
  });
  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/services`, tokens.a.token, {
    serviceIds: [serviceId],
  });

  const timezone = businessA.primaryLocation?.timezone || 'UTC';
  // Farther offset avoids collisions with Phase 08/09 verifies on the shared demo business.
  const date = DateTime.now().setZone(timezone).plus({ days: 9 }).toISODate();

  // Open hours for that weekday so slots exist (force location custom hours for determinism)
  const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
  const hoursBiz = await api('PUT', `/api/v1/businesses/${businessA.id}/operating-hours`, tokens.a.token, {
    intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
  });
  results.push(`hours_biz=${hoursBiz.status}`);
  const hoursLoc = await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/locations/${locationA}/operating-hours`,
    tokens.a.token,
    {
      hoursMode: 'custom',
      intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
    },
  );
  results.push(`hours_loc=${hoursLoc.status}`);
  const staffSched = await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/schedules`,
    tokens.a.token,
    {
      effectiveFrom: date,
      intervals: [{ weekday, locationId: locationA, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
      breaks: [],
    },
  );
  results.push(`staff_sched=${staffSched.status}`);

  // Clear leftover confirmed bookings on the target day so contention slots exist.
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
      { reason: 'phase07-verify-cleanup' },
    );
  }

  const ctx = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/availability/context?date=${date}&locationId=${locationA}&membershipId=${ownerMembership}`,
    tokens.a.token,
  );
  results.push(`avail_open=${ctx.json.data?.locationOpen}`);
  results.push(`avail_windows=${ctx.json.data?.staffAvailableWindows?.length ?? 0}`);

  const slots = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  results.push(`slots_status=${slots.status}`);
  results.push(`slots_count=${slots.json.data?.slots?.length ?? 0}`);
  results.push(`slots_notes=${(slots.json.data?.notes || []).join('|')}`);
  const firstSlot = slots.json.data?.slots?.[0]?.startsAt;
  if (!firstSlot) throw new Error('no_slots_generated');

  const customer = await api('POST', `/api/v1/businesses/${businessA.id}/customers`, tokens.a.token, {
    fullName: 'API Verify Guest',
    email: `api-verify-${Date.now()}@example.com`,
  });
  results.push(`customer_create=${customer.status}`);

  const idem = `idem-${Date.now()}`;
  const createBody = {
    locationId: locationA,
    staffMembershipId: ownerMembership,
    serviceId,
    addonIds: [],
    startsAt: firstSlot,
    customerId: customer.json.data.id,
    notes: null,
    idempotencyKey: idem,
    channel: 'workspace',
  };
  const created = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, createBody);
  results.push(`booking_create=${created.status}`);
  const bookingId = created.json.data?.id;

  const replay = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, createBody);
  results.push(`idempotent_replay=${replay.status}`);
  results.push(`idempotent_same_id=${replay.json.data?.id === bookingId}`);

  const conflictPayload = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, {
    ...createBody,
    notes: 'different',
    idempotencyKey: idem,
  });
  results.push(`idempotent_payload_conflict=${conflictPayload.status}`);

  // Pick a slot whose busy range cannot overlap the first booking (30m + buffers).
  const firstStartMs = Date.parse(firstSlot);
  const contentionSlot =
    slots.json.data.slots.find((slot) => Date.parse(slot.startsAt) >= firstStartMs + 60 * 60 * 1000)
      ?.startsAt ?? null;
  let successCount = 0;
  let conflictCount = 0;
  let parallelWinnerId = null;
  if (contentionSlot) {
    const stamp = Date.now();
    const parallel = await Promise.all(
      [0, 1].map((i) =>
        api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, {
          locationId: locationA,
          staffMembershipId: ownerMembership,
          serviceId,
          addonIds: [],
          startsAt: contentionSlot,
          customerId: customer.json.data.id,
          notes: null,
          idempotencyKey: `parallel-${stamp}-${i}`,
          channel: 'workspace',
        }),
      ),
    );
    successCount = parallel.filter((r) => r.status === 201 || r.status === 200).length;
    // Loser may hit GiST exclusion (409) or the pre-RPC slot recheck (422) depending on timing.
    conflictCount = parallel.filter(
      (r) =>
        (r.status === 409 && r.json.error?.code === 'BOOKING_CONFLICT') ||
        (r.status === 422 &&
          (r.json.error?.code === 'VALIDATION_ERROR' ||
            r.json.error?.code === 'BOOKING_CONFLICT')),
    ).length;
    parallelWinnerId = parallel.find((r) => r.status === 201 || r.status === 200)?.json?.data?.id ?? null;
    results.push(
      `parallel_statuses=${parallel.map((r) => `${r.status}:${r.json.error?.code || 'ok'}`).join(',')}`,
    );
  } else {
    results.push('parallel_statuses=no_contention_slot');
  }
  results.push(`parallel_success=${successCount}`);
  results.push(`parallel_conflict=${conflictCount}`);

  const cross = await api('GET', `/api/v1/businesses/${businessB.id}/bookings`, tokens.a.token);
  results.push(`cross_tenant=${cross.status}`);

  // Concurrent reschedule: two distinct confirmed bookings race to the same new start.
  let rescheduleSuccess = 0;
  let rescheduleConflict = 0;
  const freshSlots = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  const freeStarts = freshSlots.json.data?.slots ?? [];
  const thirdSlot = freeStarts[0]?.startsAt;
  const targetSlot = freeStarts[Math.min(12, freeStarts.length - 1)]?.startsAt;
  if (parallelWinnerId && thirdSlot && targetSlot && thirdSlot !== targetSlot) {
    const third = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, {
      locationId: locationA,
      staffMembershipId: ownerMembership,
      serviceId,
      addonIds: [],
      startsAt: thirdSlot,
      customerId: customer.json.data.id,
      notes: null,
      idempotencyKey: `third-${Date.now()}`,
      channel: 'workspace',
    });
    const thirdId = third.json.data?.id;
    results.push(`reschedule_seed=${third.status}`);
    if (thirdId) {
      const rescheduleParallel = await Promise.all([
        api(
          'POST',
          `/api/v1/businesses/${businessA.id}/bookings/${parallelWinnerId}/reschedule`,
          tokens.a.token,
          { startsAt: targetSlot },
        ),
        api(
          'POST',
          `/api/v1/businesses/${businessA.id}/bookings/${thirdId}/reschedule`,
          tokens.a.token,
          { startsAt: targetSlot },
        ),
      ]);
      rescheduleSuccess = rescheduleParallel.filter((r) => r.status === 200).length;
      rescheduleConflict = rescheduleParallel.filter(
        (r) =>
          (r.status === 409 && r.json.error?.code === 'BOOKING_CONFLICT') ||
          r.status === 422,
      ).length;
      results.push(`reschedule_statuses=${rescheduleParallel.map((r) => r.status).join(',')}`);
    }
  } else {
    results.push(`reschedule_skipped=true`);
  }
  results.push(`reschedule_parallel_success=${rescheduleSuccess}`);
  results.push(`reschedule_parallel_conflict=${rescheduleConflict}`);

  const complete = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/bookings/${bookingId}/complete`,
    tokens.a.token,
  );
  results.push(`complete=${complete.status}`);

  const invalid = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/bookings/${bookingId}/cancel`,
    tokens.a.token,
    {},
  );
  results.push(`invalid_transition=${invalid.status}`);

  const guestSlots = await api(
    'GET',
    `/api/v1/public/booking/slots?businessSlug=${encodeURIComponent(businessA.slug)}&date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
  );
  results.push(`guest_slots=${guestSlots.status}`);

  const passFixed =
    created.status === 201 &&
    (replay.status === 200 || replay.status === 201) &&
    conflictPayload.status === 409 &&
    contentionSlot != null &&
    successCount === 1 &&
    conflictCount >= 1 &&
    (cross.status === 403 || cross.status === 404) &&
    complete.status === 200 &&
    invalid.status === 422;

  console.log(results.join('\n'));
  console.log(`api_bookings_pass=${passFixed}`);
  if (!passFixed) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log('api_bookings_pass=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
}
