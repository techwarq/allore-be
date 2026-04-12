import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

/**
 * Initializes the Drizzle database connection.
 * @param databaseUrl The Neon connection string.
 */
export const getDb = (databaseUrl: string) => {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not defined')
  }
  const sql = neon(databaseUrl)
  return drizzle(sql, { schema })
}

export type Database = ReturnType<typeof getDb>