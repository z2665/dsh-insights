/**
 * LLM enrichment: one compact facet per session, one cross-session synthesis.
 *
 * Both stages are cached by content hash so repeat runs only pay for new or
 * changed sessions, and every failure degrades to deterministic heuristics
 * instead of failing the report.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FACET_SYSTEM =
  '你是 DSH（DeepSeek Harness）的会话复盘分析器。你只输出一个 JSON 对象，不输出 markdown、代码块或任何解释。'

const FACET_SCHEMA = `只输出一个 JSON 对象，字段如下：
{
  "goal": "安全审计|排障修复|功能实现|重构迁移|测试验证|文档写作|配置部署|代码理解|其他",
  "sessionType": "快问快答|一次实现|迭代推进|代码探索|多轮调整|混合任务",
  "outcome": "完成|部分完成|受阻",
  "satisfaction": 1 到 5 的整数，代表用户视角的顺畅程度,
  "summary": "不超过 40 字，说清这次会话做了什么、结果如何",
  "frictions": [
    {"type": "misunderstood|wrong-approach|buggy-output|tool-failure|rejected|excessive-changes|environment|context-loss",
     "detail": "不超过 30 字的具体摩擦",
     "quote": "用户原话片段，不超过 60 字，没有就填空字符串"}
  ],
  "repeatedInstructions": ["用户在这段对话里反复强调、或明显每次都说的指令，不超过 30 字"],
  "wins": ["这次会话里明显有效的工作方式，不超过 30 字"]
}
frictions 最多 4 条，只写真实发生的摩擦，没有就给空数组；repeatedInstructions 和 wins 各最多 3 条。`

const SUMMARY_SYSTEM =
  '你是资深 AI 编码工作流顾问，擅长从使用数据里看出真实的工作习惯问题。你只输出一个 JSON 对象，不输出 markdown 或解释。'

export function hashOf(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Build a bounded, information-dense transcript for one session. */
export function transcriptOf(session, budget = 11_000) {
  const lines = []
  const minutes = Math.max(1, Math.round(session.durationMs / 60_000))
  const failedTools = Object.entries(session.byName)
    .filter(([, stats]) => stats.errors > 0)
    .map(([name, stats]) => `${name}×${stats.errors}`)
    .join('、')

  lines.push(
    `项目：${session.project}｜预设：${session.preset}｜时长：${minutes} 分钟｜` +
      `工具调用：${session.toolCalls.length}${failedTools ? `（失败：${failedTools}）` : ''}｜` +
      `改动文件：${session.filesTouched.length}`,
  )
  if (session.title) lines.push(`标题：${clip(session.title, 80)}`)

  const events = []
  let lastError = null
  for (const event of session.events) {
    if (event.t === 'u') {
      lastError = null
      events.push(`[用户] ${clip(event.text, 600)}`)
    } else if (event.t === 'a') {
      if (event.text.trim()) events.push(`[助手] ${clip(event.text, 280)}`)
    } else if (event.t === 'e') {
      if (lastError === event.text) continue
      lastError = event.text
      events.push(`[工具失败 ${event.tool}] ${clip(event.text, 200)}`)
    } else if (event.t === 'd') {
      events.push('[审批被拒]')
    }
  }

  let body = events.join('\n')
  if (body.length > budget) {
    const head = body.slice(0, Math.floor(budget * 0.6))
    const tail = body.slice(body.length - Math.floor(budget * 0.38))
    body = `${head}\n…（中略）…\n${tail}`
  }
  lines.push(body)
  return lines.join('\n')
}

async function complete(llm, model, { system, prompt, maxTokens, signal, temperature }) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  let text = ''
  let usage = null
  let finish = null
  for await (const chunk of llm.stream({
    provider: model.provider,
    model: model.model,
    messages,
    system,
    maxTokens,
    temperature,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') {
      finish = chunk.reason
      if (finish?.kind === 'error') throw new Error(finish.failure?.message ?? 'model error')
      if (finish?.kind === 'aborted') throw new Error('model call aborted')
    }
  }
  return { text, usage, finish }
}

