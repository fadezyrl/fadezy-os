import type { BookingStatus } from './booking';

/** Inclusive local-calendar period in the selected location timezone. */
export interface InsightsPeriod {
  from: string;
  to: string;
  days: number;
  preset: '7d' | '30d';
}

export interface InsightsBookingStatusCounts {
  confirmed: number;
  completed: number;
  cancelled: number;
  no_show: number;
  total: number;
}

export interface InsightsRevenuePoint {
  date: string;
  netCollectedMinor: number;
  saleCount: number;
}

export interface InsightsAgendaItem {
  id: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  customerName: string;
  serviceSummary: string;
  staffMembershipId: string;
}

export interface InsightsTimeOffItem {
  id: string;
  membershipId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

/**
 * Workspace overview payload.
 *
 * Metric definitions (do not reinterpret):
 * - netCollectedMinor: Σ (amount_paid_minor − amount_refunded_minor) for non-voided sales
 *   created in the period (location-local day bounds). Matches POS daily summary semantics.
 * - grossSalesMinor: Σ subtotal_minor for non-voided sales in the period.
 * - refundedMinor: Σ amount_refunded_minor for non-voided sales in the period.
 * - voidedCount: count of voided sales created in the period (excluded from net/gross).
 * - bookingsToday: counts by status for bookings whose starts_at falls on location-local today.
 * - upcomingCount: confirmed bookings with starts_at >= now (same location).
 * - newCustomersCount: customers created in the period (business-wide; not location-scoped).
 */
export interface WorkspaceInsightsOverview {
  businessId: string;
  locationId: string;
  locationName: string;
  timezone: string;
  currency: string;
  period: InsightsPeriod;
  generatedAt: string;
  canViewRevenue: boolean;
  metrics: {
    netCollectedMinor: number | null;
    grossSalesMinor: number | null;
    refundedMinor: number | null;
    voidedCount: number | null;
    saleCount: number | null;
    bookingsToday: InsightsBookingStatusCounts;
    upcomingCount: number;
    newCustomersCount: number;
  };
  revenueSeries: InsightsRevenuePoint[];
  todayAgenda: InsightsAgendaItem[];
  upcoming: InsightsAgendaItem[];
  pendingTimeOff: InsightsTimeOffItem[];
}
