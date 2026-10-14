// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes } from "node:crypto"
import { generateDomain, resolveTemplate } from "@ploydok/shared"
import { parse, stringify } from "yaml"
import { childLogger } from "../logger"
import {
  composeRequiresContainerRuntime,
  composeToContainers,
} from "./compose-to-containers.js"
import { planComposeSwarmDeploy } from "../worker/compose-swarm.js"

const log = childLogger("marketplace-template")
const DOLLAR_MARKER = "\u0000ploydok-dollar\u0000"
function replaceTemplateExpressions(value: string, replace: (match: string, token: string) => string): string {
  let result = "", position = 0
  while (position < value.length) {
    const start = value.indexOf("${", position)
    if (start === -1) return result + value.slice(position)
    result += value.slice(position, start)
    let end = start + 2, depth = 1
    for (; end < value.length && depth; end++) {
      if (value[end] === "{") depth++
      if (value[end] === "}") depth--
    }
    if (depth) throw validationError("Unclosed template variable expression")
    result += replace(value.slice(start, end), value.slice(start + 2, end - 1))
    position = end
  }
  return result
}
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const HELPER_NAMES = new Set([
  "domain",
  "password",
  "base64",
  "hash",
  "uuid",
  "timestamp",
  "timestampms",
  "timestamps",
  "randomPort",
  "jwt",
  "username",
  "email",
])

export interface DeclaredEntrypoint {
  serviceName: string
  port: number
}

export interface PreparedTemplateInstall {
  composeResolved: string
  generatedVars: Record<string, string>
  domain: string | null
  declaredEntrypoint: DeclaredEntrypoint | null
  runtimeMode: "docker" | "swarm"
}

type TemplateDocument = {
  variables?: Record<string, unknown>
  config?: {
    env?: unknown
    domains?: unknown
  }
}

type HelperContext = {
  projectSlug: string
  variables: Record<string, string>
  generatedVars: Record<string, string>
  helperDomain: string | null
  scope: string
}

function validationError(message: string): Error & { code: "VALIDATION_ERROR" } {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR" as const })
}

function randomHex(bytes: number): string {
  return randomBytes(Math.max(1, bytes)).toString("hex")
}

function randomBase64(bytes: number): string {
  return randomBytes(Math.max(1, bytes)).toString("base64")
}

function positiveLength(token: string, fallback: number): number {
  const colon = token.indexOf(":")
  if (colon === -1) return fallback
  const value = Number.parseInt(token.slice(colon + 1), 10)
  const length = Number.isFinite(value) && value > 0 ? value : fallback
  if (length > 65536) throw validationError("Generator length exceeds 65536")
  return length
}

function randomPassword(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  let value = ""
  for (let index = 0; index < length; index++) {
    value += alphabet[randomBytes(1)[0]! % alphabet.length]
  }
  return value
}

function randomUsername(): string {
  return `user_${randomHex(5)}`
}

