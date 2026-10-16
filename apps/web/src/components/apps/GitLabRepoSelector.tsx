// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useGitLabCacheStatus, useGitLabRepos } from "../../lib/gitlab"
import type { GitRepo } from "@ploydok/shared"

interface GitLabRepoSelectorProps {
  selected?: GitRepo | null
  onSelect: (repo: GitRepo) => void
  enabled?: boolean
  unavailableReason?: string | null
}

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState<T>(value)

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

export function GitLabRepoSelector({
  selected,
  onSelect,
  enabled = true,
  unavailableReason,
}: GitLabRepoSelectorProps): React.JSX.Element {
  const { t } = useTranslation(["settings", "apps"])
  const [search, setSearch] = React.useState("")
  const debouncedSearch = useDebounce(search, 200)
  const postOAuthSyncQueued =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("sync") === "queued"
  const cacheStatus = useGitLabCacheStatus({
    autoRefresh: enabled && postOAuthSyncQueued,
    enabled,
  })

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
    error,
  } = useGitLabRepos({
    search: debouncedSearch || undefined,
    enabled,
  })

  React.useEffect(() => {
    if (postOAuthSyncQueued && cacheStatus.data?.syncStatus === "completed") {
      void refetch()
    }
  }, [cacheStatus.data?.syncStatus, postOAuthSyncQueued, refetch])

  if (!enabled) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {unavailableReason ?? t("gitlab.notAvailable")}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            window.location.href = "/settings/git-providers/gitlab"
          }}
        >
          {t("gitlab.configure")}
        </Button>
      </div>
    )
  }

  const repos = data?.pages.flatMap((p) => p.repos) ?? []

  return (
    <div className="space-y-3">
      <Input
        type="search"
        placeholder={t("apps:create.searchGitLab")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-9"
        aria-label={t("apps:repo.searchGitLabAria")}
      />

      {isLoading ? (
        <RepoListSkeleton />
      ) : error ? (
        <p className="text-sm text-destructive" role="alert">
          {t("apps:create.loadProjectsFailed", { message: error.message })}
        </p>
      ) : repos.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {debouncedSearch
            ? t("apps:create.noProjectMatch", { query: debouncedSearch })
            : t("apps:create.noProjects")}
        </p>
      ) : (
        <ul
          className="scrollbar-thin max-h-[clamp(14rem,88dvh_-_40rem,34rem)] divide-y divide-border overflow-y-auto rounded-md border border-border"
          role="listbox"
          aria-label={t("apps:repo.gitlabProjectsAria")}
        >
          {repos.map((repo) => (
            <RepoItem
              key={String(repo.id)}
              repo={repo}
              isSelected={selected?.fullName === repo.fullName}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {hasNextPage ? (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? t("apps:repo.loading") : t("apps:repo.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface RepoItemProps {
  repo: GitRepo
  isSelected: boolean
  onSelect: (repo: GitRepo) => void
}

export function RepoItem({
  repo,
  isSelected,
  onSelect,
}: RepoItemProps): React.JSX.Element {
  const { t } = useTranslation(["settings", "apps"])
  const parts = repo.fullName.split("/")
  const repoName = parts.at(-1) ?? repo.fullName
  const namespace = parts.slice(0, -1).join("/")

  return (
    <li
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      className={[
        "flex cursor-pointer items-start gap-3 px-3 py-3 text-sm transition-colors hover:bg-muted",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:-outline-offset-2 focus-visible:outline-none",
        isSelected ? "bg-primary/10" : "",
      ].join(" ")}
      onClick={() => onSelect(repo)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect(repo)
        }
      }}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-sans text-xs text-muted-foreground">
        {repoName.slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{repoName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {namespace}
          </span>
          {repo.private ? (
            <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {t("apps:repo.private")}
            </span>
          ) : null}
        </div>
        {repo.description ? (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {repo.description}
          </p>
        ) : null}
      </div>
      {isSelected ? (
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
      ) : null}
    </li>
  )
}

function RepoListSkeleton(): React.JSX.Element {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {[...Array<null>(4)].map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="size-8 skeleton-surface rounded-md" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-40 skeleton-surface rounded" />
            <div className="h-3 w-64 skeleton-surface rounded" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function CheckIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
