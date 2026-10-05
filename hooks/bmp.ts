// Turns a small uncompressed BMP (what `sips -s format bmp` writes) into Raster cells:
// each terminal cell is two stacked pixels drawn as '▀', top pixel as foreground, bottom as background.

export type Rgb = { width: number; height: number; px: Uint32Array } // 0x00RRGGBB, row-major, top row first

function shift(mask: number): number {
  let s = 0
  while (mask && !(mask & 1)) { mask >>>= 1; s++ }
  return s
}

export function decodeBmp(bytes: Uint8Array): Rgb {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint16(0, false) !== 0x424d) throw new Error('not a BMP')
  const offset = v.getUint32(10, true)
  const headerSize = v.getUint32(14, true)
  const width = v.getInt32(18, true)
  const rawHeight = v.getInt32(22, true)
  const bpp = v.getUint16(28, true)
  const compression = v.getUint32(30, true)
  const height = Math.abs(rawHeight)
  const topDown = rawHeight < 0
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP depth ${bpp}`)
  // BI_BITFIELDS (3) carries channel masks right after the 40-byte info header
  let rm = 0x00ff0000, gm = 0x0000ff00, bm = 0x000000ff
  if (compression === 3 && headerSize >= 52) { rm = v.getUint32(54, true); gm = v.getUint32(58, true); bm = v.getUint32(62, true) }
  const rs = shift(rm), gs = shift(gm), bs = shift(bm)
  const stride = Math.ceil(width * bpp / 32) * 4
  const px = new Uint32Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = offset + (topDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const at = row + x * (bpp / 8)
      let r: number, g: number, b: number
      if (bpp === 24) { b = bytes[at]!; g = bytes[at + 1]!; r = bytes[at + 2]! }
      else {
        const word = v.getUint32(at, true)
        r = (word & rm) >>> rs; g = (word & gm) >>> gs; b = (word & bm) >>> bs
      }
      px[y * width + x] = (r << 16) | (g << 8) | b
    }
  }
  return { width, height, px }
}

function toBase64(bytes: Uint8Array): string {
  const b = bytes as Uint8Array & { toBase64?: () => string }
  if (typeof b.toBase64 === 'function') return b.toBase64()
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
  if (typeof U.fromBase64 === 'function') return U.fromBase64(s)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// `img` must be `columns` wide and `rows * 2` tall.
export function toCells(img: Rgb): { cells: string; columns: number; rows: number } {
  const columns = img.width
  const rows = Math.floor(img.height / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = (r * columns + c) * 3
      words[i] = 0x2580
      words[i + 1] = img.px[r * 2 * columns + c]!
      words[i + 2] = img.px[(r * 2 + 1) * columns + c]!
    }
  }
  return { cells: toBase64(new Uint8Array(words.buffer)), columns, rows }
}

// The largest box of terminal cells that keeps the picture's aspect, a cell being about twice as tall as wide.
export function fitCells(pxW: number, pxH: number, maxCols: number, maxRows: number): { columns: number; rows: number } {
  if (pxW <= 0 || pxH <= 0) return { columns: Math.max(1, maxCols), rows: Math.max(1, maxRows) }
  let columns = Math.max(1, maxCols)
  let rows = Math.max(1, Math.round(columns * pxH / pxW / 2))
  if (rows > maxRows) {
    rows = Math.max(1, maxRows)
    columns = Math.max(1, Math.min(maxCols, Math.round(rows * 2 * pxW / pxH)))
  }
  return { columns, rows }
}
