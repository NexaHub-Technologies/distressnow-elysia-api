CREATE TABLE "service_provider_views" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"service_provider_id" bigint NOT NULL,
	"viewer_id" bigint,
	"ip_address" varchar(45),
	"user_agent" text,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_providers" ADD COLUMN "views_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_settings" jsonb;--> statement-breakpoint
ALTER TABLE "service_provider_views" ADD CONSTRAINT "service_provider_views_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "public"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_provider_views" ADD CONSTRAINT "service_provider_views_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_provider_views_provider_viewed_idx" ON "service_provider_views" USING btree ("service_provider_id","viewed_at");--> statement-breakpoint
CREATE INDEX "service_provider_views_viewer_viewed_idx" ON "service_provider_views" USING btree ("viewer_id","viewed_at");