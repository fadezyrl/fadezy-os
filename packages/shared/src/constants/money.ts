/**
 * ISO 4217 minor-unit exponents.
 * Most currencies use 2. Zero-decimal and three-decimal currencies are explicit.
 * Unknown codes default to 2 — never assume every currency has two decimals at display time
 * without consulting this map (or extending it).
 */
export const CURRENCY_MINOR_UNIT_DIGITS: Record<string, number> = {
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

export const DEFAULT_CURRENCY_MINOR_DIGITS = 2;

export function currencyMinorDigits(currencyCode: string): number {
  const code = currencyCode.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_UNIT_DIGITS, code)) {
    return CURRENCY_MINOR_UNIT_DIGITS[code]!;
  }
  return DEFAULT_CURRENCY_MINOR_DIGITS;
}

export function formatMoneyMinor(amountMinor: number, currencyCode: string): string {
  const digits = currencyMinorDigits(currencyCode);
  const negative = amountMinor < 0;
  const abs = Math.abs(Math.trunc(amountMinor));
  const asString = String(abs);
  const padded = asString.padStart(digits + 1, '0');
  const whole = digits === 0 ? padded : padded.slice(0, -digits) || '0';
  const fraction = digits === 0 ? '' : padded.slice(-digits);
  const formatted = digits === 0 ? whole : `${whole}.${fraction}`;
  return `${negative ? '-' : ''}${formatted} ${currencyCode.trim().toUpperCase()}`;
}
