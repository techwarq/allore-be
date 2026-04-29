import { pgTable, text, timestamp, uuid, integer, decimal } from 'drizzle-orm/pg-core';
import { users } from './schema';

/**
 * Plans table stores both plan templates (where userId is null)
 * and specific purchase records (where userId is linked to a user).
 * 
 * Template plans: userId is null, used for the pricing page.
 * Purchase records: userId is set, captures the specific details (invoice, add-ons) at time of purchase.
 */
export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // Nullable for templates
  templateId: uuid('template_id'), // Reference to the original template ID for purchase records
  name: text('name').notNull(),
  priceMonthly: decimal('price_monthly', { precision: 10, scale: 2 }).notNull(),
  monthlyCredits: integer('monthly_credits').notNull(),
  addOnTokens: integer('add_on_tokens').default(0).notNull(), // Added per request
  credits: integer('credits'), // Snapshot of total user credits after this purchase
  invoiceUrl: text('invoice_url'), // Link to the successful payment invoice
  dodoProductId: text('dodo_product_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
