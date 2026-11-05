import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { decodeZstdFrames, readSessionLog } from '../src/zstd.js'

test('decodes concatenated zstd frames', () => {
  const frames = ['{"a":1}\n', '{"b":2}\n'].map((line) => zlib.zstdCompressSync(Buffer.from(line)))
  const decoded = decodeZstdFrames(Buffer.concat(frames)).toString('utf8')
  assert.equal(decoded, '{"a":1}\n{"b":2}\n')
})

test('a half-written trailing frame cannot corrupt earlier records', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-insights-partial-'))
  const file = path.join(home, 'session.v4.jsonl.zstd')
  const complete = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n'))
  const partial = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n')).subarray(0, -6)
  fs.writeFileSync(file, Buffer.concat([complete, partial]))

  const { records, warnings } = readSessionLog(file)
  assert.equal(records.length, 1)
  assert.equal(records[0].type, 'session')
  assert.ok(warnings.length >= 1, 'the partial record is reported, not parsed')
  fs.rmSync(home, { recursive: true, force: true })
})

test('reports a malformed line instead of failing the whole log', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-insights-log-'))
  const file = path.join(home, 'session.v4.jsonl.zstd')
  const lines = ['{"type":"session"}\n', 'not json\n', '{"type":"turn/start"}\n']
  fs.writeFileSync(file, Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(line)))))
  const { records, warnings } = readSessionLog(file)
  assert.equal(records.length, 2)
  assert.equal(warnings.length, 1)
  fs.rmSync(home, { recursive: true, force: true })
})
