/**
 * Session-log collection: discover DSH session logs, decode each into a
 * compact behavioural record, and filter the ones that carry no signal
 * (subagent children, seeded sessions, empty shells).
 */
import fs from 'node:fs'
import path from 'node:path'
import { readSessionLog } from './zstd.js'

const LOG_FILE = /^session\.v(\d+)\.jsonl(\.zstd|\.gz)?$/
const HUMAN_SOURCES = new Set(['user'])
const MAX_EVENTS = 4000

export function sessionsRoot(dshHome) {
  return path.join(dshHome, 'sessions')
}

/** Every session log under `sessions/<project>/<session>/`, newest first. */
export function findSessionFiles(dshHome) {
  const root = sessionsRoot(dshHome)
  const found = []
  let projectDirs = []
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return found
  }
  for (const projectDir of projectDirs) {
    const projectPath = path.join(root, projectDir.name)
    let sessionDirs = []
    try {
      sessionDirs = fs.readdirSync(projectPath, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      const dirPath = path.join(projectPath, sessionDir.name)
      let entries = []
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const match = LOG_FILE.exec(entry.name)
        if (!match) continue
        const filePath = path.join(dirPath, entry.name)
        let stat
        try {
          stat = fs.statSync(filePath)
        } catch {
          continue
        }
        found.push({
          filePath,
          projectKey: projectDir.name,
          formatVersion: Number(match[1]),
          mtime: stat.mtimeMs,
          bytes: stat.size,
        })
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function toolText(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function parseArguments(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function pathFromArguments(args) {
  for (const key of ['file_path', 'path', 'filePath']) {
    if (typeof args[key] === 'string' && args[key]) return args[key]
  }
  return undefined
}

function projectNameOf(cwd) {
  if (!cwd) return '未知项目'
  const normalized = cwd.replace(/[\\/]+$/, '')
  const base = normalized.split(/[\\/]/).filter(Boolean).pop()
  return base || normalized
}

function isErrorResult(message) {
  if (message?.isError === true) return true
  const text = toolText(message?.content)
  if (/^\[exit code: (\d+)\]/.test(text)) return !/^\[exit code: 0\]/.test(text)
  return false
}

function errorHeadline(message) {
  const text = toolText(message?.content).trim()
  if (!text) return ''
  return text.split('\n').find((line) => line.trim())?.slice(0, 240) ?? ''
}

/**
 * Parse one session log into the compact shape the analyzer and report use.
 * Returns null when the file has no session header.
 */
export function readSessionFile(filePath) {
  const { records, warnings } = readSessionLog(filePath)
  if (records.length === 0) return null

  const header = records.find((record) => record.type === 'session')
  if (!header) return null

  const session = {
    id: header.id,
    version: header.version,
    createdAt: header.createdAt,
    cwd: header.cwd ?? '',
    project: projectNameOf(header.cwd),
    isSeeded: header.isSeeded === true,
    delegationDepth: header.delegationDepth ?? 0,
    preset: header.agentPreset ?? 'standard',
    title: '',
    model: null,
    lastTime: header.createdAt,
    humanMessages: [],
    turns: [],
    toolCalls: [],
    toolErrors: [],
    edits: [],
    commands: [],
    approvals: { asked: 0, allowed: 0, denied: 0 },
    jobs: 0,
    subagents: 0,
    steps: 0,
    assistantMessages: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    interrupts: 0,
    events: [],
    warnings,
  }

  const openCalls = new Map()
  let currentTurn = null
  let turnStart = 0

  const pushEvent = (event) => {
    if (session.events.length < MAX_EVENTS) session.events.push(event)
  }

  for (const record of records) {
    const time = typeof record.time === 'number' ? record.time : session.lastTime
    if (time > session.lastTime) session.lastTime = time
    const data = record.data ?? {}

    switch (record.type) {
      case 'session/title':
        if (typeof data.title === 'string' && data.title) session.title = data.title
        break
      case 'request/header': {
        const config = data.header?.config
        if (config?.model) session.model = { provider: config.provider, model: config.model }
        break
      }
      case 'agent-preset/selected':
        if (typeof data.agentPreset === 'string') session.preset = data.agentPreset
        break
      case 'turn/start':
        turnStart = time
        currentTurn = {
          index: data.turn ?? session.turns.length + 1,
          start: time,
          end: null,
          reason: 'open',
          userText: '',
          assistantTextLength: 0,
          toolCalls: 0,
        }
        session.turns.push(currentTurn)
        break
      case 'turn/end':
        if (currentTurn) {
          currentTurn.end = time
          currentTurn.reason = data.reason?.kind ?? 'completed'
          if (currentTurn.reason === 'aborted' || currentTurn.reason === 'interrupted') session.interrupts += 1
          if (currentTurn.reason !== 'completed') {
            pushEvent({ t: 'x', time, reason: currentTurn.reason })
          }
          currentTurn = null
        }
        break
      case 'step/start':
        session.steps += 1
        break
      case 'user/message': {
        const source = data.source?.kind ?? 'unknown'
        if (!HUMAN_SOURCES.has(source)) break
        const text = textOfBlocks(data.content).trim()
        if (!text) break
        const message = { time, text: text.slice(0, 4000) }
        session.humanMessages.push(message)
        if (currentTurn && !currentTurn.userText) currentTurn.userText = message.text
        pushEvent({ t: 'u', time, text: message.text.slice(0, 600) })
        break
      }
      case 'assistant/message': {
        session.assistantMessages += 1
        const usage = data.usage
        if (usage) {
          session.usage.input += usage.inputTokens ?? 0
          session.usage.output += usage.outputTokens ?? 0
          session.usage.cacheRead += usage.cacheReadTokens ?? 0
          session.usage.cacheWrite += usage.cacheWriteTokens ?? 0
        }
        const blocks = data.message?.content
        if (Array.isArray(blocks)) {
          let text = ''
          for (const block of blocks) {
            if (block?.type === 'text' && typeof block.text === 'string') text += block.text
          }
          if (text) {
            if (currentTurn) currentTurn.assistantTextLength += text.length
            pushEvent({ t: 'a', time, text: text.slice(0, 500) })
          }
        }
        break
      }
      case 'tool/call': {
        openCalls.set(data.callId, { name: data.name, start: time, args: parseArguments(data.arguments) })
        break
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.toolCallId
        const call = openCalls.get(callId)
        const message = data.message
        const failed = isErrorResult(message)
        const name = call?.name ?? '未知工具'
        const durationMs = call ? Math.max(0, time - call.start) : 0
        session.toolCalls.push({
          name,
          ms: durationMs,
          error: failed,
          time,
          path: call ? pathFromArguments(call.args) : undefined,
        })
        if (currentTurn) currentTurn.toolCalls += 1
        if (failed) {
          session.toolErrors.push({ name, time, message: errorHeadline(message) })
          pushEvent({ t: 'e', time, tool: name, text: errorHeadline(message).slice(0, 300) })
        }
        if (call) {
          const toolPath = pathFromArguments(call.args)
          if (toolPath && /^(write|edit)$/i.test(name)) {
            session.edits.push({ path: toolPath, tool: name, time })
          }
        }
        openCalls.delete(callId)
        break
      }
      case 'tool/ptc-dispatch': {
        const failed = data.isError === true
        const name = data.name ?? '未知工具'
        const args = parseArguments(data.arguments)
        session.toolCalls.push({ name, ms: 0, error: failed, time, path: pathFromArguments(args) })
        if (currentTurn) currentTurn.toolCalls += 1
        if (failed) {
          session.toolErrors.push({ name, time, message: errorHeadline({ content: data.content }) })
          pushEvent({ t: 'e', time, tool: name, text: errorHeadline({ content: data.content }).slice(0, 300) })
        }
        if (/^(write|edit)$/i.test(name)) {
          const toolPath = pathFromArguments(args)
          if (toolPath) session.edits.push({ path: toolPath, tool: name, time })
        }
        break
      }
      case 'approval/asked':
        session.approvals.asked += 1
        break
      case 'approval/decided': {
        const outcome = data.outcome ?? ''
        if (outcome === 'denied' || outcome === 'rejected') {
          session.approvals.denied += 1
          pushEvent({ t: 'd', time, text: data.reason ?? 'approval denied' })
        } else {
          session.approvals.allowed += 1
        }
        break
      }
      case 'command/run':
        session.commands.push({ name: data.name, args: data.args ?? '', time })
        break
      case 'job/registered':
        session.jobs += 1
        break
      case 'subagent/catalog':
      case 'subagent/descriptor':
        session.subagents += 1
        break
      default:
        break
    }
  }

  // A turn that never ended (live session) still counts with the last timestamp.
  if (currentTurn) {
    currentTurn.end = session.lastTime
    currentTurn.reason = 'open'
  }

  session.durationMs = session.turns.reduce(
    (total, turn) => total + Math.max(0, (turn.end ?? session.lastTime) - turn.start),
    0,
  )
  if (session.durationMs < 1000) session.durationMs = Math.max(0, session.lastTime - session.createdAt)

  session.filesTouched = [...new Set(session.edits.map((edit) => edit.path))]
  session.toolCounts = countBy(session.toolCalls, (call) => call.name)
  session.errorCounts = countBy(session.toolErrors, (error) => error.name)
  session.byName = Object.fromEntries(
    Object.entries(session.toolCounts).map(([name, calls]) => [name, { calls, errors: session.errorCounts[name] ?? 0 }]),
  )
  delete session.toolCounts
  delete session.errorCounts

  return session
}

function countBy(items, key) {
  const out = {}
  for (const item of items) {
    const k = key(item)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/** Drop sessions that carry no behavioural signal. */
export function isNoise(session) {
  if (!session) return true
  if (session.delegationDepth > 0) return true
  if (session.isSeeded) return true
  if (session.humanMessages.length === 0) return true
  if (session.durationMs < 45_000 && session.toolCalls.length === 0 && session.humanMessages.length < 2) return true
  return false
}

/**
 * Collect the sessions inside the window, newest first.
 * `maxSessions` bounds how many are fully analyzed (LLM/aggregation work).
 */
export function collectSessions({ dshHome, days = 30, maxSessions = 60, project, now = Date.now() }) {
  const from = now - days * 86_400_000
  const files = findSessionFiles(dshHome)
  const sessions = []
  const skipped = { subagent: 0, seeded: 0, empty: 0, outsideWindow: 0, unreadable: 0, otherProject: 0, overLimit: 0 }
  let scanned = 0

  for (const file of files) {
    if (file.mtime < from) {
      skipped.outsideWindow += 1
      continue
    }
    scanned += 1
    if (scanned > maxSessions * 6) {
      skipped.overLimit += 1
      continue
    }
    let session
    try {
      session = readSessionFile(file.filePath)
    } catch {
      skipped.unreadable += 1
      continue
    }
    if (!session) {
      skipped.unreadable += 1
      continue
    }
    if (session.createdAt < from && session.lastTime < from) {
      skipped.outsideWindow += 1
      continue
    }
    if (session.delegationDepth > 0) {
      skipped.subagent += 1
      continue
    }
    if (session.isSeeded) {
      skipped.seeded += 1
      continue
    }
    if (isNoise(session)) {
      skipped.empty += 1
      continue
    }
    if (project && !matchesProject(session, project)) {
      skipped.otherProject += 1
      continue
    }
    if (sessions.length >= maxSessions) {
      skipped.overLimit += 1
      continue
    }
    session.filePath = file.filePath
    session.bytes = file.bytes
    sessions.push(session)
  }

  sessions.sort((a, b) => b.createdAt - a.createdAt)
  return { sessions, skipped, scannedFiles: files.length, window: { from, to: now, days } }
}

function matchesProject(session, needle) {
  const lower = needle.toLowerCase()
  return (
    session.project.toLowerCase().includes(lower) ||
    session.cwd.toLowerCase().includes(lower) ||
    (session.title ?? '').toLowerCase().includes(lower)
  )
}
