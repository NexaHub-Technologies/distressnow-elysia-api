/**
 * Storage service — Cloudinary-backed file uploads.
 *
 * Port of the Laravel FileUploadService (DistressNowApi/app/Services/FileUploadService.php):
 * central upload path for KYC documents, listing images, avatars and logos.
 *
 * Backwards-compatible with the previous stub consumed by the kyc/applications
 * modules: uploadBuffer(data, { folder, filename?, contentType? }) keeps its
 * signature and still resolves { url, path }. UploadResult gains an optional
 * `public_id` (present for real Cloudinary uploads and derived for mocks).
 *
 * Mock mode: when CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
 * CLOUDINARY_API_SECRET are not all set, no network calls are made and a
 * deterministic https://res.cloudinary.com/mock/... URL is returned so local
 * dev and tests run without Cloudinary credentials.
 */
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

export interface UploadOptions {
  /** Destination folder, e.g. "kyc/<userId>/identity". */
  folder: string;
  /** File name (extension preserved when present). Defaults to a generated name. */
  filename?: string;
  /** MIME type hint, e.g. "image/png". */
  contentType?: string;
}

export interface UploadResult {
  /** Public (secure) URL of the stored file. */
  url: string;
  /** Storage path / public id of the stored file. */
  path: string;
  /** Cloudinary public id (present for real uploads; derived in mock mode). */
  public_id?: string;
}

function cloudinaryCreds(): { cloudName: string; apiKey: string; apiSecret: string } {
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
  };
}

/** True when Cloudinary credentials are incomplete — uploads run in mock mode. */
export function isMockMode(): boolean {
  const { cloudName, apiKey, apiSecret } = cloudinaryCreds();
  return !cloudName || !apiKey || !apiSecret;
}

function ensureConfigured(): void {
  const { cloudName, apiKey, apiSecret } = cloudinaryCreds();
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

function toBuffer(data: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function cleanFolder(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, "");
}

function splitFilename(filename: string): { publicId: string; extension?: string } {
  const dot = filename.lastIndexOf(".");
  if (dot > 0 && dot < filename.length - 1) {
    return { publicId: filename.slice(0, dot), extension: filename.slice(dot + 1) };
  }
  return { publicId: filename };
}

let counter = 0;

/**
 * Upload a file buffer to Cloudinary (or mock when credentials are missing).
 * Resolves — never rejects in mock mode — so callers do not need a fallback.
 */
export async function uploadBuffer(
  data: Buffer | Uint8Array | ArrayBuffer,
  options: UploadOptions,
): Promise<UploadResult> {
  const folder = cleanFolder(options.folder);
  const filename = options.filename ?? `upload-${Date.now()}-${(counter += 1)}`;
  const { publicId } = splitFilename(filename);
  const fullPublicId = `${folder}/${publicId}`;

  if (isMockMode()) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "mock";
    console.log(`[storage:mock] ${folder}/${filename} (${toBuffer(data).byteLength} bytes)`);
    return {
      url: `https://res.cloudinary.com/${cloudName}/image/upload/${fullPublicId}`,
      path: fullPublicId,
      public_id: fullPublicId,
    };
  }

  ensureConfigured();
  const buffer = toBuffer(data);

  const uploaded: UploadApiResponse = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type: "auto",
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary upload failed with no result."));
          return;
        }
        resolve(result);
      },
    );
    stream.end(buffer);
  });

  return {
    url: uploaded.secure_url || uploaded.url,
    path: uploaded.public_id,
    public_id: uploaded.public_id,
  };
}

/** Upload a KYC document for a user into kyc/<userId>/<slot>. */
export async function uploadKycDoc(
  data: Buffer | Uint8Array | ArrayBuffer,
  userId: string,
  slot: string,
  filename?: string,
  contentType?: string,
): Promise<UploadResult> {
  return uploadBuffer(data, {
    folder: `kyc/${userId}/${slot}`,
    filename: filename ?? `${slot}-${Date.now()}`,
    contentType,
  });
}

/** Upload a listing image into listings/<listingId>. */
export async function uploadListingImage(
  data: Buffer | Uint8Array | ArrayBuffer,
  listingId: string,
  filename?: string,
  contentType?: string,
): Promise<UploadResult> {
  return uploadBuffer(data, {
    folder: `listings/${listingId}`,
    filename: filename ?? `image-${Date.now()}`,
    contentType,
  });
}

/** Delete an asset by its Cloudinary public id. Mock mode resolves without I/O. */
export async function deleteByPublicId(publicId: string): Promise<{ result: string }> {
  if (isMockMode()) {
    console.log(`[storage:mock] destroy ${publicId}`);
    return { result: "ok (mock)" };
  }
  ensureConfigured();
  const res = await cloudinary.uploader.destroy(publicId);
  return { result: res.result ?? "ok" };
}
