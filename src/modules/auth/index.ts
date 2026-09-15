/**
 * Auth module — Elysia plugin, prefix /api/v1/auth.
 *
 * Port of the Laravel reference:
 *   RegisterController, LoginController, OtpController, SocialController,
 *   PasswordResetController, AuthController (me/update/logout).
 *
 * All responses use the envelope { success, message, data }.
 *
 * Persistence: stores implement small interfaces (UserStore / OtpStore below).
 * The default plugins resolve DB-backed stores via getDbStores()
 * (src/db/stores.ts) whenever DATABASE_URL is reachable and fall back to the
 * in-memory singletons otherwise (one warning is logged on connect failure).
 * Tests pass explicit in-memory stores through the plugin options, so route
 * code never changes.
 *
 * JWT: @elysiajs/jwt, secret from JWT_SECRET env. Logout revokes the bearer
 * token in-memory (revokedTokens); use a denylist table once persistent.
 */
import { Elysia, t, type AnyElysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { getDbStores } from '../../db/stores';
import { isEmailIdentifier, newId, normalizeEmail, normalizePhone, nowIso } from '../../utils/phone';
import {
  otpStore as defaultOtpStore,
  sendOtp as sendPhoneOtp,
  OtpError,
  type OtpType,
} from '../../services/termii';
import {
  sendPasswordReset as sendPasswordResetEmail,
  sendVerification as sendVerificationEmail,
} from '../../services/email';

// ── Envelope ─────────────────────────────────────────────────────────────────

export function ok<T>(message: string, data: T): {
  success: true;
  message: string;
  data: T;
  errors: null;
} {
  return { success: true, message, data, errors: null };
}

export function fail(message: string): {
  success: false;
  message: string;
  data: null;
  errors: null;
} {
  return { success: false, message, data: null, errors: null };
}

// ── User types + store ───────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** bcrypt hash; null for password-less (social/phone-OTP) accounts until set. */
  passwordHash: string | null;
  auth_provider: string;
  provider_id: string | null;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  is_suspended: boolean;
  roles: string[];
  whatsapp_number: string | null;
  location_state: string | null;
  location_sublocation: string | null;
  interests: string[] | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export type PublicUser = Omit<AuthUser, 'passwordHash' | 'provider_id'>;

export function toPublicUser(user: AuthUser): PublicUser {
  const { passwordHash: _passwordHash, provider_id: _providerId, ...rest } = user;
  return rest;
}

export interface CreateUserInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  passwordHash?: string | null;
  auth_provider?: string;
  provider_id?: string | null;
}

export interface UserStore {
  findById(id: string): Promise<AuthUser | null>;
  findByEmail(email: string): Promise<AuthUser | null>;
  findByPhone(phone: string): Promise<AuthUser | null>;
  findByProvider(provider: string, providerId: string): Promise<AuthUser | null>;
  create(input: CreateUserInput): Promise<AuthUser>;
  update(id: string, patch: Partial<AuthUser>): Promise<AuthUser | null>;
}

/**
 * OTP lifecycle, abstracted so a Postgres-backed implementation
 * (src/db/stores.ts) can sit behind the same surface as MemoryOtpStore.
 */
export interface OtpStore {
  /** Issue a code, invalidating any previous unused code for identifier + type. */
  issue(
    identifier: string,
    type: OtpType,
  ): Promise<{ code: string; expiresAt: number }>;
  /** Single-use verify; @throws OtpError NOT_FOUND | EXPIRED | LOCKED | INVALID */
  verify(
    identifier: string,
    code: string,
    type: OtpType,
    now?: number,
  ): Promise<void>;
  /** Test/dev helper: drop all stored codes. */
  clear(): void;
}

export class MemoryUserStore implements UserStore {
  private users = new Map<string, AuthUser>();

