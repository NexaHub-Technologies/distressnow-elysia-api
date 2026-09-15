/**
 * Role applications module — Elysia plugin, prefix /api/v1/applications.
 *
 * Port of the Laravel SellerApplicationController + ProviderApplicationController:
 *  - GET  /applications/seller/status
 *  - POST /applications/seller      (requires approved KYC tier >= 2, mirrors kyc:2)
 *  - GET  /applications/provider/status
 *  - POST /applications/provider    (requires approved KYC tier >= 1, mirrors kyc:1)
 *
 * Guards read the approved tier from the KYC store (see kyc module).
 * Duplicate pending applications are rejected with 409, mirroring the reference.
 * File uploads (store logos / provider photos) are accepted as URL strings;
 * use src/services/storage.ts uploadBuffer() if binary upload is needed later.
 *
 * Persistence sits behind the SellerApplicationStore / ProviderApplicationStore
 * interfaces: the default plugin uses Postgres-backed stores
 * (src/db/stores.ts) while DATABASE_URL is reachable and falls back to the
 * in-memory singletons otherwise (same pattern as the auth / kyc modules).
 */
import { Elysia, t } from 'elysia';
import { applyAuthGuard, createEnvelopeErrors, fail, ok, type UserStore } from '../auth/index';
import { getDbStores } from '../../db/stores';
import { kycStore as defaultKycStore, type KycStore } from '../kyc/index';
import { newId, nowIso } from '../../utils/phone';

export type ApplicationStatus = 'pending' | 'approved' | 'declined';

export interface SellerApplication {
  id: string;
  userId: string;
  status: ApplicationStatus;
  store_name: string;
  store_description: string | null;
  store_phone: string;
  store_email: string;
  store_state: string;
  store_sublocation: string;
  store_market: string;
  store_categories: string[];
  store_address: string | null;
  store_lat: number | null;
  store_lng: number | null;
  store_logo_url: string | null;
  declined_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface ProviderApplication {
  id: string;
  userId: string;
  status: ApplicationStatus;
  full_name: string;
  business_name: string | null;
  bio: string | null;
  service_categories: string[];
  years_experience: number;
  price_range: string | null;
  response_time: string | null;
  availability: 'immediate' | 'scheduled' | 'busy' | 'weekends' | 'unavailable';
  location_state: string;
  location_sublocation: string;
  location_lat: number | null;
  location_lng: number | null;
  contact_phone: string;
  contact_whatsapp: string | null;
  photo_url: string | null;
  declined_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
}

/**
 * Persistence surface for seller applications. Methods may be sync (memory)
 * or async (Postgres) — callers always `await`, which works for both.
 */
export interface SellerApplicationStore {
  create(
    data: Omit<SellerApplication, 'id' | 'created_at'>,
  ): SellerApplication | Promise<SellerApplication>;
  latestByUser(
    userId: string,
  ): SellerApplication | null | Promise<SellerApplication | null>;
  pendingByUser(
    userId: string,
  ): SellerApplication | null | Promise<SellerApplication | null>;
  clear(): void;
}

export class MemorySellerApplicationStore implements SellerApplicationStore {
  private applications: SellerApplication[] = [];

  create(data: Omit<SellerApplication, 'id' | 'created_at'>): SellerApplication {
    const application: SellerApplication = {
      ...data,
      id: newId('sellerapp'),
      created_at: nowIso(),
    };
    this.applications.push(application);
    return application;
  }

  latestByUser(userId: string): SellerApplication | null {
    const mine = this.applications.filter((a) => a.userId === userId);
    return mine.length > 0 ? (mine[mine.length - 1] as SellerApplication) : null;
  }

  pendingByUser(userId: string): SellerApplication | null {
    return (
      this.applications.find((a) => a.userId === userId && a.status === 'pending') ?? null
    );
  }

