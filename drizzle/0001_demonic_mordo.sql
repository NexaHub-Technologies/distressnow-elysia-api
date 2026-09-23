CREATE TABLE "item_request_responses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"item_request_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"message" text NOT NULL,
	"listing_id" bigint,
	"images" jsonb,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_request_responses_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "req_store_response_unique" UNIQUE("item_request_id","store_id")
);
--> statement-breakpoint
CREATE TABLE "item_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"category_id" bigint,
	"subcategory_id" bigint,
	"state_id" bigint,
	"sublocation_id" bigint,
	"budget_min" numeric(12, 2),
	"budget_max" numeric(12, 2),
	"images" jsonb,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"responses_count" integer DEFAULT 0 NOT NULL,
	"broadcast_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_requests_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "profile_views" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"viewer_id" bigint,
	"ip_address" varchar(45),
	"user_agent" text,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_views" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" bigint NOT NULL,
	"viewer_id" bigint,
	"ip_address" varchar(45),
	"user_agent" text,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text,
	"group" varchar(100) DEFAULT 'general' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "adverts" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "adverts" ADD COLUMN "placement" varchar(50) DEFAULT 'banner' NOT NULL;--> statement-breakpoint
ALTER TABLE "adverts" ADD COLUMN "package_id" varchar(50);--> statement-breakpoint
ALTER TABLE "adverts" ADD COLUMN "payment_reference" varchar(100);--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "views_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "is_promoted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "promotion_type" varchar(50);--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "promotion_expiry" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_views_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_request_responses" ADD CONSTRAINT "item_request_responses_item_request_id_item_requests_id_fk" FOREIGN KEY ("item_request_id") REFERENCES "public"."item_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_request_responses" ADD CONSTRAINT "item_request_responses_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_request_responses" ADD CONSTRAINT "item_request_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_request_responses" ADD CONSTRAINT "item_request_responses_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_subcategory_id_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."subcategories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_sublocation_id_sublocations_id_fk" FOREIGN KEY ("sublocation_id") REFERENCES "public"."sublocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_views" ADD CONSTRAINT "store_views_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_views" ADD CONSTRAINT "store_views_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_request_responses_user_idx" ON "item_request_responses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "item_request_responses_store_idx" ON "item_request_responses" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "item_request_responses_status_idx" ON "item_request_responses" USING btree ("status");--> statement-breakpoint
CREATE INDEX "item_request_responses_created_at_idx" ON "item_request_responses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "item_requests_status_idx" ON "item_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "item_requests_created_at_idx" ON "item_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "item_requests_state_status_idx" ON "item_requests" USING btree ("state_id","status");--> statement-breakpoint
CREATE INDEX "item_requests_category_status_idx" ON "item_requests" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "profile_views_user_viewed_idx" ON "profile_views" USING btree ("user_id","viewed_at");--> statement-breakpoint
CREATE INDEX "profile_views_viewer_viewed_idx" ON "profile_views" USING btree ("viewer_id","viewed_at");--> statement-breakpoint
CREATE INDEX "store_views_store_viewed_idx" ON "store_views" USING btree ("store_id","viewed_at");--> statement-breakpoint
CREATE INDEX "store_views_viewer_viewed_idx" ON "store_views" USING btree ("viewer_id","viewed_at");--> statement-breakpoint
CREATE INDEX "system_settings_key_idx" ON "system_settings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "system_settings_group_idx" ON "system_settings" USING btree ("group");