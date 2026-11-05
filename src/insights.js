/**
 * Orchestration: deterministic signals + LLM facets + synthesis, merged into
 * the single data object the HTML report renders.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  buildStats,
  detectFrictions,
  repeatedInstructions,
  workflowSignals,
  classifySession,
} from './signals.js'
import { generateFacets, synthesizeReport, FRICTION_LABELS, hashOf } from './llm.js'

const FRICTION_ORDER = [
  'misunderstood',
  'wrong-approach',
  'buggy-output',
  'tool-failure',
  'rejected',
  'excessive-changes',
  'environment',
  'context-loss',
  'rework',
  'interrupted',
]

function countInto(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function mergeFacetCategories(sessions, facets) {
  const goals = new Map()
  const types = new Map()
  const satisfaction = []
  for (const session of sessions) {
    const facet = facets.get(session.id)
    const heuristic = classifySession(session)
    const goal = facet?.goal ?? heuristic.goal
    const type = facet?.sessionType ?? heuristic.type
    countInto(goals, goal)
    countInto(types, type)
    if (facet?.satisfaction) satisfaction.push(facet.satisfaction)
  }
  return {
    goals: [...goals.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    types: [...types.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    satisfaction: satisfaction.length
      ? {
          average: Math.round((satisfaction.reduce((sum, value) => sum + value, 0) / satisfaction.length) * 10) / 10,
          distribution: [1, 2, 3, 4, 5].map((score) => ({ score, count: satisfaction.filter((value) => value === score).length })),
          samples: satisfaction.length,
        }
      : null,
  }
}

function mergeFrictions(sessions, deterministic, facets) {
  const byType = new Map()
  const ensure = (type) => {
    const entry = byType.get(type) ?? {
      type,
      label: FRICTION_LABELS[type] ?? deterministic.find((item) => item.type === type)?.label ?? type,
      count: 0,
      sessions: new Set(),
      examples: [],
    }
    byType.set(type, entry)
    return entry
  }

  for (const friction of deterministic) {
    const entry = ensure(friction.type)
    entry.label = friction.label
    entry.count += friction.count
    for (const example of friction.examples) {
      entry.sessions.add(example.session)
      pushExample(entry, example)
    }
  }

  for (const session of sessions) {
    const facet = facets.get(session.id)
    if (!facet?.frictions?.length) continue
    for (const friction of facet.frictions) {
      const entry = ensure(friction.type)
      entry.count += 1
      entry.sessions.add(session.id)
      pushExample(entry, {
        session: session.id,
        title: session.title || session.project,
        detail: friction.detail,
        quote: friction.quote,
      })
    }
  }

  const total = Math.max(1, sessions.length)
  const list = [...byType.values()]
    .map((entry) => ({
      type: entry.type,
      label: entry.label,
      count: entry.count,
      sessions: entry.sessions.size,
      share: Math.round((entry.sessions.size / total) * 100),
      examples: entry.examples.slice(0, 4),
    }))
    .filter((entry) => entry.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count)

  for (const entry of list) {
    entry.severity = entry.share >= 40 ? 'high' : entry.share >= 15 ? 'medium' : 'low'
  }
  return list.sort(
    (a, b) => b.sessions - a.sessions || b.count - a.count || FRICTION_ORDER.indexOf(a.type) - FRICTION_ORDER.indexOf(b.type),
  )
}

function pushExample(entry, example) {
  const key = `${example.session}:${example.detail}`
  if (entry.examples.some((item) => `${item.session}:${item.detail}` === key)) return
  if (entry.examples.length < 6) entry.examples.push(example)
}

function mergeRepeated(global, facets) {
  const map = new Map()
  for (const item of global) {
    map.set(normalize(item.text), { text: item.text, sessions: item.sessions, count: item.count })
  }
  for (const [, facet] of facets) {
    for (const text of facet.repeatedInstructions ?? []) {
      const key = normalize(text)
      const existing = map.get(key)
      if (existing) {
        existing.count += 1
      } else {
        map.set(key, { text, sessions: 1, count: 1, hinted: true })
      }
    }
  }
  return [...map.values()]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
}

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, '').replace(/[。，、；：！？.,;:!?"'“”‘’()（）]/g, '').slice(0, 80)
}

function fallbackSummary({ stats, frictions, repeated, signals }) {
  const working = []
  const hindering = []
  const quickWins = []
  const opportunities = []

  if (stats.toolCalls > 0) {
    const best = stats.tools[0]
    working.push(`工具链跑得通：${stats.toolCalls} 次调用中 ${best.name} 用了 ${best.calls} 次，失败率只有 ${stats.errorRate}%。`)
  }
  if (stats.activeDays > 0) {
    working.push(`最近 ${stats.windowDays} 天里有 ${stats.activeDays} 天在推进，${stats.sessions} 个会话覆盖 ${stats.projects} 个项目。`)
  }
  if (stats.connections.jobs > 0) {
    working.push(`会主动用后台任务：${stats.connections.jobs} 个 job 把长命令挪出了主对话。`)
  }

  for (const friction of frictions.slice(0, 3)) {
    hindering.push(`${friction.label}：影响 ${friction.sessions} 个会话（占 ${friction.share}%），累计 ${friction.count} 次。`)
  }
  if (signals.multiTurn >= 3) {
    hindering.push(`${signals.multiTurn} 个会话需要 4 轮以上对话才收敛，说明需求或约束没有一次讲清。`)
  }
  if (stats.errorRate >= 5) {
    hindering.push(`工具失败率 ${stats.errorRate}%，每次失败都要额外一轮对话来恢复。`)
  }

  if (repeated.length) {
    quickWins.push(`把「${repeated[0].text.slice(0, 40)}」这类重复指令写进 AGENTS.md，${repeated[0].sessions} 个会话里又说过一遍。`)
  }
  if (frictions.find((item) => item.type === 'rework')) {
    quickWins.push('同一文件被反复修改时，先一次性读完再动手，减少来回。')
  }
  if (stats.connections.approvalsDenied > 0) {
    quickWins.push(`有 ${stats.connections.approvalsDenied} 次操作被拒，提前在 AGENTS.md 里写清禁止事项。`)
  }
  if (quickWins.length < 3) quickWins.push('每次长任务前先让智能体复述目标和验收标准，30 秒省下一轮返工。')

  if (signals.subagentSessions === 0 && stats.sessions >= 3) {
    opportunities.push('把并行的代码库探索交给子代理：主对话只留结论，上下文更干净。')
  }
  if (signals.skillUses === 0 && stats.sessions >= 3) {
    opportunities.push('把每次都要重新交代的流程做成 Skill，用一次调用替代一段提示词。')
  }
  if (opportunities.length < 2) {
    opportunities.push('给常见任务固定验收标准（测试通过/页面能用），让「完成」有客观定义。')
  }
  if (opportunities.length < 2) {
    opportunities.push('把 30 分钟以上的会话拆成计划 + 执行两段，缩短单次上下文长度。')
  }

  return { headline: null, working: working.slice(0, 3), hindering: hindering.slice(0, 3), quickWins, opportunities, agentRules: null }
}

function fallbackRules({ repeated, frictions, stats }) {
  const rules = []
  for (const item of repeated.slice(0, 4)) {
    rules.push({
      category: '沟通',
      rule: item.text.replace(/^[，。、\s]+|[，。、\s]+$/g, ''),
      why: `在 ${item.sessions} 个会话里重复出现`,
    })
  }
  for (const friction of frictions) {
    if (friction.type === 'tool-failure') {
      const tool = friction.examples[0]?.detail ?? ''
      rules.push({
        category: '工具',
        rule: `执行 ${tool.replace(/ 失败 \d+ 次$/, '') || '命令'} 前先确认环境，失败后先读错误再重试，不要盲目改参数。`,
        why: `${friction.count} 次失败分布在 ${friction.sessions} 个会话`,
      })
    } else if (friction.type === 'rework') {
      rules.push({
        category: '流程',
        rule: '编辑文件前先完整读一遍；同一文件改动超过 3 次时，停下来重新确认方案。',
        why: `同一文件反复修改影响 ${friction.sessions} 个会话`,
      })
    } else if (friction.type === 'misunderstood') {
      rules.push({
        category: '沟通',
        rule: '动手前先用一句话复述需求并列出验收标准，得到确认后再改代码。',
        why: `需求纠正影响 ${friction.sessions} 个会话`,
      })
    } else if (friction.type === 'rejected') {
      rules.push({
        category: '流程',
        rule: '涉及删除、对外请求、提权或写工作区之外的操作，先说明影响再请求确认。',
        why: `${friction.count} 次操作被拒绝`,
      })
    }
  }
  if (rules.length === 0) {
    rules.push({
      category: '流程',
      rule: '开始前先读 AGENTS.md 与相关文件，改动保持最小，完成后跑一遍验证命令。',
      why: '作为基线规则使用',
    })
  }
  return rules.slice(0, 8)
}

function recommendFeatures({ stats, signals, repeated, frictions = [] }) {
  const items = []
  const topTool = stats.tools[0]
  const exploreTools = (stats.tools.find((tool) => tool.name === 'read')?.calls ?? 0) +
    (stats.tools.find((tool) => tool.name === 'grep')?.calls ?? 0) +
    (stats.tools.find((tool) => tool.name === 'glob')?.calls ?? 0)

  if (signals.subagentSessions === 0 && stats.sessions >= 2) {
    items.push({
      title: '并行探索交给子代理',
      body: '你目前所有检索都在主对话里顺序完成，读进来的大段内容会一直占着上下文。',
      evidence: `${exploreTools} 次 read/grep/glob，${signals.subagentSessions} 个会话用过 subagent`,
      action: '说「用两个子代理分别摸清 X 和 Y，只回报结论」。',
    })
  }
  if (signals.skillUses === 0) {
    items.push({
      title: '把固定流程做成 Skill',
      body: '同样的步骤每次都用自然语言交代一遍，既费 token 又容易漏步骤。',
      evidence: repeated.length ? `检测到 ${repeated.length} 条跨会话重复指令` : `skill 调用 ${signals.skillUses} 次`,
      action: '用 skill-creator 生成一个 Skill，把步骤、命令和验收标准固化下来。',
    })
  }
  if (signals.todoUses === 0 && signals.longSessions > 0) {
    items.push({
      title: '长任务先列待办',
      body: '超过 30 分钟的会话没有 todo 列表，容易出现做到一半忘记目标。',
      evidence: `${signals.longSessions} 个会话超过 30 分钟，todo_write 使用 ${signals.todoUses} 次`,
      action: '任务开始时说「先列 todo，再逐项推进」。',
    })
  }
  if (topTool && topTool.name === 'pwsh' && topTool.calls > 50) {
    items.push({
      title: '常用命令固化成脚本',
      body: '大量重复的 shell 调用可以合并成一个脚本，减少往返和出错机会。',
      evidence: `pwsh 调用 ${topTool.calls} 次`,
      action: '把出现 3 次以上的命令序列写进 scripts/，让智能体只调用一次。',
    })
  }
  if (!items.length) {
    items.push({
      title: '用 AGENTS.md 固化偏好',
      body: '把已经稳定下来的约定写进项目指令，减少每次的重复解释。',
      evidence: `${stats.sessions} 个会话覆盖 ${stats.projects} 个项目`,
      action: '在项目根目录维护 AGENTS.md，只写真正反复出现的约束。',
    })
  } else if (items.length < 2) {
    const failure = frictions.find((item) => item.type === 'tool-failure')
    items.push({
      title: '给高频失败加一道检查',
      body: '失败大多来自环境和前置条件，先确认再执行比失败后重试便宜。',
      evidence: failure ? `${failure.label}影响 ${failure.sessions} 个会话` : `工具失败率 ${stats.errorRate}%`,
      action: '把最容易失败的那条命令写成一个带前置检查的脚本，交给智能体调用。',
    })
  }
  return items.slice(0, 4)
}

function readPreviousRun(reportDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(reportDir, 'last-run.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Produce the full report data object.
 */
