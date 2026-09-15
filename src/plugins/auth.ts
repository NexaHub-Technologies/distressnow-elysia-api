import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { kycProfiles, modelHasRoles, roles, users } from "../db/schema";
import { env } from "../env";
import { fail } from "../utils/response";

export interface JwtPayload {
  sub: number;
  roles: string[];
}

export type CurrentUser = typeof users.$inferSelect;

async function rolesForUser(userId: number): Promise<string[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(roles)
    .innerJoin(modelHasRoles, eq(modelHasRoles.roleId, roles.id))
    .where(eq(modelHasRoles.modelId, userId));
  // model_has_roles is polymorphic; this project only stores users here.
  return rows.map((r) => r.name);
}

/**
 * Base auth plugin — verifies the Bearer JWT and derives `currentUser`.
 * Null when no/invalid token (public routes stay public).
 * JWT payload: { sub: userId, roles: string[] }, 7-day expiry (Sanctum parity).
 */
export const auth = new Elysia({ name: "auth" })
  .use(jwt({ name: "jwt", secret: env.JWT_SECRET, exp: "7d" }))
  .derive(
    { as: "scoped" },
    async ({
      jwt,
      headers,
    }): Promise<{ currentUser: CurrentUser | null; userRoles: string[] }> => {
      const none = { currentUser: null, userRoles: [] as string[] };
      const header = headers["authorization"];
      if (!header || !header.startsWith("Bearer ")) return none;

      const payload = (await jwt.verify(header.slice(7))) as unknown as Partial<JwtPayload> | null;
      if (!payload || typeof payload.sub !== "number") return none;

      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1);
      const user = rows[0];
      if (!user) return none;

      const userRoles =
        Array.isArray(payload.roles) && payload.roles.length > 0
          ? payload.roles.filter((r): r is string => typeof r === "string")
          : await rolesForUser(user.id);

      return { currentUser: user, userRoles };
    },
  );

/** 401 when unauthenticated. Compose with `.use(requireAuth)` + `.guard()`. */
export const requireAuth = new Elysia({ name: "require-auth" })
  .use(auth)
  .onBeforeHandle({ as: "scoped" }, ({ currentUser, set }) => {
    if (!currentUser) {
      set.status = 401;
      return fail("Unauthenticated.");
    }
  });

/**
 * 403 when the user is suspended.
 * Mirrors Laravel `not_suspended` middleware (EnsureNotSuspended).
 */
export const notSuspended = new Elysia({ name: "not-suspended" })
  .use(auth)
  .onBeforeHandle({ as: "scoped" }, ({ currentUser, set }) => {
    if (currentUser?.isSuspended) {
      set.status = 403;
      return {
        success: false,
        message: "Your account has been suspended. Please contact support.",
        data: { suspended: true, reason: currentUser.suspensionReason },
        errors: null,
      };
    }
  });

/**
 * Staff gate. Mirrors Laravel `role:admin|verifier`.
 * `requireRole("admin")` = admin-only; `requireRole("admin", "verifier")` = staff.
 */
export function requireRole(...allowed: Array<"admin" | "verifier">) {
  return new Elysia({ name: `require-role:${allowed.join(",")}` })
    .use(auth)
    .onBeforeHandle({ as: "scoped" }, ({ currentUser, userRoles, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      if (!allowed.some((r) => (userRoles ?? []).includes(r))) {
        set.status = 403;
        return fail("Forbidden. Insufficient permissions.");
      }
    });
}

/**
 * KYC tier gate. Mirrors Laravel `kyc:1` / `kyc:2` (RequireKyc):
 * approved profile with tier >= required (1 = provider, 2 = seller).
 */
export function requireKyc(level: 1 | 2) {
  const requiredRole = level >= 2 ? "seller" : "provider";
  return new Elysia({ name: `require-kyc:${level}` })
    .use(auth)
    .onBeforeHandle({ as: "scoped" }, async ({ currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const rows = await db
        .select()
        .from(kycProfiles)
        .where(eq(kycProfiles.userId, currentUser.id))
        .limit(1);
      const kyc = rows[0];
      const ok =
        kyc?.status === "approved" &&
        (requiredRole === "seller" ? kyc.tier >= 2 : kyc.tier >= 1);
      if (!ok) {
        set.status = 403;
        return {
          success: false,
          message:
            level >= 2
              ? "You must complete Business KYC verification (Tier 2) before applying as a seller."
              : "You must complete Identity KYC verification (Tier 1) before applying as a provider.",
          data: {
            kyc_required: true,
            required_tier: level,
            current_tier: kyc?.tier ?? 0,
            kyc_status: kyc?.status ?? null,
          },
          errors: null,
        };
      }
    });
}

export async function signToken(
  sign: (payload: JwtPayload) => Promise<string>,
  userId: number,
  userRoles: string[],
): Promise<string> {
  return sign({ sub: userId, roles: userRoles });
}
