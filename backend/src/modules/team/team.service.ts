import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AcceptInvitationInput,
  BusinessInvitation,
  BusinessRole,
  CreateInvitationInput,
  SetMemberLocationsInput,
  SetMemberServicesInput,
  TeamListQuery,
  TeamMemberDetail,
  TeamMemberPublic,
  TeamPermissions,
  UpdateMemberRoleInput,
  UpdateMemberStatusInput,
  UpdateStaffProfileInput,
} from '@fadezy/shared';
import { resolveTeamPermissions } from '@fadezy/shared';
import { EmailDeliveryError, sendInvitationEmail } from '../../services/email';
import { mapInvitation, mapTeamMemberDetail, mapTeamMemberPublic } from './team.mappers';

export class TeamServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

function mapDbError(error: { message?: string; code?: string } | null): never {
  const message = error?.message ?? 'Database operation failed';
  const lower = message.toLowerCase();

  if (lower.includes('already_member') || error?.code === '23505') {
    throw new TeamServiceError('User is already a member of this business', 'CONFLICT', 409);
  }
  if (lower.includes('manager_invite_staff_only')) {
    throw new TeamServiceError('Managers may only invite staff', 'FORBIDDEN', 403);
  }
  if (lower.includes('last_owner_protected')) {
    throw new TeamServiceError('Cannot modify the last active owner', 'FORBIDDEN', 403);
  }
  if (lower.includes('email_mismatch')) {
    throw new TeamServiceError('Signed-in email does not match the invitation', 'FORBIDDEN', 403);
  }
  if (lower.includes('email_not_verified')) {
    throw new TeamServiceError('Verify your email before accepting an invitation', 'FORBIDDEN', 403);
  }
  if (lower.includes('invite_expired')) {
    throw new TeamServiceError('Invitation has expired', 'VALIDATION_ERROR', 422);
  }
  if (lower.includes('invite_not_pending') || lower.includes('invite_already_used')) {
    throw new TeamServiceError('Invitation is no longer valid', 'CONFLICT', 409);
  }
  if (lower.includes('invite_not_found') || lower.includes('member_not_found')) {
    throw new TeamServiceError('Resource not found', 'NOT_FOUND', 404);
  }
  if (lower.includes('cannot_modify_self_status')) {
    throw new TeamServiceError('You cannot change your own membership status', 'FORBIDDEN', 403);
  }
  if (
    error?.code === '42501' ||
    error?.code === 'PGRST301' ||
    lower.includes('forbidden') ||
    lower.includes('row-level security') ||
    lower.includes('permission denied')
  ) {
    throw new TeamServiceError('Not permitted for this business team', 'FORBIDDEN', 403);
  }

  throw new TeamServiceError('Unable to complete team operation', 'INTERNAL_ERROR', 500);
}

async function getCallerMembership(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<{ role: BusinessRole; membershipId: string }> {
  const { data, error } = await client
    .from('business_members')
    .select('id, role, membership_status, deactivated_at')
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) mapDbError(error);
  if (!data || data.membership_status !== 'active' || data.deactivated_at) {
    throw new TeamServiceError('Business not found or not permitted', 'NOT_FOUND', 404);
  }
  return { role: data.role as BusinessRole, membershipId: data.id };
}

