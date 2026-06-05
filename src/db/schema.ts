import { pgTable, text, timestamp, uuid, integer, jsonb, boolean, numeric, primaryKey, decimal, uniqueIndex } from 'drizzle-orm/pg-core';
import { plans } from './plan';

export { plans };

// 🔐 AUTH LAYER

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  role: text('role').default('user').notNull(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const authAccounts = pgTable('auth_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(), // 'local', 'google', etc.
  providerId: text('provider_id'),      // Google ID, etc.
  passwordHash: text('password_hash'),
  failedAttempts: integer('failed_attempts').default(0).notNull(),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  sessionToken: text('session_token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const emailVerifications = pgTable('email_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  verified: boolean('verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 👤 PROFILE

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  companyName: text('company_name'),
  userType: text('user_type'), // 'creator' | 'brand'
  goals: text('goals'),
  targetAudience: text('target_audience'),
  companyUrls: jsonb('company_urls').default([]).notNull(),
  companySize: text('company_size'),
  industry: text('industry'),
  competitors: jsonb('competitors').default([]).notNull(),
  inspiration: text('inspiration'),
  extraDetails: text('extra_details'),
  brandingKitUrl: text('branding_kit_url'),
  
  // Brand Profile dimensions (AI Creative Studio)
  tone: text('tone'),
  aesthetic: text('aesthetic'),
  positioning: text('positioning'),
  coreStory: text('core_story'),
  colorPalette: jsonb('color_palette').default([]).notNull(),
  visualMood: text('visual_mood'),
  lightingStyle: text('lighting_style'),
  platformFocus: jsonb('platform_focus').default([]).notNull(),

  onboardingCompleted: boolean('onboarding_completed').default(false).notNull(),
  preferences: jsonb('preferences').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 🧠 PRODUCT SYSTEM

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(), // clothing, skincare, jewelry
  description: text('description'),
  colors: jsonb('colors').default([]).notNull(),
  sizes: jsonb('sizes').default([]).notNull(),
  materials: jsonb('materials').default([]).notNull(),
  price: decimal('price', { precision: 10, scale: 2 }),
  heroAssetId: uuid('hero_asset_id'), // Will reference assets.id
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: text('title'),
  type: text('type'),
  status: text('status').default('active').notNull(),
  activeChatId: uuid('active_chat_id'), // To be updated during runtime
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const chats = pgTable('chats', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  parentChatId: uuid('parent_chat_id'), // Optional, for context branching
  title: text('title'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  sender: text('sender').notNull(), // 'user', 'assistant', 'system'
  type: text('type'),               // 'text', 'asset_generation', etc.
  content: text('content'),
  generationId: uuid('generation_id'),
  version: integer('version').default(1).notNull(),
  status: text('status').default('completed').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const generations = pgTable('generations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  chatId: uuid('chat_id').references(() => chats.id).notNull(),
  messageId: uuid('message_id').references(() => messages.id),
  type: text('type'),
  status: text('status'),
  inputJson: jsonb('input_json').default({}).notNull(),
  outputJson: jsonb('output_json').default({}).notNull(),
  creditsUsed: integer('credits_used').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  chatId: uuid('chat_id').references(() => chats.id),
  generationId: uuid('generation_id').references(() => generations.id),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  type: text('type'),   // 'garment', 'model', 'image', 'video', 'document'
  subtype: text('subtype'), // 'product_image', 'lifestyle_image', 'logo'
  source: text('source'), // 'upload', 'ai', 'pinterest'
  url: text('url').notNull(),
  tags: jsonb('tags').default([]).notNull(),
  colors: jsonb('colors').default([]).notNull(),
  angle: text('angle'),
  background: text('background'),
  extractedText: jsonb('extracted_text'),
  parsedData: jsonb('parsed_data'),
  metadataJson: jsonb('metadata_json').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const privateAssets = pgTable('private_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  projectId: uuid('project_id').references(() => projects.id),
  r2Key: text('r2_key').notNull(),
  type: text('type'),
  tags: jsonb('tags').default([]).notNull(),
  colors: jsonb('colors').default([]).notNull(),
  angle: text('angle'),
  background: text('background'),
  parsedData: jsonb('parsed_data'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});


export const messageAssets = pgTable('message_assets', {
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.messageId, t.assetId] }),
}));

// 💰 BILLING SYSTEM

// Plans moved to plan.ts

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  planId: uuid('plan_id').references(() => plans.id).notNull(),
  status: text('status').notNull(), // 'active', 'cancelled', 'past_due'
  currentPeriodStart: timestamp('current_period_start'),
  currentPeriodEnd: timestamp('current_period_end'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
  dodoSubscriptionId: text('dodo_subscription_id').unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Rename 'payments' to 'invoices'
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  status: text('status').notNull(),
  dodoPaymentId: text('dodo_payment_id').unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userCredits = pgTable('user_credits', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).primaryKey().notNull(),
  creditsRemaining: integer('credits_remaining').default(0).notNull(),
  lastResetAt: timestamp('last_reset_at').defaultNow().notNull(),
});

export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  changeAmount: integer('change_amount').notNull(),
  reason: text('reason').notNull(), // 'monthly_grant', 'usage', 'topup', 'purchase'
  referenceId: uuid('reference_id'), // messageId, invoiceId, etc.
  invoiceUrl: text('invoice_url'), // Link to the invoice if applicable
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Track simplified chat usage counts
export const chatUsage = pgTable('chat_usage', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id).notNull(),
    day: timestamp('day').defaultNow().notNull(), // Truncated to day
    count: integer('count').default(0).notNull(),
});

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  companyName: text('company_name'),
  website: text('website'),
  teamSize: text('team_size'),
  brandStage: text('brand_stage'),
  primaryNeed: jsonb('primary_need').default([]),
  additionalInfo: text('additional_info'),
  status: text('status').default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
