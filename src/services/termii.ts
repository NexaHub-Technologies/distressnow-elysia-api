/**
 * Termii SMS service + OTP lifecycle.
 *
 * Port of App\Services\TermiiService from the Laravel reference:
 *  - sendOtp(phone, code) delivers an SMS via the Termii API
 *  - the OTP lifecycle (issue / verify, 6-digit, 10-min expiry, hashed
 *    storage, max 5 attempts) lives here, mirroring OtpCode + TermiiService
 *
 * Transport is deliberately separated from storage: MemoryOtpStore.issue()
 * returns the plain code and the caller (auth module) hands it to sendOtp()
 * for SMS or to the email service for email OTPs.
 *
 * Mock mode: when TERMII_API_KEY is missing the SMS is logged and
 * { mock: true } is returned — never throws, never bills.
 *
 * Env:
 *   TERMII_API_KEY   Termii API key (mock mode when missing)
 *   TERMII_SENDER_ID sender id, default "DistressNow"
 *   TERMII_BASE_URL  default https://api.ng.termii.com
 */
import { generateOtpCode, normalizePhone } from '../utils/phone';

export const TERMII_BASE_URL = 'https://api.ng.termii.com';
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export type OtpType =
  | 'phone_signup'
  | 'phone_reset'
  | 'email_signup'
  | 'email_reset';

export interface SendResult {
  ok: boolean;
  mock: boolean;
  to: string;
  providerId?: string;
}

function termiiConfig(): { apiKey: string; senderId: string; baseUrl: string } {
  return {
    apiKey: process.env.TERMII_API_KEY ?? '',
    senderId: process.env.TERMII_SENDER_ID ?? 'DistressNow',
    baseUrl: (process.env.TERMII_BASE_URL ?? TERMII_BASE_URL).replace(/\/+$/, ''),
  };
}

/**
 * Hash an OTP code for storage (SHA-256 hex).
 * Plain codes are never persisted — only the hash is kept.
 */
export function hashOtp(code: string): string {
  return new Bun.CryptoHasher('sha256').update(code).digest('hex');
}

/**
 * Send a verification code to a phone number via Termii.
 * Never throws for transport config issues in mock mode; throws on a
 * non-2xx Termii response when a key IS configured.
 */
export async function sendOtp(phone: string, code: string): Promise<SendResult> {
  const to = normalizePhone(phone);
  const message = `Your DistressNow verification code is ${code}. It expires in 10 minutes.`;
  return sendSms(to, message);
}

/** Send an arbitrary SMS. Returns { mock: true } instead of sending when no API key is configured. */
export async function sendSms(phone: string, message: string): Promise<SendResult> {
  const to = normalizePhone(phone);
  const { apiKey, senderId, baseUrl } = termiiConfig();

  if (!apiKey) {
    console.log(`[termii:mock] SMS to ${to}: ${message}`);
    return { ok: true, mock: true, to };
  }

  const res = await fetch(`${baseUrl}/api/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      to,
      from: senderId,
      sms: message,
      type: 'plain',
      channel: 'generic',
    }),
  });

  if (!res.ok) {
    throw new Error(`Termii SMS request failed with status ${res.status}`);
  }

  let providerId: string | undefined;
  try {
    const raw = (await res.json()) as { message_id?: string };
    providerId = raw.message_id;
  } catch {
    providerId = undefined;
  }

  return { ok: true, mock: false, to, providerId };
}

// ── OTP lifecycle (hashed in-memory store; drizzle table comes later) ────────

export type OtpFailure = 'NOT_FOUND' | 'EXPIRED' | 'LOCKED' | 'INVALID';

export class OtpError extends Error {
  readonly failure: OtpFailure;
  readonly attemptsRemaining: number;

  constructor(failure: OtpFailure, message: string, attemptsRemaining = 0) {
    super(message);
    this.name = 'OtpError';
    this.failure = failure;
    this.attemptsRemaining = attemptsRemaining;
  }
}

interface OtpRecord {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

export interface OtpStoreOptions {
  ttlMs?: number;
  maxAttempts?: number;
}

export class MemoryOtpStore {
  private records = new Map<string, OtpRecord>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(options: OtpStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? OTP_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? OTP_MAX_ATTEMPTS;
  }

  private key(identifier: string, type: OtpType): string {
    return `${type}:${identifier}`;
  }

  /** Issue a code, invalidating any previous unused code for this identifier + type. */
  async issue(
    identifier: string,
    type: OtpType,
  ): Promise<{ code: string; expiresAt: number }> {
    const code = generateOtpCode();
    this.records.set(this.key(identifier, type), {
      codeHash: hashOtp(code),
      expiresAt: Date.now() + this.ttlMs,
      attempts: 0,
    });
    return { code, expiresAt: Date.now() + this.ttlMs };
  }

  /**
   * Verify a code. Marks it used (single-use) on success.
   * @throws OtpError with failure NOT_FOUND | EXPIRED | LOCKED | INVALID
   */
  async verify(
    identifier: string,
    code: string,
    type: OtpType,
    now: number = Date.now(),
  ): Promise<void> {
    const k = this.key(identifier, type);
    const record = this.records.get(k);

    if (!record) {
      throw new OtpError('NOT_FOUND', 'No OTP found. Please request a new one.');
    }

    if (record.expiresAt <= now) {
      this.records.delete(k);
      throw new OtpError('EXPIRED', 'OTP has expired. Please request a new one.');
    }

    if (record.attempts >= this.maxAttempts) {
      throw new OtpError(
        'LOCKED',
        'Too many incorrect attempts. Please request a new OTP.',
      );
    }

    if (record.codeHash !== hashOtp(code)) {
      record.attempts += 1;
      const remaining = this.maxAttempts - record.attempts;
      throw new OtpError(
        'INVALID',
        `Invalid OTP. ${remaining} attempt(s) remaining.`,
        remaining,
      );
    }

    // Single-use: consume on success.
    this.records.delete(k);
  }

  /** Test/dev helper: drop all stored codes. */
  clear(): void {
    this.records.clear();
  }
}

/** Default singleton used by the auth module (override via plugin options in tests). */
export const otpStore = new MemoryOtpStore();