export async function getMyTeamPermissions(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<TeamPermissions> {
  const caller = await getCallerMembership(client, businessId, userId);
  return resolveTeamPermissions(caller.role);
}

async function loadAssignments(
  client: SupabaseClient,
  businessId: string,
  membershipIds: string[],
) {
  const locationMap = new Map<string, string[]>();
  const serviceMap = new Map<string, string[]>();
  if (!membershipIds.length) return { locationMap, serviceMap };

  const [{ data: locs }, { data: svcs }] = await Promise.all([
    client
      .from('staff_location_assignments')
      .select('membership_id, location_id')
      .eq('business_id', businessId)
      .in('membership_id', membershipIds),
    client
      .from('staff_service_assignments')
      .select('membership_id, service_id')
      .eq('business_id', businessId)
      .in('membership_id', membershipIds),
  ]);

  for (const row of locs ?? []) {
    const list = locationMap.get(row.membership_id) ?? [];
    list.push(row.location_id);
    locationMap.set(row.membership_id, list);
  }
  for (const row of svcs ?? []) {
    const list = serviceMap.get(row.membership_id) ?? [];
    list.push(row.service_id);
    serviceMap.set(row.membership_id, list);
  }
  return { locationMap, serviceMap };
}

export async function listTeamMembers(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  query: TeamListQuery,
): Promise<TeamMemberPublic[]> {
  const caller = await getCallerMembership(client, businessId, userId);
  const canSeePrivate = resolveTeamPermissions(caller.role).canViewInternalNotes;

  let memberQuery = client
    .from('business_members')
    .select('*')
    .eq('business_id', businessId)
    .is('deactivated_at', null)
    .order('created_at', { ascending: true });

  if (query.status === 'active') {
    memberQuery = memberQuery.eq('membership_status', 'active');
  } else if (query.status === 'suspended') {
    memberQuery = memberQuery.eq('membership_status', 'suspended');
  } else if (!canSeePrivate) {
    memberQuery = memberQuery.eq('membership_status', 'active');
  }

  if (query.role) {
    memberQuery = memberQuery.eq('role', query.role);
  }

  const { data: members, error } = await memberQuery;
  if (error) mapDbError(error);

  const membershipIds = (members ?? []).map((m) => m.id);
  const { data: profiles, error: profileError } = await client
    .from('staff_profiles')
    .select('*')
    .eq('business_id', businessId)
    .in('membership_id', membershipIds.length ? membershipIds : ['00000000-0000-0000-0000-000000000000']);
  if (profileError) mapDbError(profileError);

  const profileByMembership = new Map((profiles ?? []).map((p) => [p.membership_id, p]));
  const { locationMap, serviceMap } = await loadAssignments(client, businessId, membershipIds);

  let results = (members ?? []).map((member) => {
    const profile = profileByMembership.get(member.id);
    return mapTeamMemberPublic({
      membershipId: member.id,
      businessId: member.business_id,
      userId: member.user_id,
      role: member.role,
      membershipStatus: member.membership_status,
      deactivatedAt: member.deactivated_at,
      invitedAt: member.invited_at,
      acceptedAt: member.accepted_at,
      email: canSeePrivate || member.user_id === userId ? (profile?.email ?? null) : null,
      displayName: profile?.display_name ?? 'Team member',
      imageUrl: profile?.image_url ?? null,
      jobTitle: profile?.job_title ?? null,
      locationIds: locationMap.get(member.id) ?? [],
      serviceIds: serviceMap.get(member.id) ?? [],
      createdAt: member.created_at,
      updatedAt: member.updated_at,
    });
  });

  if (query.locationId) {
    results = results.filter((item) => item.locationIds.includes(query.locationId!));
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    results = results.filter(
      (item) =>
        item.displayName.toLowerCase().includes(q) ||
        (item.email ?? '').toLowerCase().includes(q) ||
        (item.jobTitle ?? '').toLowerCase().includes(q),
    );
  }

  return results;
}

export async function getTeamMember(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
): Promise<TeamMemberDetail> {
  const caller = await getCallerMembership(client, businessId, userId);
  const canSeePrivate = resolveTeamPermissions(caller.role).canViewInternalNotes;

  const { data: member, error } = await client
    .from('business_members')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', membershipId)
    .maybeSingle();
  if (error) mapDbError(error);
  if (!member || (member.deactivated_at && !canSeePrivate)) {
    throw new TeamServiceError('Member not found', 'NOT_FOUND', 404);
  }

  const { data: profile } = await client
    .from('staff_profiles')
    .select('*')
    .eq('membership_id', membershipId)
    .maybeSingle();

  const { locationMap, serviceMap } = await loadAssignments(client, businessId, [membershipId]);
  const isSelf = member.user_id === userId;

  const publicMember = mapTeamMemberPublic({
    membershipId: member.id,
    businessId: member.business_id,
    userId: member.user_id,
    role: member.role,
    membershipStatus: member.membership_status,
    deactivatedAt: member.deactivated_at,
    invitedAt: member.invited_at,
    acceptedAt: member.accepted_at,
    email: canSeePrivate || isSelf ? (profile?.email ?? null) : null,
    displayName: profile?.display_name ?? 'Team member',
    imageUrl: profile?.image_url ?? null,
    jobTitle: profile?.job_title ?? null,
    locationIds: locationMap.get(member.id) ?? [],
    serviceIds: serviceMap.get(member.id) ?? [],
    createdAt: member.created_at,
    updatedAt: member.updated_at,
  });

  return mapTeamMemberDetail(publicMember, {
    phone: canSeePrivate || isSelf ? (profile?.phone ?? null) : null,
    employmentType: profile?.employment_type ?? null,
    bio: profile?.bio ?? null,
    startDate: profile?.start_date ?? null,
    internalNotes: canSeePrivate ? (profile?.internal_notes ?? null) : null,
    staffProfileId: profile?.id ?? null,
  });
}

export async function createInvitation(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: CreateInvitationInput,
  meta: { businessName: string; inviterLabel: string },
): Promise<{
  invitation: BusinessInvitation;
  emailSent: boolean;
  emailSkipped: boolean;
  emailError: string | null;
}> {
  const caller = await getCallerMembership(client, businessId, userId);
  const permissions = resolveTeamPermissions(caller.role);

  if (input.role === 'manager' && !permissions.canInviteManager) {
    throw new TeamServiceError('Only owners can invite managers', 'FORBIDDEN', 403);
  }
  if (input.role === 'staff' && !permissions.canInviteStaff) {
    throw new TeamServiceError('Not permitted to invite staff', 'FORBIDDEN', 403);
  }

  const token = generateInviteToken();
  const tokenHash = hashToken(token);

  const { data, error } = await client.rpc('create_business_invitation', {
    payload: {
      business_id: businessId,
      email: input.email,
      role: input.role,
      display_name: input.displayName ?? null,
      token_hash: tokenHash,
      location_ids: input.locationIds ?? [],
    },
  });

  if (error) mapDbError(error);

  const invitation = mapInvitation(data);

  let emailSent = false;
  let emailSkipped = false;
  let emailError: string | null = null;
  try {
    const result = await sendInvitationEmail({
      to: invitation.email,
      businessName: meta.businessName,
      inviterLabel: meta.inviterLabel,
      role: invitation.role,
      acceptToken: token,
    });
    emailSent = result.sent;
    emailSkipped = Boolean(result.skipped);
  } catch (error) {
    // Invitation row already exists — do not fail the create as 500.
    emailError =
      error instanceof EmailDeliveryError
        ? error.message
        : 'Invitation created but email delivery failed. You can resend later.';
  }

  return { invitation, emailSent, emailSkipped, emailError };
}

export async function listInvitations(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<BusinessInvitation[]> {
  const caller = await getCallerMembership(client, businessId, userId);
  if (!resolveTeamPermissions(caller.role).canInviteStaff) {
    throw new TeamServiceError('Not permitted to view invitations', 'FORBIDDEN', 403);
  }

  const { data, error } = await client
    .from('business_invitations')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  if (error) mapDbError(error);
  return (data ?? []).map(mapInvitation);
}

export async function cancelInvitation(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  invitationId: string,
): Promise<BusinessInvitation> {
  await getCallerMembership(client, businessId, userId);
  const { data, error } = await client.rpc('cancel_business_invitation', {
    p_invitation_id: invitationId,
  });
  if (error) mapDbError(error);
  const invitation = mapInvitation(data);
  if (invitation.businessId !== businessId) {
    throw new TeamServiceError('Invitation not found', 'NOT_FOUND', 404);
  }
  return invitation;
}

export async function resendInvitation(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  invitationId: string,
  meta: { businessName: string; inviterLabel: string },
): Promise<{
  invitation: BusinessInvitation;
  emailSent: boolean;
  emailSkipped: boolean;
  emailError: string | null;
}> {
  const existing = await listInvitations(client, businessId, userId);
  const current = existing.find((item) => item.id === invitationId);
  if (!current || current.status !== 'pending') {
    throw new TeamServiceError('Pending invitation not found', 'NOT_FOUND', 404);
  }

  await cancelInvitation(client, businessId, userId, invitationId);
  return createInvitation(
    client,
    businessId,
    userId,
    {
      email: current.email,
      role: current.role,
      displayName: current.displayName,
      locationIds: current.locationIds,
    },
    meta,
  );
}

export async function acceptInvitation(
  client: SupabaseClient,
  input: AcceptInvitationInput,
): Promise<{ businessId: string; membershipId: string; idempotentReplay: boolean }> {
  const tokenHash = hashToken(input.token);
  const { data, error } = await client.rpc('accept_business_invitation', {
    p_token_hash: tokenHash,
  });
  if (error) mapDbError(error);

  return {
    businessId: data.membership.business_id,
    membershipId: data.membership.id,
    idempotentReplay: Boolean(data.idempotent_replay),
  };
}

export async function updateStaffProfile(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
  input: UpdateStaffProfileInput,
): Promise<TeamMemberDetail> {
  const caller = await getCallerMembership(client, businessId, userId);
  const canManage = resolveTeamPermissions(caller.role).canManageMembers;

  const { data: member } = await client
    .from('business_members')
    .select('*')
    .eq('id', membershipId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (!member) throw new TeamServiceError('Member not found', 'NOT_FOUND', 404);

  const isSelf = member.user_id === userId;
  if (!canManage && !isSelf) {
    throw new TeamServiceError('Not permitted to update this profile', 'FORBIDDEN', 403);
  }

  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.imageUrl !== undefined) patch.image_url = input.imageUrl;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.jobTitle !== undefined) patch.job_title = input.jobTitle;
  if (input.employmentType !== undefined) patch.employment_type = input.employmentType;
  if (input.bio !== undefined) patch.bio = input.bio;
  if (input.startDate !== undefined) patch.start_date = input.startDate;
  if (input.internalNotes !== undefined) {
    if (!resolveTeamPermissions(caller.role).canViewInternalNotes) {
      throw new TeamServiceError('Not permitted to edit internal notes', 'FORBIDDEN', 403);
    }
    patch.internal_notes = input.internalNotes;
  }

  const { data: existing } = await client
    .from('staff_profiles')
    .select('id')
    .eq('membership_id', membershipId)
    .maybeSingle();

  if (!existing) {
    const { error } = await client.from('staff_profiles').insert({
      business_id: businessId,
      membership_id: membershipId,
      user_id: member.user_id,
      display_name: input.displayName ?? 'Team member',
      ...patch,
    });
    if (error) mapDbError(error);
  } else if (Object.keys(patch).length) {
    const { error } = await client.from('staff_profiles').update(patch).eq('id', existing.id);
    if (error) mapDbError(error);
  }

  return getTeamMember(client, businessId, userId, membershipId);
}

export async function updateMemberRole(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
  input: UpdateMemberRoleInput,
): Promise<TeamMemberDetail> {
  const caller = await getCallerMembership(client, businessId, userId);
  if (!resolveTeamPermissions(caller.role).canChangeRoles) {
    throw new TeamServiceError('Only owners can change roles', 'FORBIDDEN', 403);
  }

  const { error } = await client.rpc('update_business_member_role', {
    p_membership_id: membershipId,
    p_role: input.role,
  });
  if (error) mapDbError(error);
  return getTeamMember(client, businessId, userId, membershipId);
}

export async function updateMemberStatus(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
  input: UpdateMemberStatusInput,
): Promise<TeamMemberDetail> {
  const caller = await getCallerMembership(client, businessId, userId);
  if (!resolveTeamPermissions(caller.role).canSuspendMembers) {
    throw new TeamServiceError('Not permitted to change membership status', 'FORBIDDEN', 403);
  }

  const { error } = await client.rpc('update_business_member_status', {
    p_membership_id: membershipId,
    p_action: input.action,
  });
  if (error) mapDbError(error);
  return getTeamMember(client, businessId, userId, membershipId);
}

export async function setMemberLocations(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
  input: SetMemberLocationsInput,
): Promise<TeamMemberDetail> {
  const caller = await getCallerMembership(client, businessId, userId);
  if (!resolveTeamPermissions(caller.role).canAssignLocations) {
    throw new TeamServiceError('Not permitted to assign locations', 'FORBIDDEN', 403);
  }

  const { error } = await client.rpc('set_staff_locations', {
    p_membership_id: membershipId,
    p_location_ids: input.locationIds,
  });
  if (error) mapDbError(error);
  return getTeamMember(client, businessId, userId, membershipId);
}

export async function setMemberServices(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
  input: SetMemberServicesInput,
): Promise<TeamMemberDetail> {
  const caller = await getCallerMembership(client, businessId, userId);
  if (!resolveTeamPermissions(caller.role).canAssignServices) {
    throw new TeamServiceError('Not permitted to assign services', 'FORBIDDEN', 403);
  }

  const { error } = await client.rpc('set_staff_services', {
    p_membership_id: membershipId,
    p_service_ids: input.serviceIds,
  });
  if (error) mapDbError(error);
  return getTeamMember(client, businessId, userId, membershipId);
}
