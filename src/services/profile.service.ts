import { eq } from 'drizzle-orm';
import { profiles } from '../db/schema';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export interface ProfileData {
  name?: string;
  avatarUrl?: string;
  companyName?: string;
  userType?: 'creator' | 'brand';
  goals?: string;
  targetAudience?: string;
  companyUrls?: string[];
  companySize?: string;
  industry?: string;
  competitors?: string[];
  inspiration?: string;
  extraDetails?: string;
  brandingKitUrl?: string;
  onboardingCompleted?: boolean;
  preferences?: any;
}

export class ProfileService {
  constructor(private db: any) {} // db is our Drizzle instance

  /**
   * Fetches the profile for a specific user.
   */
  async getProfile(userId: string) {
    const [profile] = await this.db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
    return profile;
  }

  /**
   * Creates or updates a user profile.
   */
  async upsertProfile(userId: string, data: ProfileData) {
    // Check if profile exists
    const existing = await this.getProfile(userId);

    if (existing) {
      // Update
      const [updated] = await this.db.update(profiles)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(eq(profiles.userId, userId))
        .returning();
      return updated;
    } else {
      // Create
      const [created] = await this.db.insert(profiles)
        .values({
          userId,
          ...data as any,
        })
        .returning();
      return created;
    }
  }

  /**
   * Resets/Deletes the content of a profile while keeping the entry.
   * Or deletes the entry entirely depending on requirements.
   * Here we reset the fields.
   */
  async resetProfile(userId: string) {
    const [reset] = await this.db.update(profiles)
      .set({
        name: null,
        avatarUrl: null,
        companyName: null,
        userType: null,
        goals: null,
        targetAudience: null,
        companyUrls: [],
        companySize: null,
        industry: null,
        competitors: [],
        inspiration: null,
        extraDetails: null,
        brandingKitUrl: null,
        onboardingCompleted: false,
        preferences: {},
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId))
      .returning();
    return reset;
  }
}
