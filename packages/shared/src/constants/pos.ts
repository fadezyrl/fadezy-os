import type { BusinessRole } from '../types/business';
import type { PosPermissions } from '../types/pos';

export const POS_ACTIONS = [
  'create_sales',
  'manage_all_location_pos',
  'manage_assigned_location_pos',
  'apply_discount',
  'create_custom_lines',
  'record_payments',
  'refund',
  'void_sale',
  'edit_open_sale',
  'manage_tax_settings',
  'open_close_register',
  'adjust_cash',
  'view_reports',
] as const;

export type PosAction = (typeof POS_ACTIONS)[number];

const ROLE_CAPABILITIES: Record<BusinessRole, ReadonlySet<PosAction>> = {
  owner: new Set(POS_ACTIONS),
  manager: new Set(POS_ACTIONS),
  staff: new Set([
    'create_sales',
    'manage_assigned_location_pos',
    'record_payments',
    'view_reports',
  ]),
};

export function canPerformPosAction(role: BusinessRole, action: PosAction): boolean {
  return ROLE_CAPABILITIES[role]?.has(action) ?? false;
}

export function resolvePosPermissions(role: BusinessRole): PosPermissions {
  return {
    canCreateSales: canPerformPosAction(role, 'create_sales'),
    canManageAllLocations: canPerformPosAction(role, 'manage_all_location_pos'),
    canManageAssignedLocations: canPerformPosAction(role, 'manage_assigned_location_pos'),
    canApplyDiscount: canPerformPosAction(role, 'apply_discount'),
    canCreateCustomLines: canPerformPosAction(role, 'create_custom_lines'),
    canRecordPayments: canPerformPosAction(role, 'record_payments'),
    canRefund: canPerformPosAction(role, 'refund'),
    canVoid: canPerformPosAction(role, 'void_sale'),
    canEditOpenSale: canPerformPosAction(role, 'edit_open_sale'),
    canManageTaxSettings: canPerformPosAction(role, 'manage_tax_settings'),
    canOpenCloseRegister: canPerformPosAction(role, 'open_close_register'),
    canAdjustCash: canPerformPosAction(role, 'adjust_cash'),
    canViewReports: canPerformPosAction(role, 'view_reports'),
  };
}
