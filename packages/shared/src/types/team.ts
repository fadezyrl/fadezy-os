import type { BusinessRole, MembershipStatus } from './business';

export const INVITATION_STATUSES = ['pending', 'accepted', 'cancelled', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor', 'other'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Invite roles: never owner via invitation. */
export const INVITABLE_ROLES = ['manager', 'staff'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export interface StaffProfile {
  id: string;
  businessId: string;
  membershipId: string;
  userId: string;
  displayName: string;
  /** Denormalized from Auth at accept/sync — not a second login identity. */
  email: string | null;
  imageUrl: string | null;
  phone: string | null;
  jobTitle: string | null;
  employmentType: EmploymentType | null;
  bio: string | null;
  startDate: string | null;
  /** Owner/manager only — omitted for staff directory views. */
  internalNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemberPublic {
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
}

export interface TeamMemberDetail extends TeamMemberPublic {
  phone: string | null;
  employmentType: EmploymentType | null;
  bio: string | null;
  startDate: string | null;
  internalNotes: string | null;
  staffProfileId: string | null;
}

export interface BusinessInvitation {
  id: string;
  businessId: string;
  email: string;
  role: InvitableRole;
  invitedByUserId: string;
  displayName: string | null;
  status: InvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  cancelledAt: string | null;
  locationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamPermissions {
  canInviteManager: boolean;
  canInviteStaff: boolean;
  canManageMembers: boolean;
  canAssignLocations: boolean;
  canAssignServices: boolean;
  canViewInternalNotes: boolean;
  canChangeRoles: boolean;
  canSuspendMembers: boolean;
}
