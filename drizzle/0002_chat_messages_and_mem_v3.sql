CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"sender" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"email" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mem_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"weight" numeric(5, 4) DEFAULT '0.5000' NOT NULL,
	"source_layer" text DEFAULT 'episodic' NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mem_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"chat_id" uuid,
	"content" jsonb NOT NULL,
	"summary" text NOT NULL,
	"feedback_score" integer DEFAULT 0 NOT NULL,
	"feedback_text" text,
	"importance" numeric(5, 4) DEFAULT '0.5000' NOT NULL,
	"was_consolidated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mem_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"insight" text NOT NULL,
	"category" text NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5000' NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"source_episode_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mem_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"layer" text DEFAULT 'episodic' NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5000' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mem_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mem_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "invoice_url" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "add_on_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "credits" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "invoice_url" text;--> statement-breakpoint
ALTER TABLE "private_assets" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "private_assets" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "private_assets" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "private_assets" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "private_assets" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_edges" ADD CONSTRAINT "mem_edges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_edges" ADD CONSTRAINT "mem_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_edges" ADD CONSTRAINT "mem_edges_from_node_id_mem_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."mem_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_edges" ADD CONSTRAINT "mem_edges_to_node_id_mem_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."mem_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_episodes" ADD CONSTRAINT "mem_episodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_episodes" ADD CONSTRAINT "mem_episodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_episodes" ADD CONSTRAINT "mem_episodes_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_insights" ADD CONSTRAINT "mem_insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_insights" ADD CONSTRAINT "mem_insights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_nodes" ADD CONSTRAINT "mem_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_nodes" ADD CONSTRAINT "mem_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_sessions" ADD CONSTRAINT "mem_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mem_sessions" ADD CONSTRAINT "mem_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mem_edges_user_from_to_type_key" ON "mem_edges" USING btree ("user_id","from_node_id","to_node_id","relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "mem_nodes_user_name_type_scope_key" ON "mem_nodes" USING btree ("user_id","name","type","scope");--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_assets" ADD CONSTRAINT "private_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_assets" ADD CONSTRAINT "private_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;