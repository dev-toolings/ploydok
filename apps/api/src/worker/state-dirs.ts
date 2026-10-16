// SPDX-License-Identifier: AGPL-3.0-only
//
// Préflight des racines d'état sur disque (builds, sites statiques).
//
// Un deploy qui découvre au dernier moment que `PLOYDOK_STATIC_ROOT` n'est pas
// inscriptible échoue après le build, log un EACCES nu et laisse l'opérateur
// deviner. On sonde donc les répertoires au boot du worker : `mkdir -p` couvre
// le cas « le dossier n'existe pas encore », et l'écriture d'un fichier témoin
// couvre le cas « il existe mais appartient à quelqu'un d'autre » (typiquement
// un bind Docker créé par le daemon, donc root, alors que l'API tourne sous
// l'uid de l'utilisateur).
//
// Volontairement non bloquant : un control-plane qui refuse de démarrer parce
// que le stockage statique est mal monté est pire que le sous-ensemble de
// fonctionnalités concerné.

import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { env } from "../env"
import { workerLog as logger } from "./logger"

export interface StateDirProbe {
  label: string
  dir: string
  writable: boolean
  error?: string
}

export async function probeStateDir(
  label: string,
  dir: string
): Promise<StateDirProbe> {
  const witness = path.join(dir, ".ploydok-write-probe")
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(witness, "")
    await rm(witness, { force: true })
    return { label, dir, writable: true }
  } catch (err) {
    return {
      label,
      dir,
      writable: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const STATE_DIR_ENV: Record<string, string> = {
  static: "PLOYDOK_STATIC_ROOT",
  "local-backups": "PLOYDOK_LOCAL_BACKUP_DIR",
}

export function stateDirRemediation(probe: StateDirProbe): string {
  return (
    `${probe.label} directory is not writable: ${probe.dir}. ` +
    `Point it elsewhere with ${STATE_DIR_ENV[probe.label] ?? "PLOYDOK_BUILD_DIR"}, ` +
    `or give the API process ownership: chown -R $(id -u):$(id -g) ${probe.dir}`
  )
}

export async function ensureStateDirs(): Promise<StateDirProbe[]> {
  const probes = await Promise.all([
    probeStateDir("builds", env.PLOYDOK_BUILD_DIR),
    probeStateDir("static", env.PLOYDOK_STATIC_ROOT),
    probeStateDir("local-backups", env.PLOYDOK_LOCAL_BACKUP_DIR),
  ])
  for (const probe of probes) {
    if (probe.writable) {
      logger.debug({ dir: probe.dir }, `state-dirs: ${probe.label} ready`)
      continue
    }
    logger.error(
      { dir: probe.dir, err: probe.error },
      stateDirRemediation(probe)
    )
  }
  return probes
}
