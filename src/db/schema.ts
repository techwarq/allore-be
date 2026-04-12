import { pgTable, text, timestamp, uuid, integer, jsonb, pgEnum, boolean } from 'drizzle-orm/pg-core'

// --- Enums ---
export const roleEnum = pgEnum('role', ['user', 'admin'])
export const authProviderEnum = pgEnum('auth_provider', ['local', 'google', 'both'])
export const messageTypeEnum = pgEnum('message_type', ['user', 'assistant', 'system'])

// --- Base Fields ---
const baseFields = {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}

// --- Collections Mapping ---

// 👤 Users ('users')
export const users = pgTable('users', {
  ...baseFields,
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  password: text('password'), // Optional for Google users
  googleId: text('google_id'),
  role: roleEnum('role').default('user').notNull(),
  authProvider: authProviderEnum('auth_provider').default('local').notNull(),
  // Usage tracking
  totalGenerations: integer('total_generations').default(0).notNull(),
  totalImages: integer('total_images').default(0).notNull(),
  lastActive: timestamp('last_active').defaultNow().notNull(),
  // Verification
  isVerified: boolean('is_verified').default(false).notNull(),
  verificationToken: text('verification_token'),
  verificationExpiresAt: timestamp('verification_expires_at'),
  resetPasswordToken: text('reset_password_token'),
  resetPasswordExpiresAt: timestamp('reset_password_expires_at'),
})

// 📁 Projects ('savedProjects')
export const projects = pgTable('projects', {
  ...baseFields,
  userId: uuid('user_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  type: text('type').notNull(), // e.g., 'photoshoot', 'tryon', 'research'
  context: jsonb('context').default({}).notNull(), // Workflow state and variables
})

// AI GENERATIONS

// 🤖 Model Generations ('modelGenerations')
export const modelGenerations = pgTable('model_generations', {
  ...baseFields,
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  gender: text('gender'),
  ethnicity: text('ethnicity'),
  age: text('age'),
  skinTone: text('skin_tone'),
  eyeColor: text('eye_color'),
  hairStyle: text('hair_style'),
  hairColor: text('hair_color'),
  clothingStyle: text('clothing_style'),
  results: jsonb('results').default([]).notNull(), // Array of image URLs/statuses
})

// 💃 Pose Generations ('poseGenerations')
export const poseGenerations = pgTable('pose_generations', {
  ...baseFields,
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  prompt: text('prompt'),
  count: integer('count').default(1).notNull(),
  runwayImageUrl: text('runway_image_url'),
  ratio: text('ratio'),
  results: jsonb('results').default([]).notNull(),
})

// 🖼️ Background Generations ('backgroundGenerations')
export const backgroundGenerations = pgTable('background_generations', {
  ...baseFields,
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  locationType: text('location_type'),
  locationDetail: text('location_detail'),
  cameraAngle: text('camera_angle'),
  lightingStyle: text('lighting_style'),
  mood: text('mood'),
  results: jsonb('results').default([]).notNull(),
})

// MESSAGING

// 💬 Chats & Messages
export const chats = pgTable('chats', {
  ...baseFields,
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
})

export const messages = pgTable('messages', {
  ...baseFields,
  chatId: uuid('chat_id').references(() => chats.id).notNull(),
  senderId: uuid('sender_id').references(() => users.id).notNull(),
  content: text('content').notNull(),
  messageType: messageTypeEnum('message_type').default('user').notNull(),
  userAssets: jsonb('user_assets').default([]).notNull(),
  systemAssets: jsonb('system_assets').default([]).notNull(),
})

// ASSETS

// 📷 Assets ('uploadedAssets')
export const uploadedAssets = pgTable('uploaded_assets', {
  ...baseFields,
  userId: uuid('user_id').references(() => users.id).notNull(),
  fileUrl: text('file_url').notNull(),
  assetType: text('asset_type').notNull(), // 'garment', 'model_ref', 'logo'
  metadata: jsonb('metadata').default({}).notNull(),
})

// ✨ Generated Assets ('generatedAssets')
export const generatedAssets = pgTable('generated_assets', {
  ...baseFields,
  userId: uuid('user_id').references(() => users.id).notNull(),
  generationId: uuid('generation_id').notNull(), // Linked to specific generation ID
  fileUrl: text('file_url').notNull(),
  assetType: text('asset_type').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
})

// PREFERENCES & BRANDING

// 🏢 Company Preferences
export const companyPreferences = pgTable('company_preferences', {
  ...baseFields,
  userId: uuid('user_id').references(() => users.id).notNull(),
  companyName: text('company_name').notNull(),
  companyUrls: jsonb('company_urls').default([]).notNull(),
  industry: text('industry'),
  targetAudience: text('target_audience'),
  brandDetails: jsonb('brand_details').default({}).notNull(),
})

// 🧑 User Preferences
export const userPreferences = pgTable('user_preferences', {
  ...baseFields,
  userId: uuid('user_id').references(() => users.id).notNull(),
  competitors: jsonb('competitors').default([]).notNull(), // URLs
  resources: jsonb('resources').default([]).notNull(), // URLs
  stylePreferences: jsonb('style_preferences').default({}).notNull(),
  researchResults: jsonb('research_results').default({}).notNull(),
})

// SYSTEM

// 📋 Waitlist
export const waitlist = pgTable('waitlist', {
  ...baseFields,
  email: text('email').notNull().unique(),
  name: text('name'),
  status: text('status').default('pending').notNull(),
})

// 💰 Purchases
export const purchases = pgTable('purchases', {
  ...baseFields,
  userId: uuid('user_id').references(() => users.id).notNull(),
  planId: text('plan_id').notNull(),
  paymentId: text('payment_id').notNull(),
  status: text('status').notNull(),
})

// 📸 Private Assets ('private_assets')
export const privateAssets = pgTable('private_assets', {
  ...baseFields,
  userId: uuid('user_id').references(() => users.id).notNull(),
  fileName: text('file_name').notNull(), // The R2 key (path)
  originalUrl: text('original_url'),     // Pinterest original URL
  contentType: text('content_type').default('image/jpeg').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
})
