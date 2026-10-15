// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { useGitHubAppConfig, useGitHubRepos } from "../../lib/github"
import type { GitRepo } from "@ploydok/shared"

interface RepoSelectorProps {
  selected?: GitRepo | null
  onSelect: (repo: GitRepo) => void
}

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState<T>(value)

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

export function RepoSelector({
  selected,
  onSelect,
}: RepoSelectorProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [search, setSearch] = React.useState("")
  const debouncedSearch = useDebounce(search, 200)

  const { data: appConfig } = useGitHubAppConfig()
  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
  } = useGitHubRepos({ search: debouncedSearch || undefined })

  if (!appConfig?.configured) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {t("repo.setupGithub")}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            window.location.href = "/settings/git-providers/github"
          }}
        >
          {t("repo.setupGithubCta")}
        </Button>
      </div>
    )
  }

  const repos = data?.pages.flatMap((p) => p.repos) ?? []

  return (
    <div className="space-y-3">
      <input
        type="search"
        placeholder={t("create.searchRepos")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none"
        aria-label={t("repo.searchAria")}
      />

      {isLoading ? (
        <RepoListSkeleton />
      ) : error ? (
        <p className="text-sm text-destructive" role="alert">
          {t("repo.loadFailed", { message: error.message })}
        </p>
      ) : repos.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {debouncedSearch
            ? t("repo.noMatch", { query: debouncedSearch })
            : t("repo.none")}
        </p>
      ) : (
        <ul
          className="scrollbar-thin max-h-[clamp(14rem,88dvh_-_40rem,34rem)] divide-y divide-border overflow-y-auto rounded-md border border-border"
          role="listbox"
          aria-label={t("repo.repositories")}
        >
          {repos.map((repo) => (
            <RepoItem
              key={repo.id}
              repo={repo}
              isSelected={selected?.fullName === repo.fullName}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {hasNextPage && (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? t("repo.loading") : t("repo.loadMore")}
          </Button>
        </div>
      )}
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

function RepoItem({
  repo,
  isSelected,
  onSelect,
}: RepoItemProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [owner, repoName] = repo.fullName.split("/")

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
      <div className="size-8 shrink-0 overflow-hidden rounded-full bg-muted">
        <img
          src={`https://github.com/${owner}.png?size=32`}
          alt={owner}
          className="size-full object-cover"
          loading="lazy"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{repoName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {owner}
          </span>
          {repo.private && (
            <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {t("repo.private")}
            </span>
          )}
        </div>
        {repo.description && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {repo.description}
          </p>
        )}
      </div>
      {isSelected && (
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
      )}
    </li>
  )
}

function RepoListSkeleton(): React.JSX.Element {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {[...Array<null>(4)].map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="size-8 skeleton-surface rounded-full" />
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
