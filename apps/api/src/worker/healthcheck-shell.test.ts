// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from "bun:test"
import { healthcheckShell, quotePosixShellLiteral } from "./healthcheck-shell"

it("keeps spaces, quotes, and shell syntax literal in healthcheck paths", () => {
  const path = `/ready path/'"$(printf ready)`
  const script = healthcheckShell(8080, path)

  expect(quotePosixShellLiteral(path)).toBe(
    `'${path.replaceAll("'", "'\\''")}'`
  )
  expect(script).toContain(
    `"http://$host"':8080/ready path/'\\''"$(printf ready)'`
  )
  expect(script).not.toContain(`"http://$host:8080${path}"`)
})