  clear(): void {
    this.applications = [];
  }
}

/**
 * Persistence surface for provider applications. Methods may be sync (memory)
 * or async (Postgres) — callers always `await`, which works for both.
 */
export interface ProviderApplicationStore {
  create(
    data: Omit<ProviderApplication, 'id' | 'created_at'>,
  ): ProviderApplication | Promise<ProviderApplication>;
  latestByUser(
    userId: string,
  ): ProviderApplication | null | Promise<ProviderApplication | null>;
  pendingByUser(
    userId: string,
  ): ProviderApplication | null | Promise<ProviderApplication | null>;
  clear(): void;
}

export class MemoryProviderApplicationStore implements ProviderApplicationStore {
  private applications: ProviderApplication[] = [];

  create(data: Omit<ProviderApplication, 'id' | 'created_at'>): ProviderApplication {
    const application: ProviderApplication = {
      ...data,
      id: newId('providerapp'),
      created_at: nowIso(),
    };
    this.applications.push(application);
    return application;
  }

  latestByUser(userId: string): ProviderApplication | null {
    const mine = this.applications.filter((a) => a.userId === userId);
    return mine.length > 0 ? (mine[mine.length - 1] as ProviderApplication) : null;
  }

  pendingByUser(userId: string): ProviderApplication | null {
    return (
      this.applications.find((a) => a.userId === userId && a.status === 'pending') ?? null
    );
  }

