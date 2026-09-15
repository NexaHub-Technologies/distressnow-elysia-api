/**
 * KYC module — Elysia plugin, prefix /api/v1/kyc.
 *
 * Port of the Laravel KycController (graduated tiers):
 *  - Tier 1 (provider level): nin_number + nin_front + nin_back + selfie
 *  - Tier 2 (seller level):   tier 1 + business details + CAC (+ SMEDAN)
 *
 * Rules mirrored from the reference:
 *  - an approved KYC cannot be downgraded (422)
 *  - a rejected/pending KYC can be re-submitted
 *
 * Files upload via src/services/storage.ts uploadBuffer(); document URLs are
 * stored as JSON on the record. Persistence is an in-memory store behind a
 * small interface until the drizzle schema lands (same swap-out pattern as
 * the auth module).
 *
 * Also exports approvedTier() / MemoryKycStore for the applications module's
 * kyc:1 / kyc:2 guards.
 */
import { Elysia, t } from 'elysia';
import { applyAuthGuard, createEnvelopeErrors, fail, ok, type UserStore } from '../auth/index';
import { uploadBuffer } from '../../services/storage';
import { newId, nowIso } from '../../utils/phone';

export type KycStatus = 'pending' | 'approved' | 'rejected';

export interface KycDocument {
  /** Stable slot name: nin_front | nin_back | selfie | cac_certificate | smedan_certificate | document */
  name: string;
  url: string;
  kind: 'identity' | 'business' | 'document';
}

export interface KycRecord {
  userId: string;
  tier: 1 | 2;
  status: KycStatus;
  rejection_reason: string | null;
  documents: KycDocument[];
  fields: Record<string, string | string[] | null>;
  submitted_at: string;
  reviewed_at: string | null;
}

export interface SerializedKyc {
  user_id: string;
  tier: number;
  status: KycStatus;
  rejection_reason: string | null;
  documents: KycDocument[];
  fields: Record<string, string | string[] | null>;
  submitted_at: string;
  reviewed_at: string | null;
}

export function serializeKyc(record: KycRecord): SerializedKyc {
  return {
    user_id: record.userId,
    tier: record.tier,
    status: record.status,
    rejection_reason: record.rejection_reason,
    documents: record.documents,
    fields: record.fields,
    submitted_at: record.submitted_at,
    reviewed_at: record.reviewed_at,
  };
}

export class MemoryKycStore {
  private records = new Map<string, KycRecord>();

  get(userId: string): KycRecord | null {
    return this.records.get(userId) ?? null;
  }

  upsert(record: KycRecord): KycRecord {
    this.records.set(record.userId, record);
    return record;
  }

  /** Admin/test helper: force a review outcome. */
  setStatus(userId: string, status: KycStatus, reason?: string | null): KycRecord | null {
    const record = this.records.get(userId);
    if (!record) return null;
    record.status = status;
    record.rejection_reason = status === 'rejected' ? (reason ?? null) : null;
    record.reviewed_at = nowIso();
    return record;
  }

  /** Approved tier, or 0 when there is no approved KYC. */
  approvedTier(userId: string): number {
    const record = this.records.get(userId);
    return record && record.status === 'approved' ? record.tier : 0;
  }

  clear(): void {
    this.records.clear();
  }
}

/** Default singleton (override via plugin options in tests). */
export const kycStore = new MemoryKycStore();

const NAMED_SLOTS = [
  { field: 'nin_front', name: 'nin_front', kind: 'identity', folder: 'identity' },
  { field: 'nin_back', name: 'nin_back', kind: 'identity', folder: 'identity' },
  { field: 'selfie', name: 'selfie', kind: 'identity', folder: 'identity' },
  { field: 'cac_certificate', name: 'cac_certificate', kind: 'business', folder: 'business' },
  { field: 'smedan_certificate', name: 'smedan_certificate', kind: 'business', folder: 'business' },
] as const;

const TIER1_REQUIRED = ['nin_front', 'nin_back', 'selfie'] as const;
const TIER2_REQUIRED = [...TIER1_REQUIRED, 'cac_certificate'] as const;

const KycSubmitBody = t.Object({
  // t.Numeric() coerces multipart string fields ("1"/"2") to numbers.
  level: t.Numeric(),
  nin_number: t.Optional(t.String({ maxLength: 50 })),
  business_name: t.Optional(t.String({ maxLength: 255 })),
  business_type: t.Optional(t.String({ maxLength: 255 })),
  business_address: t.Optional(t.String({ maxLength: 500 })),
  business_phone: t.Optional(t.String({ maxLength: 20 })),
  business_email: t.Optional(t.String({ maxLength: 255 })),
  rc_number: t.Optional(t.String({ maxLength: 100 })),
  tin_number: t.Optional(t.String({ maxLength: 100 })),
  nin_front: t.Optional(t.File()),
  nin_back: t.Optional(t.File()),
  selfie: t.Optional(t.File()),
  cac_certificate: t.Optional(t.File()),
  smedan_certificate: t.Optional(t.File()),
  // Generic attachments: repeated "documents" multipart fields.
  documents: t.Optional(t.Any()),
});

