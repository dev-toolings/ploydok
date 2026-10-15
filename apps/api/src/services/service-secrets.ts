// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm"
import { services, type Db, type ServiceRow } from "@ploydok/db"
import { encryptField, decryptField } from "../github/app-credentials"

type SecretEntry = { ref: string; enc: string; nonce: string }
type Vault = Record<string, SecretEntry>

export async function protectServiceSecrets(compose: string, values: Record<string, string>) {
  const vault: Vault = {}
  let referenced = compose
  // Longest first prevents replacing a substring of another generated value.
  for (const [index, [key, value]] of Object.entries(values).sort((a, b) => b[1].length - a[1].length).entries()) {
    const ref = `__PLOYDOK_SECRET_${index}__`
    if (compose.includes(ref)) throw new Error("Reserved service secret reference in Compose")
    const { enc, nonce } = await encryptField(value)
    vault[key] = { ref, enc: enc.toString("base64"), nonce: nonce.toString("base64") }
    if (value) referenced = referenced.split(value).join(ref)
  }
  return { compose_raw: referenced, generated_env: vault, secrets_encrypted: true }
}

export async function revealServiceSecrets(service: Pick<ServiceRow, "generated_env" | "secrets_encrypted">): Promise<Record<string, string>> {
  if (!service.secrets_encrypted) throw new Error("Service secrets migration required")
  const values: Record<string, string> = {}
  for (const [key, entry] of Object.entries(service.generated_env as Vault)) {
    values[key] = await decryptField(Buffer.from(entry.enc, "base64"), Buffer.from(entry.nonce, "base64"))
  }
  return values
}

export async function resolveServiceCompose(service: Pick<ServiceRow, "compose_raw" | "generated_env" | "secrets_encrypted">): Promise<string> {
  const values = await revealServiceSecrets(service)
  const refs = new Map(Object.entries(service.generated_env as Vault).map(([key, entry]) => [entry.ref, values[key]!]))
  // One pass: decrypted text must never be interpreted as another reference.
  return service.compose_raw.replace(/__PLOYDOK_SECRET_\d+__/g, ref => {
    const value = refs.get(ref)
    if (value === undefined) throw new Error("Unknown service secret reference")
    return value
  })
}

export function maskServiceSecrets<T extends { compose_raw: string; generated_env: unknown; secrets_encrypted?: boolean }>(service: T): T {
  return { ...service, compose_raw: service.secrets_encrypted ? service.compose_raw.replace(/__PLOYDOK_SECRET_\d+__/g, "[REDACTED]") : "[REDACTED]",
    generated_env: Object.fromEntries(Object.keys((service.generated_env ?? {}) as object).map(key => [key, "[REDACTED]"])) }
}

export async function migrateServiceSecrets(db: Db): Promise<number> {
  return db.transaction(async tx => {
    // Serialize migration with row writers; each row changes atomically.
    const rows = await tx.select().from(services).where(eq(services.secrets_encrypted, false)).for("update")
    for (const row of rows) {
      const protectedValues = await protectServiceSecrets(row.compose_raw, row.generated_env as Record<string, string>)
      await tx.update(services).set(protectedValues).where(eq(services.id, row.id))
    }
    return rows.length
  })
}
