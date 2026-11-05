import type {
  BusinessInvitation,
  EmploymentType,
  InvitationStatus,
  InvitableRole,
  StaffProfile,
  TeamMemberDetail,
  TeamMemberPublic,
} from '@fadezy/shared';
import type { BusinessRole, MembershipStatus } from '@fadezy/shared';

export function mapInvitation(row: {
  id: string;
  business_id: string;
  email: string;
  role: InvitableRole;
  invited_by: string;
  display_name: string | null;
  status: InvitationStatus;
  expires_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  location_ids: string[] | null;
  created_at: string;
  updated_at: string;
}): BusinessInvitation {
  return {
    id: row.id,
    businessId: row.business_id,
    email: row.email,
    role: row.role,
    invitedByUserId: row.invited_by,
    displayName: row.display_name,
    status: row.status,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    cancelledAt: row.cancelled_at,
    locationIds: row.location_ids ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStaffProfile(
  row: {
    id: string;
    business_id: string;
    membership_id: string;
    user_id: string;
    display_name: string;
    email: string | null;
    image_url: string | null;
    phone: string | null;
    job_title: string | null;
    employment_type: EmploymentType | null;
    bio: string | null;
    start_date: string | null;
    internal_notes: string | null;
    created_at: string;
    updated_at: string;
  },
  includeNotes: boolean,
): StaffProfile {
  return {
    id: row.id,
    businessId: row.business_id,
    membershipId: row.membership_id,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    imageUrl: row.image_url,
    phone: row.phone,
    jobTitle: row.job_title,
    employmentType: row.employment_type,
    bio: row.bio,
    startDate: row.start_date,
    ...(includeNotes ? { internalNotes: row.internal_notes } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTeamMemberPublic(input: {
  membershipId: string;
  businessId: string;
  userId: string;
  role: BusinessRole;
  membershipStatus: MembershipStatus;
  deactivatedAt: string | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  email: string | null;
  displayName: string;
  imageUrl: string | null;
  jobTitle: string | null;
  locationIds: string[];
  serviceIds: string[];
  createdAt: string;
  updatedAt: string;
}): TeamMemberPublic {
  return { ...input };
}

export function mapTeamMemberDetail(
  publicMember: TeamMemberPublic,
  extra: {
    phone: string | null;
    employmentType: EmploymentType | null;
    bio: string | null;
    startDate: string | null;
    internalNotes: string | null;
    staffProfileId: string | null;
  },
): TeamMemberDetail {
  return { ...publicMember, ...extra };
}
