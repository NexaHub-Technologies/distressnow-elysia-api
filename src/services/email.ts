/**
 * Email service (Resend).
 *
 * Covers the email side of the auth/KYC flows from the Laravel reference
 * (OtpMail + notification mails): verification OTPs, password-reset OTPs,
 * KYC decision notices, plus a generic send().
 *
 * Mock mode: when RESEND_API_KEY is missing the message is logged and
 * { mock: true } is returned — never throws, never bills.
 *
 * Env:
 *   RESEND_API_KEY Resend API key (mock mode when missing)
 *   RESEND_FROM    sender, default "DistressNow <no-reply@distressnow.com>"
 */
import { Resend } from 'resend';

export interface EmailOptions {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface EmailResult {
  ok: boolean;
  mock: boolean;
  to: string;
  id?: string;
}

function resendClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

function sender(): string {
  return process.env.RESEND_FROM ?? 'DistressNow <no-reply@distressnow.com>';
}

/** Generic send. Throws only when a key IS configured and Resend rejects the message. */
export async function send(options: EmailOptions): Promise<EmailResult> {
  const client = resendClient();

  if (!client) {
    console.log(`[email:mock] to=${options.to} subject=${options.subject}`);
    return { ok: true, mock: true, to: options.to };
  }

  const { data, error } = await client.emails.send({
    from: sender(),
    to: options.to,
    subject: options.subject,
    html: options.html ?? options.text ?? '',
    text: options.text,
  });

  if (error) {
    throw new Error(`Resend failed: ${error.message}`);
  }

  return { ok: true, mock: false, to: options.to, id: data?.id };
}

/** Account-verification OTP (email_signup). */
export async function sendVerification(
  email: string,
  code: string,
): Promise<EmailResult> {
  return send({
    to: email,
    subject: 'Verify your DistressNow account',
    text: `Your DistressNow verification code is ${code}. It expires in 15 minutes.`,
    html: `<p>Your DistressNow verification code is <strong>${code}</strong>.</p><p>It expires in 15 minutes.</p>`,
  });
}

/** Password-reset OTP (email_reset). */
export async function sendPasswordReset(
  email: string,
  code: string,
): Promise<EmailResult> {
  return send({
    to: email,
    subject: 'Reset your DistressNow password',
    text: `Your DistressNow password reset code is ${code}. It expires in 15 minutes. If you did not request this, ignore this email.`,
    html: `<p>Your DistressNow password reset code is <strong>${code}</strong>.</p><p>It expires in 15 minutes. If you did not request this, ignore this email.</p>`,
  });
}

/** KYC review outcome notice to the applicant. */
export async function sendKycDecision(
  email: string,
  decision: 'approved' | 'rejected',
  reason?: string | null,
): Promise<EmailResult> {
  const approved = decision === 'approved';
  return send({
    to: email,
    subject: approved ? 'Your KYC verification was approved' : 'Your KYC verification needs attention',
    text: approved
      ? 'Good news — your DistressNow identity verification was approved.'
      : `Your DistressNow identity verification was not approved.${reason ? ` Reason: ${reason}` : ''} You can re-submit from the app.`,
    html: approved
      ? '<p>Good news — your DistressNow identity verification was <strong>approved</strong>.</p>'
      : `<p>Your DistressNow identity verification was <strong>not approved</strong>.</p>${reason ? `<p>Reason: ${reason}</p>` : ''}<p>You can re-submit from the app.</p>`,
  });
}
