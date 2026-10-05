import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { PreviewSource } from '../types'
import { decodeBmp, fitCells, fromBase64, toCells } from './bmp.ts'

type Engine = EngineInterface

const PANE = 'preview'
const MIN_COLS = 30
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEFAULT_URL = 'http://localhost:8081'

const source = atom({ plugin: 'preview', key: 'source' } as const, { kind: 'web', url: '', device: 'phone' } as PreviewSource)

// The frame is a file on disk plus what was decoded from it; the module holds it and redraws by invalidate.
type Frame = {
  png: string
  pxW: number
  pxH: number
  generation: number
  at: number
  raster?: { cells: string; columns: number; rows: number }
}

let dir = '/tmp/claude-preview'
let frame: Frame | undefined
let error: string | undefined
let busy = false
let lastShot = 0
let generation = 0
let pixels = false // the terminal draws real images (kitty graphics protocol)
let box = { columns: 0, rows: 0 } // the picture's room in the pane, from the last draw
let share = 0.3
let lastTerm = 0
let cwd = ''

// A path the person typed or Claude wrote, as a file:// URL; anything that looks like a host or port, as http.
function toUrl(arg: string): string {
  if (/^(https?|file):\/\//.test(arg)) return arg
  if (/^\d+$/.test(arg)) return `http://localhost:${arg}`
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/.test(arg)) return `http://${arg}`
  if (/\.(html?|svg)$/i.test(arg) || arg.startsWith('/') || arg.startsWith('.') || arg.startsWith('~')) {
    const abs = arg.startsWith('/') ? arg : `${cwd}/${arg.replace(/^\.\//, '')}`
    return `file://${encodeURI(abs)}`
  }
  return `http://${arg}`
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"`)\]]*/

const SH_CAPTURE = `
set -u
d="$1"; kind="$2"; url="$3"; w="$4"; h="$5"; chrome="$6"
mkdir -p "$d"; rm -f "$d/new.png"
if [ "$kind" = sim ]; then
  xcrun simctl io booted screenshot --type=png "$d/new.png" >/dev/null 2>"$d/err" || { echo "error nosim"; exit 0; }
else
  [ -x "$chrome" ] || { echo "error nochrome"; exit 0; }
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run --window-size="$w,$h" --virtual-time-budget=1500 --screenshot="$d/new.png" "$url" >/dev/null 2>"$d/err"
  [ -s "$d/new.png" ] || { echo "error noweb"; exit 0; }
fi
sum=$(md5 -q "$d/new.png")
if [ -f "$d/shot.png" ] && [ "$sum" = "$(cat "$d/last.md5" 2>/dev/null)" ]; then state=same; rm -f "$d/new.png"; else state=new; mv "$d/new.png" "$d/shot.png"; echo "$sum" > "$d/last.md5"; fi
size=$(sips -g pixelWidth -g pixelHeight "$d/shot.png" 2>/dev/null | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w, h}')
echo "$state $size"
`

const SH_SAMPLE = `sips -z "$2" "$3" -s format bmp "$1/shot.png" --out "$1/shot.bmp" >/dev/null 2>&1 && echo ok`

async function sample($: Engine, f: Frame): Promise<Frame> {
  if (pixels || box.columns < 2 || box.rows < 1) return f
  const fit = fitCells(f.pxW, f.pxH, box.columns, box.rows)
  if (f.raster && f.raster.columns === fit.columns && f.raster.rows === fit.rows) return f
  const r = await $.process.run(['/bin/sh', '-c', SH_SAMPLE, 'sh', dir, String(fit.rows * 2), String(fit.columns)], { timeoutMs: 5000 })
  if (!r.stdout.includes('ok')) return f
  const bytes = await $.fs.read(`${dir}/shot.bmp`, { as: 'bytes' })
  return { ...f, raster: toCells(decodeBmp(fromBase64(bytes.base64))) }
}

async function capture($: Engine, force = false) {
  if (busy) return
  busy = true
  try {
    const src = await read($, source)
    if (src.kind === 'web' && !src.url) { error = undefined; frame = undefined; $.ui.invalidate('ui.render'); return }
    const [w, h] = src.kind === 'web' && src.device === 'desktop' ? [1280, 800] : [430, 932]
    const url = src.kind === 'web' ? src.url : ''
    const r = await $.process.run(['/bin/sh', '-c', SH_CAPTURE, 'sh', dir, src.kind, url, String(w), String(h), CHROME], { timeoutMs: 20000 })
    lastShot = Date.now()
    const [state, a, b] = r.stdout.trim().split(/\s+/)
    if (state === 'error') {
      error = a === 'nosim' ? 'No simulator is booted. Start one: open -a Simulator'
        : a === 'nochrome' ? 'Google Chrome is not installed; the web preview needs it.'
        : `Could not load ${url}. Is the dev server running?`
      frame = undefined
      $.ui.invalidate('ui.render')
      return
    }
    error = undefined
    const pxW = Number(a), pxH = Number(b)
    if (state === 'same' && frame && !force) {
      const next = await sample($, frame)
      if (next !== frame) { frame = next; $.ui.invalidate('ui.render') }
      return
    }
    generation++
    frame = await sample($, { png: `${dir}/shot.png`, pxW, pxH, generation, at: Date.now() })
    $.ui.invalidate('ui.render')
  } catch (err) {
    error = `Capture failed: ${err instanceof Error ? err.message : String(err)}`
    $.ui.invalidate('ui.render')
  } finally {
    busy = false
  }
}

async function isShown($: Engine) {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
}

const openArgs = (term?: number) =>
  term && term > 0 ? { id: PANE, title: 'preview', columns: Math.max(MIN_COLS, Math.round(term * share)) } : { id: PANE, title: 'preview' }

const ago = (ms: number) => { const s = Math.round(ms / 1000); return s < 2 ? 'now' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago` }

async function setSource($: Engine, next: PreviewSource) {
  await update($, source, () => next)
  frame = undefined
  error = undefined
  $.ui.invalidate('ui.render')
  void capture($, true)
}

// Show what Claude just made: a page it wrote, a dev server it started. Otherwise an edit is what
// changes the screen, so look again once hot reload has had a moment.
async function follow($: Engine, url: string) {
  const src = await read($, source)
  if (src.kind === 'web' && src.url === url) { $.clock.after(400, () => { void capture($, true) }); return }
  await setSource($, { kind: 'web', url, device: src.kind === 'web' ? src.device : 'phone' })
  if (!(await isShown($))) void $.ui.open(openArgs(lastTerm || undefined))
}

export const register: Register = (on, options) => {
  const simEvery = Math.max(500, Number(options.simIntervalMs) || 1500)
  const webEvery = Math.max(2000, Number(options.webIntervalMs) || 10000)
  const pct = Number(options.widthPercent)
  share = Number.isFinite(pct) && pct >= 10 && pct <= 80 ? pct / 100 : 0.3


  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const tmp = (await $.env.get('TMPDIR')) || '/tmp/'
    dir = `${tmp.replace(/\/$/, '')}/claude-preview-${(await $.session.id()).slice(0, 8)}`
    const term = (await $.env.get('TERM_PROGRAM'))?.toLowerCase() ?? ''
    pixels = /ghostty|kitty|wezterm/.test(term) || !!(await $.env.get('KITTY_WINDOW_ID'))
    await $.command.register({ name: 'preview', description: 'Live preview of the iOS simulator or a web page', argumentHint: 'sim | <url> [desktop] | refresh' })
    $.clock.every(500, () => {
      void (async () => {
        if (busy || !(await isShown($))) return
        const src = await read($, source)
        if (Date.now() - lastShot >= (src.kind === 'sim' ? simEvery : webEvery)) await capture($)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'preview' }, async ($, e) => {
    const term = e.presentation.columns
    lastTerm = term
    const [first, second] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!first) {
      if (await isShown($)) { await $.ui.close({ id: PANE }); return { text: 'Preview closed.' } }
      const r = await $.ui.open(openArgs(term))
      void capture($, true)
      return { text: r.isPlaced ? 'Preview open.' : `Preview waits: ${r.reason ?? 'no room'}` }
    }
    if (first === 'refresh') { void capture($, true); return { text: 'Refreshing the preview.' } }
    if (first === 'sim') await setSource($, { kind: 'sim' })
    else await setSource($, { kind: 'web', url: toUrl(first), device: second === 'desktop' ? 'desktop' : 'phone' })
    await $.ui.open(openArgs(term))
    const src = await read($, source)
    return { text: `Preview: ${src.kind === 'sim' ? 'simulator' : src.url}` }
  })


  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError || ran.deny !== undefined || e.agentId) return ran
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
      const path = String(input.file_path ?? '')
      if (/\.html?$/i.test(path)) { await follow($, toUrl(path)); return ran }
      $.clock.after(1200, () => { void isShown($).then(shown => { if (shown) void capture($) }) })
    }
    if (tool === 'Bash') {
      const url = LOCAL_URL.exec(ran.text ?? '')?.[0]
      if (url) $.clock.after(1500, () => { void follow($, url.replace(/[.,;:]+$/, '')) })
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster, Image } = $.ui.resolve(e) as any
    const props = e.props as { bodyColumns?: number; scroll?: { bodyRows?: number } }
    const cols = Math.max(10, props.bodyColumns ?? e.viewport?.columns ?? 40)
    const bodyRows = Math.max(6, props.scroll?.bodyRows ?? e.viewport?.rows ?? 30)

    const term = e.viewport?.columns
    if (term && props.bodyColumns && term > props.bodyColumns + 4 && term !== lastTerm) {
      lastTerm = term
      const want = Math.max(MIN_COLS, Math.round(term * share))
      if (Math.abs(want - props.bodyColumns) > 2) $.clock.after(0, () => { void $.ui.open(openArgs(term)) })
    }

    const room = { columns: cols, rows: bodyRows - 3 }
    if (room.columns !== box.columns || room.rows !== box.rows) {
      box = room
      if (frame && !pixels) $.clock.after(0, () => { void (async () => { if (frame) { frame = await sample($, frame); $.ui.invalidate('ui.render') } })() })
    }

    const src = await read($, source)
    const label = src.kind === 'sim' ? 'Simulator' : !src.url ? 'Web' : src.url.startsWith('file://') ? decodeURI(src.url).split('/').pop() ?? src.url : src.url.replace(/^https?:\/\//, '')
    const header = (
      <Box key="head" flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text wrap="truncate"><Text color="#7fc77a">● </Text><Text bold>{label}</Text></Text>
          <Text dimColor>{frame ? ago(Date.now() - frame.at) : busy ? 'capturing…' : ''}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="sim" label="Sim" hotkey="s" variant={src.kind === 'sim' ? 'primary' : undefined} dimColor={src.kind !== 'sim'} onPress={() => { void setSource($, { kind: 'sim' }) }} />
          <Button key="web" label="Web" hotkey="w" variant={src.kind === 'web' ? 'primary' : undefined} dimColor={src.kind !== 'web'} onPress={() => { void setSource($, { kind: 'web', url: src.kind === 'web' && src.url ? src.url : DEFAULT_URL, device: 'phone' }) }} />
          <Button key="refresh" label="↻" hotkey="r" dimColor onPress={() => { void capture($, true) }} />
        </Box>
      </Box>
    )

    let body: any
    if (src.kind === 'web' && !src.url) body = <Text key="idle" dimColor wrap="wrap">{'Nothing to show yet. When Claude writes an .html page or starts a dev server, it opens here.\n\n/preview <file|url|port> shows one now; /preview sim shows the simulator.'}</Text>
    else if (error) body = <Text key="err" color="#e8645b" wrap="wrap">{error}</Text>
    else if (!frame) body = <Text key="wait" dimColor>Capturing…</Text>
    else if (pixels) {
      const fit = fitCells(frame.pxW, frame.pxH, room.columns, room.rows)
      body = (
        <Box key="pic" width={cols} justifyContent="center">
          <Image key="shot" columns={fit.columns} rows={fit.rows} alt={`${label} preview`} source={{ file: frame.png, format: 'png', generation: frame.generation }} />
        </Box>
      )
    } else if (frame.raster) {
      body = (
        <Box key="pic" width={cols} justifyContent="center">
          <Raster key="shot" columns={frame.raster.columns} rows={frame.raster.rows} cells={frame.raster.cells} />
        </Box>
      )
    } else body = <Text key="wait" dimColor>Drawing…</Text>

    return (
      <Box flexDirection="column" width={cols}>
        {header}
        <Box key="gap" height={1} />
        {body}
      </Box>
    )
  })
}
