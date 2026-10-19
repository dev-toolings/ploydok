// SPDX-License-Identifier: AGPL-3.0-only

// `navigator.clipboard` only exists in secure contexts: a self-hosted
// instance served over plain HTTP (LAN IP, sslip.io) has none, so every copy
// button must go through this helper and its `execCommand` fallback.
export async function copyToClipboard(value: string): Promise<void> {
  if (window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Permission denied or document not focused: try the legacy path.
    }
  }
  legacyCopy(value)
}

function legacyCopy(value: string): void {
  // A modal's focus trap pulls focus back from a node appended to <body>,
  // which empties the selection before the copy. Mount inside the open
  // dialog so the textarea stays within the trap.
  const active = document.activeElement
  const host =
    active?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body
  const previousFocus = active instanceof HTMLElement ? active : null

  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.setAttribute("aria-hidden", "true")
  textarea.style.position = "fixed"
  textarea.style.top = "0"
  textarea.style.left = "-9999px"
  textarea.style.opacity = "0"
  host.appendChild(textarea)

  try {
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy was rejected")
    }
  } finally {
    textarea.remove()
    previousFocus?.focus()
  }
}
