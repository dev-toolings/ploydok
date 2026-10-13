// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto"

export const diskHostKey = createHash("sha256")
  .update(
    Bun.env["PLOYDOK_AGENT_ADDR"] ??
      Bun.env["PLOYDOK_AGENT_SOCKET"] ??
      "default"
  )
  .digest("hex")