export async function generateInsightData({
  sessions,
  skipped,
  window,
  timezone,
  days,
  llm,
  model,
  cacheDir,
  reportDir,
  concurrency = 3,
  signal,
  refresh = false,
  project = null,
  onProgress,
  generatedAt = Date.now(),
}) {
  const stats = buildStats(sessions, { timezone, days })
  stats.windowDays = days
  stats.errorRate = stats.toolCalls ? Math.round((stats.toolErrors / stats.toolCalls) * 1000) / 10 : 0

  const deterministicFrictions = detectFrictions(sessions)
  const globalRepeated = repeatedInstructions(sessions)
  const signals = workflowSignals(sessions)
  const llmErrors = []

  const facetRun = await generateFacets({
    sessions,
    llm,
    model,
    cacheDir,
    concurrency,
    signal,
    refresh,
    errors: llmErrors,
    onProgress: (progress) => onProgress?.({ stage: 'facets', ...progress }),
  })

  const categories = mergeFacetCategories(sessions, facetRun.facets)
  const frictions = mergeFrictions(sessions, deterministicFrictions, facetRun.facets)
  const repeated = mergeRepeated(globalRepeated, facetRun.facets)

  const summaryInput = buildSummaryInput({ stats, sessions, facets: facetRun.facets, frictions, repeated, workflow: signals })
  onProgress?.({ stage: 'synthesis' })
  const synthesis = await synthesizeReport({
    llm,
    model,
    input: summaryInput,
    cacheDir,
    signal,
    refresh,
    errors: llmErrors,
  })

  const heuristic = fallbackSummary({ stats, frictions, repeated, signals })
  const summary = synthesis.value
    ? {
        headline: synthesis.value.headline,
        working: synthesis.value.working.length ? synthesis.value.working : heuristic.working,
        hindering: synthesis.value.hindering.length ? synthesis.value.hindering : heuristic.hindering,
        quickWins: synthesis.value.quickWins.length ? synthesis.value.quickWins : heuristic.quickWins,
        opportunities: synthesis.value.opportunities.length ? synthesis.value.opportunities : heuristic.opportunities,
      }
    : heuristic

  const rules = synthesis.value?.agentRules?.length
    ? synthesis.value.agentRules
    : fallbackRules({ repeated, frictions, stats })

  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, month: '2-digit', day: '2-digit' })
  const sessionRows = sessions.map((session) => {
    const facet = facetRun.facets.get(session.id)
    const heuristicClass = classifySession(session)
    return {
      id: session.id,
      title: session.title || session.project,
      date: dateFormatter.format(new Date(session.createdAt)),
      project: session.project,
      preset: session.preset,
      createdAt: session.createdAt,
      durationMs: session.durationMs,
      messages: session.humanMessages.length,
      tools: session.toolCalls.length,
      errors: session.toolErrors.length,
      files: session.filesTouched.length,
      tokens: session.usage.input + session.usage.output,
      goal: facet?.goal ?? heuristicClass.goal,
      type: facet?.sessionType ?? heuristicClass.type,
      outcome: facet?.outcome ?? null,
      satisfaction: facet?.satisfaction ?? null,
      summary: facet?.summary ?? '',
      frictions: (facet?.frictions ?? []).map((item) => FRICTION_LABELS[item.type] ?? item.type),
    }
  })

  const statsSnapshot = {
    sessions: stats.sessions,
    humanMessages: stats.humanMessages,
    toolCalls: stats.toolCalls,
    toolErrors: stats.toolErrors,
    edits: stats.edits,
    files: stats.files,
    activeDays: stats.activeDays,
    durationMs: stats.durationMs,
    tokens: stats.tokens,
    errorRate: stats.errorRate,
    generatedAt,
  }
  const previous = readPreviousRun(reportDir)
  const comparable =
    previous && previous.days === days && (previous.project ?? null) === (project ?? null) ? previous : null
  const deltas = comparable
    ? {
        sessions: stats.sessions - (comparable.stats?.sessions ?? 0),
        humanMessages: stats.humanMessages - (comparable.stats?.humanMessages ?? 0),
        toolErrors: stats.toolErrors - (comparable.stats?.toolErrors ?? 0),
        activeDays: stats.activeDays - (comparable.stats?.activeDays ?? 0),
        since: comparable.generatedAt ?? null,
      }
    : null

  return {
    version: 1,
    generatedAt,
    timezone,
    range: { days, from: window.from, to: window.to },
    project: project ?? null,
    stats: {
      ...stats,
      goals: categories.goals,
      types: categories.types,
      satisfaction: categories.satisfaction,
    },
    summary,
    frictions,
    repeated,
    rules,
    features: recommendFeatures({ stats, signals, repeated, frictions }),
    workflow: signals,
    sessions: sessionRows,
    skipped,
    llm: {
      used: Boolean(llm),
      provider: model?.provider ?? null,
      model: model?.model ?? null,
      analyzed: facetRun.analyzed,
      cached: facetRun.cached,
      failed: facetRun.failed,
      synthesis: Boolean(synthesis.value),
      errors: llmErrors,
      tokens: {
        input: facetRun.usage.input + (synthesis.usage?.inputTokens ?? 0),
        output: facetRun.usage.output + (synthesis.usage?.outputTokens ?? 0),
      },
    },
    deltas,
    cacheKey: hashOf(JSON.stringify({ sessions: sessions.map((session) => session.id), generatedAt })),
  }
}