  async findById(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<AuthUser | null> {
    const target = normalizeEmail(email);
    for (const user of this.users.values()) {
      if (user.email && normalizeEmail(user.email) === target) return user;
    }
    return null;
  }

  async findByPhone(phone: string): Promise<AuthUser | null> {
    const target = normalizePhone(phone);
    for (const user of this.users.values()) {
      if (user.phone && normalizePhone(user.phone) === target) return user;
    }
    return null;
  }

  async findByProvider(provider: string, providerId: string): Promise<AuthUser | null> {
    for (const user of this.users.values()) {
      if (user.auth_provider === provider && user.provider_id === providerId) {
        return user;
      }
    }
    return null;
  }

  async create(input: CreateUserInput): Promise<AuthUser> {
    const now = nowIso();
    const user: AuthUser = {
      id: newId('user'),
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ? normalizePhone(input.phone) : null,
      passwordHash: input.passwordHash ?? null,
      auth_provider: input.auth_provider ?? 'email',
      provider_id: input.provider_id ?? null,
      email_verified_at: null,
      phone_verified_at: null,
      is_suspended: false,
      roles: ['buyer'],
      whatsapp_number: null,
      location_state: null,
      location_sublocation: null,
      interests: null,
      onboarding_completed: false,
      created_at: now,
      updated_at: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  async update(id: string, patch: Partial<AuthUser>): Promise<AuthUser | null> {
    const existing = this.users.get(id);
    if (!existing) return null;
    const updated: AuthUser = { ...existing, ...patch, id: existing.id, updated_at: nowIso() };
    this.users.set(id, updated);
    return updated;
  }

  /** Test helper: drop all users. */
  clear(): void {
    this.users.clear();
  }
}

/** Default singleton (override via plugin options in tests). */
export const userStore = new MemoryUserStore();

/** In-memory bearer-token denylist backing POST /logout. */
export const revokedTokens = new Set<string>();

export function jwtSecret(): string {
  return process.env.JWT_SECRET ?? 'dev-secret-change-me';
}

// ── Envelope error mapping ───────────────────────────────────────────────────

function firstValidationMessage(err: unknown): string | null {
  const all = (err as { all?: Array<{ path?: string; message?: string }> }).all;
  if (!Array.isArray(all) || all.length === 0) return null;
  const first = all[0];
  if (!first) return null;
  const path = first.path ?? '';
  const message = first.message ?? 'is invalid';
  return path ? `${path} ${message}` : message;
}

/**
 * Map framework-level errors (body validation, malformed payloads, unknown
 * routes, unhandled failures) into the { success, message, data } envelope.
 * Explicit `return status(code, fail(...))` responses in handlers bypass this
 * hook — they already carry the envelope.
 */
export function createEnvelopeErrors() {
  return new Elysia({ name: 'envelope-errors' }).onError(({ code, error: err, status }) => {
    if (code === 'VALIDATION') {
      const detail = firstValidationMessage(err);
      return status(422, fail(detail ? `Validation failed: ${detail}` : 'Validation failed.'));
    }
    if (code === 'NOT_FOUND') return status(404, fail('Not found.'));
    if (code === 'PARSE') return status(400, fail('Malformed request body.'));
    const message = err instanceof Error && err.message ? err.message : 'An unexpected error occurred.';
    const maybeStatus = (err as { status?: unknown }).status;
    const code2 = typeof maybeStatus === 'number' ? maybeStatus : 500;
    return status(code2, fail(code2 === 500 ? 'An unexpected error occurred.' : message));
  });
}

// ── Shared auth guard (reused by kyc/applications modules) ──────────────────

export interface GuardOptions {
  secret?: string;
  users?: UserStore;
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  return token ? token : null;
}

/**
 * Attach the auth guard directly to the instance that owns the routes.
 *
 * NOTE: this must run on the route-owning instance itself — Elysia does not
 * propagate `resolve` values from a `.use()`d plugin to the parent's routes.
 * Resolves { currentUser } from the bearer token and rejects unauthenticated
 * / suspended callers. Chain routes after this call.
 */
export function applyAuthGuard<const T extends AnyElysia>(app: T, options: GuardOptions = {}) {
  const secret = options.secret ?? jwtSecret();
  const users = options.users ?? userStore;

  return app
    .use(jwt({ name: 'authJwt', secret }))
    .resolve(async ({ headers, authJwt }) => {
      let currentUser: AuthUser | null = null;
      const token = bearerToken(headers.authorization);
      if (token && !revokedTokens.has(token)) {
        const payload = await authJwt.verify(token);
        if (payload && typeof payload === 'object') {
          const sub = (payload as { sub?: unknown }).sub;
          if (typeof sub === 'string') {
            currentUser = await users.findById(sub);
          }
        }
      }
      return { currentUser };
    })
    .onBeforeHandle(({ currentUser, status }) => {
      if (!currentUser) return status(401, fail('Unauthenticated.'));
      if (currentUser.is_suspended) {
        return status(403, fail('Your account has been suspended. Contact support.'));
      }
      return undefined;
    });
}

// ── Social verification (minimal, mirrors SocialAuthService) ────────────────

export interface SocialProfile {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
}

/** Verify a Google id_token via Google's tokeninfo endpoint. */
async function verifyGoogleToken(idToken: string): Promise<SocialProfile> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  );
  if (!res.ok) throw new Error('Invalid Google id_token.');
  const data = (await res.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (!data.sub) throw new Error('Invalid Google id_token payload.');
  return {
    id: data.sub,
    email: data.email ?? null,
    name: data.name ?? null,
    avatar: data.picture ?? null,
  };
}

/**
 * Minimal Apple id_token check: decodes the JWT payload and validates
 * expiry (+ audience when APPLE_CLIENT_ID is set).
 * NOTE: production should additionally verify the RS256 signature against
 * Apple's JWKS (https://appleid.apple.com/auth/keys) — see the Laravel
 * SocialAuthService for the reference implementation.
 */
function verifyAppleToken(idToken: string): SocialProfile {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Invalid Apple id_token format.');
  }
  let payload: Record<string, unknown>;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    payload = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid Apple id_token payload.');
  }
  if (typeof payload['sub'] !== 'string') {
    throw new Error('Invalid Apple id_token payload.');
  }
  if (typeof payload['exp'] === 'number' && payload['exp'] < Math.floor(Date.now() / 1000)) {
    throw new Error('Apple id_token has expired.');
  }
  const clientId = process.env.APPLE_CLIENT_ID;
  if (clientId && payload['aud'] !== clientId) {
    throw new Error('Apple token audience mismatch.');
  }
  return {
    id: payload['sub'] as string,
    email: typeof payload['email'] === 'string' ? (payload['email'] as string) : null,
    name: typeof payload['name'] === 'string' ? (payload['name'] as string) : null,
    avatar: null,
  };
}

