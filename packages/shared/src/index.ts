import { z } from 'zod'

export { z }

// Shared Zod schemas — expanded in later phases
export const ProjectSlugSchema = z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type Pagination = z.infer<typeof PaginationSchema>
