/**
 * Multi-frame zstd + JSONL session-log reading.
 *
 * DSH appends one zstd frame per durable batch, so a log file is a
 * concatenation of independent frames. Node's `zstdDecompressSync` decodes
 * only the first frame, so we split on the frame magic and decode each slice.
 * A slice that fails to decode is joined with the next candidate: this both
 * recovers from a magic-byte false positive inside a payload and tolerates a
 * half-written trailing frame from a live session.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function decodeZstdFrames(buf) {
  const offsets = []
  let at = buf.indexOf(FRAME_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(FRAME_MAGIC, at + FRAME_MAGIC.length)
  }
  if (offsets.length === 0) throw new Error('not a zstd stream')

  const parts = []
  let i = 0
  while (i < offsets.length) {
    let j = i + 1
    let decoded
    while (j <= offsets.length) {
      const end = j < offsets.length ? offsets[j] : buf.length
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(offsets[i], end))
        i = j
        break
      } catch {
        j += 1
      }
    }
    if (!decoded) {
      // Unreadable tail: keep everything decoded so far.
      if (parts.length === 0) throw new Error('cannot decode any zstd frame')
      return Buffer.concat(parts)
    }
    parts.push(decoded)
  }
  return Buffer.concat(parts)
}

/** Read one session log (`.jsonl`, `.jsonl.zstd`, `.jsonl.gz`) into records. */
export function readSessionLog(filePath) {
  const raw = fs.readFileSync(filePath)
  let text
  try {
    if (filePath.endsWith('.zstd')) {
      text = decodeZstdFrames(raw).toString('utf8')
    } else if (filePath.endsWith('.gz')) {
      text = zlib.gunzipSync(raw).toString('utf8')
    } else {
      text = raw.toString('utf8')
    }
  } catch (error) {
    return { records: [], warnings: [`unreadable log: ${error.message}`] }
  }

  const records = []
  const warnings = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      if (warnings.length < 5) warnings.push('skipped malformed record')
    }
  }
  return { records, warnings }
}
