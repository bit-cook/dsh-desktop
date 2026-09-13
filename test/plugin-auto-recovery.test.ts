import { describe, expect, it } from 'vitest'
import { selectAutomaticPluginRecovery } from '../src/main/plugin-auto-recovery'

const failure = (owner?: string) => ({
  stage: 'import', packageName: owner ?? 'entry', message: 'failed', chain: [],
  ...(owner ? { owner: { packageName: owner } } : {})
})

describe('automatic plugin recovery policy', () => {
  it('selects one explicit third-party root already validated against the Profile', () => {
    expect(selectAutomaticPluginRecovery({ startupFailures: [failure('dsh-better-sidebar')], profilePlugins: ['dsh-better-sidebar'], removedPlugins: [], followsRendererLogs: false })).toBe('dsh-better-sidebar')
  })
  it.each([
    { startupFailures: [failure('plugin-a'), failure('plugin-b')], profilePlugins: ['plugin-a'], removedPlugins: [], followsRendererLogs: false },
    { startupFailures: [failure()], profilePlugins: ['plugin-a'], removedPlugins: [], followsRendererLogs: false },
    { startupFailures: [failure('plugin-a')], profilePlugins: ['plugin-a', 'plugin-b'], removedPlugins: [], followsRendererLogs: false },
    { startupFailures: [failure('plugin-a')], profilePlugins: ['plugin-a'], removedPlugins: ['plugin-a'], followsRendererLogs: false },
    { startupFailures: [failure('plugin-a')], profilePlugins: ['plugin-a'], removedPlugins: [], followsRendererLogs: true }
  ])('does not guess a target for ambiguous or frontend evidence', options => {
    expect(selectAutomaticPluginRecovery(options)).toBeUndefined()
  })
})