function randomEmail(): string {
  return `${randomUsername()}@example.com`
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function generateJwt(
  secret: string | undefined,
  payload: Record<string, unknown> | undefined
): string {
  const now = Math.floor(Date.now() / 1000)
  const body = {
    iss: "dokploy",
    iat: now,
    exp: Math.floor(new Date("2030-01-01T00:00:00Z").getTime() / 1000),
    ...payload,
  }
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const encodedPayload = base64Url(JSON.stringify(body))
  const key = secret ?? randomBytes(32).toString("hex")
  const signature = createHmac("sha256", key)
    .update(`${header}.${encodedPayload}`)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  return `${header}.${encodedPayload}.${signature}`
}

function parseJwtPayload(
  token: string,
  variables: Record<string, string>
): Record<string, unknown> | undefined {
  if (!token) return undefined
  const value = variables[token] ?? token
  if (!value.trimStart().startsWith("{") || !value.trimEnd().endsWith("}")) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function helperName(token: string): string {
  const colon = token.indexOf(":")
  return colon === -1 ? token : token.slice(0, colon)
}

function isHelper(token: string): boolean {
  const name = helperName(token)
  return HELPER_NAMES.has(name) && !/^\w+:[-+?]/.test(token)
}

function helperValue(token: string, context: HelperContext, legacyInline = false): string | null {
  if (!isHelper(token)) return null
  const generatedKey = context.scope ? `${context.scope}:${token}` : token
  if (context.generatedVars[generatedKey] !== undefined) return context.generatedVars[generatedKey]!

  let value: string
  const name = helperName(token)
  if (legacyInline && ["domain", "password", "base64", "hash", "uuid", "timestamp", "timestampms", "timestamps"].includes(name) && (!["timestampms", "timestamps"].includes(name) || token === name)) {
    const legacy = resolveTemplate(`\${${token}}`, { projectSlug: context.projectSlug })
    value = legacy.composeResolved
    if (legacy.domain) context.helperDomain = legacy.domain
  } else if (name === "domain") {
    value = generateDomain(context.projectSlug)
    context.helperDomain = value
  } else if (name === "password") {
    value = randomPassword(positiveLength(token, 16))
  } else if (name === "base64") {
    value = randomBase64(positiveLength(token, 32))
  } else if (name === "hash") {
    value = randomHex(positiveLength(token, 8)).slice(0, positiveLength(token, 8))
  } else if (name === "uuid") {
    value = crypto.randomUUID()
  } else if (name === "timestamp") {
    value = Date.now().toString()
  } else if (name === "timestampms") {
    const date = token.slice("timestampms:".length)
    value = token === "timestampms" ? Date.now().toString() : new Date(date).getTime().toString()
  } else if (name === "timestamps") {
    const date = token.slice("timestamps:".length)
    const milliseconds = token === "timestamps" ? Date.now() : new Date(date).getTime()
    value = Math.round(milliseconds / 1000).toString()
  } else if (name === "randomPort") {
    value = (1 + Math.floor(Math.random() * 65535)).toString()
  } else if (name === "jwt") {
    const argument = token.slice("jwt:".length)
    if (token === "jwt") {
      value = generateJwt(undefined, undefined)
    } else if (/^\d{1,3}$/.test(argument)) {
      value = randomHex(Number.parseInt(argument, 10))
    } else {
      const separator = argument.indexOf(":")
      const secretToken = separator === -1 ? argument : argument.slice(0, separator)
      const payloadToken = separator === -1 ? "" : argument.slice(separator + 1)
      const secret = context.variables[secretToken] ?? secretToken
      value = generateJwt(secret, parseJwtPayload(payloadToken, context.variables))
    }
  } else if (name === "username") {
    value = randomUsername()
  } else {
    value = randomEmail()
  }

  if (value === "NaN") throw validationError("Invalid date in timestamp helper")
  context.generatedVars[generatedKey] = value
  return value
}

function resolveHelpers(value: string, context: HelperContext): string {
  return replaceTemplateExpressions(value.replaceAll("$$", DOLLAR_MARKER), (match, token) => helperValue(token, context) ?? match).replaceAll(DOLLAR_MARKER, () => "$$")
}

function resolveVariableReferences(
  value: string,
  variables: Record<string, string>
): string {
  let resolved = value
  for (let pass = 0; pass < Object.keys(variables).length + 1; pass++) {
    const next = replaceTemplateExpressions(resolved, (match, token) => {
      return VARIABLE_PATTERN.test(token) && Object.hasOwn(variables, token)
        ? variables[token]!
        : match
    })
    if (next === resolved) break
    resolved = next
  }
  return resolved
}

function processTemplateValue(value: string, context: HelperContext): string {
  return resolveVariableReferences(resolveHelpers(value, context), context.variables)
}

function parseTemplate(templateToml: string): TemplateDocument {
  if (templateToml.length > 200_000) {
    throw validationError("template.toml exceeds the 200000 character limit")
  }
  try {
    const parsed: unknown = Bun.TOML.parse(templateToml)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("TOML document must be an object")
    }
    return parsed as TemplateDocument
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw validationError(`Invalid template.toml: ${message}`)
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value)
}

function processConfigEnv(
  raw: unknown,
  context: HelperContext
): Record<string, string> {
  const env: Record<string, string> = Object.create(null)
  if (raw === undefined || raw === null) return env

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        context.scope = `config.env:${item.split("=")[0]}`
        const processed = processTemplateValue(item, context)
        const separator = processed.indexOf("=")
        if (separator > 0) {
          env[processed.slice(0, separator)] = processed.slice(separator + 1)
        }
        continue
      }
      if (item && typeof item === "object") {
        for (const [key, value] of Object.entries(item)) {
          context.scope = `config.env:${key}`
          env[key] = processTemplateValue(stringValue(value), context)
        }
      }
    }
    return env
  }

  if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      context.scope = `config.env:${key}`
      env[key] = processTemplateValue(stringValue(value), context)
    }
  }
  return env
}

