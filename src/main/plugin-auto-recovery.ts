import type { PluginStartupFailure } from '../shared/plugin-startup-failure'

/**
 * Automatic recovery is allowed only for one explicit loader owner. The
 * Profile check happens before this policy is called; this function refuses
 * aggregate failures so a coincidental third-party entry never removes one
 * plugin while leaving another known failing root enabled.
 */
export function selectAutomaticPluginRecovery(options: {
  startupFailures?: readonly PluginStartupFailure[]
  profilePlugins: readonly string[]
  removedPlugins: readonly string[]
  followsRendererLogs: boolean
}): string | undefined {
  if (options.followsRendererLogs || !options.startupFailures?.length || options.profilePlugins.length !== 1) return undefined
  const owners = new Set(options.startupFailures.flatMap(failure =>
    failure.owner?.packageName ? [failure.owner.packageName] : []
  ))
  const target = options.profilePlugins[0]
  if (!target) return undefined
  if (owners.size !== 1 || !owners.has(target) || options.removedPlugins.includes(target)) return undefined
  return target
}
