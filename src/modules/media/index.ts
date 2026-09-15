/**
 * Media module — Elysia plugin, prefix /api/v1/media.
 *
 * Single upload endpoint shared by the KYC and listing flows:
 *  - POST /upload — auth — multipart { file, folder? } → Cloudinary
 *
 * Files are stored via src/services/storage.ts uploadBuffer() (Cloudinary,
 * mock mode when CLOUDINARY_* credentials are missing).
 *
 * Auth: local header stub (x-user-id required).
 * TODO(auth): replace resolveMediaUser() with createAuthGuard() from
 * ../auth/index once the auth integration pass happens.
 */
import { Elysia, t } from "elysia";
import { uploadBuffer } from "../../services/storage";

// ── Envelope (same shape as the auth module) ─────────────────────────────────

export function ok<T>(message: string, data: T): {
  success: true;
  message: string;
  data: T;
} {
  return { success: true, message, data };
}

export function fail(message: string): {
  success: false;
  message: string;
  data: null;
} {
  return { success: false, message, data: null };
}

// ── Auth stub ────────────────────────────────────────────────────────────────

export interface MediaUser {
  id: string;
}

export function resolveMediaUser(
  headers: Record<string, string | string[] | undefined>,
): MediaUser | null {
  const rawId = headers["x-user-id"];
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) return null;
  return { id };
}

// ── Folder validation ────────────────────────────────────────────────────────

/** Allowed folder characters: letters, digits, slash, dash, underscore. */
export function sanitizeFolder(folder: string | undefined, userId: string): string {
  const fallback = `uploads/${userId}`;
  if (!folder) return fallback;
  const cleaned = folder.replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned.includes("..") || !/^[A-Za-z0-9/_-]+$/.test(cleaned)) {
    throw new Error(
      "Invalid folder. Use letters, numbers, slash, dash and underscore only.",
    );
  }
  return cleaned;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

const UploadBody = t.Object({
  file: t.File(),
  folder: t.Optional(t.String({ maxLength: 128 })),
});

export function createMediaPlugin() {
  return new Elysia({ prefix: "/api/v1/media" }).post(
    "/upload",
    async ({ body, headers, status }) => {
      const user = resolveMediaUser(headers);
      if (!user) return status(401, fail("Unauthenticated."));

      let folder: string;
      try {
        folder = sanitizeFolder(body.folder, user.id);
      } catch (err) {
        return status(422, fail((err as Error).message));
      }

      if (!(body.file instanceof File) || body.file.size === 0) {
        return status(422, fail("A non-empty file is required."));
      }

      const buffer = Buffer.from(await body.file.arrayBuffer());
      const uploaded = await uploadBuffer(buffer, {
        folder,
        filename: body.file.name || `upload-${Date.now()}`,
        contentType: body.file.type || undefined,
      });

      return status(201, ok("Upload successful.", {
        url: uploaded.url,
        public_id: uploaded.public_id ?? uploaded.path,
        path: uploaded.path,
      }));
    },
    { body: UploadBody },
  );
}

/** Default singleton plugin. */
export const mediaApp = createMediaPlugin();
