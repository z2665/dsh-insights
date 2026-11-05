/**
 * Deterministic analysis over collected sessions: volume, activity, tool and
 * language mix, friction candidates, repeated instructions.
 *
 * Everything here is timezone-aware only through the caller-supplied
 * `timezone`; raw timestamps are kept so the report can re-bucket on demand.
 */

const DAY_MS = 86_400_000

const EXT_LANGUAGE = {
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.c': 'C/C++',
  '.h': 'C/C++',
  '.cc': 'C/C++',
  '.cpp': 'C/C++',
  '.hpp': 'C/C++',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.css': 'CSS',
  '.scss': 'CSS',
  '.less': 'CSS',
  '.html': 'HTML',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.md': '文档',
  '.mdx': '文档',
  '.json': '配置',
  '.yaml': '配置',
  '.yml': '配置',
  '.toml': '配置',
  '.ini': '配置',
  '.env': '配置',
}

const CORRECTION = /^(不|没|别|错|还是|重新|再来|又|怎么|为什么|为啥|no\b|nope\b|wrong\b|still\b|actually\b|that's not|not what)/i

const GOAL_RULES = [
  ['安全审计', /(漏洞|安全|审计|渗透|越权|注入|xss|csrf|ssrf|exploit|vulnerab|security|pentest|cve)/i],
  ['排障修复', /(报错|错误|失败|修复|挂了|不能用|bug|error|fix|debug|crash|broken)/i],
  ['功能实现', /(实现|添加|新增|开发|支持|做一个|feature|implement|add |build )/i],
  ['重构迁移', /(重构|迁移|整理|拆分|升级|refactor|migrate|upgrade|rewrite)/i],
  ['测试验证', /(测试|单测|覆盖率|test|spec|coverage)/i],
  ['文档写作', /(文档|说明|注释|readme|doc|comment)/i],
  ['配置部署', /(配置|部署|安装|环境|docker|deploy|config|setup|install|ci\b)/i],
  ['代码理解', /(阅读|理解|分析|看看|梳理|review|understand|explore|分析一下)/i],
]

const FEATURE_SIGNALS = {
  subagent: /^(subagent|subagent_fork|workflow)$/,
  backgroundJobs: null,
}

export function languageOf(filePath) {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return undefined
  return EXT_LANGUAGE[lower.slice(dot)]
}

function localParts(timeMs, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(new Date(timeMs))
  const get = (type) => parts.find((part) => part.type === type)?.value
  const hour = Number(get('hour')) % 24
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour }
}

function dayKey(timeMs, timezone) {
  return localParts(timeMs, timezone).date
}

function percent(part, whole) {
  if (!whole) return 0
  return Math.round((part / whole) * 1000) / 10
}

export function classifySession(session) {
  const firstText = session.humanMessages.map((message) => message.text).join('\n').slice(0, 4000)
  const haystack = `${session.title}\n${firstText}`
  let goal = '其他'
  for (const [label, pattern] of GOAL_RULES) {
    if (pattern.test(haystack)) {
      goal = label
      break
    }
  }

  const readish = (session.byName.read?.calls ?? 0) + (session.byName.grep?.calls ?? 0) + (session.byName.glob?.calls ?? 0)
  const edits = session.edits.length
  const humans = session.humanMessages.length
  let type = '混合任务'
  if (humans === 1 && session.durationMs < 5 * 60_000 && session.toolCalls.length < 8) type = '快问快答'
  else if (edits > 0 && humans >= 4) type = '迭代推进'
  else if (edits > 0 && humans <= 3) type = '一次实现'
  else if (edits === 0 && readish >= 4) type = '代码探索'
  else if (humans >= 3) type = '多轮调整'

  return { goal, type }
}

