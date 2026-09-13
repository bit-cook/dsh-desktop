import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateProfileSchema } from '../src/main/state/profile-schema-migrator'

const homes: string[] = []

async function newHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-schema-'))
  homes.push(dir)
  return dir
}

async function writePreset(home: string, name: string, body: string): Promise<string> {
  const dir = join(home, '.agent-presets', name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'agent.cordis.yml')
  await writeFile(file, body, 'utf8')
  return file
}

afterEach(async () => {
  while (homes.length) await rm(homes.pop()!, { recursive: true, force: true })
})

describe('migrateProfileSchema — persona text → prefix', () => {
  it('renames the key on the first run and leaves surrounding YAML byte-identical', async () => {
    const home = await newHome()
    const preset = `# leading comment
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
      first line
      second line
    complete: true

# trailing comment
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
`
    const file = await writePreset(home, 'dsh-report', preset)

    const notes: string[] = []
    const report = await migrateProfileSchema(home, (line) => notes.push(line))

    expect(report.changedFiles).toContain(file)
    expect(report.fromVersion).toBe(0)
    expect(report.toVersion).toBe(1)
    expect(report.warnings).toEqual([])
    const rewritten = await readFile(file, 'utf8')
    expect(rewritten).toBe(preset.replace('    text: |-', '    prefix: |-'))
    expect(notes.some((line) => line.includes('renamed persona.text → persona.prefix'))).toBe(true)
    expect(notes.some((line) => line.includes('advanced from v0 to v1'))).toBe(true)
  })

  it('is idempotent — a second run touches nothing and reports skipped work', async () => {
    const home = await newHome()
    const file = await writePreset(
      home,
      'dsh-report',
      `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: hello
`
    )
    await migrateProfileSchema(home, () => {})
    const afterFirst = await readFile(file, 'utf8')
    const report = await migrateProfileSchema(home, () => {})
    expect(report.changedFiles).toEqual([])
    expect(report.fromVersion).toBe(1)
    expect(report.toVersion).toBe(1)
    expect(await readFile(file, 'utf8')).toBe(afterFirst)
  })

  it('leaves an already-migrated preset alone even before the marker exists', async () => {
    const home = await newHome()
    const already = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: modern
`
    const file = await writePreset(home, 'standard-codex', already)
    const report = await migrateProfileSchema(home, () => {})
    expect(report.changedFiles).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(already)
  })

  it('records a warning for unparseable YAML but still writes the marker', async () => {
    const home = await newHome()
    await writePreset(home, 'broken', ': : : not yaml\n\t- - -\n')
    const report = await migrateProfileSchema(home, () => {})
    expect(report.warnings.some((w) => w.includes('unparseable YAML'))).toBe(true)
    expect(report.toVersion).toBe(1)
  })

  it('ignores non-persona rows in the same composition', async () => {
    const home = await newHome()
    const preset = `- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    text: keep me
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: rename me
`
    const file = await writePreset(home, 'mixed', preset)
    await migrateProfileSchema(home, () => {})
    const rewritten = await readFile(file, 'utf8')
    expect(rewritten).toContain('name: \'@deepseek-ai/dsh-agent-instructions\'\n  config:\n    text: keep me')
    expect(rewritten).toContain('name: \'@deepseek-ai/dsh-persona\'\n  config:\n    prefix: rename me')
  })
})

describe('migrateProfileSchema — agent-default-model health check', () => {
  it('rewrites the default model to the first configured one when it does not match', async () => {
    const home = await newHome()
    const settingsPath = join(home, 'settings.yaml')
    const settings = `llm-pi-ai:
  providers:
    {
      qwen: { models: [ { id: qwen3.8-27b-fp8 }, { id: qwen3.8-27b-int8 } ] }
    }
agent-default-model:
  provider: qwen
  model: qwen3.8-27b-awq
`
    await writeFile(settingsPath, settings, 'utf8')
    const notes: string[] = []
    const report = await migrateProfileSchema(home, (line) => notes.push(line))
    expect(report.changedFiles).toContain(settingsPath)
    const rewritten = await readFile(settingsPath, 'utf8')
    expect(rewritten).toContain('model: qwen3.8-27b-fp8')
    expect(rewritten).not.toContain('model: qwen3.8-27b-awq')
    expect(notes.some((line) => line.includes('agent-default-model.model "qwen3.8-27b-awq"'))).toBe(true)
  })

  it('leaves a matching default model alone even across repeated runs', async () => {
    const home = await newHome()
    const settingsPath = join(home, 'settings.yaml')
    const settings = `llm-pi-ai:
  providers:
    {
      qwen: { models: [ { id: qwen3.8-27b-fp8 } ] }
    }
agent-default-model:
  provider: qwen
  model: qwen3.8-27b-fp8
`
    await writeFile(settingsPath, settings, 'utf8')
    await migrateProfileSchema(home, () => {})
    const report = await migrateProfileSchema(home, () => {})
    expect(report.changedFiles).toEqual([])
    expect(await readFile(settingsPath, 'utf8')).toBe(settings)
  })

  it('does nothing when the provider has no models to fall back to', async () => {
    const home = await newHome()
    const settingsPath = join(home, 'settings.yaml')
    const settings = `llm-pi-ai:
  providers:
    { qwen: { models: [] } }
agent-default-model:
  provider: qwen
  model: qwen3.8-27b-awq
`
    await writeFile(settingsPath, settings, 'utf8')
    const report = await migrateProfileSchema(home, () => {})
    expect(report.changedFiles).toEqual([])
    expect(await readFile(settingsPath, 'utf8')).toBe(settings)
  })
})
