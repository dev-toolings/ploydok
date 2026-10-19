// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import { apiBaseUrl } from "./api/base"
import i18n from "./i18n"
import type { ApiError } from "./api"
import type { McpTokenCreateInput } from "@ploydok/shared"

export interface ApiToken {
  id: string
  name: string
  scopes: Array<string>
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
  kind: "api" | "mcp"
  org_id: string | null
  app_ids: Array<string> | null
}

interface CreatedToken {
  token: string
  row: ApiToken
}

const TOKENS_KEY = ["api-tokens"] as const

export function useApiTokens() {
  return useQuery<Array<ApiToken>, ApiError>({
    queryKey: TOKENS_KEY,
    queryFn: async () =>
      (await apiFetch<{ tokens: Array<ApiToken> }>("/api-tokens")).tokens,
    staleTime: 30_000,
  })
}

export function useCreateMcpToken() {
  const qc = useQueryClient()
  return useMutation<CreatedToken, ApiError, McpTokenCreateInput>({
    mutationFn: (body) =>
      apiFetch<CreatedToken>("/api-tokens/mcp", { method: "POST", body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: TOKENS_KEY })
    },
    onError: (err) => {
      toast.error(err.message)
    },
  })
}

export function useRevokeApiToken() {
  const qc = useQueryClient()
  return useMutation<{ success: true }, ApiError, string>({
    mutationFn: (id) =>
      apiFetch<{ success: true }>(`/api-tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      toast.success(i18n.t("settings:apiTokens.revoked"))
      await qc.invalidateQueries({ queryKey: TOKENS_KEY })
    },
    onError: (err) => {
      toast.error(err.message)
    },
  })
}

/** Public MCP URL: `/api/mcp` behind the installer's Caddy, `:3335/mcp` in dev. */
export function mcpEndpointUrl(): string {
  return new URL(`${apiBaseUrl()}/mcp`, window.location.origin).toString()
}

export function mcpClientSnippets(url: string, token: string) {
  return {
    claude: `claude mcp add --transport http ploydok ${url} --header "Authorization: Bearer ${token}" --scope user`,
    codex: `export PLOYDOK_TOKEN=${token}\ncodex mcp add ploydok --url ${url} --bearer-token-env-var PLOYDOK_TOKEN`,
    cursor: JSON.stringify(
      {
        mcpServers: {
          ploydok: { url, headers: { Authorization: `Bearer ${token}` } },
        },
      },
      null,
      2
    ),
  }
}
