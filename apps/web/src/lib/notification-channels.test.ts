// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { isComingSoon } from "./notification-channels"

describe("isComingSoon", () => {
  it("treats Slack as a live channel", () => {
    expect(isComingSoon("slack")).toBe(false)
  })

  it("keeps WhatsApp blocked until the adapter ships", () => {
    expect(isComingSoon("whatsapp")).toBe(true)
  })
})