function buildSummaryInput({ stats, sessions, facets, frictions, repeated, workflow }) {
  const lines = []
  lines.push(
    `窗口：最近 ${stats.windowDays} 天｜会话 ${stats.sessions}｜用户消息 ${stats.humanMessages}｜` +
      `工具调用 ${stats.toolCalls}（失败率 ${stats.errorRate}%）｜改动文件 ${stats.files}｜` +
      `活跃天数 ${stats.activeDays}｜项目 ${stats.projects}`,
  )
  lines.push(`工具分布：${stats.tools.slice(0, 8).map((tool) => `${tool.name}×${tool.calls}`).join('、')}`)
  if (stats.languages.length) {
    lines.push(`涉及语言/文件类型：${stats.languages.slice(0, 6).map((item) => `${item.name}(${item.files})`).join('、')}`)
  }
  if (repeated.length) {
    lines.push(`跨会话重复出现的指令：${repeated.map((item) => `「${item.text.slice(0, 40)}」×${item.sessions}`).join('；')}`)
  }
  if (frictions.length) {
    lines.push(
      `已识别的摩擦：${frictions
        .slice(0, 6)
        .map((item) => `${item.label}(${item.sessions} 个会话/${item.count} 次)`)
        .join('、')}`,
    )
  }
  lines.push(`工作流信号：${JSON.stringify(workflow)}`)
  lines.push('会话清单：')
  for (const session of sessions.slice(0, 40)) {
    const facet = facets.get(session.id)
    const head = facet
      ? `[${facet.goal}/${facet.sessionType}/${facet.outcome}/满意度${facet.satisfaction}]`
      : '[未分析]'
    const frictionText = facet?.frictions?.length ? ` 摩擦：${facet.frictions.map((item) => item.detail).join('；')}` : ''
    lines.push(
      `- ${head} ${session.title || session.project}（${session.project}，${Math.round(
        session.durationMs / 60_000,
      )} 分钟，${session.humanMessages.length} 条消息）${facet?.summary ? `：${facet.summary}` : ''}${frictionText}`,
    )
  }
  return lines.join('\n')
}

export function writeRunSnapshot(reportDir, data) {
  try {
    fs.mkdirSync(reportDir, { recursive: true })
    const snapshot = {
      generatedAt: data.generatedAt,
      days: data.range.days,
      project: data.project ?? null,
      stats: {
        sessions: data.stats.sessions,
        humanMessages: data.stats.humanMessages,
        toolCalls: data.stats.toolCalls,
        toolErrors: data.stats.toolErrors,
        edits: data.stats.edits,
        files: data.stats.files,
        activeDays: data.stats.activeDays,
        durationMs: data.stats.durationMs,
        tokens: data.stats.tokens,
        errorRate: data.stats.errorRate,
      },
    }
    fs.writeFileSync(path.join(reportDir, 'last-run.json'), JSON.stringify(snapshot, null, 2))
  } catch {
    // best effort
  }
}
