import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgres://postgres:postgres@localhost:5432/distressnow"),
  JWT_SECRET: z.string().default("dev-secret-change-me"),
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

export type Env = z.infer<typeof envSchema> & { PAYSTACK_SECRET_RESOLVED: string };

function loadEnv(): Env {
  const parsed = envSchema.parse(process.env);
  return {
    ...parsed,
    PAYSTACK_SECRET_RESOLVED: parsed.PAYSTACK_SECRET_KEY || parsed.PAYSTACK_SECRET,
  };
}

export const env: Env = loadEnv();
