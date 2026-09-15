/**
 * Auth module tests (bun:test).
 *
 * Covers pure helpers (phone normalization, OTP code shape, OTP hashing,
 * password hashing) plus HTTP-level route tests via app.handle() with fresh
 * in-memory stores — no DB required.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia, type AnyElysia } from 'elysia';
import { generateOtpCode, normalizePhone } from '../src/utils/phone';
import {
  MemoryOtpStore,
  OtpError,
  hashOtp,
} from '../src/services/termii';
import { createAuthPlugin, MemoryUserStore } from '../src/modules/auth/index';

const SECRET = 'test-secret-auth';

function buildApp(): {
  app: AnyElysia;
  users: MemoryUserStore;
  otp: MemoryOtpStore;
} {
  const users = new MemoryUserStore();
  const otp = new MemoryOtpStore();
  const app = new Elysia().use(createAuthPlugin({ secret: SECRET, users, otp }));
  return { app, users, otp };
}

async function post(
  app: AnyElysia,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function get(
  app: AnyElysia,
  path: string,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await app.handle(new Request(`http://localhost${path}`, { headers }));
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

function dataOf(res: { json: Record<string, unknown> }): Record<string, unknown> {
  return res.json['data'] as Record<string, unknown>;
}

describe('normalizePhone', () => {
  test('converts Nigerian local format to +234 E.164', () => {
    expect(normalizePhone('08012345678')).toBe('+2348012345678');
  });

  test('round-trips an already-normalized number', () => {
    expect(normalizePhone('+2348012345678')).toBe('+2348012345678');
  });

  test('strips spaces, dashes and brackets', () => {
    expect(normalizePhone('0801 234-5678')).toBe('+2348012345678');
    expect(normalizePhone('(0801) 234 5678')).toBe('+2348012345678');
  });

  test('handles numbers without leading zero', () => {
    expect(normalizePhone('2348012345678')).toBe('+2348012345678');
  });
});

describe('OTP helpers', () => {
  test('generateOtpCode produces 6-digit numeric codes', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  test('hashOtp is deterministic and one-way', () => {
    const hash = hashOtp('123456');
    expect(hash).toBe(hashOtp('123456'));
    expect(hash).not.toContain('123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('MemoryOtpStore issue/verify round-trip', async () => {
    const store = new MemoryOtpStore();
    const { code } = await store.issue('+2348012345678', 'phone_signup');
    await store.verify('+2348012345678', code, 'phone_signup');
  });

  test('MemoryOtpStore rejects wrong codes and tracks attempts', async () => {
    const store = new MemoryOtpStore({ maxAttempts: 2 });
    await store.issue('+2348012345678', 'phone_signup');
    const first = await store
      .verify('+2348012345678', '000000', 'phone_signup')
      .then(
        () => 'resolved',
        (err: unknown) => err,
      );
    expect(first).toBeInstanceOf(OtpError);
    expect((first as OtpError).failure).toBe('INVALID');
    expect((first as OtpError).attemptsRemaining).toBe(1);
  });

  test('MemoryOtpStore rejects expired codes', async () => {
    const store = new MemoryOtpStore({ ttlMs: 1 });
    const { code } = await store.issue('+2348012345678', 'phone_signup');
    const result = await store
      .verify('+2348012345678', code, 'phone_signup', Date.now() + 60_000)
      .then(
        () => 'resolved',
        (err: unknown) => err,
      );
    expect(result).toBeInstanceOf(OtpError);
    expect((result as OtpError).failure).toBe('EXPIRED');
  });

  test('MemoryOtpStore codes are single-use', async () => {
    const store = new MemoryOtpStore();
    const { code } = await store.issue('+2348012345678', 'phone_signup');
    await store.verify('+2348012345678', code, 'phone_signup');
    const second = await store.verify('+2348012345678', code, 'phone_signup').then(
      () => 'resolved',
      (err: unknown) => err,
    );
    expect(second).toBeInstanceOf(OtpError);
    expect((second as OtpError).failure).toBe('NOT_FOUND');
  });
});

describe('password hashing (Bun.password)', () => {
  test('hash + verify round-trip, wrong password fails', async () => {
    const hash = await Bun.password.hash('supersecret1');
    expect(hash).not.toContain('supersecret1');
    expect(await Bun.password.verify('supersecret1', hash)).toBe(true);
    expect(await Bun.password.verify('wrongpassword', hash)).toBe(false);
  });
});

describe('POST /api/v1/auth/register', () => {
  test('registers with email + password and returns JWT + user', async () => {
    const { app } = buildApp();
    const res = await post(app, '/api/v1/auth/register', {
      name: 'Ada Buyer',
      email: 'ada@example.com',
      password: 'password123',
    });
    expect(res.status).toBe(201);
    expect(res.json['success']).toBe(true);
    const data = dataOf(res);
    expect(typeof data['token']).toBe('string');
    const user = data['user'] as Record<string, unknown>;
    expect(user['email']).toBe('ada@example.com');
    expect(user).not.toHaveProperty('passwordHash');
  });

  test('registers with phone, normalizing to +234', async () => {
    const { app } = buildApp();
    const res = await post(app, '/api/v1/auth/register', {
      name: 'Chidi Buyer',
      phone: '08012345678',
      password: 'password123',
    });
    expect(res.status).toBe(201);
    const user = dataOf(res)['user'] as Record<string, unknown>;
    expect(user['phone']).toBe('+2348012345678');
  });

  test('requires email or phone', async () => {
    const { app } = buildApp();
    const res = await post(app, '/api/v1/auth/register', {
      name: 'Nobody',
      password: 'password123',
    });
    expect(res.status).toBe(422);
    expect(res.json['success']).toBe(false);
  });

  test('rejects duplicate email with 409', async () => {
    const { app } = buildApp();
    const body = { name: 'Ada', email: 'ada@example.com', password: 'password123' };
    expect((await post(app, '/api/v1/auth/register', body)).status).toBe(201);
    const dup = await post(app, '/api/v1/auth/register', body);
    expect(dup.status).toBe(409);
  });
});

describe('POST /api/v1/auth/login', () => {
  test('logs in with email via { login } and via { email }', async () => {
    const { app } = buildApp();
    await post(app, '/api/v1/auth/register', {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
    });

    const viaLogin = await post(app, '/api/v1/auth/login', {
      login: 'ada@example.com',
      password: 'password123',
    });
    expect(viaLogin.status).toBe(200);
    expect(typeof dataOf(viaLogin)['token']).toBe('string');

    const viaEmail = await post(app, '/api/v1/auth/login', {
      email: 'ada@example.com',
      password: 'password123',
    });
    expect(viaEmail.status).toBe(200);
  });

  test('logs in with phone in local format', async () => {
    const { app } = buildApp();
    await post(app, '/api/v1/auth/register', {
      name: 'Chidi',
      phone: '08012345678',
      password: 'password123',
    });
    const res = await post(app, '/api/v1/auth/login', {
      login: '08012345678',
      password: 'password123',
    });
    expect(res.status).toBe(200);
  });

  test('rejects wrong password with 401', async () => {
    const { app } = buildApp();
    await post(app, '/api/v1/auth/register', {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
    });
    const res = await post(app, '/api/v1/auth/login', {
      login: 'ada@example.com',
      password: 'wrongpassword',
    });
    expect(res.status).toBe(401);
  });
});

describe('authenticated /me + logout', () => {
  test('GET /me returns the user; anonymous gets 401', async () => {
    const { app } = buildApp();
    const reg = await post(app, '/api/v1/auth/register', {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
    });
    const token = dataOf(reg)['token'] as string;

    expect((await get(app, '/api/v1/auth/me')).status).toBe(401);
    const me = await get(app, '/api/v1/auth/me', token);
    expect(me.status).toBe(200);
    const user = dataOf(me)['user'] as Record<string, unknown>;
    expect(user['email']).toBe('ada@example.com');
  });

  test('PATCH /me updates profile fields', async () => {
    const { app } = buildApp();
    const reg = await post(app, '/api/v1/auth/register', {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
    });
    const token = dataOf(reg)['token'] as string;
    const res = await app.handle(
      new Request('http://localhost/api/v1/auth/me', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: 'Ada Updated', location_state: 'Lagos' }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { user: { name: string; location_state: string } };
    };
    expect(json.data.user.name).toBe('Ada Updated');
    expect(json.data.user.location_state).toBe('Lagos');
  });

  test('POST /logout revokes the token', async () => {
    const { app } = buildApp();
    const reg = await post(app, '/api/v1/auth/register', {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
    });
    const token = dataOf(reg)['token'] as string;
    const logout = await post(app, '/api/v1/auth/logout', {}, token);
    expect(logout.status).toBe(200);
    expect((await get(app, '/api/v1/auth/me', token)).status).toBe(401);
  });
});

describe('OTP send/verify + password reset', () => {
  test('phone OTP verify creates a new user and issues JWT', async () => {
    const { app, otp } = buildApp();
    const send = await post(app, '/api/v1/auth/otp/send', { phone: '08012345678' });
    expect(send.status).toBe(200);

    // The store holds the only copy of the code (hashed at rest).
    const { code } = await otp.issue('+2348012345678', 'phone_signup');
    const verify = await post(app, '/api/v1/auth/otp/verify', {
      phone: '08012345678',
      code,
      name: 'Otp User',
    });
    expect(verify.status).toBe(201);
    const data = dataOf(verify);
    expect(data['is_new']).toBe(true);
    expect(typeof data['token']).toBe('string');
  });

  test('phone OTP verify rejects a bad code with 422', async () => {
    const { app, otp } = buildApp();
    await otp.issue('+2348012345678', 'phone_signup');
    const res = await post(app, '/api/v1/auth/otp/verify', {
      phone: '08012345678',
      code: '000000',
    });
    expect(res.status).toBe(422);
  });

  test('password reset flow: check-phone -> send-reset -> reset -> login', async () => {
    const { app, otp } = buildApp();
    await post(app, '/api/v1/auth/register', {
      name: 'Ada',
      phone: '08012345678',
      password: 'password123',
    });

    const check = await post(app, '/api/v1/auth/password/check-phone', {
      phone: '08012345678',
    });
    expect(check.status).toBe(200);
    expect((check.json['data'] as Record<string, unknown>)['exists']).toBe(true);

    const sent = await post(app, '/api/v1/auth/password/send-reset', {
      phone: '08012345678',
    });
    expect(sent.status).toBe(200);

    const { code } = await otp.issue('+2348012345678', 'phone_reset');
    const reset = await post(app, '/api/v1/auth/password/reset', {
      phone: '08012345678',
      code,
      password: 'newpassword1',
    });
    expect(reset.status).toBe(200);

    const login = await post(app, '/api/v1/auth/login', {
      login: '08012345678',
      password: 'newpassword1',
    });
    expect(login.status).toBe(200);
  });

  test('send-reset for an unknown phone returns 404', async () => {
    const { app } = buildApp();
    const res = await post(app, '/api/v1/auth/password/send-reset', {
      phone: '08099999999',
    });
    expect(res.status).toBe(404);
  });
});
