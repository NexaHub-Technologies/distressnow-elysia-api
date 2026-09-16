import { z } from "zod";

export const DEFAULT_JWT_SECRET = "dev-secret-change-me";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .default("postgres://postgres:postgres@localhost:5432/distressnow"),
  JWT_SECRET: z.string().default(DEFAULT_JWT_SECRET),
  PORT: z.coerce.number().int().positive().default(3000),

  RESEND_API_KEY: z.string().default(""),
  RESEND_FROM: z.string().default("no-reply@distressnow.com"),

  TERMII_API_KEY: z.string().default(""),
  TERMII_SENDER_ID: z.string().default("DistressNow"),
  TERMII_BASE_URL: z.string().default("https://api.ng.termii.com"),

  CLOUDINARY_CLOUD_NAME: z.string().default(""),
  CLOUDINARY_API_KEY: z.string().default(""),
  CLOUDINARY_API_SECRET: z.string().default(""),

  // Canonical key (matches Laravel config/paystack.php); legacy alias supported.
  PAYSTACK_SECRET_KEY: z.string().default(""),
  PAYSTACK_SECRET: z.string().default(""),
  PAYSTACK_PUBLIC_KEY: z.string().default(""),

  EXPO_ACCESS_TOKEN: z.string().default(""),
});

export type Env = z.infer<typeof envSchema> & {
  PAYSTACK_SECRET_RESOLVED: string;
  IS_PRODUCTION: boolean;
};

/** JWT minimum length — rejects default/placeholder secrets in production. */
export const MIN_JWT_SECRET_LENGTH = 32;

function loadEnv(): Env {
  const parsed = envSchema.parse(process.env);
  const isProduction = parsed.NODE_ENV === "production";

  if (
    isProduction &&
    (parsed.JWT_SECRET === DEFAULT_JWT_SECRET ||
      parsed.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH)
  ) {
    throw new Error(
      `Refusing to boot in NODE_ENV=production with an insecure JWT_SECRET. ` +
        `Set JWT_SECRET to a random string of at least ${MIN_JWT_SECRET_LENGTH} characters ` +
        `in your environment (e.g. "openssl rand -hex 32").`,
    );
  }

  return {
    ...parsed,
    PAYSTACK_SECRET_RESOLVED: parsed.PAYSTACK_SECRET_KEY || parsed.PAYSTACK_SECRET,
    IS_PRODUCTION: isProduction,
  };
}

export const env: Env = loadEnv();