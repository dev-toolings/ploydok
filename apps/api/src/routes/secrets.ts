// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Hono } from "hono"
import { z } from "zod"
import { and, eq, isNull, notInArray } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { nanoid } from "nanoid"
import { secrets, audit_log, databases, users } from "@ploydok/db"
import { createDb } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { env } from "../env"
import { getAppForUser } from "@ploydok/db/queries"
import { encryptSecret, decryptSecret } from "../secrets/crypto"
import { requireTotpVerified } from "../auth/second-factor"
import { childLogger } from "../logger"
import { sanitizeFrameworkEnvValues } from "../services/framework-env"
import type { AuthUser } from "../auth/middleware"

const execFileAsync = promisify(execFile)
const log = childLogger("secrets.routes")

// Valid secret key: UPPER_SNAKE_CASE starting with a letter
const SECRET_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/

const ScopeEnum = z.enum(["shared", "prod", "preview", "dev"])
const PhaseEnum = z.enum(["build", "runtime", "both"])
const ImportModeEnum = z.enum(["merge", "replace"])

const CreateSecretBody = z.object({
  key: z.string().regex(SECRET_KEY_REGEX, "Key must be UPPER_SNAKE_CASE"),
  value: z.string().min(1),
  scope: ScopeEnum,
  phase: PhaseEnum.optional().default("runtime"),
})

const UpdateSecretBody = z
  .object({
    value: z.string().min(1).optional(),
    phase: PhaseEnum.optional(),
  })
  .refine((body) => body.value !== undefined || body.phase !== undefined, {
    message: "value or phase required",
  })

const ExportSecretBody = z.object({
  age_recipient: z.string().min(1),
})

type Scope = z.infer<typeof ScopeEnum>
type Phase = z.infer<typeof PhaseEnum>
type ImportMode = z.infer<typeof ImportModeEnum>

type AppEnv = { Variables: { user?: AuthUser } }

