// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

// ---------------------------------------------------------------------------
// Marketplace catalog (proxied from the upstream template registry)
// ---------------------------------------------------------------------------

export const MarketplaceTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  logoUrl: z.string().nullable(),
  tags: z.array(z.string()),
  links: z.object({
    github: z.string().optional(),
    website: z.string().optional(),
    docs: z.string().optional(),
  }),
})
export type MarketplaceTemplate = z.infer<typeof MarketplaceTemplate>

export const MarketplaceCatalogPage = z.object({
  templates: z.array(MarketplaceTemplate),
  nextCursor: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative(),
  // true when the upstream registry is unreachable and we served a cached copy
  stale: z.boolean(),
})
export type MarketplaceCatalogPage = z.infer<typeof MarketplaceCatalogPage>

export const MarketplaceTemplateFiles = z.object({
  templateToml: z.string(),
  dockerCompose: z.string(),
})
export type MarketplaceTemplateFiles = z.infer<typeof MarketplaceTemplateFiles>

export const ServiceStatus = z.enum([
  "created",
  "pending",
  "running",
  "stopped",
  "failed",
  "deleting",
])
export type ServiceStatus = z.infer<typeof ServiceStatus>

export const ServiceSummary = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  slug: z.string(),
  template_id: z.string(),
  template_version: z.string().nullable(),
  status: ServiceStatus.nullable(),
  domain: z.string().nullable(),
  publicUrl: z.string().url().nullable().optional(),
  created_at: z.date().or(z.string()),
})
export type ServiceSummary = z.infer<typeof ServiceSummary>

export const ServiceDetail = ServiceSummary.extend({
  compose_raw: z.string(),
  generated_env: z.record(z.string(), z.string()),
  container_ids: z.array(z.string()),
})
export type ServiceDetail = z.infer<typeof ServiceDetail>

export const CreateServiceFromTemplateBody = z.object({
  projectId: z.string().min(1),
  templateId: z.string().min(1),
  templateVersion: z.string().min(1),
  name: z.string().min(1).max(64),
  compose: z.string().min(1).max(200_000),
  templateToml: z.string().max(200_000).optional(),
})
export type CreateServiceFromTemplateBody = z.infer<
  typeof CreateServiceFromTemplateBody
>

// Upstream versions are free-form: "1.9" and "v1.9" both occur, as do tags such
// as "latest". Prefix "v" only to numeric versions, and never twice.
export function formatTemplateVersion(version: string): string {
  const trimmed = version.trim()
  const numeric = /^[vV]?(\d.*)$/.exec(trimmed)
  return numeric ? `v${numeric[1]}` : trimmed
}
