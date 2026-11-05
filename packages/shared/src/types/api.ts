/**
 * Canonical API envelope used by web, mobile, and future clients.
 * Controllers should always return one of these shapes.
 */

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface HealthStatusData {
  status: 'ok';
  service: string;
  version: string;
  timestamp: string;
}

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReadinessStatusData {
  status: 'ready' | 'not_ready';
  service: string;
  version: string;
  timestamp: string;
  checks: ReadinessCheck[];
}
