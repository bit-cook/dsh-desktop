import { LanMobileBridge } from './lan-mobile-bridge'
import { join } from 'node:path'

const args = process.argv.slice(2)
let harnessUrl = 'http://127.0.0.1:43125'
let harnessAuthToken = ''
let port = 43127
let userData =
  process.env.DSH_USER_DATA ||
  join(process.env.HOME || '', 'Library/Application Support/dsh-desktop')

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--harness-url') harnessUrl = args[++i]
  if (args[i] === '--token') harnessAuthToken = args[++i]
  if (args[i] === '--port') port = parseInt(args[++i], 10)
  if (args[i] === '--user-data') userData = args[++i]
}

const root = process.cwd()

const bridge = new LanMobileBridge({
  harnessUrl: () => harnessUrl,
  harnessAuthToken: () => harnessAuthToken,
  locale: () => 'zh',
  brandLogoPaths: {
    light: join(root, 'build/logo-light.png'),
    dark: join(root, 'build/logo-dark.png')
  },
  appIconPath: join(root, 'build/app-icon.png'),
  cloudflaredCacheDir: join(userData, 'bin'),
  forceCloudflareFailure: false,
  tunnelLog: (msg) => console.log('[mobile-tunnel]', msg),
  port,
  onReconnectRequested: () => {
    console.log('[mobile-bridge] reconnect-requested')
  },
  onConnectedChange: (connected) => {
    console.log('[mobile-bridge] connected:', connected)
  }
})

bridge
  .start()
  .then((snapshot) => {
    console.log('[mobile-bridge] ready:', snapshot.desktopUrl)
  })
  .catch((err) => {
    console.error('[mobile-bridge] start error:', err)
  })

process.on('SIGTERM', () => {
  bridge.stop().finally(() => process.exit(0))
})
process.on('SIGINT', () => {
  bridge.stop().finally(() => process.exit(0))
})
