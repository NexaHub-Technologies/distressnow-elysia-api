/**
 * KYC + role-applications tests (bun:test).
 *
 * HTTP-level tests via app.handle() with fresh in-memory stores:
 * auth (register/login/JWT) + kyc + applications wired together, mirroring
 * the production mount order. No DB required.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia, type AnyElysia } from 'elysia';
import { createAuthPlugin, MemoryUserStore } from '../src/modules/auth/index';
import { createKycPlugin, MemoryKycStore } from '../src/modules/kyc/index';
import {
  createApplicationsPlugin,
  MemoryProviderApplicationStore,
  MemorySellerApplicationStore,
} from '../src/modules/applications/index';
import { MemoryOtpStore } from '../src/services/termii';

const SECRET = 'test-secret-kyc';

interface TestContext {
  app: AnyElysia;
  kyc: MemoryKycStore;
}

function buildApp(): TestContext {
  const users = new MemoryUserStore();
  const otp = new MemoryOtpStore();
  const kyc = new MemoryKycStore();
  const sellers = new MemorySellerApplicationStore();
  const providers = new MemoryProviderApplicationStore();
  const app = new Elysia()
    .use(createAuthPlugin({ secret: SECRET, users, otp }))
    .use(createKycPlugin({ secret: SECRET, users, kyc }))
    .use(createApplicationsPlugin({ secret: SECRET, users, kyc, sellers, providers }));
  return { app, kyc };
}

async function register(app: AnyElysia, name = 'Kyc User'): Promise<{ token: string; userId: string }> {
  const res = await app.handle(
    new Request('http://localhost/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        email: `${name.toLowerCase().replace(/[^a-z]+/g, '')}@example.com`,
        password: 'password123',
      }),
    }),
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as {
    data: { token: string; user: { id: string } };
  };
  return { token: json.data.token, userId: json.data.user.id };
}

async function authed(
  app: AnyElysia,
  method: string,
  path: string,
  token: string,
  body?: FormData | string,
  contentType?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (contentType) headers['content-type'] = contentType;
  const res = await app.handle(
    new Request(`http://localhost${path}`, { method, headers, body }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

function kycForm(level: string, opts: { withSelfie?: boolean; business?: boolean } = {}): FormData {
  const form = new FormData();
  form.append('level', level);
  form.append('nin_number', '12345678901');
  const png = new File(['fake-image-bytes'], 'doc.png', { type: 'image/png' });
  form.append('nin_front', new File(['front'], 'nin-front.png', { type: 'image/png' }), 'nin-front.png');
  form.append('nin_back', new File(['back'], 'nin-back.png', { type: 'image/png' }), 'nin-back.png');
  if (opts.withSelfie !== false) {
    form.append('selfie', new File(['selfie'], 'selfie.png', { type: 'image/png' }), 'selfie.png');
  }
  if (opts.business) {
    form.append('business_name', 'Test Ventures');
    form.append('business_type', 'Private Enterprise');
    form.append('business_address', '12 Market Road, Lagos');
    form.append('business_phone', '08012345678');
    form.append('cac_certificate', png, 'cac.png');
  }
  return form;
}

const SELLER_BODY = {
  store_name: 'Test Store',
  store_phone: '08012345678',
  store_email: 'store@example.com',
  store_state: 'Lagos',
  store_sublocation: 'Ikeja',
  store_market: 'Computer Village',
  store_categories: ['electronics'],
};

const PROVIDER_BODY = {
  full_name: 'Test Provider',
  service_categories: ['plumbing'],
  years_experience: 3,
  availability: 'immediate',
  location_state: 'Lagos',
  location_sublocation: 'Lekki',
  contact_phone: '08012345678',
};

describe('GET /api/v1/kyc/status', () => {
  test('returns tier 0 when no KYC profile exists', async () => {
    const { app } = buildApp();
    const { token } = await register(app);
    const res = await authed(app, 'GET', '/api/v1/kyc/status', token);
    expect(res.status).toBe(200);
    const data = res.json['data'] as Record<string, unknown>;
    expect(data['tier']).toBe(0);
    expect(data['kyc']).toBeNull();
  });

  test('rejects anonymous callers with 401', async () => {
    const { app } = buildApp();
    const res = await app.handle(new Request('http://localhost/api/v1/kyc/status'));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/kyc/submit', () => {
  test('submits tier 1 with identity documents (201, pending)', async () => {
    const { app } = buildApp();
    const { token } = await register(app);
    const res = await authed(app, 'POST', '/api/v1/kyc/submit', token, kycForm('1'));
    expect(res.status).toBe(201);
    const data = res.json['data'] as Record<string, unknown>;
    expect(data['tier']).toBe(1);
    expect(data['status']).toBe('pending');
  });

  test('rejects tier 1 missing the selfie with 422', async () => {
    const { app } = buildApp();
    const { token } = await register(app);
    const res = await authed(
      app,
      'POST',
      '/api/v1/kyc/submit',
      token,
      kycForm('1', { withSelfie: false }),
    );
    expect(res.status).toBe(422);
  });

  test('rejects an invalid level with 422', async () => {
    const { app } = buildApp();
    const { token } = await register(app);
    const res = await authed(app, 'POST', '/api/v1/kyc/submit', token, kycForm('3'));
    expect(res.status).toBe(422);
  });

  test('blocks downgrading an approved tier-2 KYC to tier 1', async () => {
    const { app, kyc } = buildApp();
    const { token, userId } = await register(app);
    const submit = await authed(
      app,
      'POST',
      '/api/v1/kyc/submit',
      token,
      kycForm('2', { business: true }),
    );
    expect(submit.status).toBe(201);
    kyc.setStatus(userId, 'approved');

    const downgrade = await authed(app, 'POST', '/api/v1/kyc/submit', token, kycForm('1'));
    expect(downgrade.status).toBe(422);
  });
});

describe('role applications', () => {
  test('provider application requires approved tier-1 KYC (403 before, 201 after)', async () => {
    const { app, kyc } = buildApp();
    const { token, userId } = await register(app, 'Provider One');

    const blocked = await authed(
      app,
      'POST',
      '/api/v1/applications/provider',
      token,
      JSON.stringify(PROVIDER_BODY),
      'application/json',
    );
    expect(blocked.status).toBe(403);

    const submit = await authed(app, 'POST', '/api/v1/kyc/submit', token, kycForm('1'));
    expect(submit.status).toBe(201);
    kyc.setStatus(userId, 'approved');

    const created = await authed(
      app,
      'POST',
      '/api/v1/applications/provider',
      token,
      JSON.stringify(PROVIDER_BODY),
      'application/json',
    );
    expect(created.status).toBe(201);

    const statusRes = await authed(app, 'GET', '/api/v1/applications/provider/status', token);
    expect(statusRes.status).toBe(200);
    const application = (statusRes.json['data'] as Record<string, unknown>)[
      'application'
    ] as Record<string, unknown>;
    expect(application['status']).toBe('pending');
    expect(application['full_name']).toBe('Test Provider');
  });

  test('duplicate pending provider applications are rejected with 409', async () => {
    const { app, kyc } = buildApp();
    const { token, userId } = await register(app, 'Provider Two');
    await authed(app, 'POST', '/api/v1/kyc/submit', token, kycForm('1'));
    kyc.setStatus(userId, 'approved');

    const first = await authed(
      app,
      'POST',
      '/api/v1/applications/provider',
      token,
      JSON.stringify(PROVIDER_BODY),
      'application/json',
    );
    expect(first.status).toBe(201);
    const second = await authed(
      app,
      'POST',
      '/api/v1/applications/provider',
      token,
      JSON.stringify(PROVIDER_BODY),
      'application/json',
    );
    expect(second.status).toBe(409);
  });

  test('seller application requires approved tier-2 KYC', async () => {
    const { app, kyc } = buildApp();
    const { token, userId } = await register(app, 'Seller One');

    // Tier-1 approval is not enough for the seller track.
    await authed(app, 'POST', '/api/v1/kyc/submit', token, kycForm('1'));
    kyc.setStatus(userId, 'approved');
    const tierOne = await authed(
      app,
      'POST',
      '/api/v1/applications/seller',
      token,
      JSON.stringify(SELLER_BODY),
      'application/json',
    );
    expect(tierOne.status).toBe(403);

    // Upgrade to tier 2 + approval unlocks it.
    const upgrade = await authed(
      app,
      'POST',
      '/api/v1/kyc/submit',
      token,
      kycForm('2', { business: true }),
    );
    expect(upgrade.status).toBe(200);
    kyc.setStatus(userId, 'approved');

    const created = await authed(
      app,
      'POST',
      '/api/v1/applications/seller',
      token,
      JSON.stringify(SELLER_BODY),
      'application/json',
    );
    expect(created.status).toBe(201);

    const statusRes = await authed(app, 'GET', '/api/v1/applications/seller/status', token);
    expect(statusRes.status).toBe(200);
    const application = (statusRes.json['data'] as Record<string, unknown>)[
      'application'
    ] as Record<string, unknown>;
    expect(application['store_name']).toBe('Test Store');
  });

  test('status endpoints return null application when none exists', async () => {
    const { app } = buildApp();
    const { token } = await register(app, 'Fresh User');
    const seller = await authed(app, 'GET', '/api/v1/applications/seller/status', token);
    expect((seller.json['data'] as Record<string, unknown>)['application']).toBeNull();
    const provider = await authed(app, 'GET', '/api/v1/applications/provider/status', token);
    expect((provider.json['data'] as Record<string, unknown>)['application']).toBeNull();
  });

  test('seller application validates required fields (422)', async () => {
    const { app, kyc } = buildApp();
    const { token, userId } = await register(app, 'Seller Two');
    await authed(app, 'POST', '/api/v1/kyc/submit', token, kycForm('2', { business: true }));
    kyc.setStatus(userId, 'approved');

    const res = await authed(
      app,
      'POST',
      '/api/v1/applications/seller',
      token,
      JSON.stringify({ store_name: 'Incomplete' }),
      'application/json',
    );
    expect(res.status).toBe(422);
  });
});
