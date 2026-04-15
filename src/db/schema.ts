import { pgTable, text, timestamp, uuid, integer, jsonb, boolean, numeric, primaryKey, decimal } from 'drizzle-orm/pg-core';

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
  preferences: jsonb('preferences').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 🧠 PRODUCT SYSTEM

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
  type: text('type'),   // 'garment', 'model', etc.
  source: text('source'), // 'upload', 'ai', 'pinterest'
  url: text('url').notNull(),
  metadataJson: jsonb('metadata_json').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const messageAssets = pgTable('message_assets', {
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.messageId, t.assetId] }),
}));

// 💰 BILLING SYSTEM

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  priceMonthly: decimal('price_monthly', { precision: 10, scale: 2 }).notNull(),
  monthlyCredits: integer('monthly_credits').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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
  status: text('status').default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