function getUser(c: { get: (k: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

async function insertAuditLog(
  db: Db,
  userId: string,
  action: string,
  appId: string,
  keyHash: string
): Promise<void> {
  await db.insert(audit_log).values({
    user_id: userId,
    action,
    target_type: "secret",
    target_id: appId,
    metadata: JSON.stringify({ key_hash: keyHash }),
    created_at: new Date(),
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSecretsRouter(db: Db): Hono<any, any, any> {
  const router = new Hono<AppEnv>()
  const totpMiddleware = requireTotpVerified(db)
  const maybeTotpMiddleware = async (
    c: Parameters<typeof totpMiddleware>[0],
    next: Parameters<typeof totpMiddleware>[1]
  ) => {
    const user = getUser(c)
    const rows = await db
      .select({
        require_totp_for_secret_reveal: users.require_totp_for_secret_reveal,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (rows[0]?.require_totp_for_secret_reveal === false) {
      return next()
    }

    return totpMiddleware(c, next)
  }

  // GET /:id/secrets?scope=shared|prod|preview|dev
  router.get("/:id/secrets", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")
    const scopeParam = c.req.query("scope") as Scope | undefined
    const phaseParam = c.req.query("phase") as Phase | undefined

    const app = await getAppForUser(db, appId!, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const conditions = [eq(secrets.app_id, appId!)]
    if (scopeParam) {
      const parsed = ScopeEnum.safeParse(scopeParam)
      if (!parsed.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "Invalid scope" } },
          400
        )
      }
      conditions.push(eq(secrets.scope, parsed.data))
    }
    if (phaseParam) {
      const parsed = PhaseEnum.safeParse(phaseParam)
      if (!parsed.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "Invalid phase" } },
          400
        )
      }
      conditions.push(eq(secrets.phase, parsed.data))
    }

    const rows = await db
      .select({
        id: secrets.id,
        key: secrets.key,
        scope: secrets.scope,
        phase: secrets.phase,
        linked_database_id: secrets.linked_database_id,
        linked_database_name: databases.name,
        linked_database_kind: databases.kind,
        created_at: secrets.created_at,
      })
      .from(secrets)
      .leftJoin(databases, eq(secrets.linked_database_id, databases.id))
      .where(and(...(conditions as [ReturnType<typeof eq>])))

    return c.json({
      secrets: rows.map((r) => ({
        key: r.key,
        scope: r.scope,
        phase: r.phase,
        linked_database_id: r.linked_database_id,
        linked_database_name: r.linked_database_name,
        linked_database_kind: r.linked_database_kind,
        managed_by: r.linked_database_id ? "database" : "manual",
        updated_at: r.created_at?.toISOString() ?? null,
      })),
    })
  })

  // POST /:id/secrets — upsert (create or update by key+scope)
  router.post("/:id/secrets", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")

    const app = await getAppForUser(db, appId!, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    let body: z.infer<typeof CreateSecretBody>
    try {
      body = CreateSecretBody.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }

    const { enc, nonce } = await encryptSecret(body.value)

    // Check if secret already exists for this key+scope+phase tuple.
    const matchingPhase = await db
      .select({
        id: secrets.id,
        linked_database_id: secrets.linked_database_id,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.app_id, appId!),
          eq(secrets.key, body.key),
          eq(secrets.scope, body.scope),
          eq(secrets.phase, body.phase)
        )
      )
      .limit(1)

    // Linked secrets must be managed via DB link, not edited manually
    if (matchingPhase[0]?.linked_database_id) {
      return c.json(
        {
          error: {
            code: "LINKED_SECRET",
            message: "linked secret — use DB link management instead",
          },
        },
        400
      )
    }

    const isUpdate = matchingPhase.length > 0
    const secretId = matchingPhase[0]?.id ?? nanoid()

    if (isUpdate) {
      await db
        .update(secrets)
        .set({
          value_ciphertext: enc,
          nonce,
          created_at: new Date(),
        })
        .where(eq(secrets.id, secretId))
    } else {
      await db.insert(secrets).values({
        id: secretId,
        app_id: appId,
        project_id: app.project_id,
        scope: body.scope,
        phase: body.phase,
        key: body.key,
        value_ciphertext: enc,
        nonce,
        created_at: new Date(),
      })
    }

    const action = isUpdate ? "secret.updated" : "secret.created"
    await insertAuditLog(db, user.id, action, appId, keyHash(body.key))

    return c.json(
      { key: body.key, scope: body.scope, phase: body.phase },
      isUpdate ? 200 : 201
    )
  })

  // PATCH /:id/secrets/:key?scope=&phase= — update the value and/or move the
  // secret to another phase. The phase is part of the secret identity, so a
  // move is refused when the target phase already holds the same key.
  router.patch("/:id/secrets/:key", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")
    const key = c.req.param("key")
    const scopeParam = c.req.query("scope") as Scope | undefined
    const phaseParam = c.req.query("phase") as Phase | undefined

    const app = await getAppForUser(db, appId!, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    if (!scopeParam) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "scope query param required",
          },
        },
        400
      )
    }
    const parsedScope = ScopeEnum.safeParse(scopeParam)
    if (!parsedScope.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid scope" } },
        400
      )
    }

    if (!phaseParam) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "phase query param required",
          },
        },
        400
      )
    }
    const parsedPhase = PhaseEnum.safeParse(phaseParam)
    if (!parsedPhase.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid phase" } },
        400
      )
    }

    let body: z.infer<typeof UpdateSecretBody>
    try {
      body = UpdateSecretBody.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }

    const existing = await db
      .select({
        id: secrets.id,
        linked_database_id: secrets.linked_database_id,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.app_id, appId!),
          eq(secrets.key, key!),
          eq(secrets.scope, parsedScope.data),
          eq(secrets.phase, parsedPhase.data)
        )
      )
      .limit(1)

    const row = existing[0]
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Secret not found" } },
        404
      )
    }

    if (row.linked_database_id) {
      return c.json(
        {
          error: {
            code: "LINKED_SECRET",
            message: "managed by a database link, unlink first",
          },
        },
        400
      )
    }

    const nextPhase = body.phase ?? parsedPhase.data
    if (nextPhase !== parsedPhase.data) {
      const conflict = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.app_id, appId!),
            eq(secrets.key, key!),
            eq(secrets.scope, parsedScope.data),
            eq(secrets.phase, nextPhase)
          )
        )
        .limit(1)
      if (conflict[0]) {
        return c.json(
          {
            error: {
              code: "SECRET_EXISTS",
              message: `${key} already exists for the ${nextPhase} phase`,
            },
          },
          409
        )
      }
    }

    const encrypted =
      body.value !== undefined ? await encryptSecret(body.value) : null
    await db
      .update(secrets)
      .set({
        ...(encrypted
          ? { value_ciphertext: encrypted.enc, nonce: encrypted.nonce }
          : {}),
        phase: nextPhase,
        created_at: new Date(),
      })
      .where(eq(secrets.id, row.id))

    await insertAuditLog(db, user.id, "secret.updated", appId!, keyHash(key!))

    return c.json({
      key,
      scope: parsedScope.data,
      phase: nextPhase,
    })
  })

  // DELETE /:id/secrets/:key?scope=
  router.delete("/:id/secrets/:key", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")
    const key = c.req.param("key")
    const scopeParam = c.req.query("scope") as Scope | undefined
    const phaseParam = c.req.query("phase") as Phase | undefined

    const app = await getAppForUser(db, appId!, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    if (!scopeParam) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "scope query param required",
          },
        },
        400
      )
    }
    const parsedScope = ScopeEnum.safeParse(scopeParam)
    if (!parsedScope.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid scope" } },
        400
      )
    }

    const parsedPhase = PhaseEnum.safeParse(phaseParam)
    if (!parsedPhase.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid phase" } },
        400
      )
    }

    const existing = await db
      .select({
        id: secrets.id,
        linked_database_id: secrets.linked_database_id,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.app_id, appId!),
          eq(secrets.key, key!),
          eq(secrets.scope, parsedScope.data),
          eq(secrets.phase, parsedPhase.data)
        )
      )
      .limit(1)

    if (existing[0]?.linked_database_id) {
      return c.json(
        {
          error: {
            code: "LINKED_SECRET",
            message: "linked secret — unlink the database instead",
          },
        },
        400
      )
    }

    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.app_id, appId!),
          eq(secrets.key, key!),
          eq(secrets.scope, parsedScope.data),
          eq(secrets.phase, parsedPhase.data)
        )
      )

    await insertAuditLog(db, user.id, "secret.deleted", appId, keyHash(key))

    return c.json({ deleted: true })
  })

  // POST /:id/secrets/:key/reveal — TOTP required unless disabled by user preference.
  router.post("/:id/secrets/:key/reveal", maybeTotpMiddleware, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")
    const key = c.req.param("key")
    const scopeParam = c.req.query("scope") as Scope | undefined
    const phaseParam = (c.req.query("phase") ?? "runtime") as Phase

    const app = await getAppForUser(db, appId!, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    if (!scopeParam) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "scope query param required",
          },
        },
        400
      )
    }
    const parsedScope = ScopeEnum.safeParse(scopeParam)
    if (!parsedScope.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid scope" } },
        400
      )
    }

    const parsedPhase = PhaseEnum.safeParse(phaseParam)
    if (!parsedPhase.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid phase" } },
        400
      )
    }

    const rows = await db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.app_id, appId!),
          eq(secrets.key, key!),
          eq(secrets.scope, parsedScope.data),
          eq(secrets.phase, parsedPhase.data)
        )
      )
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Secret not found" } },
        404
      )
    }

    const value = await decryptSecret(
      row.value_ciphertext as Buffer,
      row.nonce as Buffer
    )

    await insertAuditLog(db, user.id, "secret.revealed", appId!, keyHash(key!))

    return c.json({ value })
  })

  // POST /:id/secrets/import — multipart .env file
  router.post("/:id/secrets/import", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")

    const app = await getAppForUser(db, appId!, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const defaultScopeParam = (c.req.query("scope") ?? "shared") as Scope
    const defaultPhaseParam = (c.req.query("phase") ?? "runtime") as Phase
    const modeParam = c.req.query("mode")
    let mode: ImportMode = "merge"
    if (modeParam !== undefined) {
      const parsedMode = ImportModeEnum.safeParse(modeParam)
      if (!parsedMode.success) {
        return c.json(
          {
            error: { code: "VALIDATION_ERROR", message: "Invalid import mode" },
          },
          400
        )
      }
      mode = parsedMode.data
    }
    const parsedDefaultScope = ScopeEnum.safeParse(defaultScopeParam)
    if (!parsedDefaultScope.success) {
      return c.json(
        {
          error: { code: "VALIDATION_ERROR", message: "Invalid default scope" },
        },
        400
      )
    }
    const defaultScope = parsedDefaultScope.data
    const parsedDefaultPhase = PhaseEnum.safeParse(defaultPhaseParam)
    if (!parsedDefaultPhase.success) {
      return c.json(
        {
          error: { code: "VALIDATION_ERROR", message: "Invalid default phase" },
        },
        400
      )
    }
    const defaultPhase = parsedDefaultPhase.data

    let rawContent: string
    const contentType = c.req.header("content-type") ?? ""

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData()
      const file = formData.get("file")
      if (!file || typeof file === "string") {
        return c.json(
          {
            error: { code: "VALIDATION_ERROR", message: "Missing file field" },
          },
          400
        )
      }
      rawContent = await (file as File).text()
    } else if (contentType.includes("application/json")) {
      const json = await c.req.json<{ content?: string }>()
      if (typeof json.content !== "string") {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Missing content field",
            },
          },
          400
        )
      }
      rawContent = json.content
    } else {
      // Accept raw text/plain body as well
      rawContent = await c.req.text()
    }

    const parsedRaw = parseDotenv(rawContent, defaultScope, defaultPhase)
    const sanitized = sanitizeFrameworkEnvValues(
      null,
      Object.fromEntries(parsedRaw.map((item) => [item.key, item.value]))
    )
    const parsed = parsedRaw.map((item) =>
      sanitized.repaired.includes(item.key)
        ? { ...item, value: sanitized.values[item.key] ?? item.value }
        : item
    )
    if (parsed.length === 0 && mode === "merge") {
      return c.json({ imported: 0, removed: 0 })
    }

    for (const { key, scope, phase } of parsed) {
      const existing = await db
        .select({
          id: secrets.id,
          linked_database_id: secrets.linked_database_id,
        })
        .from(secrets)
        .where(
          and(
            eq(secrets.app_id, appId!),
            eq(secrets.key, key!),
            eq(secrets.scope, scope),
            eq(secrets.phase, phase)
          )
        )
        .limit(1)

      if (existing[0]?.linked_database_id) {
        return c.json(
          {
            error: {
              code: "LINKED_SECRET",
              message: `${key} is managed by a database link — unlink the database instead`,
            },
          },
          400
        )
      }
    }

    let imported = 0
    for (const { key, value, scope, phase } of parsed) {
      const { enc, nonce } = await encryptSecret(value)

      const existing = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.app_id, appId!),
            eq(secrets.key, key!),
            eq(secrets.scope, scope),
            eq(secrets.phase, phase)
          )
        )
        .limit(1)

      if (existing.length > 0) {
        await db
          .update(secrets)
          .set({ value_ciphertext: enc, nonce, created_at: new Date() })
          .where(eq(secrets.id, existing[0]!.id))
      } else {
        await db.insert(secrets).values({
          id: nanoid(),
          app_id: appId,
          project_id: app.project_id,
          scope,
          phase,
          key,
          value_ciphertext: enc,
          nonce,
          created_at: new Date(),
        })
      }
      imported++
    }

    let removed = 0
    if (mode === "replace") {
      const targetKeys = new Set(
        parsed
          .filter(
            ({ scope, phase }) =>
              scope === defaultScope && phase === defaultPhase
          )
          .map(({ key }) => key)
      )
      const deleteConditions: SQL[] = [
        eq(secrets.app_id, appId!),
        eq(secrets.scope, defaultScope),
        eq(secrets.phase, defaultPhase),
        isNull(secrets.linked_database_id),
      ]
      if (targetKeys.size > 0) {
        deleteConditions.push(notInArray(secrets.key, [...targetKeys]))
      }
      const removedRows = await db
        .delete(secrets)
        .where(and(...deleteConditions))
        .returning({ id: secrets.id })
      removed = removedRows.length
    }

    const auditAction = mode === "replace" ? "secret.synced" : "secret.imported"
    await insertAuditLog(db, user.id, auditAction, appId, `count:${imported}`)
    log.info({ appId, imported, removed, mode }, "secrets imported")

    return c.json({ imported, removed })
  })

  // GET /:id/secrets/export?scope=&age_recipient=
  router.get("/:id/secrets/export", maybeTotpMiddleware, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const scopeParam = c.req.query("scope") as Scope | undefined
    const ageRecipient = c.req.query("age_recipient")

    if (!ageRecipient) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "age_recipient query param required",
          },
        },
        400
      )
    }

    // Check age binary is available
    try {
      await execFileAsync("age", ["--version"])
    } catch {
      return c.json(
        {
          error: {
            code: "NOT_IMPLEMENTED",
            message: "age binary not installed on this server",
          },
        },
        501
      )
    }

    const conditions = [eq(secrets.app_id, appId!)]
    if (scopeParam) {
      const parsed = ScopeEnum.safeParse(scopeParam)
      if (!parsed.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "Invalid scope" } },
          400
        )
      }
      conditions.push(eq(secrets.scope, parsed.data))
    }

    const rows = await db
      .select()
      .from(secrets)
      .where(and(...(conditions as [ReturnType<typeof eq>])))

    // Decrypt all secrets to build .env content
    const lines: string[] = []
    for (const row of rows) {
      const value = await decryptSecret(
        row.value_ciphertext as Buffer,
        row.nonce as Buffer
      )
      const escaped = value.replace(/\n/g, "\\n")
      lines.push(`${row.key}=${escaped}`)
    }
    const dotenvContent = lines.join("\n")

    // Encrypt with age
    let encrypted: string
    try {
      const { stdout } = await execFileAsync(
        "age",
        ["-r", ageRecipient, "--armor"],
        {
          input: dotenvContent,
        } as Parameters<typeof execFileAsync>[2] & { input: string }
      )
      encrypted = typeof stdout === "string" ? stdout : stdout.toString("utf8")
    } catch (err) {
      log.error({ err, appId }, "age encryption failed")
      return c.json(
        { error: { code: "INTERNAL_ERROR", message: "Encryption failed" } },
        500
      )
    }

    await insertAuditLog(
      db,
      user.id,
      "secret.exported",
      appId,
      `count:${rows.length}`
    )

    c.header("Content-Type", "text/plain")
    c.header(
      "Content-Disposition",
      `attachment; filename="secrets-${appId}.env.age"`
    )
    return c.body(encrypted)
  })

  return router
}