/** Ask once, and once more if the reply is not a JSON object. */
async function completeJson(llm, model, options) {
  const usages = []
  let lastText = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { text, usage, finish } = await complete(llm, model, options)
    if (usage) usages.push(usage)
    lastText = text
    const parsed = parseJsonObject(text)
    if (parsed) return { parsed, usages, text }
    if (finish?.kind === 'max-tokens') break
  }
  return { parsed: null, usages, text: lastText }
}

export function parseJsonObject(text) {
  if (!text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const source = fenced ? fenced[1] : text
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const value = JSON.parse(source.slice(start, end + 1))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

const FRICTION_TYPES = new Set([
  'misunderstood',
  'wrong-approach',
  'buggy-output',
  'tool-failure',
  'rejected',
  'excessive-changes',
  'environment',
  'context-loss',
])

export const FRICTION_LABELS = {
  misunderstood: '需求理解偏差',
  'wrong-approach': '技术方案不对',
  'buggy-output': '产出不可用',
  'tool-failure': '工具执行失败',
  rejected: '操作被拒绝',
  'excessive-changes': '改动过宽',
  environment: '环境/依赖问题',
  'context-loss': '上下文丢失',
}

function normalizeFacet(raw) {
  if (!raw) return null
  const satisfaction = Number(raw.satisfaction)
  const frictions = Array.isArray(raw.frictions)
    ? raw.frictions
        .filter((item) => item && FRICTION_TYPES.has(item.type))
        .slice(0, 4)
        .map((item) => ({
          type: item.type,
          detail: clip(item.detail, 60),
          quote: clip(item.quote, 120),
        }))
    : []
  return {
    goal: clip(raw.goal, 12) || '其他',
    sessionType: clip(raw.sessionType, 12) || '混合任务',
    outcome: clip(raw.outcome, 8) || '部分完成',
    satisfaction: Number.isFinite(satisfaction) ? Math.min(5, Math.max(1, Math.round(satisfaction))) : 3,
    summary: clip(raw.summary, 90),
    frictions,
    repeatedInstructions: Array.isArray(raw.repeatedInstructions)
      ? raw.repeatedInstructions.filter((item) => typeof item === 'string').map((item) => clip(item, 60)).slice(0, 3)
      : [],
    wins: Array.isArray(raw.wins)
      ? raw.wins.filter((item) => typeof item === 'string').map((item) => clip(item, 60)).slice(0, 3)
      : [],
  }
}

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeCache(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(value))
    fs.renameSync(temporary, file)
  } catch {
    // Caching is best-effort; a read-only profile still produces a report.
  }
}

/**
 * One facet per session, parallel-bounded and cached by transcript hash.
 * Returns { facets: Map, analyzed, cached, failed, usage }.
 */
export async function generateFacets({
  sessions,
  llm,
  model,
  cacheDir,
  concurrency = 3,
  signal,
  refresh = false,
  errors = [],
  onProgress,
}) {
  const facets = new Map()
  const stats = { analyzed: 0, cached: 0, failed: 0, usage: { input: 0, output: 0 } }
  if (sessions.length === 0 || !llm) return { facets, ...stats }

  await mapLimited(sessions, concurrency, async (session) => {
    if (signal?.aborted) return
    const transcript = transcriptOf(session)
    const hash = hashOf(transcript)
    const cacheFile = path.join(cacheDir, 'facets', `${session.id}.json`)
    const cached = refresh ? null : readCache(cacheFile)
    if (cached && cached.hash === hash && cached.model === model.model && cached.facet) {
      facets.set(session.id, cached.facet)
      stats.cached += 1
      onProgress?.({ done: stats.analyzed + stats.cached + stats.failed, total: sessions.length })
      return
    }

    try {
      const { parsed, usages } = await completeJson(llm, model, {
        system: FACET_SYSTEM,
        prompt: `${FACET_SCHEMA}\n\n--- 会话记录 ---\n${transcript}`,
        maxTokens: 4000,
        temperature: 0.2,
        signal,
      })
      for (const usage of usages) {
        stats.usage.input += usage.inputTokens ?? 0
        stats.usage.output += usage.outputTokens ?? 0
      }
      const facet = normalizeFacet(parsed)
      if (facet) {
        facets.set(session.id, facet)
        writeCache(cacheFile, { hash, model: model.model, facet })
        stats.analyzed += 1
      } else {
        stats.failed += 1
        if (errors.length < 6) errors.push(`会话 ${session.id.slice(0, 14)} 的摘要没有返回合法 JSON`)
      }
    } catch (error) {
      stats.failed += 1
      if (errors.length < 6) errors.push(`会话 ${session.id.slice(0, 14)}：${error?.message ?? error}`)
    }
    onProgress?.({ done: stats.analyzed + stats.cached + stats.failed, total: sessions.length })
  })

  return { facets, ...stats }
}

