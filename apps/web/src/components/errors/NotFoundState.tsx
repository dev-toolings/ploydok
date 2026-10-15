// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@workspace/ui/components/button";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SearchOffIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="8" x2="14" y2="14" />
    </svg>
  );
}

function HomeIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NotFoundState(): React.JSX.Element {
  const { t } = useTranslation("errors");
  return (
    <div
      role="alert"
      className="rounded-2xl bg-panel p-8 flex flex-col items-center gap-4 text-center max-w-md mx-auto"
    >
      {/* Icon */}
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <SearchOffIcon className="size-6 text-muted-foreground" />
      </div>

      {/* Status badge */}
      <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs font-mono text-muted-foreground">
        404
      </span>

      {/* Title + message */}
      <div className="space-y-1">
        <h2 className="text-base font-medium text-foreground">{t("pageNotFound")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("pageNotFoundBody")}
        </p>
      </div>

      {/* Action */}
      <Button variant="default" size="sm" asChild>
        <Link to="/dashboard">
          <HomeIcon className="size-3.5 mr-1.5" />
          {t("common:goToDashboard")}
        </Link>
      </Button>
    </div>
  );
}