export function detectFrictions(sessions) {
  const byType = new Map()
  const add = (type, label, example, weight = 1) => {
    const entry = byType.get(type) ?? { type, label, count: 0, sessions: new Set(), examples: [], weight }
    entry.count += weight
    entry.sessions.add(example.session)
    if (entry.examples.length < 5) entry.examples.push(example)
    byType.set(type, entry)
  }

  for (const session of sessions) {
    const ref = { session: session.id, title: session.title || session.project }

    // Tool failures, with the failing tool and its first error line.
    const errorsByTool = new Map()
    for (const error of session.toolErrors) {
      errorsByTool.set(error.name, (errorsByTool.get(error.name) ?? 0) + 1)
    }
    for (const [tool, count] of errorsByTool) {
      const sample = session.toolErrors.find((error) => error.name === tool)
      add('tool-failure', '工具执行失败', {
        ...ref,
        detail: `${tool} 失败 ${count} 次`,
        quote: sample?.message ?? '',
      }, count)
    }

    // User corrections: short follow-ups that push back on the previous answer.
    for (let i = 1; i < session.humanMessages.length; i += 1) {
      const message = session.humanMessages[i]
      const text = message.text.trim()
      if (text.length > 180) continue
      if (CORRECTION.test(text)) {
        add('misunderstood', '需求被误解 / 反复纠正', {
          ...ref,
          detail: `第 ${i + 1} 条用户消息出现纠正`,
          quote: text.slice(0, 180),
        })
      }
    }

    // Denied approvals are the strongest "rejected action" signal.
    if (session.approvals.denied > 0) {
      add('rejected', '操作被拒绝', {
        ...ref,
        detail: `${session.approvals.denied} 次审批被拒`,
        quote: '',
      }, session.approvals.denied)
    }

    // Heavy rework: the same file edited over and over is a stronger signal
    // than raw edit volume, which just tracks session length.
    const perFile = new Map()
    for (const edit of session.edits) perFile.set(edit.path, (perFile.get(edit.path) ?? 0) + 1)
    for (const [file, count] of perFile) {
      if (count >= 5) {
        add('rework', '同一文件反复修改', {
          ...ref,
          detail: `${file.split(/[\\/]/).pop()} 被修改 ${count} 次`,
          quote: '',
        })
      }
    }

    // Aborted turns and interrupts.
    if (session.interrupts > 0) {
      add('interrupted', '中途打断', {
        ...ref,
        detail: `${session.interrupts} 个回合被中断`,
        quote: '',
      }, session.interrupts)
    }
  }

  return [...byType.values()]
    .map((entry) => ({
      type: entry.type,
      label: entry.label,
      count: entry.count,
      sessions: entry.sessions.size,
      examples: entry.examples,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count)
}

function normalizeInstruction(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s。，、；：！？.,;:!?"'“”‘’()（）\[\]【】]/g, '')
    .trim()
}

const IMPERATIVE_HINT =
  /(总是|始终|永远|不要|别|必须|记得|注意|每次|统一|改用|使用|用 |先 |以后|always|never|don't|must|remember|use |prefer)/i

/**
 * Instructions the user keeps repeating across sessions: the raw material for
 * AGENTS.md rules. Exact-normalized duplicates first, then repeated sentences.
 */
export function repeatedInstructions(sessions) {
  const exact = new Map()
  const sentences = new Map()

  for (const session of sessions) {
    for (const message of session.humanMessages) {
      const compact = normalizeInstruction(message.text)
      if (compact.length >= 4 && compact.length <= 200) {
        const entry = exact.get(compact) ?? { text: message.text.trim(), sessions: new Set(), count: 0 }
        entry.sessions.add(session.id)
        entry.count += 1
        exact.set(compact, entry)
      }
      for (const sentence of message.text.split(/[。！？!?\n]/)) {
        const trimmed = sentence.trim()
        const compactSentence = normalizeInstruction(trimmed)
        if (compactSentence.length < 6 || compactSentence.length > 90) continue
        if (!IMPERATIVE_HINT.test(trimmed)) continue
        const entry = sentences.get(compactSentence) ?? { text: trimmed, sessions: new Set(), count: 0 }
        entry.sessions.add(session.id)
        entry.count += 1
        sentences.set(compactSentence, entry)
      }
    }
  }

  const pick = (map) =>
    [...map.values()]
      .filter((entry) => entry.sessions.size >= 2)
      .map((entry) => ({ text: entry.text.slice(0, 200), sessions: entry.sessions.size, count: entry.count }))
      .sort((a, b) => b.sessions - a.sessions || b.count - a.count)

  const merged = [...pick(exact), ...pick(sentences)]
  const seen = new Set()
  return merged.filter((entry) => {
    const key = normalizeInstruction(entry.text)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 12)
}

export function buildActivity(sessions, { timezone, days, now = Date.now() }) {
  const dayBuckets = new Map()
  const hourBuckets = new Array(24).fill(0)
  const messageTimes = []
  const sessionStarts = []

  const bucketFor = (date) => {
    const bucket = dayBuckets.get(date) ?? { date, messages: 0, sessions: 0, ms: 0, tools: 0 }
    dayBuckets.set(date, bucket)
    return bucket
  }

  for (const session of sessions) {
    sessionStarts.push(session.createdAt)
    for (const message of session.humanMessages) {
      messageTimes.push(message.time)
      const { date, hour } = localParts(message.time, timezone)
      bucketFor(date).messages += 1
      hourBuckets[hour] += 1
    }
    const startParts = localParts(session.createdAt, timezone)
    const startBucket = bucketFor(startParts.date)
    startBucket.sessions += 1
    startBucket.ms += session.durationMs
    startBucket.tools += session.toolCalls.length
  }

  // A contiguous window, oldest first: the heatmap and the bar chart share it.
  const daily = []
  const todayKey = dayKey(now, timezone)
  const [ty, tm, td] = todayKey.split('-').map(Number)
  const todayUtc = Date.UTC(ty, tm - 1, td, 12)
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(todayUtc - i * DAY_MS, 'UTC')
    daily.push(dayBuckets.get(key) ?? { date: key, messages: 0, sessions: 0, ms: 0, tools: 0 })
  }

  return { daily, hourly: hourBuckets, messageTimes, sessionStarts }
}

function streakOf(daily, timezone) {
  const active = new Set(daily.filter((day) => day.messages > 0 || day.sessions > 0).map((day) => day.date))
  const todayKey = dayKey(Date.now(), timezone)
  let streak = 0
  let skippedToday = false
  for (let i = 0; i < 400; i += 1) {
    const key = dayKey(Date.now() - i * DAY_MS, timezone)
    if (active.has(key)) {
      streak += 1
      skippedToday = true
    } else if (!skippedToday && key === todayKey) {
      continue
    } else {
      break
    }
  }
  return streak
}

export function buildStats(sessions, { timezone, days }) {
  const activity = buildActivity(sessions, { timezone, days })
  const toolTotals = new Map()
  const languages = new Map()
  const goals = new Map()
  const types = new Map()
  const projects = new Map()
  let tokensIn = 0
  let tokensOut = 0
  let cacheRead = 0
  let durationMs = 0
  let toolCalls = 0
  let toolErrors = 0
  let edits = 0
  let humanMessages = 0
  let steps = 0
  let jobs = 0
  let subagents = 0
  let approvalsAsked = 0
  let approvalsDenied = 0

  for (const session of sessions) {
    tokensIn += session.usage.input
    tokensOut += session.usage.output
    cacheRead += session.usage.cacheRead
    durationMs += session.durationMs
    toolCalls += session.toolCalls.length
    toolErrors += session.toolErrors.length
    edits += session.edits.length
    humanMessages += session.humanMessages.length
    steps += session.steps
    jobs += session.jobs
    subagents += session.subagents
    approvalsAsked += session.approvals.asked
    approvalsDenied += session.approvals.denied

    for (const [name, stats] of Object.entries(session.byName)) {
      const total = toolTotals.get(name) ?? { name, calls: 0, errors: 0 }
      total.calls += stats.calls
      total.errors += stats.errors
      toolTotals.set(name, total)
    }
    for (const file of session.filesTouched) {
      const language = languageOf(file)
      if (!language) continue
      languages.set(language, (languages.get(language) ?? 0) + 1)
    }
    const classified = classifySession(session)
    goals.set(classified.goal, (goals.get(classified.goal) ?? 0) + 1)
    types.set(classified.type, (types.get(classified.type) ?? 0) + 1)
    projects.set(session.project, (projects.get(session.project) ?? 0) + 1)
  }

  const activeDays = activity.daily.filter((day) => day.messages > 0 || day.sessions > 0).length
  const peakHour = activity.hourly.indexOf(Math.max(...activity.hourly))
  const tools = [...toolTotals.values()].sort((a, b) => b.calls - a.calls)

  return {
    sessions: sessions.length,
    humanMessages,
    steps,
    toolCalls,
    toolErrors,
    edits,
    files: new Set(sessions.flatMap((session) => session.filesTouched)).size,
    tokens: { input: tokensIn, output: tokensOut, cacheRead, total: tokensIn + tokensOut },
    durationMs,
    avgSessionMs: sessions.length ? Math.round(durationMs / sessions.length) : 0,
    activeDays,
    streak: streakOf(activity.daily, timezone),
    peakHour: Number.isFinite(peakHour) ? peakHour : 0,
    projects: projects.size,
    connections: { jobs, subagents, approvalsAsked, approvalsDenied },
    tools,
    languages: [...languages.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files),
    goals: [...goals.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    types: [...types.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    projectsList: [...projects.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    errorRate: percent(toolErrors, toolCalls),
    activity,
  }
}

/** Workflow coverage signals used by the feature recommendations. */
export function workflowSignals(sessions) {
  const signals = {
    tests: 0,
    git: 0,
    install: 0,
    build: 0,
    longSessions: 0,
    multiTurn: 0,
    subagentSessions: 0,
    skillUses: 0,
    todoUses: 0,
    approvalAsks: 0,
  }
  for (const session of sessions) {
    const text = session.events.filter((event) => event.t === 'u').map((event) => event.text).join('\n')
    if (/\b(test|vitest|jest|pytest|cargo test|go test|npm test|pnpm test)\b/i.test(text)) signals.tests += 1
    if (/\bgit (commit|push|merge|rebase|checkout)\b/i.test(text)) signals.git += 1
    if (/\b(npm i|npm install|pnpm add|yarn add|pip install|uv add|poetry add)\b/i.test(text)) signals.install += 1
    if (/\b(build|compile|tsc|vite build|cargo build|go build)\b/i.test(text)) signals.build += 1
    if (session.durationMs > 30 * 60_000) signals.longSessions += 1
    if (session.humanMessages.length >= 4) signals.multiTurn += 1
    if (session.subagents > 0 || session.byName.subagent || session.byName.subagent_fork) signals.subagentSessions += 1
    if (session.byName.skill) signals.skillUses += session.byName.skill.calls
    if (session.byName.todo_write) signals.todoUses += session.byName.todo_write.calls
    signals.approvalAsks += session.approvals.asked
  }
  return signals
}