const SUMMARY_SCHEMA = `只输出一个 JSON 对象：
{
  "headline": "不超过 30 字的总体判断，要具体",
  "working": ["3 条，每条不超过 40 字，必须包含具体数字或事实"],
  "hindering": ["3 条，每条不超过 40 字，指出真实的阻塞或低效"],
  "quickWins": ["3 条，每条不超过 40 字，本周就能落地的改进"],
  "opportunities": ["2 条，每条不超过 45 字，结构性的工作方式改进"],
  "agentRules": [
    {"category": "测试|代码风格|流程|工具|沟通", "rule": "可以直接写进 AGENTS.md 的一句话规则，不超过 60 字", "why": "不超过 30 字，引用数据"}
  ]
}
agentRules 6 到 8 条，只针对数据里反复出现的模式，不要写通用最佳实践；全部用中文。`

const SYNTHESIS_VERSION = 'v2'

/** Cross-session synthesis, cached by the exact input it summarizes. */
export async function synthesizeReport({ llm, model, input, cacheDir, signal, refresh = false, errors = [] }) {
  const hash = hashOf(`${SYNTHESIS_VERSION}\n${model?.model ?? 'unknown'}\n${input}`)
  const cacheFile = path.join(cacheDir, 'synthesis.json')
  const cached = refresh ? null : readCache(cacheFile)
  if (cached && cached.hash === hash && cached.value) {
    return { value: cached.value, cached: true, usage: null }
  }
  if (!llm) return { value: null, cached: false, usage: null }

  try {
    const { parsed, usages } = await completeJson(llm, model, {
      system: SUMMARY_SYSTEM,
      prompt: `下面是这位开发者最近一段时间的 DSH 使用数据。请据此写一份坦诚、具体、可执行的复盘。\n\n${input}\n\n${SUMMARY_SCHEMA}`,
      maxTokens: 9000,
      temperature: 0.3,
      signal,
    })
    const usage = usages.length
      ? {
          inputTokens: usages.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
          outputTokens: usages.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
        }
      : null
    if (!parsed) {
      if (errors.length < 6) errors.push('跨会话总结没有返回合法 JSON')
      return { value: null, cached: false, usage }
    }
    const normalized = {
      headline: clip(parsed.headline, 60),
      working: normalizeList(parsed.working, 4),
      hindering: normalizeList(parsed.hindering, 4),
      quickWins: normalizeList(parsed.quickWins, 4),
      opportunities: normalizeList(parsed.opportunities, 3),
      agentRules: Array.isArray(parsed.agentRules)
        ? parsed.agentRules
            .filter((rule) => rule && typeof rule.rule === 'string')
            .slice(0, 8)
            .map((rule) => ({
              category: clip(rule.category, 10) || '流程',
              rule: clip(rule.rule, 120),
              why: clip(rule.why, 80),
            }))
        : [],
    }
    writeCache(cacheFile, { hash, value: normalized })
    return { value: normalized, cached: false, usage }
  } catch (error) {
    if (errors.length < 6) errors.push(`跨会话总结：${error?.message ?? error}`)
    return { value: null, cached: false, usage: null }
  }
}

function normalizeList(value, max) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => clip(item, 120)).slice(0, max)
}
