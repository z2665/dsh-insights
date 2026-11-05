import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { collectSessions, readSessionFile } from '../src/collect.js'

const NOW = Date.now()
const START = NOW - 3_600_000

function writeSession(home, project, id, events, header = {}) {
  const dir = path.join(home, 'sessions', project, id)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 4,
      id,
      createdAt: START,
      cwd: 'C:\\work\\demo',
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
      ...header,
    }),
    ...events.map((event) => JSON.stringify(event)),
  ]
  // One zstd frame per durable record, mirroring the real append log.
  const frames = lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`)))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

const MAIN_EVENTS = [
  { type: 'turn/start', seq: 1, time: START, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: START + 1000,
    data: {
      content: [{ type: 'text', text: '修复登录 bug' }],
      source: { kind: 'user' },
      role: 'user',
      id: 'm1',
    },
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: START + 2000,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '先看代码' }] },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 },
    },
  },
  {
    type: 'tool/call',
    seq: 4,
    time: START + 3000,
    data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"C:/work/demo/src/login.js"}' },
  },
  {
    type: 'tool/result',
    seq: 5,
    time: START + 3100,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c1' },
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'file body' }],
      },
    },
  },
  { type: 'turn/end', seq: 6, time: START + 65_000, data: { turn: 1, reason: { kind: 'completed' } } },
]

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-insights-home-'))
  writeSession(home, '--demo--', 'session-main', MAIN_EVENTS)
  writeSession(home, '--demo--', 'session-child', MAIN_EVENTS, { delegationDepth: 1 })
  writeSession(home, '--demo--', 'session-empty', [])
  return home
}

test('reads one session into the compact shape', () => {
  const home = fixtureHome()
  const session = readSessionFile(path.join(home, 'sessions', '--demo--', 'session-main', 'session.v4.jsonl.zstd'))
  assert.equal(session.project, 'demo')
  assert.equal(session.humanMessages.length, 1)
  assert.equal(session.toolCalls.length, 1)
  assert.equal(session.byName.read.calls, 1)
  assert.equal(session.usage.input, 100)
  assert.equal(session.usage.output, 20)
  assert.equal(session.durationMs, 65_000)
  fs.rmSync(home, { recursive: true, force: true })
})

test('collect keeps real work and skips subagent and empty sessions', () => {
  const home = fixtureHome()
  const result = collectSessions({ dshHome: home, days: 30, maxSessions: 10 })
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].id, 'session-main')
  assert.equal(result.skipped.subagent, 1)
  assert.equal(result.skipped.empty, 1)
  fs.rmSync(home, { recursive: true, force: true })
})

test('a project filter narrows the result', () => {
  const home = fixtureHome()
  assert.equal(collectSessions({ dshHome: home, days: 30, project: 'demo' }).sessions.length, 1)
  assert.equal(collectSessions({ dshHome: home, days: 30, project: 'nope' }).sessions.length, 0)
  fs.rmSync(home, { recursive: true, force: true })
})