// A single scan keeps inserted values opaque and supports nested defaults.
function interpolateCompose(compose: string, variables: Record<string, string>, context: HelperContext): string {
  const missing = new Set<string>()
  const interpolate = (text: string): string => {
    let output = ""
    for (let i = 0; i < text.length;) {
      if (text[i] !== "$") { output += text[i++]; continue }
      if (text[i + 1] === "$") { output += "$"; i += 2; continue }
      if (text[i + 1] !== "{") {
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1))
        if (!match) { output += "$"; i++; continue }
        const name = match[0]
        if (!Object.hasOwn(variables, name)) missing.add(name)
        output += variables[name] ?? ""
        i += name.length + 1
        continue
      }
      let end = i + 2, depth = 1
      for (; end < text.length && depth; end++) {
        if (text[end] === "{") depth++
        if (text[end] === "}") depth--
      }
      if (depth) throw validationError("Unclosed Compose interpolation")
      const token = text.slice(i + 2, end - 1)
      const helper = helperValue(token, context, true)
      if (helper !== null) { output += helper; i = end; continue }
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(:?[-+?])?(.*)$/.exec(token)
      if (!match || (!match[2] && match[3])) throw validationError(`Invalid Compose interpolation: ${token}`)
      const name = match[1]!, operator = match[2], argument = match[3]!
      const present = Object.hasOwn(variables, name), value = variables[name] ?? ""
      const set = operator?.startsWith(":") ? present && value !== "" : present
      if (!operator) {
        if (!present) missing.add(name)
        output += value
      } else if (operator.endsWith("-")) output += set ? value : interpolate(argument)
      else if (operator.endsWith("+")) output += set ? interpolate(argument) : ""
      else {
        if (!set) throw validationError(`Missing required Compose variable ${name}: ${argument || "value is required"}`)
        output += value
      }
      i = end
    }
    return output
  }
  const resolved = interpolate(compose)
  if (missing.size) log.warn({ names: [...missing].sort() }, "Compose variables missing without defaults; replaced with empty strings")
  // Quote only empty environment scalars introduced by interpolation. Legacy
  // environment inheritance remains rejected by the existing Compose validator.
  const document = parse(resolved) as any
  let original: any
  try { original = parse(compose) } catch { original = {} }
  let changed = false
  for (const [name, service] of Object.entries(document?.services ?? {}) as Array<[string, any]>) {
    const before = original?.services?.[name]?.environment
    if (!service?.environment || Array.isArray(service.environment)) continue
    for (const [key, value] of Object.entries(service.environment)) {
      if (value === null && typeof before?.[key] === "string" && before[key].includes("$")) {
        service.environment[key] = ""
        changed = true
      }
    }
  }
  return changed ? stringify(document) : resolved
}

