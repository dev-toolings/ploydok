// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// QuickActions
// ---------------------------------------------------------------------------

interface QuickActionsProps {
  isGitHubConnected: boolean;
  onCreateApp: () => void;
}

export function QuickActions({ isGitHubConnected, onCreateApp }: QuickActionsProps): React.JSX.Element {
  const { t } = useTranslation("workspace");
  return (
    <div className="rounded-2xl bg-panel p-5">
      <p className="text-xs text-muted-foreground font-medium mb-3">
        {t("dashboard.quickActions")}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button size="sm" onClick={onCreateApp} className="gap-1.5">
          <PlusIcon className="size-3.5" aria-hidden="true" />
          {t("dashboard.newApp")}
        </Button>

        {!isGitHubConnected && (
          <Button size="sm" variant="outline" asChild>
            <Link
              to="/settings/git-providers/$slug"
              params={{ slug: "github" }}
              className="gap-1.5 inline-flex items-center"
            >
              <GitHubIcon className="size-3.5" aria-hidden="true" />
              {t("dashboard.connectGitHub")}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function PlusIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
