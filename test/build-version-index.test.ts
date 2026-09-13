import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildVersionIndex, mergeVersionIndex } from '../scripts/build-version-index.mjs'

const execFile = promisify(execFileCallback)
const projectRoot = path.resolve(import.meta.dirname, '..')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('buildVersionIndex', () => {
  it('drops non-semver names and sorts descending', () => {
    const index = buildVersionIndex(['1.2.0', 'latest', '1.10.0', 'nightly', '1.2.10'])
    expect(index.versions.map((v: { version: string }) => v.version)).toEqual([
      '1.10.0',
      '1.2.10',
      '1.2.0'
    ])
  })

  it('orders prerelease counters numerically so rc.10 is newer than rc.9', () => {
    const index = buildVersionIndex([
      '1.2.3-rc.1',
      '1.2.3-rc.10',
      '1.2.3-rc.9',
      '1.2.3-rc.2'
    ])
    expect(index.versions.map((v: { version: string }) => v.version)).toEqual([
      '1.2.3-rc.10',
      '1.2.3-rc.9',
      '1.2.3-rc.2',
      '1.2.3-rc.1'
    ])
  })

  it('derives tag and archiveUrl for each entry', () => {
    const [entry] = buildVersionIndex(['3.4.5']).versions
    expect(entry).toEqual({
      version: '3.4.5',
      tag: 'v3.4.5',
      archiveUrl: 'https://dshdesktop.com/updates/archive/3.4.5/'
    })
  })

  it('writes the index file from the CLI', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-version-index-'))
    roots.push(root)
    const namesFile = path.join(root, 'names.json')
    const outFile = path.join(root, 'versions.json')
    await writeFile(namesFile, JSON.stringify(['1.0.0', '1.1.0']), 'utf8')
    await execFile(process.execPath, [
      path.join(projectRoot, 'scripts', 'build-version-index.mjs'),
      namesFile,
      outFile
    ])
    const written = JSON.parse(await readFile(outFile, 'utf8'))
    expect(written.versions.map((v: { version: string }) => v.version)).toEqual([
      '1.1.0',
      '1.0.0'
    ])
    expect(typeof written.generatedAt).toBe('string')
  })
})


describe('stable history selection', () => {
  it('preserves all prior versions and explicitly retained selections across releases', () => {
    const selected = mergeVersionIndex(buildVersionIndex(['1.0.0', '1.1.0']), '1.0.0', 'retain')
    const next = mergeVersionIndex(selected, '2.0.0')
    expect(next.versions.map(entry => entry.version)).toEqual(['2.0.0', '1.1.0', '1.0.0'])
    expect(next.versions.find(entry => entry.version === '1.0.0')?.stableHistory).toBe(true)
    expect(next.versions[0]?.stableHistory).toBeUndefined()
    const unpinned = mergeVersionIndex(next, '1.0.0', 'unpin')
    expect(unpinned.versions).toHaveLength(3)
    expect(unpinned.versions[2]?.stableHistory).toBeUndefined()
  })
})
