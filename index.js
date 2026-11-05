/**
 * DSH Insights — a host plugin that reads the local session history and
 * produces an interactive report about how you work with the agent.
 *
 * Three entry points share one pipeline:
 *   /insights            human command
 *   insights_report      model-facing tool
 *   GET /insights        the rendered report in the browser
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectSessions } from './src/collect.js'
import { generateInsightData, writeRunSnapshot } from './src/insights.js'
import { renderReport } from './src/report.js'

const DEFAULTS = {
  days: 30,
  maxSessions: 60,
  concurrency: 3,
  useModel: true,
  reportDir: null,
}

export const name = 'dsh-insights'

/**
 * `commands` is created lazily by the harness (it appears with the first agent
 * context), so a plain `ctx.get('commands')` during a cold boot can miss it.
 * Declaring it here makes Cordis hold this plugin until the registry exists —
 * the same contract the built-in `/export` command uses.
 */
export const inject = ['tools', 'commands']

function resolveOptions(config) {
  const input = config && typeof config === 'object' ? config : {}
  const days = Number(input.days)
  const maxSessions = Number(input.maxSessions)
  const concurrency = Number(input.concurrency)
  const model = input.model && typeof input.model === 'object' ? input.model : null
  return {
    days: Number.isFinite(days) && days > 0 ? Math.min(365, Math.round(days)) : DEFAULTS.days,
    maxSessions:
      Number.isFinite(maxSessions) && maxSessions > 0 ? Math.min(400, Math.round(maxSessions)) : DEFAULTS.maxSessions,
    concurrency:
      Number.isFinite(concurrency) && concurrency > 0 ? Math.min(8, Math.round(concurrency)) : DEFAULTS.concurrency,
    useModel: input.useModel !== false,
    reportDir: typeof input.reportDir === 'string' && input.reportDir ? input.reportDir : DEFAULTS.reportDir,
    model:
      model && typeof model.provider === 'string' && typeof model.model === 'string'
        ? { provider: model.provider, model: model.model }
        : null,
  }
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv) return fromEnv
  try {
    return path.join(os.homedir(), '.dsh')
  } catch {
    return '.dsh'
  }
}

function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function resolveModel(ctx, options) {
  if (options.model) return options.model
  try {
    const service = ctx.get('agentDefaultModel')
    const selection = service?.currentSelection?.()
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // fall through: model enrichment is optional
  }
  return null
}

function parseCommandInput(raw) {
  const parsed = {}
  const tokens = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--no-llm' || token === '--no-model') parsed.useModel = false
    else if (token === '--refresh') parsed.refresh = true
    else if (token === '--project') parsed.project = tokens[(index += 1)]
    else if (/^\d{1,3}$/.test(token)) parsed.days = Number(token)
  }
  return parsed
}

function formatCommandText(data, url, filePath) {
  const top = data.frictions.slice(0, 3).map((item) => `${item.label}（${item.sessions} 个会话）`)
  const lines = [
    `已生成洞察报告：${data.sessions.length} 个会话 / 最近 ${data.range.days} 天。`,
    data.summary.headline ? `结论：${data.summary.headline}` : null,
    top.length ? `最值得修的：${top.join('、')}` : null,
    url ? `在浏览器打开：${url}` : null,
    `报告文件：${filePath}`,
    data.llm.used
      ? `模型分析：新增 ${data.llm.analyzed} 个、缓存 ${data.llm.cached} 个${data.llm.failed ? `、失败 ${data.llm.failed} 个` : ''}。`
      : '本次为规则模式（未调用模型）。',
  ].filter(Boolean)
  return lines.join('\n')
}

function toolText(value) {
  const lines = [
    `洞察报告已生成：${value.sessions} 个会话 / 最近 ${value.days} 天。`,
    value.headline ? `结论：${value.headline}` : null,
    value.frictions?.length ? `主要摩擦：${value.frictions.join('、')}` : null,
    value.url ? `打开：${value.url}` : null,
    `文件：${value.reportPath}`,
    value.llm
      ? `模型：新增 ${value.llm.analyzed}，缓存 ${value.llm.cached}${value.llm.failed ? `，失败 ${value.llm.failed}` : ''}`
      : '规则模式（未调用模型）。',
  ]
  return lines.filter(Boolean).join('\n')
}

