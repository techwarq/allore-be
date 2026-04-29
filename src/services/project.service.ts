import { eq, and } from 'drizzle-orm';
import { projects } from '../db/schema';

export interface ProjectData {
  title?: string;
  type?: string;
  status?: 'active' | 'archived' | 'completed';
  activeChatId?: string;
}

export class ProjectService {
  constructor(private db: any) {}

  /**
   * Fetches a project by ID, ensuring it belongs to the specified user.
   */
  async getProjectById(projectId: string, userId: string) {
    const [project] = await this.db.select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);
    return project;
  }

  /**
   * Fetches all projects for a specific user.
   */
  async getProjectsByUser(userId: string) {
    return await this.db.select()
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(projects.createdAt);
  }

  /**
   * Creates a new project.
   */
  async createProject(userId: string, data: { title: string; type?: string }) {
    const [newProject] = await this.db.insert(projects)
      .values({
        userId,
        title: data.title || 'Untitled Project',
        type: data.type || 'general',
      })
      .returning();
    return newProject;
  }

  /**
   * Updates an existing project.
   */
  async updateProject(projectId: string, userId: string, data: ProjectData) {
    const [updated] = await this.db.update(projects)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .returning();
    return updated;
  }

  /**
   * Deletes a project.
   */
  async deleteProject(projectId: string, userId: string) {
    const [deleted] = await this.db.delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .returning();
    return deleted;
  }
}