// ---------------------------------------------------------------------------
// .env parser — tolerant of comments, blank lines, quotes, escapes
// ---------------------------------------------------------------------------

function parseDotenv(
  content: string,
  defaultScope: Scope,
  defaultPhase: Phase
): { key: string; value: string; scope: Scope; phase: Phase }[] {
  const results: { key: string; value: string; scope: Scope; phase: Phase }[] =
    []
  const lines = content.split(/\r?\n/)
  let currentScope: Scope = defaultScope
  let currentPhase: Phase = defaultPhase

  for (const rawLine of lines) {
    const line = rawLine.trim()

    // Blank or comment
    if (!line || line.startsWith("#")) {
      // Detect scope directive in comment: # @scope prod
      const scopeDirective = line.match(/^#\s*@scope\s+(\w+)/)
      if (scopeDirective) {
        const parsed = ScopeEnum.safeParse(scopeDirective[1])
        if (parsed.success) currentScope = parsed.data
      }
      const phaseDirective = line.match(/^#\s*@phase\s+(\w+)/)
      if (phaseDirective) {
        const parsed = PhaseEnum.safeParse(phaseDirective[1])
        if (parsed.success) currentPhase = parsed.data
      }
      continue
    }

    // Scope/phase prefix: @prod @build KEY=VALUE
    const prefixed = line.match(/^((?:@\w+\s+)+)([A-Z][A-Z0-9_]*)=(.*)$/)
    if (prefixed) {
      let scoped = currentScope
      let phased = currentPhase
      const prefixes = prefixed[1]!.trim().split(/\s+/)
      for (const prefix of prefixes) {
        const raw = prefix.slice(1)
        const parsedScope = ScopeEnum.safeParse(raw)
        if (parsedScope.success) {
          scoped = parsedScope.data
          continue
        }
        const parsedPhase = PhaseEnum.safeParse(raw)
        if (parsedPhase.success) {
          phased = parsedPhase.data
        }
      }
      const value = unquote(prefixed[3] ?? "")
      results.push({ key: prefixed[2]!, value, scope: scoped, phase: phased })
      continue
    }

    // Standard KEY=VALUE
    const eqIndex = line.indexOf("=")
    if (eqIndex === -1) continue

    const key = line.slice(0, eqIndex).trim()
    const rawValue = line.slice(eqIndex + 1)

    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue

    results.push({
      key,
      value: unquote(rawValue),
      scope: currentScope,
      phase: currentPhase,
    })
  }

  return results
}

function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"')
  }
  // Strip inline comment for unquoted values
  const commentIdx = trimmed.indexOf(" #")
  if (commentIdx !== -1) {
    return trimmed.slice(0, commentIdx).trim()
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// Prod singleton
// ---------------------------------------------------------------------------

const prodDb = createDb(env.DATABASE_URL)
export const secretsRouter = createSecretsRouter(prodDb)