export function apply(ctx, config) {
  const options = resolveOptions(config)
  const home = dshHome()
  const reportDir = options.reportDir ?? path.join(home, 'usage-data')
  const reportFile = path.join(reportDir, 'report.html')

  let queue = Promise.resolve()
  let latest = null

  function enqueue(task) {
    const result = queue.then(task, task)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function execute(request = {}) {
    const startedAt = Date.now()
    const days = Number.isFinite(request.days) && request.days > 0 ? Math.min(365, Math.round(request.days)) : options.days
    const useModel = request.useModel === false ? false : options.useModel
    const collected = collectSessions({
      dshHome: home,
      days,
      maxSessions: options.maxSessions,
      project: request.project,
    })

    const model = resolveModel(ctx, options)
    const llm = useModel && model ? ctx.get('llm') : undefined

    const data = await generateInsightData({
      sessions: collected.sessions,
      skipped: collected.skipped,
      window: collected.window,
      timezone: timezone(),
      days,
      llm,
      model,
      cacheDir: reportDir,
      reportDir,
      concurrency: options.concurrency,
      refresh: request.refresh === true,
      project: request.project ?? null,
      signal: request.signal,
      onProgress: request.onProgress,
    })

    const html = renderReport(data)
    await fs.promises.mkdir(reportDir, { recursive: true })
    const temporary = `${reportFile}.${process.pid}.tmp`
    await fs.promises.writeFile(temporary, html, 'utf8')
    await fs.promises.rename(temporary, reportFile)
    if (data.sessions.length > 0) writeRunSnapshot(reportDir, data)

    latest = { html, data, at: Date.now() }
    return { data, html, filePath: reportFile, elapsedMs: Date.now() - startedAt }
  }

  function reportUrl() {
    try {
      const server = ctx.get('webServer')
      const origin = server?.getOrigin?.()
      return origin ? `${origin.replace(/\/$/, '')}/insights` : undefined
    } catch {
      return undefined
    }
  }

  const tool = {
    name: 'insights_report',
    description:
      'Analyze the local DSH session history (recent N days) and generate an interactive HTML report about how the user collaborates with the agent: activity, tool usage, friction points, repeated instructions and AGENTS.md suggestions. Use when the user asks for an insights report, a review of their coding habits or sessions, or wants concrete AGENTS.md rules. The report is written under the DSH home usage-data directory and its path and URL are returned.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'Analysis window in days. Defaults to the plugin configuration (30).',
        },
        project: {
          type: 'string',
          description: 'Only include sessions whose project name, cwd or title contains this text.',
        },
        use_model: {
          type: 'boolean',
          description:
            'Call the configured model to summarize each transcript. Set false for a fast, deterministic report.',
        },
        refresh: {
          type: 'boolean',
          description: 'Ignore cached per-session analyses and re-analyze every session.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          reportPath: { type: 'string' },
          url: { type: 'string' },
          sessions: { type: 'integer' },
          days: { type: 'integer' },
          headline: { type: 'string' },
          frictions: { type: 'array', items: { type: 'string' } },
          elapsedMs: { type: 'integer' },
          llm: {
            type: 'object',
            properties: {
              analyzed: { type: 'integer' },
              cached: { type: 'integer' },
              failed: { type: 'integer' },
            },
            additionalProperties: false,
          },
        },
        required: ['reportPath', 'sessions', 'days', 'elapsedMs'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: toolText(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const result = await enqueue(() =>
        execute({
          days: input.days,
          project: input.project,
          useModel: input.use_model,
          refresh: input.refresh === true,
        }),
      )
      return {
        reportPath: result.filePath,
        url: reportUrl() ?? '',
        sessions: result.data.sessions.length,
        days: result.data.range.days,
        headline: result.data.summary.headline ?? '',
        frictions: result.data.frictions.slice(0, 3).map((item) => `${item.label}（${item.sessions}）`),
        elapsedMs: result.elapsedMs,
        llm: {
          analyzed: result.data.llm.analyzed,
          cached: result.data.llm.cached,
          failed: result.data.llm.failed,
        },
      }
    },
  }

  const tools = ctx.get('tools')
  if (tools) ctx.effect(() => tools.register(tool))

  // A profile plugin cannot be introspected from outside, so the activation
  // outcome is recorded next to the report for troubleshooting.
  const commands = ctx.commands ?? ctx.get('commands')
  const status = {
    activatedAt: new Date().toISOString(),
    tools: Boolean(tools),
    commands: Boolean(commands),
    webServer: Boolean(ctx.get('webServer')),
    commandRegistered: false,
    commandError: null,
  }
  const statusFile = path.join(reportDir, 'plugin-status.json')
  const flushStatus = () => {
    try {
      fs.mkdirSync(reportDir, { recursive: true })
      fs.writeFileSync(statusFile, JSON.stringify(status, null, 2))
    } catch {
      // diagnostics are best effort
    }
  }

  const commandDefinition = {
    definitionId: 'dsh-insights/insights',
    name: 'insights',
    description: '分析最近的 DSH 会话，生成工作习惯洞察报告（活动、工具、摩擦点、AGENTS.md 建议）',
    input: { hint: '[天数] [--project 名称] [--no-llm] [--refresh]' },
    handler: async ({ rawInput, signal }) => {
      try {
        const parsed = parseCommandInput(rawInput)
        const result = await enqueue(() => execute({ ...parsed, signal }))
        return {
          kind: 'success',
          text: formatCommandText(result.data, reportUrl(), result.filePath),
        }
      } catch (error) {
        return { kind: 'error', text: `洞察报告生成失败：${error?.message ?? error}` }
      }
    },
  }

  if (commands) {
    ctx.effect(() => {
      try {
        const dispose = commands.register(commandDefinition)
        status.commandRegistered = true
        flushStatus()
        return dispose
      } catch (error) {
        status.commandError = String(error?.message ?? error)
        flushStatus()
        return undefined
      }
    })
  }
  flushStatus()

  const registerRoute = (server) =>
    ctx.effect(() =>
      server.register({
        kind: 'prefix',
        path: '/insights',
        handler: async (req, res) => {
          const pathname = (req.url ?? '/').split('?')[0]
          if (pathname !== '/insights' && pathname !== '/insights/' && pathname !== '/insights/index.html') {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          let html = latest?.html
          if (!html) {
            try {
              html = await fs.promises.readFile(reportFile, 'utf8')
            } catch {
              html = null
            }
          }
          if (!html) {
            res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
            res.end(
              '<!doctype html><meta charset="utf-8"><title>DSH Insights</title><body style="font-family:system-ui;background:#0b0e16;color:#e9edf6;padding:48px"><h1>还没有报告</h1><p>先在会话里运行 <code>/insights</code>，或让智能体调用 <code>insights_report</code> 工具。</p></body>',
            )
            return
          }
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(html)
        },
      }),
    )

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoute(webServer)
  } else if (typeof ctx.inject === 'function') {
    // The HTTP carrier can also appear after this plugin on a cold boot.
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer ?? scoped.get?.('webServer')
      if (server) registerRoute(server)
    })
  }
}
