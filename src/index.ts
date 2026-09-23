import cors from "@elysiajs/cors";
import swagger from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { env } from "./env";
import { errorsPlugin } from "./plugins/errors";
import { ok } from "./utils/response";

// Full-prefix plugins (mount at root — they already contain /api/v1/...)
import { authPlugin } from "./modules/auth/index";
import { kycPlugin } from "./modules/kyc/index";
import { applicationsPlugin } from "./modules/applications/index";
import { createAdminPlugin } from "./modules/admin/index";
import { createMediaPlugin } from "./modules/media/index";
import { createPaymentsPlugin } from "./modules/payments/index";

// Group-mounted modules (mounted inside /api/v1)
import catalog from "./modules/catalog/index";
import listingsModule from "./modules/listings/index";
import storesModule from "./modules/stores/index";
import providersModule from "./modules/providers/index";
import bookingsModule from "./modules/bookings/index";
import reviewsModule from "./modules/reviews/index";
import savedSearchesModule from "./modules/saved-searches/index";
import searchModule from "./modules/search/index";
import advertsApp from "./modules/adverts/index";
import chatApp from "./modules/chat/index";
import notificationsApp from "./modules/notifications/index";
import supportApp from "./modules/support/index";
import referralsApp from "./modules/referrals/index";
import safetyApp from "./modules/safety/index";
import itemRequestsModule from "./modules/item-requests/index";
import viewTrackingModule from "./modules/view-tracking/index";

export const app = new Elysia()
  .use(cors())
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "DistressNow API",
          version: "1.0.0",
          description:
            "DistressNow marketplace API (Bun + Elysia + Postgres port of the Laravel 11 backend). Resend for email, Termii for SMS, Cloudinary for media.",
        },
      },
    }),
  )
  .use(errorsPlugin)
  .get("/health", () => ok({ status: "ok" }, "Healthy."))
  // Full-prefix: auth / kyc / applications / admin / media / payments
  .use(authPlugin)
  .use(kycPlugin)
  .use(applicationsPlugin)
  .use(createAdminPlugin())
  .use(createMediaPlugin())
  .use(createPaymentsPlugin())
  // Everything else lives under /api/v1/*
  .group("/api/v1", (api) =>
    api
      .use(catalog)
      .use(searchModule)
      .use(listingsModule)
      .use(storesModule)
      .use(providersModule)
      .use(bookingsModule)
      .use(reviewsModule)
      .use(savedSearchesModule)
      .use(advertsApp)
      .use(chatApp)
      .use(notificationsApp)
      .use(supportApp)
      .use(referralsApp)
      .use(safetyApp)
      .use(itemRequestsModule)
      .use(viewTrackingModule)
      .get("/", () => ok({ version: "v1" }, "DistressNow API v1.")),
  );

// Export `app` without listening so bun:test can import it.
// Only bind a port when executed directly: `bun run src/index.ts`.
if (import.meta.main) {
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`DistressNow API listening on :${env.PORT} (docs at /docs)`);
  });
}

export type App = typeof app;
