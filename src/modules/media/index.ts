/**
 * Media module — Elysia plugin, prefix /api/v1/media.
 *
 * Single upload endpoint shared by the KYC and listing flows:
 *  - POST /upload — auth — multipart { file, folder? } → Cloudinary
 *
 * Files are stored via src/services/storage.ts uploadBuffer() (Cloudinary,
 * mock mode when CLOUDINARY_* credentials are missing).
 *
 * Auth: real JWT guard (applyAuthGuard) resolving the shared UserStore.
 */
import { Elysia, t } from "elysia";
import { uploadBuffer } from "../../services/storage";
import { applyAuthGuard, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";

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

export interface MediaPluginOptions {
  users?: UserStore;
  secret?: string;
}

export function createMediaPlugin(options: MediaPluginOptions = {}) {
  return applyAuthGuard(new Elysia({ prefix: "/api/v1/media" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  }).post(
    "/upload",
    async ({ body, currentUser, status }) => {
      if (!currentUser) return status(401, fail("Unauthenticated."));
      const user = currentUser;

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
