import type { BusinessRole } from '../types/business';
import type { TeamPermissions } from '../types/team';

export const INVITATION_TTL_DAYS = 7;

export const TEAM_ACTIONS = [
  'invite_manager',
  'invite_staff',
  'manage_members',
  'assign_locations',
  'assign_services',
  'view_internal_notes',
  'change_roles',
  'suspend_members',
] as const;

export type TeamAction = (typeof TEAM_ACTIONS)[number];

const ROLE_CAPABILITIES: Record<BusinessRole, ReadonlySet<TeamAction>> = {
  owner: new Set(TEAM_ACTIONS),
  manager: new Set([
    'invite_staff',
    'manage_members',
    'assign_locations',
    'assign_services',
    'view_internal_notes',
    'suspend_members',
  ]),
  staff: new Set([]),
};

export function canPerformTeamAction(role: BusinessRole, action: TeamAction): boolean {
  return ROLE_CAPABILITIES[role]?.has(action) ?? false;
}

export function resolveTeamPermissions(role: BusinessRole): TeamPermissions {
  return {
    canInviteManager: canPerformTeamAction(role, 'invite_manager'),
    canInviteStaff: canPerformTeamAction(role, 'invite_staff'),
    canManageMembers: canPerformTeamAction(role, 'manage_members'),
    canAssignLocations: canPerformTeamAction(role, 'assign_locations'),
    canAssignServices: canPerformTeamAction(role, 'assign_services'),
    canViewInternalNotes: canPerformTeamAction(role, 'view_internal_notes'),
    canChangeRoles: canPerformTeamAction(role, 'change_roles'),
    canSuspendMembers: canPerformTeamAction(role, 'suspend_members'),
  };
}
