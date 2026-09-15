/**
 * Nigerian phone number normalization.
 *
 * Port of App\Support\PhoneNumber::normalize() from the Laravel reference.
 * Matches the normalizeAuthPhone() utility in the Expo app.
 *
 * Normalizes to international format (+234XXXXXXXXXX):
 *  - strips every non-digit first (which removes a leading '+'),
 *    then re-adds it, so an already-normalized number round-trips unchanged
 *  - Nigerian local format 08012345678 -> +2348012345678
 */
export function normalizePhone(input: string): string {
  let digits = input.replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('0')) {
    digits = '234' + digits.slice(1);
  }

  return '+' + digits;
}

/** Loose check that a login identifier is an email address. */
export function isEmailIdentifier(value: string): boolean {
  return value.includes('@');
}

/** Normalize an email for storage/lookup (lowercase + trim). */
export function normalizeEmail(input: string): string {
  return input.toLowerCase().trim();
}

/**
 * Generate a 6-digit numeric OTP code (100000-999999).
 * Uses the Web Crypto API so codes are unpredictable.
 */
export function generateOtpCode(): string {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  const n = (buf[0] as number) % 900000;
  return String(100000 + n);
}

/** Prefix-scoped unique id for the in-memory dev stores (real DB ids come later). */
export function newId(prefix: string): string {
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** Current timestamp as an ISO string. */
export function nowIso(): string {
  return new Date().toISOString();
}
