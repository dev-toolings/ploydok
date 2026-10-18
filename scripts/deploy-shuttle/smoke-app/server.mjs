// SPDX-License-Identifier: AGPL-3.0-only
import { writeFileSync } from "node:fs"
import { createServer } from "node:http"

const token = process.env.SMOKE_BUILD_TOKEN ?? ""
writeFileSync("/tmp/ploydok-smoke", token)

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" })
  res.end(`ploydok-smoke ${token}\n`)
}).listen(Number(process.env.PORT ?? 8080))