export async function verifySocialToken(
  provider: string,
  idToken: string,
): Promise<SocialProfile> {
  if (provider === 'google') return verifyGoogleToken(idToken);
  if (provider === 'apple') return verifyAppleToken(idToken);
  throw new Error(`Provider [${provider}] is not supported.`);
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const RegisterBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  email: t.Optional(t.String({ format: 'email', maxLength: 255 })),
  phone: t.Optional(t.String({ maxLength: 20 })),
  password: t.String({ minLength: 8, maxLength: 128 }),
});

const LoginBody = t.Object({
  login: t.Optional(t.String({ maxLength: 255 })),
  email: t.Optional(t.String({ maxLength: 255 })),
  phone: t.Optional(t.String({ maxLength: 20 })),
  password: t.String({ minLength: 1, maxLength: 128 }),
});

const OtpTypeSchema = t.Union([
  t.Literal('phone_signup'),
  t.Literal('phone_reset'),
  t.Literal('email_signup'),
  t.Literal('email_reset'),
]);

const OtpSendBody = t.Object({
  phone: t.Optional(t.String({ maxLength: 20 })),
  email: t.Optional(t.String({ format: 'email', maxLength: 255 })),
  type: t.Optional(OtpTypeSchema),
});

const OtpVerifyBody = t.Object({
  phone: t.Optional(t.String({ maxLength: 20 })),
  email: t.Optional(t.String({ format: 'email', maxLength: 255 })),
  code: t.String({ minLength: 6, maxLength: 6 }),
  type: t.Optional(OtpTypeSchema),
  name: t.Optional(t.String({ maxLength: 255 })),
  password: t.Optional(t.String({ minLength: 8, maxLength: 128 })),
});

const SocialBody = t.Object({
  id_token: t.Optional(t.String({ minLength: 1 })),
  token: t.Optional(t.String({ minLength: 1 })),
});

const CheckPhoneBody = t.Object({
  phone: t.String({ minLength: 1, maxLength: 20 }),
});

const SendResetBody = t.Object({
  phone: t.Optional(t.String({ maxLength: 20 })),
  email: t.Optional(t.String({ format: 'email', maxLength: 255 })),
});

const ResetBody = t.Object({
  phone: t.Optional(t.String({ maxLength: 20 })),
  email: t.Optional(t.String({ format: 'email', maxLength: 255 })),
  code: t.Optional(t.String({ minLength: 6, maxLength: 6 })),
  otp: t.Optional(t.String({ minLength: 6, maxLength: 6 })),
  password: t.Optional(t.String({ minLength: 8, maxLength: 128 })),
  new_password: t.Optional(t.String({ minLength: 8, maxLength: 128 })),
});

const UpdateMeBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  phone: t.Optional(t.String({ maxLength: 20 })),
  whatsapp_number: t.Optional(t.String({ maxLength: 20 })),
  location_state: t.Optional(t.String({ maxLength: 255 })),
  location_sublocation: t.Optional(t.String({ maxLength: 255 })),
  interests: t.Optional(t.Array(t.String())),
  onboarding_completed: t.Optional(t.Boolean()),
});

// ── Plugin ───────────────────────────────────────────────────────────────────

export interface AuthPluginOptions {
  secret?: string;
  users?: UserStore;
  otp?: OtpStore;
}

export function createAuthPlugin(options: AuthPluginOptions = {}) {
  const dbStores = getDbStores();
  const users = options.users ?? dbStores?.users ?? userStore;
  const otp = options.otp ?? dbStores?.otp ?? defaultOtpStore;
  const secret = options.secret ?? jwtSecret();

  async function signToken(authJwt: { sign: (p: Record<string, string>) => Promise<string> }, userId: string): Promise<string> {
    return authJwt.sign({ sub: userId });
  }

  const protectedRoutes = applyAuthGuard(new Elysia(), { secret, users })
    .get('/me', ({ currentUser, status }) => {
      if (!currentUser) return status(401, fail('Unauthenticated.'));
      return ok('Authenticated user.', { user: toPublicUser(currentUser) });
    })
    .patch(
      '/me',
      async ({ body, currentUser, status }) => {
        if (!currentUser) return status(401, fail('Unauthenticated.'));

        const patch: Partial<AuthUser> = {};
        if (body.name !== undefined) patch.name = body.name.trim();
        if (body.phone !== undefined) {
          const phone = normalizePhone(body.phone);
          const taken = await users.findByPhone(phone);
          if (taken && taken.id !== currentUser.id) {
            return status(409, fail('This phone number is already in use.'));
          }
          patch.phone = phone;
        }
        if (body.whatsapp_number !== undefined) {
          patch.whatsapp_number = normalizePhone(body.whatsapp_number);
        }
        if (body.location_state !== undefined) patch.location_state = body.location_state;
        if (body.location_sublocation !== undefined) {
          patch.location_sublocation = body.location_sublocation;
        }
        if (body.interests !== undefined) patch.interests = body.interests;
        if (body.onboarding_completed !== undefined) {
          patch.onboarding_completed = body.onboarding_completed;
        }

        const updated = await users.update(currentUser.id, patch);
        if (!updated) return status(404, fail('User not found.'));
        return ok('Profile updated.', { user: toPublicUser(updated) });
      },
      { body: UpdateMeBody },
    )
    .post('/logout', ({ headers, currentUser, status }) => {
      if (!currentUser) return status(401, fail('Unauthenticated.'));
      const token = bearerToken(headers.authorization);
      if (token) revokedTokens.add(token);
      return ok('Logged out successfully.', null);
    });

  return new Elysia({ prefix: '/api/v1/auth' })
    .use(jwt({ name: 'authJwt', secret }))
    .use(createEnvelopeErrors())

    .post(
      '/register',
      async ({ body, authJwt, status }) => {        const email = body.email ? normalizeEmail(body.email) : null;
        const phone = body.phone ? normalizePhone(body.phone) : null;

        if (!email && !phone) {
          return status(422, fail('Please provide an email or phone number.'));
        }
        if (email && (await users.findByEmail(email))) {
          return status(409, fail('An account with this email already exists. Please log in.'));
        }
        if (phone && (await users.findByPhone(phone))) {
          return status(409, fail('An account with this phone number already exists. Please log in.'));
        }

        const passwordHash = await Bun.password.hash(body.password);
        const user = await users.create({
          name: body.name.trim(),
          email,
          phone,
          passwordHash,
          auth_provider: email ? 'email' : 'phone',
        });

        // Fire-and-forget verification OTP — never fails registration.
        let channel: 'sms' | 'email' | null = null;
        try {
          if (phone) {
            const { code } = await otp.issue(phone, 'phone_signup');
            await sendPhoneOtp(phone, code);
            channel = 'sms';
          } else if (email) {
            const { code } = await otp.issue(email, 'email_signup');
            await sendVerificationEmail(email, code);
            channel = 'email';
          }
        } catch (err) {
          console.warn('[auth] verification OTP dispatch failed:', (err as Error).message);
        }

        return status(201, {
          success: true as const,
          message: 'Registration successful.',
          data: {
            token: await signToken(authJwt, user.id),
            user: toPublicUser(user),
            requires_verification: channel !== null,
            channel,
          },
        });
      },
      { body: RegisterBody },
    )

    .post(
      '/login',
      async ({ body, authJwt, status }) => {
        const identifier = body.login ?? body.email ?? body.phone;
        if (!identifier) {
          return status(422, fail('Please provide an email or phone number.'));
        }

        const user = isEmailIdentifier(identifier)
          ? await users.findByEmail(normalizeEmail(identifier))
          : await users.findByPhone(normalizePhone(identifier));

        if (!user || !user.passwordHash) {
          return status(401, fail('These credentials do not match our records.'));
        }
        if (!(await Bun.password.verify(body.password, user.passwordHash))) {
          return status(401, fail('These credentials do not match our records.'));
        }
        if (user.is_suspended) {
          return status(403, fail('Your account has been suspended. Contact support.'));
        }

        return ok('Login successful.', {
          token: await signToken(authJwt, user.id),
          user: toPublicUser(user),
        });
      },
      { body: LoginBody },
    )

    .post(
      '/otp/send',
      async ({ body, status }) => {
        if (body.email) {
          const email = normalizeEmail(body.email);
          const type: OtpType = body.type ?? 'email_signup';
          try {
            const { code } = await otp.issue(email, type);
            await sendVerificationEmail(email, code);
          } catch (err) {
            return status(422, fail((err as Error).message));
          }
          return ok('Email verification code sent successfully. It expires in 15 minutes.', {
            email,
          });
        }

        if (!body.phone) {
          return status(422, fail('Please provide a phone number or email address.'));
        }
        const phone = normalizePhone(body.phone);
        const type: OtpType = body.type ?? 'phone_signup';

        if (type === 'phone_signup' && (await users.findByPhone(phone))) {
          return status(409, fail('An account with this phone number already exists. Please log in.'));
        }
        if (type === 'phone_reset' && !(await users.findByPhone(phone))) {
          return status(404, fail('No account found with this phone number.'));
        }

        try {
          const { code } = await otp.issue(phone, type);
          await sendPhoneOtp(phone, code);
        } catch (err) {
          return status(422, fail((err as Error).message));
        }
        return ok('OTP sent successfully. It expires in 10 minutes.', { phone });
      },
      { body: OtpSendBody },
    )

    .post(
      '/otp/verify',
      async ({ body, authJwt, status }) => {
        if (body.email) {
          const email = normalizeEmail(body.email);
          const type: OtpType = body.type ?? 'email_signup';
          try {
            await otp.verify(email, body.code, type);
          } catch (err) {
            return status(422, fail((err as Error).message));
          }
          const user = await users.findByEmail(email);
          if (user && !user.email_verified_at) {
            await users.update(user.id, { email_verified_at: nowIso() });
          }
          const fresh = user ? await users.findById(user.id) : null;
          return ok('Email verified successfully.', {
            token: fresh ? await signToken(authJwt, fresh.id) : null,
            user: fresh ? toPublicUser(fresh) : null,
          });
        }

        if (!body.phone) {
          return status(422, fail('Please provide a phone number or email address.'));
        }
        const phone = normalizePhone(body.phone);
        const type: OtpType = body.type ?? 'phone_signup';
        try {
          await otp.verify(phone, body.code, type);
        } catch (err) {
          return status(422, fail((err as Error).message));
        }

        let user = await users.findByPhone(phone);
        let isNew = false;
        if (!user) {
          isNew = true;
          user = await users.create({
            name: body.name?.trim() || 'User',
            phone,
            passwordHash: body.password ? await Bun.password.hash(body.password) : null,
            auth_provider: 'phone',
          });
        }
        await users.update(user.id, { phone_verified_at: nowIso() });
        const fresh = (await users.findById(user.id)) as AuthUser;

        return status(isNew ? 201 : 200, {
          success: true as const,
          message: isNew ? 'Account created successfully.' : 'Login successful.',
          data: {
            is_new: isNew,
            token: await signToken(authJwt, fresh.id),
            user: toPublicUser(fresh),
          },
        });
      },
      { body: OtpVerifyBody },
    )

    .post(
      '/social/:provider',
      async ({ params, body, authJwt, status }) => {
        const { provider } = params;
        if (provider !== 'google' && provider !== 'apple') {
          return status(422, fail(`Provider [${provider}] is not supported.`));
        }
        const idToken = body.id_token ?? body.token;
        if (!idToken) {
          return status(422, fail('An id_token is required.'));
        }

        let profile: SocialProfile;
        try {
          profile = await verifySocialToken(provider, idToken);
        } catch (err) {
          const message =
            err instanceof OtpError ? err.message : (err as Error).message;
          return status(422, fail(message));
        }

        let user = await users.findByProvider(provider, profile.id);
        if (!user && profile.email) {
          const existing = await users.findByEmail(normalizeEmail(profile.email));
          if (existing) {
            user = await users.update(existing.id, {
              provider_id: profile.id,
              auth_provider: provider,
              email_verified_at: existing.email_verified_at ?? nowIso(),
            });
          }
        }
        const isNew = !user;
        if (!user) {
          user = await users.create({
            name: profile.name ?? 'User',
            email: profile.email ? normalizeEmail(profile.email) : null,
            auth_provider: provider,
            provider_id: profile.id,
          });
          if (profile.email) {
            await users.update(user.id, { email_verified_at: nowIso() });
            user = (await users.findById(user.id)) as AuthUser;
          }
        }

        return ok('Social login successful.', {
          is_new: isNew,
          token: await signToken(authJwt, (user as AuthUser).id),
          user: toPublicUser(user as AuthUser),
        });
      },
      {
        body: SocialBody,
        params: t.Object({ provider: t.String() }),
      },
    )

    .post(
      '/password/check-phone',
      async ({ body }) => {
        const phone = normalizePhone(body.phone);
        const exists = (await users.findByPhone(phone)) !== null;
        return ok('Phone checked.', { exists, phone });
      },
      { body: CheckPhoneBody },
    )

    .post(
      '/password/send-reset',
      async ({ body, status }) => {
        if (body.phone) {
          const phone = normalizePhone(body.phone);
          if (!(await users.findByPhone(phone))) {
            return status(404, fail('No account found with this phone number.'));
          }
          try {
            const { code } = await otp.issue(phone, 'phone_reset');
            await sendPhoneOtp(phone, code);
          } catch (err) {
            return status(422, fail((err as Error).message));
          }
          return ok('Password reset OTP sent to your phone.', { via: 'phone' });
        }

        if (body.email) {
          const email = normalizeEmail(body.email);
          if (!(await users.findByEmail(email))) {
            return status(404, fail('No account found with this email address.'));
          }
          try {
            const { code } = await otp.issue(email, 'email_reset');
            await sendPasswordResetEmail(email, code);
          } catch (err) {
            return status(422, fail((err as Error).message));
          }
          return ok('Password reset OTP sent to your email.', { via: 'email' });
        }

        return status(422, fail('Please provide a phone number or email address.'));
      },
      { body: SendResetBody },
    )

    .post(
      '/password/reset',
      async ({ body, status }) => {
        const code = body.code ?? body.otp;
        const newPassword = body.password ?? body.new_password;
        if (!code) return status(422, fail('A verification code is required.'));
        if (!newPassword) return status(422, fail('A new password is required.'));

        let user: AuthUser | null = null;
        if (body.phone) {
          const phone = normalizePhone(body.phone);
          try {
            await otp.verify(phone, code, 'phone_reset');
          } catch (err) {
            return status(422, fail((err as Error).message));
          }
          user = await users.findByPhone(phone);
        } else if (body.email) {
          const email = normalizeEmail(body.email);
          try {
            await otp.verify(email, code, 'email_reset');
          } catch (err) {
            return status(422, fail((err as Error).message));
          }
          user = await users.findByEmail(email);
        } else {
          return status(422, fail('Please provide a phone number or email address.'));
        }

        if (!user) return status(404, fail('No account found.'));
        await users.update(user.id, { passwordHash: await Bun.password.hash(newPassword) });
        return ok('Password reset successfully. You can now log in.', null);
      },
      { body: ResetBody },
    )

    .use(protectedRoutes);
}

/** Default singleton plugin (uses env secret + shared in-memory stores). */
export const authPlugin = createAuthPlugin();
