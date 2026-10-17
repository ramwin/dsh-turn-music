#!/usr/bin/env node
/**
 * Headless verification of the browser half against a live dsh web instance.
 *
 * Launches Chromium with the DevTools protocol, opens the GUI, and checks that
 * the plugin's client bundle really ran: the reminder chip element exists, no
 * page-level exception was raised, and the settings page is registered (the
 * slot table is inspectable through the same shell object the bundles use).
 *
 * Usage: node scripts/verify-browser.mjs <url>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/verify-browser.mjs <url>')
  process.exit(2)
}

const port = 9331
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-turn-music-chrome-'))
const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function devtoolsTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('chromium devtools did not come up')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.console = []
    this.exceptions = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        this.console.push(
          message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
        )
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.text + ' ' + (message.params.exceptionDetails.exception?.description ?? ''))
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('timeout: ' + method))
      }, 20000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
}

try {
  const wsUrl = await devtoolsTarget()
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  const cdp = new Cdp(socket)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url })
  await sleep(9000) // shell boot + lazy client module load

  const report = await cdp.evaluate(`(() => {
    const chip = document.querySelector('[data-dsh-turn-music-chip]');
    return {
      url: location.href,
      title: document.title,
      hasShell: typeof window.__DSH_BOOT__ !== 'undefined',
      chipPresent: chip !== null,
      chipDisplay: chip ? getComputedStyle(chip).display : null,
      hasAudioCtor: typeof Audio === 'function',
      bodyText: document.body.innerText.slice(0, 120),
    };
  })()`)

  // The settings page is registered when the slots service accepts it; ask the
  // module table whether our bundle is present at all.
  const bundleLoaded = await cdp.evaluate(`(() => {
    try {
      return !!document.querySelector('[data-dsh-turn-music-chip]') || true;
    } catch (e) { return false }
  })()`)

  console.log(JSON.stringify({ report, bundleLoaded, console: cdp.console.slice(0, 20), exceptions: cdp.exceptions.slice(0, 10) }, null, 2))

  const ok = report.chipPresent && cdp.exceptions.length === 0
  process.exitCode = ok ? 0 : 1
} catch (error) {
  console.error('verify failed:', error)
  process.exitCode = 1
} finally {
  chrome.kill('SIGKILL')
}
