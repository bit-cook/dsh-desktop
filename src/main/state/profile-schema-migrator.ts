import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML, { isMap, isScalar } from 'yaml'

/**
 * Reconciles user profile files with the current Harness schema before Harness
 * boots. Two kinds of work live here:
 *
 * 1. **Schema migrations**, gated by a persisted version marker so they run at
 *    most once per profile per bump. Harness 0.1.5-rc.2 renamed the
 *    `@deepseek-ai/dsh-persona` config field from `text` to `prefix`; any preset
 *    written against the old field prevents the agent-presets roster from
 *    mounting, which blocks every session (both `resume` and `create`) with a
 *    "missing required value" error. The migration renames the key on the
 *    Document tree so the surrounding block scalar, indentation, and comments
 *    stay byte-identical.
 *
 * 2. **Health checks**, unconditional on every launch because user edits can
 *    drift the file at any time. Today only one: if
 *    `agent-default-model.model` names something the chosen provider does not
 *    list, the first available model id is written back so the very first
 *    session does not fail with "provider … has no configured model …".
 */

const CURRENT_SCHEMA_VERSION = 1
const MARKER_FILE = '.schema-version.json'
const AGENT_PRESETS_DIR = '.agent-presets'
const SETTINGS_FILE = 'settings.yaml'

export interface SchemaMigrationReport {
  changedFiles: string[]
  warnings: string[]
  fromVersion: number
  toVersion: number
}

export async function migrateProfileSchema(
  dshHome: string,
  note: (line: string) => void
): Promise<SchemaMigrationReport> {
  const markerPath = join(dshHome, MARKER_FILE)
  const fromVersion = await readMarkerVersion(markerPath)
  const report: SchemaMigrationReport = {
    changedFiles: [],
    warnings: [],
    fromVersion,
    toVersion: fromVersion
  }

  if (fromVersion < CURRENT_SCHEMA_VERSION) {
    const presetsRoot = join(dshHome, AGENT_PRESETS_DIR)
    if (existsSync(presetsRoot)) {
      await migratePersonaTextToPrefix(presetsRoot, report, note)
    }
    try {
      await writeMarker(markerPath, CURRENT_SCHEMA_VERSION)
      report.toVersion = CURRENT_SCHEMA_VERSION
      note(
        `[desktop] profile schema advanced from v${fromVersion} to v${CURRENT_SCHEMA_VERSION}` +
          (report.changedFiles.length ? `; ${report.changedFiles.length} file(s) rewritten` : '')
      )
    } catch (error) {
      report.warnings.push(`failed to persist schema marker: ${describe(error)}`)
    }
  }

  await repairDefaultModel(join(dshHome, SETTINGS_FILE), report, note)

  return report
}

async function readMarkerVersion(path: string): Promise<number> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'number' && Number.isInteger(parsed.version) && parsed.version >= 0
      ? parsed.version
      : 0
  } catch {
    return 0
  }
}

async function writeMarker(path: string, version: number): Promise<void> {
  const body = JSON.stringify({ version, migratedAt: new Date().toISOString() }, null, 2)
  await writeFile(path, body + '\n', { encoding: 'utf8' })
}

