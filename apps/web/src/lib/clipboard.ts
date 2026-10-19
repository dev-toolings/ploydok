// SPDX-License-Identifier: AGPL-3.0-only
import { toast } from "sonner"
import i18n from "./i18n"

// `navigator.clipboard` only exists in secure contexts (HTTPS, localhost): a
// self-hosted instance served over plain HTTP (LAN IP, sslip.io) has none, so
// every copy button must go through this helper. Rejects when nothing was
// copied, so callers can tell the user to copy by hand.
export async function copyToClipboard(value: string): Promise<void> {
  // The legacy path needs the click's user activation: run it before any
  // await when the async API cannot exist.
  if (!window.isSecureContext) {
    legacyCopy(value)
    return
  }
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // API missing (older webviews), permission denied or document not
    // focused.
    legacyCopy(value)
  }
}

export function notifyCopyFailed(): void {
  toast.error(i18n.t("common:copyFailed"))
}

function legacyCopy(value: string): void {
  // A modal's focus trap pulls focus back from a node appended to <body>,
  // which empties the selection before the copy. Mount inside the open
  // dialog so the textarea stays within the trap.
  const active = document.activeElement
  const host =
    active?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body
  const previousFocus = active instanceof HTMLElement ? active : null
  const selection = document.getSelection()
  const previousRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i)
      )
    : []

  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.setAttribute("aria-hidden", "true")
  textarea.tabIndex = -1
  textarea.style.position = "fixed"
  textarea.style.top = "0"
  textarea.style.left = "-9999px"
  textarea.style.opacity = "0"
  // Below 16px, iOS Safari zooms the page on focus.
  textarea.style.fontSize = "16px"
  host.appendChild(textarea)

  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy was rejected")
    }
  } finally {
    textarea.remove()
    previousFocus?.focus({ preventScroll: true })
    if (selection && previousRanges.length > 0) {
      selection.removeAllRanges()
      for (const range of previousRanges) selection.addRange(range)
    }
  }
}