function processTemplateToml(
  compose: string,
  templateToml: string,
  projectSlug: string
): Omit<PreparedTemplateInstall, "runtimeMode"> {
  const template = parseTemplate(templateToml)
  const generatedVars: Record<string, string> = Object.create(null)
  const variables: Record<string, string> = Object.assign(Object.create(null), { APP_NAME: projectSlug })
  const context: HelperContext = {
    projectSlug,
    variables,
    generatedVars,
    helperDomain: null,
    scope: "",
  }

  const rawVariables = template.variables ?? {}
  if (!rawVariables || typeof rawVariables !== "object" || Array.isArray(rawVariables)) throw validationError("template.toml variables must be an object")
  // Seed APP_NAME first; template declarations can override it.
  for (const [key, rawValue] of Object.entries(rawVariables)) variables[key] = stringValue(rawValue)
  // First pass generates independent helpers. JWT dependencies wait for pass two.
  for (const key of Object.keys(rawVariables)) {
    context.scope = key
    variables[key] = replaceTemplateExpressions(variables[key]!, (match, token) =>
      token.startsWith("jwt:") ? match : helperValue(token, context) ?? match)
  }
  // Resolve forward references recursively, including JWT secret/payload names.
  const resolving = new Set<string>(), complete = new Set<string>()
  const resolve = (key: string): string => {
    if (complete.has(key)) return variables[key]!
    if (resolving.has(key)) throw validationError(`Circular template variable reference: ${key}`)
    resolving.add(key)
    variables[key] = replaceTemplateExpressions(variables[key]!, (match, token) => {
      if (VARIABLE_PATTERN.test(token) && Object.hasOwn(variables, token)) return resolve(token)
      if (token.startsWith("jwt:")) {
        for (const dependency of token.slice(4).split(":").slice(0, 2))
          if (Object.hasOwn(variables, dependency)) variables[dependency] = resolve(dependency)
      }
      context.scope = key
      return helperValue(token, context) ?? match
    })
    resolving.delete(key); complete.add(key)
    return variables[key]!
  }
  for (const key of Object.keys(variables)) resolve(key)
  context.scope = ""

  const config = template.config ?? {}
  const configEnv = processConfigEnv(config.env, context)
  const interpolationEnv = { ...variables, ...configEnv }
  context.scope = ""
  const composeResolved = interpolateCompose(compose, interpolationEnv, context)

  let declaredEntrypoint: DeclaredEntrypoint | null = null
  let domain = context.helperDomain
  if (Array.isArray(config.domains) && config.domains.length > 0) {
    const first = config.domains[0]
    if (!first || typeof first !== "object" || Array.isArray(first)) {
      throw validationError("template.toml config.domains[0] must be an object")
    }
    const domainConfig = first as Record<string, unknown>
    const serviceName = stringValue(domainConfig.serviceName ?? "").trim()
    const port = Number(domainConfig.port)
    if (!serviceName || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw validationError(
        "template.toml config.domains[0] requires a serviceName and a valid port"
      )
    }
    const host =
      domainConfig.host === undefined
        ? generateDomain(projectSlug)
        : processTemplateValue(stringValue(domainConfig.host), context)
    if (!host || host.includes("$")) throw validationError("template.toml config.domains[0] host is empty or unresolved")
    declaredEntrypoint = { serviceName, port }
    domain = host
  }

  return { composeResolved, generatedVars, domain, declaredEntrypoint }
}

export function prepareTemplateInstall(input: {
  compose: string
  templateToml?: string
  projectSlug: string
  serviceId?: string
}): PreparedTemplateInstall {
  const prepared = input.templateToml !== undefined
    ? processTemplateToml(input.compose, input.templateToml, input.projectSlug)
    : {
        ...resolveTemplate(input.compose, { projectSlug: input.projectSlug }),
        declaredEntrypoint: null,
      }

  const runtimeMode = composeRequiresContainerRuntime(prepared.composeResolved)
    ? "docker"
    : "swarm"
  const serviceId = input.serviceId ?? input.projectSlug
  if (runtimeMode === "docker") {
    composeToContainers({
      compose: prepared.composeResolved,
      runtime: "docker",
      servicePrefix: `ploydok-svc-${serviceId}`,
      network: "validation",
      labels: {},
    })
  } else {
    planComposeSwarmDeploy({
      compose: prepared.composeResolved,
      kindToken: `svc-${serviceId}-${input.projectSlug}`.slice(0, 40),
      network: "validation",
      labels: {},
    })
  }

  if (prepared.declaredEntrypoint) {
    const composeServices = composeToContainers({
      compose: prepared.composeResolved,
      runtime: runtimeMode,
      servicePrefix: `validation-${serviceId}`,
      network: "validation",
      labels: {},
    })
    if (!composeServices.some((service) => service.composeName === prepared.declaredEntrypoint!.serviceName)) {
      throw validationError(
        `template.toml domain serviceName "${prepared.declaredEntrypoint.serviceName}" is not a Compose service`
      )
    }
  }

  return { ...prepared, runtimeMode }
}