  clear(): void {
    this.applications = [];
  }
}

/** Default singletons (override via plugin options in tests). */
export const sellerApplications = new MemorySellerApplicationStore();
export const providerApplications = new MemoryProviderApplicationStore();

const SellerBody = t.Object({
  store_name: t.String({ minLength: 1, maxLength: 255 }),
  store_description: t.Optional(t.String({ maxLength: 2000 })),
  store_phone: t.String({ minLength: 1, maxLength: 20 }),
  store_email: t.String({ format: 'email', maxLength: 255 }),
  store_state: t.String({ minLength: 1, maxLength: 255 }),
  store_sublocation: t.String({ minLength: 1, maxLength: 255 }),
  store_market: t.String({ minLength: 1, maxLength: 255 }),
  store_categories: t.Array(t.String(), { minItems: 1 }),
  store_address: t.Optional(t.String({ maxLength: 500 })),
  store_lat: t.Optional(t.Number()),
  store_lng: t.Optional(t.Number()),
  store_logo_url: t.Optional(t.String({ maxLength: 2000 })),
});

const ProviderBody = t.Object({
  full_name: t.String({ minLength: 1, maxLength: 255 }),
  business_name: t.Optional(t.String({ maxLength: 255 })),
  bio: t.Optional(t.String({ maxLength: 1000 })),
  service_categories: t.Array(t.String(), { minItems: 1 }),
  years_experience: t.Integer({ minimum: 0 }),
  price_range: t.Optional(t.String({ maxLength: 255 })),
  response_time: t.Optional(t.String({ maxLength: 255 })),
  availability: t.Union([
    t.Literal('immediate'),
    t.Literal('scheduled'),
    t.Literal('busy'),
    t.Literal('weekends'),
    t.Literal('unavailable'),
  ]),
  location_state: t.String({ minLength: 1, maxLength: 255 }),
  location_sublocation: t.String({ minLength: 1, maxLength: 255 }),
  location_lat: t.Optional(t.Number()),
  location_lng: t.Optional(t.Number()),
  contact_phone: t.String({ minLength: 1, maxLength: 20 }),
  contact_whatsapp: t.Optional(t.String({ maxLength: 20 })),
  photo_url: t.Optional(t.String({ maxLength: 2000 })),
});

export interface ApplicationsPluginOptions {
  secret?: string;
  users?: UserStore;
  kyc?: KycStore;
  sellers?: SellerApplicationStore;
  providers?: ProviderApplicationStore;
}

export function createApplicationsPlugin(options: ApplicationsPluginOptions = {}) {
  const kyc = options.kyc ?? getDbStores()?.kyc ?? defaultKycStore;
  const sellers = options.sellers ?? getDbStores()?.sellers ?? sellerApplications;
  const providers = options.providers ?? getDbStores()?.providers ?? providerApplications;

  return applyAuthGuard(new Elysia({ prefix: '/api/v1/applications' }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })
    .use(createEnvelopeErrors())

    .get('/seller/status', async ({ currentUser, status }) => {
      if (!currentUser) return status(401, fail('Unauthenticated.'));
      return ok('Seller application status retrieved.', {
        application: await sellers.latestByUser(currentUser.id),
      });
    })

    .post(
      '/seller',
      async ({ body, currentUser, status }) => {
        if (!currentUser) return status(401, fail('Unauthenticated.'));
        if ((await kyc.approvedTier(currentUser.id)) < 2) {
          return status(403, fail('Approved Tier 2 KYC is required to apply as a seller.'));
        }

        const pending = await sellers.pendingByUser(currentUser.id);
        if (pending) {
          return status(409, {
            success: false as const,
            message: 'You already have a pending seller application. Please wait for review.',
            data: { application_id: pending.id },
          });
        }

        const application = await sellers.create({
          userId: currentUser.id,
          status: 'pending',
          store_name: body.store_name,
          store_description: body.store_description ?? null,
          store_phone: body.store_phone,
          store_email: body.store_email,
          store_state: body.store_state,
          store_sublocation: body.store_sublocation,
          store_market: body.store_market,
          store_categories: body.store_categories,
          store_address: body.store_address ?? null,
          store_lat: body.store_lat ?? null,
          store_lng: body.store_lng ?? null,
          store_logo_url: body.store_logo_url ?? null,
          declined_reason: null,
          reviewed_at: null,
        });

        return status(201, {
          success: true as const,
          message: 'Seller application submitted successfully. Our team will review it shortly.',
          data: {
            application_id: application.id,
            status: application.status,
          },
        });
      },
      { body: SellerBody },
    )

    .get('/provider/status', async ({ currentUser, status }) => {
      if (!currentUser) return status(401, fail('Unauthenticated.'));
      return ok('Provider application status retrieved.', {
        application: await providers.latestByUser(currentUser.id),
      });
    })

    .post(
      '/provider',
      async ({ body, currentUser, status }) => {
        if (!currentUser) return status(401, fail('Unauthenticated.'));
        if ((await kyc.approvedTier(currentUser.id)) < 1) {
          return status(403, fail('Approved Tier 1 KYC is required to apply as a provider.'));
        }

        const pending = await providers.pendingByUser(currentUser.id);
        if (pending) {
          return status(409, {
            success: false as const,
            message: 'You already have a pending provider application. Please wait for review.',
            data: { application_id: pending.id },
          });
        }

        const application = await providers.create({
          userId: currentUser.id,
          status: 'pending',
          full_name: body.full_name,
          business_name: body.business_name ?? null,
          bio: body.bio ?? null,
          service_categories: body.service_categories,
          years_experience: body.years_experience,
          price_range: body.price_range ?? null,
          response_time: body.response_time ?? null,
          availability: body.availability,
          location_state: body.location_state,
          location_sublocation: body.location_sublocation,
          location_lat: body.location_lat ?? null,
          location_lng: body.location_lng ?? null,
          contact_phone: body.contact_phone,
          contact_whatsapp: body.contact_whatsapp ?? null,
          photo_url: body.photo_url ?? null,
          declined_reason: null,
          reviewed_at: null,
        });

        return status(201, {
          success: true as const,
          message: 'Provider application submitted successfully. Our team will review it shortly.',
          data: { application_id: application.id, status: application.status },
        });
      },
      { body: ProviderBody },
    );
}

/** Default singleton plugin (uses env secret + shared in-memory stores). */
export const applicationsPlugin = createApplicationsPlugin();