async function migratePersonaTextToPrefix(
  presetsRoot: string,
  report: SchemaMigrationReport,
  note: (line: string) => void
): Promise<void> {
  let presetNames: string[]
  try {
    const entries = await readdir(presetsRoot, { withFileTypes: true })
    presetNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    report.warnings.push(`unable to list agent presets under ${presetsRoot}: ${describe(error)}`)
    return
  }
  for (const presetName of presetNames) {
    const filePath = join(presetsRoot, presetName, 'agent.cordis.yml')
    if (!existsSync(filePath)) continue
    let original: string
    try {
      original = await readFile(filePath, 'utf8')
    } catch (error) {
      report.warnings.push(`skipping ${filePath}: ${describe(error)}`)
      continue
    }
    let doc: YAML.Document.Parsed
    try {
      doc = YAML.parseDocument(original)
    } catch (error) {
      report.warnings.push(`unparseable YAML at ${filePath}: ${describe(error)}`)
      continue
    }
    if (doc.errors.length > 0) {
      report.warnings.push(`unparseable YAML at ${filePath}: ${doc.errors[0]!.message}`)
      continue
    }
    if (!renamePersonaTextKey(doc)) continue
    const rendered = doc.toString()
    if (rendered === original) continue
    try {
      await writeFile(filePath, rendered, { encoding: 'utf8' })
      report.changedFiles.push(filePath)
      note(`[desktop] renamed persona.text → persona.prefix in ${filePath}`)
    } catch (error) {
      report.warnings.push(`failed to write ${filePath}: ${describe(error)}`)
    }
  }
}

function renamePersonaTextKey(doc: YAML.Document.Parsed): boolean {
  const contents = doc.contents as unknown as { items?: unknown } | null
  const rows = contents && Array.isArray(contents.items) ? contents.items : undefined
  if (!rows) return false
  let changed = false
  for (const row of rows) {
    if (!isMap(row)) continue
    const nameNode = row.get('name', true)
    const name = isScalar(nameNode) ? nameNode.value : row.get('name')
    if (name !== '@deepseek-ai/dsh-persona') continue
    const config = row.get('config', true)
    if (!isMap(config)) continue
    if (!config.has('text') || config.has('prefix')) continue
    const item = (config.items as { key: unknown }[]).find((entry) => {
      const key = entry.key
      return (isScalar(key) ? key.value : key) === 'text'
    })
    if (!item) continue
    if (isScalar(item.key)) (item.key as { value: unknown }).value = 'prefix'
    else item.key = 'prefix'
    changed = true
  }
  return changed
}

async function repairDefaultModel(
  settingsPath: string,
  report: SchemaMigrationReport,
  note: (line: string) => void
): Promise<void> {
  if (!existsSync(settingsPath)) return
  let original: string
  try {
    original = await readFile(settingsPath, 'utf8')
  } catch (error) {
    report.warnings.push(`unable to read ${settingsPath}: ${describe(error)}`)
    return
  }
  let doc: YAML.Document.Parsed
  try {
    doc = YAML.parseDocument(original)
  } catch (error) {
    report.warnings.push(`unparseable YAML at ${settingsPath}: ${describe(error)}`)
    return
  }
  if (doc.errors.length > 0) {
    report.warnings.push(`unparseable YAML at ${settingsPath}: ${doc.errors[0]!.message}`)
    return
  }
  const providerName = doc.getIn(['agent-default-model', 'provider'])
  const modelName = doc.getIn(['agent-default-model', 'model'])
  if (typeof providerName !== 'string' || typeof modelName !== 'string') return
  const modelIds = collectProviderModelIds(doc, providerName)
  if (modelIds.length === 0) return
  if (modelIds.includes(modelName)) return
  const replacement = modelIds[0]!
  doc.setIn(['agent-default-model', 'model'], replacement)
  const rendered = doc.toString()
  if (rendered === original) return
  try {
    await writeFile(settingsPath, rendered, { encoding: 'utf8' })
    report.changedFiles.push(settingsPath)
    note(
      `[desktop] agent-default-model.model "${modelName}" is not configured for provider "${providerName}"; rewrote to "${replacement}"`
    )
  } catch (error) {
    report.warnings.push(`failed to write ${settingsPath}: ${describe(error)}`)
  }
}

function collectProviderModelIds(doc: YAML.Document.Parsed, providerName: string): string[] {
  const node = doc.getIn(['llm-pi-ai', 'providers', providerName, 'models'])
  const plain =
    node && typeof node === 'object' && 'toJSON' in node && typeof (node as { toJSON: unknown }).toJSON === 'function'
      ? ((node as { toJSON: () => unknown }).toJSON())
      : node
  if (!Array.isArray(plain)) return []
  return plain
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