function asFileArray(value: unknown): File[] {
  if (value instanceof File) return [value];
  if (Array.isArray(value)) return value.filter((v): v is File => v instanceof File);
  return [];
}

export interface KycPluginOptions {
  secret?: string;
  users?: UserStore;
  kyc?: MemoryKycStore;
}

export function createKycPlugin(options: KycPluginOptions = {}) {
  const kyc = options.kyc ?? kycStore;

  return applyAuthGuard(new Elysia({ prefix: '/api/v1/kyc' }), {
    secret: options.secret,
    users: options.users,
  })
    .use(createEnvelopeErrors())

    .get('/status', ({ currentUser, status }) => {
      if (!currentUser) return status(401, fail('Unauthenticated.'));
      const record = kyc.get(currentUser.id);
      if (!record) {
        return ok('No KYC profile found.', { kyc: null, tier: 0, status: null });
      }
      return ok('KYC status retrieved.', {
        kyc: serializeKyc(record),
        tier: record.tier,
        status: record.status,
      });
    })

    .post(
      '/submit',
      async ({ body, currentUser, status }) => {
        if (!currentUser) return status(401, fail('Unauthenticated.'));

        const level = body.level;
        if (level !== 1 && level !== 2) {
          return status(422, fail('Level must be 1 or 2.'));
        }

        const existing = kyc.get(currentUser.id);
        const isNew = !existing;

        // An approved KYC cannot be downgraded.
        if (existing && existing.status === 'approved' && level < existing.tier) {
          return status(
            422,
            fail(`You cannot downgrade an approved KYC. Your current tier is ${existing.tier}.`),
          );
        }

        const have = new Set(existing?.documents.map((d) => d.name) ?? []);
        const required: readonly string[] = level === 1 ? TIER1_REQUIRED : TIER2_REQUIRED;
        const missing = required.filter((slot) => {
          if (have.has(slot)) return false;
          const file = body[slot as keyof typeof body];
          return !(file instanceof File && file.size > 0);
        });
        if (level === 1 && !body.nin_number && !existing?.fields['nin_number']) {
          missing.push('nin_number');
        }
        if (missing.length > 0) {
          return status(422, fail(`Missing required KYC fields: ${missing.join(', ')}.`));
        }

        // Upload files — named slots keep stable names, extras go to documents[].
        const documents: KycDocument[] = [...(existing?.documents ?? [])];
        const putDocument = (doc: KycDocument): void => {
          const index = documents.findIndex((d) => d.name === doc.name);
          if (index >= 0) documents[index] = doc;
          else documents.push(doc);
        };

        for (const slot of NAMED_SLOTS) {
          const file = body[slot.field];
          if (file instanceof File && file.size > 0) {
            const buffer = await file.arrayBuffer();
            const uploaded = await uploadBuffer(buffer, {
              folder: `kyc/${currentUser.id}/${slot.folder}`,
              filename: `${slot.name}-${newId('file')}`,
              contentType: file.type || undefined,
            });
            putDocument({
              name: slot.name,
              url: uploaded.url,
              kind: slot.kind as KycDocument['kind'],
            });
            have.add(slot.name);
          }
        }

        for (const file of asFileArray(body.documents)) {
          if (file.size === 0) continue;
          const buffer = await file.arrayBuffer();
          const uploaded = await uploadBuffer(buffer, {
            folder: `kyc/${currentUser.id}/documents`,
            filename: file.name || `document-${newId('file')}`,
            contentType: file.type || undefined,
          });
          documents.push({ name: 'document', url: uploaded.url, kind: 'document' });
        }

        const fields: Record<string, string | string[] | null> = {
          ...(existing?.fields ?? {}),
        };
        const textFields = [
          'nin_number',
          'business_name',
          'business_type',
          'business_address',
          'business_phone',
          'business_email',
          'rc_number',
          'tin_number',
        ] as const;
        for (const key of textFields) {
          const value = body[key];
          if (value !== undefined) fields[key] = value;
        }

        const record: KycRecord = {
          userId: currentUser.id,
          tier: level,
          status: 'pending',
          rejection_reason: null,
          documents,
          fields,
          submitted_at: nowIso(),
          reviewed_at: null,
        };
        kyc.upsert(record);

        return status(isNew ? 201 : 200, {
          success: true as const,
          message: 'KYC submitted successfully. Our team will review it shortly.',
          data: {
            tier: record.tier,
            status: record.status,
          },
        });
      },
      { body: KycSubmitBody },
    );
}

/** Default singleton plugin (uses env secret + shared in-memory stores). */
export const kycPlugin = createKycPlugin();