// 🧠 MEMORY SYSTEM V2 (RELATIONAL)

export const sessionMemory = pgTable('session_memory', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').notNull().unique(), // Can be chatId or DO ID
  data: jsonb('data').default({}).notNull(),
  plan: jsonb('plan'),
  status: text('status'), // 'running', 'waiting_approval', 'done'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const toolLogs = pgTable('tool_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').notNull(),
  toolName: text('tool_name').notNull(),
  input: jsonb('input').default({}).notNull(),
  output: jsonb('output').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const memoryEpisodes = pgTable('memory_episodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  content: jsonb('content').notNull(), // Stores the full graph: { events, entities, relations, outcome }
  summary: text('summary'),            // LLM generated summary for easier retrieval
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const memoryEntities = pgTable('memory_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'user', 'brand', 'topic', 'style', etc.
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const memoryRelations = pgTable('memory_relations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  fromEntityId: uuid('from_entity_id').references(() => memoryEntities.id, { onDelete: 'cascade' }).notNull(),
  toEntityId: uuid('to_entity_id').references(() => memoryEntities.id, { onDelete: 'cascade' }).notNull(),
  relationType: text('relation_type'), // 'prefers', 'avoids', 'leads_to', etc.
  weight: decimal('weight', { precision: 5, scale: 2 }).default('0.50').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const semanticMemories = pgTable('semantic_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  insight: text('insight').notNull(),
  category: text('category'), // 'preference', 'pattern', 'knowledge'
  confidence: decimal('confidence', { precision: 5, scale: 2 }).default('0.50').notNull(),
  sourceEpisodeIds: jsonb('source_episode_ids').default([]).notNull(), // Array of episode UUIDs
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex('semantic_memories_userId_projectId_insight_key').on(t.userId, t.projectId, t.insight),
}));

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  sender: text('sender').notNull(), // 'user', 'assistant'
  type: text('type').default('text').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// 🧠 MEMORY SYSTEM V3
//
// 3 layers:
//   STM       → mem_sessions   (per chat session + queryable by project)
//   Episodic  → mem_episodes   (every interaction, feedback-scored, Qdrant-indexed)
//   LTM       → mem_insights   (distilled patterns) + graph (mem_nodes + mem_edges)
//
// All layers feed the same graph — it is the connective tissue between them.
// Negative-feedback episodes are kept as avoidance signals, not deleted.
// ─────────────────────────────────────────────────────────────────────────────

export const memSessions = pgTable('mem_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').notNull().unique(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  data: jsonb('data').default({}).notNull(),
  status: text('status').default('active').notNull(), // 'active' | 'done'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const memEpisodes = pgTable('mem_episodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
  content: jsonb('content').notNull(),       // { events, entities, relations, outcome }
  summary: text('summary').notNull(),
  feedbackScore: integer('feedback_score').default(0).notNull(), // -1 | 0 | 1
  feedbackText: text('feedback_text'),
  importance: decimal('importance', { precision: 5, scale: 4 }).default('0.5000').notNull(),
  wasConsolidated: boolean('was_consolidated').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Graph nodes — shared across projects for same user (scope='global') or project-scoped (scope='project')
// Unique on (userId, name, type, scope): same entity name+type for same user = same node.
export const memNodes = pgTable('mem_nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global
  name: text('name').notNull(),
  type: text('type').notNull(),                           // 'brand' | 'style' | 'topic' | 'product' | 'audience' | 'user'
  scope: text('scope').default('project').notNull(),      // 'global' | 'project'
  layer: text('layer').default('episodic').notNull(),     // 'stm' | 'episodic' | 'ltm'
  confidence: decimal('confidence', { precision: 5, scale: 4 }).default('0.5000').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex('mem_nodes_user_name_type_scope_key').on(t.userId, t.name, t.type, t.scope),
}));

export const memEdges = pgTable('mem_edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global
  fromNodeId: uuid('from_node_id').references(() => memNodes.id, { onDelete: 'cascade' }).notNull(),
  toNodeId: uuid('to_node_id').references(() => memNodes.id, { onDelete: 'cascade' }).notNull(),
  relationType: text('relation_type').notNull(), // 'prefers' | 'avoids' | 'leads_to' | 'targets' | 'negates'
  weight: decimal('weight', { precision: 5, scale: 4 }).default('0.5000').notNull(),
  sourceLayer: text('source_layer').default('episodic').notNull(), // 'stm' | 'episodic' | 'ltm'
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex('mem_edges_user_from_to_type_key').on(t.userId, t.fromNodeId, t.toNodeId, t.relationType),
}));

export const memInsights = pgTable('mem_insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global
  insight: text('insight').notNull(),
  category: text('category').notNull(), // 'preference' | 'avoidance_pattern' | 'reinforcement_pattern' | 'brand_knowledge' | 'style_pattern'
  confidence: decimal('confidence', { precision: 5, scale: 4 }).default('0.5000').notNull(),
  hitCount: integer('hit_count').default(1).notNull(),
  sourceEpisodeIds: jsonb('source_episode_ids').default([]).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
