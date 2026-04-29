import { Hono } from 'hono'
import { getDb } from '../db'
import { ProjectService } from '../services/project.service'
import { sessionMiddleware, type AuthVariables } from '../middleware/auth'

type Bindings = {
  DATABASE_URL: string
}

const project = new Hono<{ Bindings: Bindings, Variables: AuthVariables }>()

// Protect all project routes
project.use('*', sessionMiddleware)

/**
 * GET /projects
 * List all projects for the authenticated user.
 */
project.get('/', async (c) => {
  const user = c.get('user')
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProjectService(db)

  try {
    const list = await service.getProjectsByUser(user.id)
    return c.json({ success: true, projects: list })
  } catch (error: any) {
    console.error('[Project Route] GET / failed:', error)
    return c.json({ error: 'Failed to fetch projects' }, 500)
  }
})

/**
 * GET /projects/:id
 * Get a specific project by ID.
 */
project.get('/:id', async (c) => {
  const user = c.get('user')
  const projectId = c.req.param('id')
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProjectService(db)

  try {
    const data = await service.getProjectById(projectId, user.id)
    if (!data) {
      return c.json({ error: 'Project not found or unauthorized' }, 404)
    }
    return c.json({ success: true, project: data })
  } catch (error: any) {
    console.error('[Project Route] GET /:id failed:', error)
    return c.json({ error: 'Failed to fetch project' }, 500)
  }
})

/**
 * POST /projects
 * Create a new project.
 */
project.post('/', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProjectService(db)

  if (!body.title) {
    return c.json({ error: 'Project title is required' }, 400)
  }

  try {
    const created = await service.createProject(user.id, {
      title: body.title,
      type: body.type
    })
    return c.json({ success: true, project: created, message: 'Project created successfully' })
  } catch (error: any) {
    console.error('[Project Route] POST / failed:', error)
    return c.json({ error: 'Failed to create project' }, 500)
  }
})

/**
 * PUT /projects/:id
 * Update project details.
 */
project.put('/:id', async (c) => {
  const user = c.get('user')
  const projectId = c.req.param('id')
  const body = await c.req.json()
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProjectService(db)

  try {
    const updated = await service.updateProject(projectId, user.id, body)
    if (!updated) {
      return c.json({ error: 'Project not found or unauthorized' }, 404)
    }
    return c.json({ success: true, project: updated, message: 'Project updated successfully' })
  } catch (error: any) {
    console.error('[Project Route] PUT /:id failed:', error)
    return c.json({ error: 'Failed to update project' }, 500)
  }
})

/**
 * DELETE /projects/:id
 * Delete a project.
 */
project.delete('/:id', async (c) => {
  const user = c.get('user')
  const projectId = c.req.param('id')
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProjectService(db)

  try {
    const deleted = await service.deleteProject(projectId, user.id)
    if (!deleted) {
      return c.json({ error: 'Project not found or unauthorized' }, 404)
    }
    return c.json({ success: true, message: 'Project deleted successfully' })
  } catch (error: any) {
    console.error('[Project Route] DELETE /:id failed:', error)
    return c.json({ error: 'Failed to delete project' }, 500)
  }
})

export default project
