CREATE TABLE "group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text,
	"group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"allowed_email_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"full_name" text NOT NULL,
	"title" text,
	"avatar_url" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_active_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"brand_color" text DEFAULT '#3156F5' NOT NULL,
	"logo_url" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"secret_encrypted" text,
	"credential_id" text,
	"public_key" text,
	"sign_count" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recovery_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"email" text,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text,
	"refresh_token_encrypted" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"active_workspace_id" text,
	"csrf_secret" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"mfa_satisfied" boolean DEFAULT false NOT NULL,
	"remember_me" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text,
	"review_id" text,
	"source_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"chunk_id" text,
	"source_sha256" text NOT NULL,
	"document_title" text NOT NULL,
	"document_type" text NOT NULL,
	"page_number" integer,
	"sheet_name" text,
	"cell_range" text,
	"slide_number" integer,
	"shape_name" text,
	"chapter" text,
	"section" text,
	"clause" text,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paragraph_index" integer,
	"char_start" integer,
	"char_end" integer,
	"url_fragment" text,
	"bounding_boxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supporting_excerpt" text NOT NULL,
	"retrieval_score" double precision DEFAULT 0 NOT NULL,
	"rerank_score" double precision DEFAULT 0 NOT NULL,
	"entailment" text DEFAULT 'context' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verification_method" text DEFAULT 'failed' NOT NULL,
	"effective_date" timestamp with time zone,
	"superseded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"chunk_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"section_id" text,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"page_number" integer,
	"page_end" integer,
	"sheet_name" text,
	"cell_range" text,
	"slide_number" integer,
	"chapter" text,
	"section" text,
	"clause" text,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paragraph_index" integer,
	"char_start" integer DEFAULT 0 NOT NULL,
	"char_end" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'prose' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"account_email" text,
	"credential_encrypted" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_by_user_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"source_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"page_number" integer NOT NULL,
	"text" text NOT NULL,
	"width" real,
	"height" real,
	"sheet_name" text,
	"slide_number" integer,
	"ocr_applied" boolean DEFAULT false NOT NULL,
	"ocr_confidence" real,
	"word_boxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scope" text NOT NULL,
	"group_id" text,
	"user_id" text,
	"capability" text DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"source_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_id" text,
	"ordinal" integer NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"kind" text DEFAULT 'heading' NOT NULL,
	"chapter" text,
	"section" text,
	"clause" text,
	"title" text NOT NULL,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_number" integer,
	"char_start" integer DEFAULT 0 NOT NULL,
	"char_end" integer DEFAULT 0 NOT NULL,
	"modality" text,
	"is_requirement" boolean DEFAULT false NOT NULL,
	"effective_date" timestamp with time zone,
	"superseded_note" text,
	"cross_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_sync_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"include_globs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclude_globs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_depth" integer DEFAULT 1 NOT NULL,
	"max_pages" integer DEFAULT 25 NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"respect_robots" boolean DEFAULT true NOT NULL,
	"auto_sync" boolean DEFAULT false NOT NULL,
	"sync_cron" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version" text NOT NULL,
	"version_number" integer NOT NULL,
	"sha256" text NOT NULL,
	"normalized_sha256" text,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"pages" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"promoted_at" timestamp with time zone,
	"is_current" boolean DEFAULT false NOT NULL,
	"ocr_applied" boolean DEFAULT false NOT NULL,
	"ocr_confidence" real,
	"extraction_coverage" real,
	"structure" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"document_type" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_version_id" text,
	"connector_id" text,
	"connector_kind" text,
	"external_id" text,
	"external_url" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_scope" text DEFAULT 'workspace' NOT NULL,
	"owner_user_id" text,
	"promoted_to_knowledge" boolean DEFAULT false NOT NULL,
	"effective_date" timestamp with time zone,
	"superseded_by_source_id" text,
	"last_synced_at" timestamp with time zone,
	"failure_reason" text,
	"quarantine" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compliance_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"consultation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"scope_note" text,
	"project_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"governing_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requirements_total" integer DEFAULT 0 NOT NULL,
	"compliant_count" integer DEFAULT 0 NOT NULL,
	"non_compliant_count" integer DEFAULT 0 NOT NULL,
	"needs_evidence_count" integer DEFAULT 0 NOT NULL,
	"not_assessed_count" integer DEFAULT 0 NOT NULL,
	"evidence_coverage" real,
	"confidence" real,
	"risk_level" text DEFAULT 'none' NOT NULL,
	"created_by_user_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultation_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"consultation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultation_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"consultation_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text DEFAULT 'governing' NOT NULL,
	"pinned" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"task_mode" text DEFAULT 'ask' NOT NULL,
	"answer_style" text DEFAULT 'optimal' NOT NULL,
	"output_format" text DEFAULT 'match_source' NOT NULL,
	"evidence_detail" jsonb DEFAULT '{"documentAndPage":true,"clauseAndLocation":true,"supportingExcerpt":true}'::jsonb NOT NULL,
	"response_controls" jsonb DEFAULT '{"knowledgeOnly":true,"askWhenUncertain":true,"generalModelFallback":false}'::jsonb NOT NULL,
	"compliance_score" real,
	"pinned" boolean DEFAULT false NOT NULL,
	"owner_user_id" text NOT NULL,
	"last_message_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "correction_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"finding_id" text,
	"ordinal" integer NOT NULL,
	"locator_label" text NOT NULL,
	"page_number" integer,
	"paragraph_index" integer,
	"sheet_name" text,
	"cell_range" text,
	"slide_number" integer,
	"char_start" integer,
	"char_end" integer,
	"current_content" text NOT NULL,
	"proposed_content" text NOT NULL,
	"edited_content" text,
	"reason" text NOT NULL,
	"governing_citation_id" text,
	"risk" text DEFAULT 'medium' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"consultation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"review_id" text,
	"source_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"output_strategy" text DEFAULT 'revised_edition' NOT NULL,
	"limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signature_notice" text,
	"instructions" text,
	"generated_artifact_id" text,
	"redline_artifact_id" text,
	"created_by_user_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"result" text DEFAULT 'not_assessed' NOT NULL,
	"risk" text DEFAULT 'none' NOT NULL,
	"finding" text NOT NULL,
	"project_evidence_citation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"governing_citation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_action" text,
	"confidence" real DEFAULT 0 NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"consultation_id" text,
	"review_id" text,
	"plan_id" text,
	"source_id" text,
	"source_version_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"document_type" text NOT NULL,
	"content_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"generator_descriptor" text DEFAULT '' NOT NULL,
	"change_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disclosures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"retain_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text,
	"consultation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text,
	"source_version_id" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"document_type" text DEFAULT 'unknown' NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"consultation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"author_user_id" text,
	"text" text DEFAULT '' NOT NULL,
	"task_mode" text,
	"answer_style" text,
	"answer" jsonb,
	"parent_message_id" text,
	"job_id" text,
	"feedback" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"consultation_id" text,
	"review_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"shared_with" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"section_id" text,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"obligation_text" text NOT NULL,
	"modality" text DEFAULT 'mandatory' NOT NULL,
	"citation_id" text,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cross_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"actor_user_id" text,
	"actor_name" text DEFAULT 'system' NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"result" text DEFAULT 'success' NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"trace_id" text NOT NULL,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by_user_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"proof" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"stage" text,
	"message" text,
	"error" jsonb,
	"duration_ms" integer,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"capability" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_encrypted" text,
	"health" text DEFAULT 'unknown' NOT NULL,
	"health_detail" text,
	"last_checked_at" timestamp with time zone,
	"circuit_open_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"tokens_used_30d" integer DEFAULT 0 NOT NULL,
	"requests_used_30d" integer DEFAULT 0 NOT NULL,
	"quota_limit" integer,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"trace_id" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"percent" real DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error" jsonb,
	"result_ref" jsonb,
	"target_type" text,
	"target_id" text,
	"created_by_user_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"consultation_days" integer DEFAULT 365 NOT NULL,
	"artifact_days" integer DEFAULT 365 NOT NULL,
	"audit_days" integer DEFAULT 730 NOT NULL,
	"purge_grace_days" integer DEFAULT 30 NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"last_purge_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"consultation_id" text,
	"source_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"declared_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"promote_to_knowledge" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_scope" text DEFAULT 'workspace' NOT NULL,
	"received_bytes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_factors" ADD CONSTRAINT "auth_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_workspace_id_workspaces_id_fk" FOREIGN KEY ("active_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_chunk_id_source_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."source_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_source_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."source_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_section_id_source_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."source_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_pages" ADD CONSTRAINT "source_pages_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_permissions" ADD CONSTRAINT "source_permissions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_permissions" ADD CONSTRAINT "source_permissions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_permissions" ADD CONSTRAINT "source_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sync_rules" ADD CONSTRAINT "source_sync_rules_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_reviews" ADD CONSTRAINT "compliance_reviews_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_reviews" ADD CONSTRAINT "compliance_reviews_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_reviews" ADD CONSTRAINT "compliance_reviews_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_participants" ADD CONSTRAINT "consultation_participants_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_participants" ADD CONSTRAINT "consultation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_sources" ADD CONSTRAINT "consultation_sources_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_sources" ADD CONSTRAINT "consultation_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_sources" ADD CONSTRAINT "consultation_sources_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_changes" ADD CONSTRAINT "correction_changes_plan_id_correction_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."correction_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_changes" ADD CONSTRAINT "correction_changes_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_changes" ADD CONSTRAINT "correction_changes_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_plans" ADD CONSTRAINT "correction_plans_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_plans" ADD CONSTRAINT "correction_plans_review_id_compliance_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."compliance_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_plans" ADD CONSTRAINT "correction_plans_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_plans" ADD CONSTRAINT "correction_plans_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_plans" ADD CONSTRAINT "correction_plans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_compliance_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."compliance_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_review_id_compliance_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."compliance_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_plan_id_correction_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."correction_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_artifact_id_generated_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."generated_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_review_id_compliance_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."compliance_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_review_id_compliance_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."compliance_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configurations" ADD CONSTRAINT "model_configurations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_key" ON "group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_workspace_name_key" ON "groups" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_workspace_email_idx" ON "invitations" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_workspace_user_key" ON "memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_workspace_idx" ON "memberships" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_key" ON "user_preferences" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_slug_key" ON "workspaces" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "auth_factors_user_idx" ON "auth_factors" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_factors_credential_key" ON "auth_factors" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_key" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_kind_idx" ON "auth_tokens" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "auth_tokens_expiry_idx" ON "auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_accounts_key" ON "oauth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "citations_message_idx" ON "citations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "citations_review_idx" ON "citations" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "citations_tenant_idx" ON "citations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "citations_source_version_idx" ON "citations" USING btree ("source_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_chunk_key" ON "embeddings" USING btree ("chunk_id","model");--> statement-breakpoint
CREATE INDEX "embeddings_tenant_idx" ON "embeddings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "embeddings_hnsw_idx" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "source_chunks_version_idx" ON "source_chunks" USING btree ("source_version_id","ordinal");--> statement-breakpoint
CREATE INDEX "source_chunks_tenant_idx" ON "source_chunks" USING btree ("workspace_id","source_id");--> statement-breakpoint
CREATE INDEX "source_chunks_page_idx" ON "source_chunks" USING btree ("source_version_id","page_number");--> statement-breakpoint
CREATE INDEX "source_chunks_fts_idx" ON "source_chunks" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "source_connectors_workspace_idx" ON "source_connectors" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "source_pages_key" ON "source_pages" USING btree ("source_version_id","page_number");--> statement-breakpoint
CREATE INDEX "source_pages_workspace_idx" ON "source_pages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_permissions_source_idx" ON "source_permissions" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_permissions_user_idx" ON "source_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_permissions_group_idx" ON "source_permissions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "source_sections_version_idx" ON "source_sections" USING btree ("source_version_id","ordinal");--> statement-breakpoint
CREATE INDEX "source_sections_clause_idx" ON "source_sections" USING btree ("source_version_id","clause");--> statement-breakpoint
CREATE INDEX "source_sections_requirement_idx" ON "source_sections" USING btree ("source_version_id","is_requirement");--> statement-breakpoint
CREATE INDEX "source_sections_workspace_idx" ON "source_sections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_sync_rules_connector_idx" ON "source_sync_rules" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_versions_sha_key" ON "source_versions" USING btree ("source_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "source_versions_number_key" ON "source_versions" USING btree ("source_id","version_number");--> statement-breakpoint
CREATE INDEX "source_versions_source_idx" ON "source_versions" USING btree ("source_id","is_current");--> statement-breakpoint
CREATE INDEX "source_versions_workspace_idx" ON "source_versions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sources_tenant_idx" ON "sources" USING btree ("workspace_id","status","deleted_at");--> statement-breakpoint
CREATE INDEX "sources_org_idx" ON "sources" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sources_owner_idx" ON "sources" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "sources_connector_idx" ON "sources" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "sources_title_trgm_idx" ON "sources" USING gin (to_tsvector('english', "title"));--> statement-breakpoint
CREATE INDEX "compliance_reviews_consultation_idx" ON "compliance_reviews" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "compliance_reviews_tenant_idx" ON "compliance_reviews" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "consultation_participants_key" ON "consultation_participants" USING btree ("consultation_id","user_id");--> statement-breakpoint
CREATE INDEX "consultation_participants_user_idx" ON "consultation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consultation_sources_key" ON "consultation_sources" USING btree ("consultation_id","source_id");--> statement-breakpoint
CREATE INDEX "consultation_sources_source_idx" ON "consultation_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "consultations_tenant_idx" ON "consultations" USING btree ("workspace_id","status","deleted_at");--> statement-breakpoint
CREATE INDEX "consultations_owner_idx" ON "consultations" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "consultations_pinned_idx" ON "consultations" USING btree ("workspace_id","pinned");--> statement-breakpoint
CREATE INDEX "correction_changes_plan_idx" ON "correction_changes" USING btree ("plan_id","ordinal");--> statement-breakpoint
CREATE INDEX "correction_changes_status_idx" ON "correction_changes" USING btree ("plan_id","status");--> statement-breakpoint
CREATE INDEX "correction_plans_consultation_idx" ON "correction_plans" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "correction_plans_source_idx" ON "correction_plans" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "findings_review_idx" ON "findings" USING btree ("review_id","result");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_requirement_key" ON "findings" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "generated_artifacts_tenant_idx" ON "generated_artifacts" USING btree ("workspace_id","kind","deleted_at");--> statement-breakpoint
CREATE INDEX "generated_artifacts_consultation_idx" ON "generated_artifacts" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "generated_artifacts_lineage_idx" ON "generated_artifacts" USING btree ("source_version_id");--> statement-breakpoint
CREATE INDEX "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_attachments_consultation_idx" ON "message_attachments" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "messages_consultation_idx" ON "messages" USING btree ("consultation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_tenant_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_job_idx" ON "messages" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "reports_tenant_idx" ON "reports" USING btree ("workspace_id","kind","deleted_at");--> statement-breakpoint
CREATE INDEX "requirements_review_idx" ON "requirements" USING btree ("review_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "requirements_review_ref_key" ON "requirements" USING btree ("review_id","reference");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_idx" ON "audit_events" USING btree ("workspace_id","category","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "deletion_requests_tenant_idx" ON "deletion_requests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "deletion_requests_schedule_idx" ON "deletion_requests" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_key" ON "idempotency_records" USING btree ("workspace_id","endpoint","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_key" ON "job_attempts" USING btree ("job_id","attempt");--> statement-breakpoint
CREATE INDEX "job_attempts_job_idx" ON "job_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_configurations_key" ON "model_configurations" USING btree ("workspace_id","capability","provider","model");--> statement-breakpoint
CREATE INDEX "model_configurations_tenant_idx" ON "model_configurations" USING btree ("workspace_id","capability","is_primary");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_idem_key" ON "processing_jobs" USING btree ("workspace_id","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "processing_jobs_queue_idx" ON "processing_jobs" USING btree ("status","next_attempt_at","priority");--> statement-breakpoint
CREATE INDEX "processing_jobs_tenant_idx" ON "processing_jobs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "processing_jobs_target_idx" ON "processing_jobs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_counters_key" ON "rate_limit_counters" USING btree ("bucket","window_start");--> statement-breakpoint
CREATE INDEX "rate_limit_counters_expiry_idx" ON "rate_limit_counters" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_workspace_key" ON "retention_policies" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "upload_tickets_tenant_idx" ON "upload_tickets" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "upload_tickets_source_idx" ON "upload_tickets" USING btree ("source_id");