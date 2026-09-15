CREATE TYPE "public"."application_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('email', 'phone', 'google', 'apple');--> statement-breakpoint
CREATE TYPE "public"."broadcast_audience" AS ENUM('all', 'role', 'state', 'users');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('queued', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_message_type" AS ENUM('text', 'image', 'file');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."otp_type" AS ENUM('phone_signup', 'email_signup', 'phone_reset', 'email_reset');--> statement-breakpoint
CREATE TYPE "public"."presence_status" AS ENUM('online', 'away', 'offline');--> statement-breakpoint
CREATE TYPE "public"."provider_application_availability" AS ENUM('immediate', 'scheduled', 'busy', 'weekends', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."provider_availability" AS ENUM('immediate', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."sender_type" AS ENUM('user', 'support', 'system');--> statement-breakpoint
CREATE TYPE "public"."ticket_category" AS ENUM('general_inquiry', 'report_issue', 'account_services', 'listing_issues', 'verification_issues', 'billing', 'other');--> statement-breakpoint
CREATE TYPE "public"."ticket_platform" AS ENUM('mobile', 'web', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'pending', 'resolved', 'closed');--> statement-breakpoint
CREATE TABLE "admin_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_id" bigint NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" bigint,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adverts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"listing_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"image_path" text,
	"target_url" text,
	"duration_days" integer DEFAULT 7 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"amount_paid" numeric(10, 2) DEFAULT '0' NOT NULL,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adverts_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"provider_id" bigint NOT NULL,
	"service_type" text NOT NULL,
	"description" text,
	"preferred_date" date,
	"preferred_time" text,
	"location_text" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"quoted_price" numeric(12, 2),
	"final_price" numeric(12, 2),
	"status" text DEFAULT 'pending' NOT NULL,
	"cancellation_reason" text,
	"cancelled_by" bigint,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"icon" text,
	"image_path" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" varchar(191) NOT NULL,
	"participant_key" varchar(64) NOT NULL,
	"client_message_id" varchar(128) NOT NULL,
	"sender_id" bigint NOT NULL,
	"receiver_id" bigint NOT NULL,
	"message" text,
	"message_type" "chat_message_type" DEFAULT 'text' NOT NULL,
	"attachment_url" varchar(2048),
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_client_dedupe_unique" UNIQUE("conversation_id","sender_id","client_message_id")
);
--> statement-breakpoint
CREATE TABLE "contact_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider_id" bigint NOT NULL,
	"requested_by" bigint NOT NULL,
	"proposed_changes" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"token" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"device_name" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "favorite_listings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"listing_id" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorite_listings_user_listing_unique" UNIQUE("user_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "kyc_profiles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"tier" smallint DEFAULT 0 NOT NULL,
	"status" "kyc_status",
	"rejection_reason" text,
	"nin_number" text,
	"nin_front_path" text,
	"nin_back_path" text,
	"selfie_path" text,
	"business_name" text,
	"business_type" text,
	"rc_number" text,
	"tin_number" text,
	"business_address" text,
	"business_phone" varchar(20),
	"business_email" text,
	"alternate_business_phone" varchar(20),
	"store_categories" jsonb,
	"cac_certificate_path" text,
	"smedan_certificate_path" text,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "listing_images" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"listing_id" bigint NOT NULL,
	"path" text NOT NULL,
	"url" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"store_id" bigint,
	"category_id" bigint NOT NULL,
	"subcategory_id" bigint,
	"state_id" bigint NOT NULL,
	"sublocation_id" bigint,
	"category_specific_fields" jsonb,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"discount_price" numeric(12, 2),
	"discount_percentage" integer DEFAULT 0 NOT NULL,
	"is_discounted" boolean DEFAULT false NOT NULL,
	"condition" text DEFAULT 'used' NOT NULL,
	"listing_scope" text DEFAULT 'personal' NOT NULL,
	"deal_type" text DEFAULT 'standard' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"promoted" boolean DEFAULT false NOT NULL,
	"promotion_type" text,
	"promotion_expiry" timestamp with time zone,
	"featured" boolean DEFAULT false NOT NULL,
	"views_count" bigint DEFAULT 0 NOT NULL,
	"clicks_count" bigint DEFAULT 0 NOT NULL,
	"favorites_count" bigint DEFAULT 0 NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "listings_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state_id" bigint NOT NULL,
	"sublocation_id" bigint,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"address" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "markets_state_slug_unique" UNIQUE("state_id","slug")
);
--> statement-breakpoint
CREATE TABLE "model_has_permissions" (
	"permission_id" bigint NOT NULL,
	"model_type" text NOT NULL,
	"model_id" bigint NOT NULL,
	CONSTRAINT "model_has_permissions_permission_id_model_id_model_type_pk" PRIMARY KEY("permission_id","model_id","model_type")
);
--> statement-breakpoint
CREATE TABLE "model_has_roles" (
	"role_id" bigint NOT NULL,
	"model_type" text NOT NULL,
	"model_id" bigint NOT NULL,
	CONSTRAINT "model_has_roles_role_id_model_id_model_type_pk" PRIMARY KEY("role_id","model_id","model_type")
);
--> statement-breakpoint
CREATE TABLE "notification_broadcasts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_id" bigint NOT NULL,
	"audience" "broadcast_audience" DEFAULT 'all' NOT NULL,
	"audience_role" text,
	"audience_state" text,
	"audience_user_ids" jsonb,
	"type" varchar(60) DEFAULT 'announcement' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"channels" jsonb,
	"status" "broadcast_status" DEFAULT 'queued' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"type" varchar(60) NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"smsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"code" varchar(10) NOT NULL,
	"type" "otp_type" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"email" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"guard_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_name_guard_unique" UNIQUE("name","guard_name")
);
--> statement-breakpoint
CREATE TABLE "provider_applications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"kyc_profile_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"business_name" text,
	"bio" text,
	"service_categories" jsonb NOT NULL,
	"years_experience" smallint DEFAULT 0 NOT NULL,
	"price_range" text,
	"response_time" text,
	"availability" "provider_application_availability" DEFAULT 'immediate' NOT NULL,
	"location_state" text NOT NULL,
	"location_sublocation" text NOT NULL,
	"location_lat" numeric(10, 7),
	"location_lng" numeric(10, 7),
	"contact_phone" varchar(20) NOT NULL,
	"contact_whatsapp" varchar(20),
	"photo_path" text,
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"declined_reason" text,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recently_viewed_listings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"listing_id" bigint NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "recently_viewed_user_listing_unique" UNIQUE("user_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "referral_attributions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint,
	"referral_code" text,
	"campaign_id" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"registered_user_id" bigint,
	"metadata" jsonb,
	"registered_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_attributions_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"reviewable_type" text NOT NULL,
	"reviewable_id" bigint NOT NULL,
	"booking_id" bigint,
	"rating" smallint NOT NULL,
	"comment" text,
	"reply" text,
	"replied_by" bigint,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "role_has_permissions" (
	"permission_id" bigint NOT NULL,
	"role_id" bigint NOT NULL,
	CONSTRAINT "role_has_permissions_permission_id_role_id_pk" PRIMARY KEY("permission_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"guard_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_guard_unique" UNIQUE("name","guard_name")
);
--> statement-breakpoint
CREATE TABLE "safety_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" bigint NOT NULL,
	"report_type" varchar(40) NOT NULL,
	"message" text NOT NULL,
	"listing_id" uuid,
	"reported_user_id" bigint,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "safety_reports_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_applications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"kyc_profile_id" bigint NOT NULL,
	"store_name" text NOT NULL,
	"store_description" text,
	"store_phone" varchar(20) NOT NULL,
	"store_email" text NOT NULL,
	"store_state" text NOT NULL,
	"store_sublocation" text NOT NULL,
	"store_market" text NOT NULL,
	"store_categories" jsonb NOT NULL,
	"store_logo_path" text,
	"store_address" text,
	"store_lat" numeric(10, 7),
	"store_lng" numeric(10, 7),
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"declined_reason" text,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_providers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"bio" text,
	"photo_path" text,
	"service_categories" jsonb NOT NULL,
	"experience_years" integer DEFAULT 0 NOT NULL,
	"price_range" text,
	"response_time" text,
	"availability" "provider_availability" DEFAULT 'immediate' NOT NULL,
	"phone" varchar(20),
	"whatsapp" varchar(20),
	"state_id" bigint,
	"sublocation_id" bigint,
	"location_text" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"skills" jsonb,
	"is_verified" boolean DEFAULT false NOT NULL,
	"rating" numeric(3, 2) DEFAULT '0' NOT NULL,
	"total_reviews" integer DEFAULT 0 NOT NULL,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"total_services" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_providers_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "service_providers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "states" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "states_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "states_name_unique" UNIQUE("name"),
	CONSTRAINT "states_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "store_follows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_follows_user_store_unique" UNIQUE("user_id","store_id")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"logo_path" text,
	"banner_path" text,
	"phone" varchar(20),
	"email" text,
	"whatsapp_number" varchar(20),
	"state_id" bigint,
	"sublocation_id" bigint,
	"market_id" bigint,
	"address" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"categories" jsonb,
	"social_links" jsonb,
	"opening_hours" jsonb,
	"is_verified" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rating" numeric(3, 2) DEFAULT '0' NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"listings_count" integer DEFAULT 0 NOT NULL,
	"followers_count" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "stores_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "subcategories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"category_id" bigint NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subcategories_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "subcategories_category_slug_unique" UNIQUE("category_id","slug")
);
--> statement-breakpoint
CREATE TABLE "sublocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state_id" bigint NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sublocations_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "sublocations_state_slug_unique" UNIQUE("state_id","slug")
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"support_ticket_id" bigint NOT NULL,
	"user_id" bigint,
	"sender_type" "sender_type" DEFAULT 'user' NOT NULL,
	"message" text NOT NULL,
	"attachments" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_number" varchar(20) NOT NULL,
	"user_id" bigint NOT NULL,
	"subject" text NOT NULL,
	"category" "ticket_category" DEFAULT 'general_inquiry' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"platform" "ticket_platform" DEFAULT 'unknown' NOT NULL,
	"last_message" text,
	"last_message_at" timestamp with time zone,
	"assigned_to" bigint,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_ticket_number_unique" UNIQUE("ticket_number")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"booking_id" bigint,
	"reference" text NOT NULL,
	"paystack_reference" text,
	"amount" numeric(12, 2) NOT NULL,
	"amount_kobo" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"channel" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"gateway_response" text,
	"ip_address" text,
	"metadata" jsonb,
	"authorization" jsonb,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "transactions_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"phone" varchar(20),
	"phone_verified_at" timestamp with time zone,
	"whatsapp_number" varchar(20),
	"password" text,
	"avatar_path" text,
	"auth_provider" "auth_provider" DEFAULT 'email' NOT NULL,
	"provider_id" text,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"location_state" text,
	"location_sublocation" text,
	"interests" jsonb,
	"is_suspended" boolean DEFAULT false NOT NULL,
	"suspension_reason" text,
	"suspended_at" timestamp with time zone,
	"suspended_by" bigint,
	"presence_status" "presence_status" DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"typing_in_conversation" varchar(191),
	"typing_at" timestamp with time zone,
	"remember_token" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "admin_logs" ADD CONSTRAINT "admin_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adverts" ADD CONSTRAINT "adverts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_id_service_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_receiver_id_users_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_updates" ADD CONSTRAINT "contact_updates_provider_id_service_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_updates" ADD CONSTRAINT "contact_updates_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_updates" ADD CONSTRAINT "contact_updates_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite_listings" ADD CONSTRAINT "favorite_listings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite_listings" ADD CONSTRAINT "favorite_listings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_subcategory_id_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."subcategories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_sublocation_id_sublocations_id_fk" FOREIGN KEY ("sublocation_id") REFERENCES "public"."sublocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_sublocation_id_sublocations_id_fk" FOREIGN KEY ("sublocation_id") REFERENCES "public"."sublocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_has_permissions" ADD CONSTRAINT "model_has_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_has_roles" ADD CONSTRAINT "model_has_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_broadcasts" ADD CONSTRAINT "notification_broadcasts_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_applications" ADD CONSTRAINT "provider_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_applications" ADD CONSTRAINT "provider_applications_kyc_profile_id_kyc_profiles_id_fk" FOREIGN KEY ("kyc_profile_id") REFERENCES "public"."kyc_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_applications" ADD CONSTRAINT "provider_applications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recently_viewed_listings" ADD CONSTRAINT "recently_viewed_listings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recently_viewed_listings" ADD CONSTRAINT "recently_viewed_listings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_registered_user_id_users_id_fk" FOREIGN KEY ("registered_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_replied_by_users_id_fk" FOREIGN KEY ("replied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_has_permissions" ADD CONSTRAINT "role_has_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_has_permissions" ADD CONSTRAINT "role_has_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_applications" ADD CONSTRAINT "seller_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_applications" ADD CONSTRAINT "seller_applications_kyc_profile_id_kyc_profiles_id_fk" FOREIGN KEY ("kyc_profile_id") REFERENCES "public"."kyc_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_applications" ADD CONSTRAINT "seller_applications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_sublocation_id_sublocations_id_fk" FOREIGN KEY ("sublocation_id") REFERENCES "public"."sublocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_follows" ADD CONSTRAINT "store_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_follows" ADD CONSTRAINT "store_follows_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_sublocation_id_sublocations_id_fk" FOREIGN KEY ("sublocation_id") REFERENCES "public"."sublocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sublocations" ADD CONSTRAINT "sublocations_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_support_ticket_id_support_tickets_id_fk" FOREIGN KEY ("support_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_logs_admin_created_idx" ON "admin_logs" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_logs_target_idx" ON "admin_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "adverts_status_expires_idx" ON "adverts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "adverts_user_idx" ON "adverts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bookings_user_status_idx" ON "bookings" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "bookings_provider_status_idx" ON "bookings" USING btree ("provider_id","status");--> statement-breakpoint
CREATE INDEX "bookings_preferred_date_idx" ON "bookings" USING btree ("preferred_date");--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_created_idx" ON "chat_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_participant_created_idx" ON "chat_messages" USING btree ("participant_key","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_receiver_read_idx" ON "chat_messages" USING btree ("receiver_id","read_at");--> statement-breakpoint
CREATE INDEX "contact_updates_status_created_idx" ON "contact_updates" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "device_tokens_user_platform_idx" ON "device_tokens" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "listings_status_category_idx" ON "listings" USING btree ("status","category_id");--> statement-breakpoint
CREATE INDEX "listings_deal_type_idx" ON "listings" USING btree ("deal_type");--> statement-breakpoint
CREATE INDEX "listings_promoted_idx" ON "listings" USING btree ("promoted");--> statement-breakpoint
CREATE INDEX "model_has_permissions_model_idx" ON "model_has_permissions" USING btree ("model_id","model_type");--> statement-breakpoint
CREATE INDEX "model_has_roles_model_idx" ON "model_has_roles" USING btree ("model_id","model_type");--> statement-breakpoint
CREATE INDEX "notification_broadcasts_admin_created_idx" ON "notification_broadcasts" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_broadcasts_status_created_idx" ON "notification_broadcasts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_codes_identifier_type_idx" ON "otp_codes" USING btree ("identifier","type");--> statement-breakpoint
CREATE INDEX "provider_applications_user_status_idx" ON "provider_applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "referral_attributions_code_idx" ON "referral_attributions" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "referral_attributions_status_created_idx" ON "referral_attributions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reviews_reviewable_rating_idx" ON "reviews" USING btree ("reviewable_type","reviewable_id","rating");--> statement-breakpoint
CREATE INDEX "reviews_user_idx" ON "reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "safety_reports_status_created_idx" ON "safety_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "safety_reports_reporter_idx" ON "safety_reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "saved_searches_user_created_idx" ON "saved_searches" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "seller_applications_user_status_idx" ON "seller_applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "service_providers_state_sublocation_idx" ON "service_providers" USING btree ("state_id","sublocation_id");--> statement-breakpoint
CREATE INDEX "service_providers_verified_idx" ON "service_providers" USING btree ("is_verified");--> statement-breakpoint
CREATE INDEX "service_providers_availability_idx" ON "service_providers" USING btree ("availability");--> statement-breakpoint
CREATE INDEX "store_follows_store_idx" ON "store_follows" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "stores_state_sublocation_idx" ON "stores" USING btree ("state_id","sublocation_id");--> statement-breakpoint
CREATE INDEX "stores_verified_status_idx" ON "stores" USING btree ("is_verified","status");--> statement-breakpoint
CREATE INDEX "support_messages_ticket_created_idx" ON "support_messages" USING btree ("support_ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_user_status_idx" ON "support_tickets" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "support_tickets_status_priority_idx" ON "support_tickets" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "support_tickets_last_message_at_idx" ON "support_tickets" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "transactions_user_status_idx" ON "transactions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "transactions_reference_idx" ON "transactions" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "users_last_seen_at_idx" ON "users" USING btree ("last_seen_at");