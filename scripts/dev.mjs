import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = new URL(process.env.API_PROXY_TARGET || `http://127.0.0.1:${process.env.PORT || 3001}`)
const healthUrl = new URL('/api/health', target)
const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
const targetIsLocal = localHosts.has(healthUrl.hostname.replace(/^\[|\]$/g, ''))
const apiPort = target.port || (target.protocol === 'https:' ? '443' : '80')
let apiProcess = null
let frontendProcess = null
let ownsApi = false
let stopping = false

async function isApiReady() {
  try {
    const response = await fetch(healthUrl, { cache: 'no-store', signal: AbortSignal.timeout(1000) })
    if (!response.ok) return false
    const health = await response.json()
    return health?.ok === true
  } catch {
    return false
  }
}

function stopChildren() {
  if (frontendProcess && frontendProcess.exitCode === null) frontendProcess.kill()
  if (ownsApi && apiProcess && apiProcess.exitCode === null) apiProcess.kill()
}

function finish(code = 0) {
  if (stopping) return
  stopping = true
  stopChildren()
  process.exitCode = code
}

process.on('SIGINT', () => finish(130))
process.on('SIGTERM', () => finish(143))

if (!await isApiReady()) {
  if (!targetIsLocal) {
    console.error(`Portal API is not reachable at ${healthUrl.origin}. Check the API_PROXY_TARGET setting.`)
    process.exit(1)
  }

  console.log(`Starting the Gouri Agency API on port ${apiPort}…`)
  apiProcess = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: apiPort },
    stdio: 'inherit',
    windowsHide: true
  })
  ownsApi = true
  apiProcess.once('error', error => {
    console.error(`Could not start the portal API: ${error.message}`)
    finish(1)
  })

  const startupDeadline = Date.now() + 45_000
  while (Date.now() < startupDeadline && !stopping) {
    if (apiProcess.exitCode !== null) {
      console.error('The portal API stopped during startup. Check MongoDB Atlas connectivity, credentials, and the Atlas IP access list.')
      finish(apiProcess.exitCode || 1)
      process.exit(apiProcess.exitCode || 1)
    }
    if (await isApiReady()) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  if (stopping) process.exit(process.exitCode || 1)
  if (!await isApiReady()) {
    console.error('The portal API did not become ready within 45 seconds. Check MongoDB Atlas connectivity, credentials, and the Atlas IP access list.')
    finish(1)
    process.exit(1)
  }
} else {
  console.log(`Using the running portal API at ${target.origin}.`)
}

const viteEntry = resolve(projectRoot, 'node_modules/vite/bin/vite.js')
frontendProcess = spawn(process.execPath, [viteEntry, '--host', '0.0.0.0', ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
})
frontendProcess.once('error', error => {
  console.error(`Could not start the frontend: ${error.message}`)
  finish(1)
})
frontendProcess.once('exit', code => {
  stopping = true
  stopChildren()
  process.exitCode = code || 0
})
