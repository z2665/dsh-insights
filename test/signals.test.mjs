import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySession, detectFrictions, repeatedInstructions, languageOf } from '../src/signals.js'

function session(overrides = {}) {
  return {
    id: overrides.id ?? 's1',
    project: 'demo',
    title: overrides.title ?? '',
    humanMessages: overrides.humanMessages ?? [{ time: 1, text: '' }],
    toolCalls: [],
    toolErrors: [],
    edits: [],
    filesTouched: [],
    approvals: { asked: 0, allowed: 0, denied: 0 },
    interrupts: 0,
    durationMs: overrides.durationMs ?? 120_000,
    byName: {},
    ...overrides,
  }
}

test('classifies goals from the first message', () => {
  const debug = session({ humanMessages: [{ time: 1, text: '修复登录接口报错' }] })
  assert.equal(classifySession(debug).goal, '排障修复')
  const feature = session({ humanMessages: [{ time: 1, text: '实现一个导出按钮' }] })
  assert.equal(classifySession(feature).goal, '功能实现')
})

test('recognizes a quick question', () => {
  const quick = session({ humanMessages: [{ time: 1, text: '这个函数干嘛的？' }], durationMs: 60_000 })
  assert.equal(classifySession(quick).type, '快问快答')
})

test('maps file extensions to languages', () => {
  assert.equal(languageOf('a/b/app.tsx'), 'TypeScript')
  assert.equal(languageOf('a/b/run.sh'), 'Shell')
  assert.equal(languageOf('no-extension'), undefined)
})

test('repeated instructions need at least two sessions', () => {
  const sessions = [
    session({ id: 'a', humanMessages: [{ time: 1, text: '不要自动安装依赖' }] }),
    session({ id: 'b', humanMessages: [{ time: 1, text: '不要自动安装依赖' }] }),
  ]
  const repeated = repeatedInstructions(sessions)
  assert.equal(repeated.length, 1)
  assert.equal(repeated[0].sessions, 2)
})

test('tool errors surface as a friction with an example', () => {
  const failing = session({
    toolErrors: [{ name: 'pwsh', time: 2, message: 'Error: access denied' }],
  })
  const frictions = detectFrictions([failing])
  assert.equal(frictions.length, 1)
  assert.equal(frictions[0].type, 'tool-failure')
  assert.equal(frictions[0].sessions, 1)
  assert.match(frictions[0].examples[0].quote, /access denied/)
})
