// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import ReactMarkdown from "react-markdown"
import {
  RiArrowDownSLine,
  RiFileList3Line,
  RiGitCommitLine,
} from "@remixicon/react"
import { createPageHead } from "../../lib/page-metadata"
import { ShellPage } from "../../components/layout/AppShell"
import { changelogEntries } from "../../content/changelog"
import { APP_VERSION } from "../../lib/hooks/use-unseen-release"
import type { ChangelogEntry } from "../../content/changelog"

export const Route = createFileRoute("/_authed/changelog")({
  head: createPageHead("changelog"),
  component: ChangelogPage,
})

function ChangelogPage(): React.JSX.Element {
  const latest = changelogEntries[0]

  return (
    <ShellPage
      title="Changelog"
      description="Release notes versionnées en Markdown, avec contexte opérationnel pour chaque changement livré."
      eyebrow="Release notes"
    >
      <div className="space-y-6">
        <section className="rounded-2xl bg-panel p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
                Current release
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                {latest.title}
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                {latest.summary}
              </p>
            </div>
            <div className="grid min-w-[220px] gap-2 rounded-md border border-border bg-background p-3 text-sm">
              <MetaRow label="App version" value={APP_VERSION} />
              <MetaRow
                label="Entries"
                value={String(changelogEntries.length)}
              />
              <MetaRow label="Source" value="Markdown" />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          {changelogEntries.map((entry, index) => (
            <ChangelogCollapse
              key={`${entry.version}-${entry.title}`}
              entry={entry}
              defaultOpen={index === 0}
            />
          ))}
        </section>
      </div>
    </ShellPage>
  )
}

function ChangelogCollapse(props: {
  entry: ChangelogEntry
  defaultOpen?: boolean
}): React.JSX.Element {
  return (
    <details
      className="group rounded-2xl bg-panel shadow-sm"
      open={props.defaultOpen}
    >
      <summary className="flex cursor-pointer list-none flex-col gap-4 p-5 outline-none transition-colors hover:bg-muted/30 md:flex-row md:items-start md:justify-between [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <RiFileList3Line className="size-4" />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {props.entry.version}
              </span>
              <span className="text-xs text-muted-foreground">
                {props.entry.date}
              </span>
            </div>
            <h2 className="text-base font-semibold tracking-tight">
              {props.entry.title}
            </h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              {props.entry.summary}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {props.entry.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
        <RiArrowDownSLine className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-5 py-6">
        <MarkdownBody source={props.entry.body} />
      </div>
    </details>
  )
}

function MarkdownBody(props: { source: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => (
          <h3 className="text-lg font-semibold tracking-tight">{children}</h3>
        ),
        h2: ({ children }) => (
          <h4 className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
            {children}
          </h4>
        ),
        p: ({ children }) => (
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="mt-3 grid max-w-3xl gap-2 text-sm leading-6">
            {children}
          </ul>
        ),
        li: ({ children }) => (
          <li className="flex gap-2">
            <RiGitCommitLine className="mt-1 size-4 shrink-0 text-primary" />
            <span>{children}</span>
          </li>
        ),
        code: ({ children }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
            {children}
          </code>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
      }}
    >
      {props.source}
    </ReactMarkdown>
  )
}

function MetaRow(props: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="font-medium">{props.value}</span>
    </div>
  )
}
