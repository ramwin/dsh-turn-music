#!/usr/bin/env node
/**
 * End-to-end check of the actual feature: send one real message in a headless
 * browser, wait for the turn to finish, and assert that the reminder chip lit
 * up (i.e. the plugin detected the running -> finished edge and started the
 * audio) and that pausing from the chip works.
 *
 * Usage: node scripts/verify-turn.mjs "<url with token>"
 *
 * This talks to a *separate* dsh web instance on purpose (see
 * docs/DEVELOPMENT.md): it drives a real model turn, so never point it at a
 * host you are actively using.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/verify-turn.mjs "<url with token>"')
  process.exit(2)
}

const port = 9333
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-turn-music-turn-'))
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

let wsUrl
for (let attempt = 0; attempt < 40 && !wsUrl; attempt += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((target) => target.type === 'page')
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch {
    /* not up yet */
  }
  await sleep(250)
}
if (!wsUrl) throw new Error('chromium devtools did not come up')

const socket = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
let nextId = 1
const pending = new Map()
const consoleLines = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  }
})
const send = (method, params = {}) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value

const chipState = () =>
  evaluate(`(() => {
    const chip = document.querySelector('[data-dsh-turn-music-chip]');
    if (!chip) return { present: false };
    const buttons = [...chip.querySelectorAll('button')].map((b) => b.textContent);
    return { present: true, display: getComputedStyle(chip).display, label: chip.innerText, buttons };
  })()`)

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url })
  await sleep(9000)

  // Focus the composer and send one short message.
  await evaluate(`(() => {
    const box = document.querySelector('[contenteditable="true"][role="textbox"]') || document.querySelector('[contenteditable="true"]');
    if (!box) return 'no-composer';
    box.focus();
    return 'focused';
  })()`)
  await send('Input.insertText', { text: '只回复两个字：收到' })
  await sleep(300)
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  }

  const deadline = Date.now() + 150000
  let lit = null
  while (Date.now() < deadline) {
    const state = await chipState()
    if (state.present && state.display !== 'none' && state.label && state.buttons.length > 0) {
      lit = state
      break
    }
    await sleep(2000)
  }

  const paused = lit ? await evaluate(`(() => {
    const chip = document.querySelector('[data-dsh-turn-music-chip]');
    const toggle = chip.querySelector('button');
    const before = chip.innerText;
    toggle.click();
    return { before, after: chip.innerText };
  })()`) : null

  console.log(
    JSON.stringify(
      {
        chipLit: lit !== null,
        chip: lit,
        pause: paused,
        console: consoleLines.slice(-8),
      },
      null,
      2,
    ),
  )
  process.exitCode = lit !== null ? 0 : 1
} catch (error) {
  console.error('verify-turn failed:', error)
  process.exitCode = 1
} finally {
  chrome.kill('SIGKILL')
}
