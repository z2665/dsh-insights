/**
 * Self-contained interactive HTML report.
 *
 * No external assets: a single file that works from disk, from the DSH web
 * route, and when printed to PDF. Charts are inline SVG or CSS bars; the only
 * runtime script re-buckets activity by timezone and wires the small controls.
 */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

const num = (value) => new Intl.NumberFormat('zh-CN').format(Math.round(Number(value) || 0))

function duration(ms) {
  const total = Math.round(Number(ms) / 60000)
  if (!total) return '0 分'
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours >= 100) return `${Math.round(total / 60)} 小时`
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
}

function tokens(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function pct(value) {
  return `${Math.round(Number(value) * 10) / 10}%`
}

const PALETTE = ['#8b9dff', '#5eead4', '#f5c451', '#fb7185', '#a78bfa', '#4ade80', '#38bdf8', '#f472b6']

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 11-13h-7l1-7Z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15 9-2.5 5.5L7 17l2.5-5.5Z"/>',
}

function icon(name, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
}

function deltaChip(value, unit = '') {
  if (!value) return '<span class="delta flat">持平</span>'
  const sign = value > 0 ? '+' : ''
  return `<span class="delta ${value > 0 ? 'up' : 'down'}">${sign}${num(value)}${unit}</span>`
}

function donut(items, total, caption) {
  const size = 168
  const radius = 58
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const segments = items
    .map((item, index) => {
      const fraction = total ? item.count / total : 0
      const dash = fraction * circumference
      const segment = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="16" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`
      offset += dash
      return segment
    })
    .join('')
  return `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(caption)}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="var(--line)" stroke-width="16"/>
      ${segments}
      <text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" class="donut-value">${num(total)}</text>
      <text x="${size / 2}" y="${size / 2 + 18}" text-anchor="middle" class="donut-label">${esc(caption)}</text>
    </svg>
    <ul class="legend">
      ${items
        .map(
          (item, index) => `<li><i style="background:${PALETTE[index % PALETTE.length]}"></i><span>${esc(item.name)}</span><b>${num(item.count)}</b></li>`,
        )
        .join('')}
    </ul>
  </div>`
}

function barList(items, { valueKey = 'count', unit = '', empty = '暂无数据' } = {}) {
  if (!items.length) return `<p class="empty">${esc(empty)}</p>`
  const max = Math.max(...items.map((item) => item[valueKey]), 1)
  return `<ul class="bars">${items
    .map(
      (item, index) => `<li>
        <span class="bar-label" title="${esc(item.name)}">${esc(item.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (item[valueKey] / max) * 100).toFixed(1)}%;background:${PALETTE[index % PALETTE.length]}"></span></span>
        <span class="bar-value">${num(item[valueKey])}${unit}${item.error ? `<span class="err" title="${item.error} 次失败">${item.error}</span>` : ''}</span>
      </li>`,
    )
    .join('')}</ul>`
}

function summaryCard(kind, title, items, iconName) {
  return `<article class="card summary-card ${kind}">
    <header><span class="card-icon">${icon(iconName)}</span><h3>${esc(title)}</h3></header>
    <ul>${items.map((item) => `<li>${esc(item)}</li>`).join('') || '<li class="muted">数据不足</li>'}</ul>
  </article>`
}

function frictionCard(friction) {
  const examples = friction.examples
    .map(
      (example) => `<figure class="evidence">
        <blockquote>${esc(example.quote || example.detail)}</blockquote>
        <figcaption>${esc(example.title || example.session)}</figcaption>
      </figure>`,
    )
    .join('')
  return `<article class="card friction" data-severity="${esc(friction.severity)}">
    <header>
      <span class="dot" data-severity="${esc(friction.severity)}"></span>
      <h3>${esc(friction.label)}</h3>
      <span class="pill">${friction.sessions} 个会话 · ${friction.share}%</span>
    </header>
    <p class="muted">累计出现 ${num(friction.count)} 次，涉及 ${friction.sessions} 个会话。</p>
    ${examples}
  </article>`
}

function rulesMarkdown(rules) {
  const groups = new Map()
  for (const rule of rules) {
    const list = groups.get(rule.category) ?? []
    list.push(rule)
    groups.set(rule.category, list)
  }
  const lines = ['# 来自 DSH 洞察的建议', '']
  for (const [category, list] of groups) {
    lines.push(`## ${category}`)
    for (const rule of list) lines.push(`- ${rule.rule}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}

function rulesSection(rules) {
  if (!rules.length) return '<p class="empty">这次没有足够证据生成规则。</p>'
  const markdown = rulesMarkdown(rules)
  return `<div class="card rules">
    <div class="rules-head">
      <p class="muted">把这些规则粘贴到项目根目录的 <code>AGENTS.md</code> 里，下次会话就会自动生效。</p>
      <button class="btn copy" data-copy="${esc(markdown)}">复制全部</button>
    </div>
    ${rules
      .map(
        (rule) => `<div class="rule">
          <span class="tag">${esc(rule.category)}</span>
          <p>${esc(rule.rule)}</p>
          <small>${esc(rule.why)}</small>
          <button class="copy-mini" data-copy="${esc(`- ${rule.rule}`)}" title="复制这条">复制</button>
        </div>`,
      )
      .join('')}
  </div>`
}

function featureCards(features) {
  if (!features.length) return ''
  return `<div class="grid features">${features
    .map(
      (feature, index) => `<article class="card feature">
        <span class="feature-index">0${index + 1}</span>
        <h3>${esc(feature.title)}</h3>
        <p>${esc(feature.body)}</p>
        <p class="evidence-line">${esc(feature.evidence)}</p>
        <p class="action"><span>试试</span>${esc(feature.action)}</p>
      </article>`,
    )
    .join('')}</div>`
}

function sessionTable(sessions) {
  if (!sessions.length) return '<p class="empty">这个窗口里没有可分析的会话。</p>'
  return `<div class="card table-card">
    <div class="table-tools">
      <input id="session-filter" type="search" placeholder="筛选会话 / 项目…" aria-label="筛选会话">
      <span class="muted" id="session-count">${sessions.length} 个会话</span>
    </div>
    <div class="table-scroll">
      <table id="sessions">
        <thead><tr>
          <th data-sort="createdAt">日期</th>
          <th>会话</th>
          <th>项目</th>
          <th data-sort="durationMs" class="right">时长</th>
          <th data-sort="messages" class="right">消息</th>
          <th data-sort="tools" class="right">工具</th>
          <th>目标</th>
          <th>满意度</th>
        </tr></thead>
        <tbody>
        ${sessions
          .map(
            (session) => `<tr data-created="${session.createdAt}" data-duration="${session.durationMs}" data-messages="${
              session.messages
            }" data-tools="${session.tools}" data-search="${esc(
              `${session.title} ${session.project} ${session.goal} ${session.type}`.toLowerCase(),
            )}">
            <td class="mono">${esc(session.date)}</td>
            <td class="session-title"><span title="${esc(session.summary || session.title)}">${esc(session.title)}</span>${
              session.frictions.length ? `<i class="mini-warn" title="${esc(session.frictions.join('、'))}">!</i>` : ''
            }</td>
            <td>${esc(session.project)}</td>
            <td class="right mono">${duration(session.durationMs)}</td>
            <td class="right mono">${num(session.messages)}</td>
            <td class="right mono">${num(session.tools)}${session.errors ? `<span class="err">${session.errors}</span>` : ''}</td>
            <td><span class="tag">${esc(session.goal)}</span></td>
            <td>${session.satisfaction ? `<span class="satisfaction" data-v="${session.satisfaction}">${'●'.repeat(session.satisfaction)}<i>${'○'.repeat(5 - session.satisfaction)}</i></span>` : '<span class="muted">—</span>'}</td>
          </tr>`,
          )
          .join('')}
        </tbody>
      </table>
    </div>
  </div>`
}

function kpiCard(label, value, hint, delta) {
  const plain = String(value).replace(/<[^>]+>/g, '')
  return `<div class="kpi">
    <span class="kpi-label">${esc(label)}</span>
    <strong class="kpi-value${plain.length > 7 ? ' long' : ''}">${value}</strong>
    <span class="kpi-hint">${hint}${delta ?? ''}</span>
  </div>`
}

function durationShort(ms) {
  const total = Math.round(Number(ms) / 60000)
  if (!total) return '0m'
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return hours ? `${hours}h${minutes}m` : `${minutes}m`
}

export function renderReport(data) {
  const stats = data.stats
  const dateLabel = (ms) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(ms),
    )
  const rangeFrom = dateLabel(data.range.from)
  const rangeTo = dateLabel(data.range.to)
  const isEmpty = data.sessions.length === 0
  const generated = new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false })
  const llmLabel = data.llm.used
    ? `模型 · ${esc(data.llm.model ?? '默认')}（新分析 ${data.llm.analyzed}，缓存 ${data.llm.cached}${data.llm.failed ? `，失败 ${data.llm.failed}` : ''}）`
    : data.llm.cached
      ? `缓存模式 · 复用 ${data.llm.cached} 个会话的历史分析（本次未调用模型）`
      : '规则模式 · 未调用模型'

  const deltas = isEmpty ? null : data.deltas ?? null
  const kpis = [
    kpiCard('会话', num(stats.sessions), `最近 ${data.range.days} 天`, deltas ? deltaChip(deltas.sessions) : ''),
    kpiCard('用户消息', num(stats.humanMessages), `平均 ${(stats.humanMessages / Math.max(1, stats.sessions)).toFixed(1)} 条/会话`, deltas ? deltaChip(deltas.humanMessages) : ''),
    kpiCard('累计时长', durationShort(stats.durationMs), `平均 ${duration(stats.avgSessionMs)}/会话`, ''),
    kpiCard('工具调用', num(stats.toolCalls), `失败率 ${pct(stats.errorRate)}`, deltas ? deltaChip(deltas.toolErrors, ' 失败') : ''),
    kpiCard('改动文件', num(stats.files), `${num(stats.edits)} 次编辑`, ''),
    kpiCard('活跃天数', num(stats.activeDays), `当前连续 ${stats.streak} 天`, deltas ? deltaChip(deltas.activeDays, ' 天') : ''),
    kpiCard('Token', `${tokens(stats.tokens.input)} / ${tokens(stats.tokens.output)}`, '输入 / 输出', ''),
  ].join('')

  const overview = [
    summaryCard('good', '什么在起作用', data.summary.working, 'check'),
    summaryCard('bad', '什么在拖后腿', data.summary.hindering, 'alert'),
    summaryCard('quick', '快赢', data.summary.quickWins, 'bolt'),
    summaryCard('big', '更大的机会', data.summary.opportunities, 'compass'),
  ].join('')

  const toolsWithErrors = stats.tools.slice(0, 8).map((tool) => ({
    name: tool.name,
    count: tool.calls,
    error: tool.errors,
  }))

  const languages = stats.languages.slice(0, 8)
  const goalsTotal = stats.goals.reduce((sum, item) => sum + item.count, 0)
  const satisfaction = stats.satisfaction

  const frictions = data.frictions.length
    ? data.frictions.map(frictionCard).join('')
    : '<p class="empty">没有识别到明显的摩擦点。</p>'

  const repeated = data.repeated.length
    ? `<div class="card"><h3 class="mini-title">反复出现的指令</h3><ul class="repeat-list">${data.repeated
        .map(
          (item) => `<li><span>${esc(item.text)}</span><b>${item.sessions} 个会话</b><button class="copy-mini" data-copy="${esc(item.text)}">复制</button></li>`,
        )
        .join('')}</ul></div>`
    : ''

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 洞察 · 最近 ${data.range.days} 天</title>
<style>
:root {
  color-scheme: dark;
  --bg: #07090f;
  --bg-soft: #0b0e16;
  --panel: #10131c;
  --panel-hi: #151a26;
  --line: rgba(255,255,255,.075);
  --line-strong: rgba(255,255,255,.16);
  --ink: #e9edf6;
  --ink-2: #aab3c8;
  --ink-3: #6d7690;
  --violet: #8b9dff;
  --cyan: #5eead4;
  --amber: #f5c451;
  --rose: #fb7185;
  --green: #4ade80;
  --shadow: 0 24px 60px -32px rgba(0,0,0,.9);
}
html[data-theme="light"] {
  color-scheme: light;
  --bg: #f6f7fb;
  --bg-soft: #eef0f7;
  --panel: #ffffff;
  --panel-hi: #f8f9fd;
  --line: rgba(17,24,39,.09);
  --line-strong: rgba(17,24,39,.18);
  --ink: #10131c;
  --ink-2: #4a5265;
  --ink-3: #8b93a5;
  --shadow: 0 24px 60px -40px rgba(23,29,48,.45);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: "";
  position: fixed;
  inset: -20% -10% auto -10%;
  height: 70vh;
  background:
    radial-gradient(42% 55% at 18% 20%, rgba(139,157,255,.20), transparent 70%),
    radial-gradient(38% 50% at 82% 8%, rgba(94,234,212,.13), transparent 70%);
  filter: blur(10px);
  pointer-events: none;
  z-index: 0;
}
html[data-theme="light"] body::before { opacity: .55; }
.mono { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
.muted { color: var(--ink-3); }
.right { text-align: right; }
.icon { width: 18px; height: 18px; }

.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px clamp(20px, 4vw, 48px);
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -.01em; }
.brand .mark {
  display: grid; place-items: center;
  width: 26px; height: 26px; border-radius: 8px;
  background: linear-gradient(140deg, var(--violet), var(--cyan));
  color: #07090f; font-size: 15px; font-weight: 800;
}
.brand .sub { color: var(--ink-3); font-weight: 400; font-size: 12px; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
.controls { display: flex; align-items: center; gap: 8px; }
.controls select, .controls button {
  appearance: none; border: 1px solid var(--line); background: var(--panel);
  color: var(--ink-2); border-radius: 9px; padding: 7px 11px; font-size: 12px;
  font-family: inherit; cursor: pointer; transition: .15s ease;
}
.controls select:hover, .controls button:hover { border-color: var(--line-strong); color: var(--ink); }

main { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: 44px clamp(20px, 4vw, 48px) 80px; }

.hero { padding: 18px 0 34px; border-bottom: 1px solid var(--line); }
.eyebrow {
  margin: 0 0 14px; font-size: 11px; letter-spacing: .16em; text-transform: uppercase;
  color: var(--ink-3); font-weight: 600;
}
h1 {
  margin: 0 0 14px; font-size: clamp(30px, 4.4vw, 46px); line-height: 1.12; letter-spacing: -.03em;
  font-weight: 680;
  background: linear-gradient(100deg, var(--ink) 40%, var(--violet) 78%, var(--cyan));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.lede { margin: 0; max-width: 720px; color: var(--ink-2); font-size: 15px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 18px; color: var(--ink-3); font-size: 12px; }
.meta span { display: inline-flex; align-items: center; gap: 6px; }
.meta .warn { color: var(--amber); }

.kpis {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1px; margin: 34px 0 8px; background: var(--line); border: 1px solid var(--line);
  border-radius: 16px; overflow: hidden;
}
.kpi { background: var(--panel); padding: 16px 18px 15px; display: flex; flex-direction: column; gap: 4px; }
.kpi-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
.kpi-value { font-size: 24px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kpi-value.long { font-size: 19px; letter-spacing: -.01em; }
.kpi-hint { font-size: 11.5px; color: var(--ink-3); display: flex; gap: 8px; flex-wrap: wrap; }
.delta { font-variant-numeric: tabular-nums; font-weight: 600; }
.delta.up { color: var(--green); }
.delta.down { color: var(--rose); }
.delta.flat { color: var(--ink-3); }

nav.tabs {
  position: sticky; top: 57px; z-index: 30; display: flex; gap: 4px; overflow-x: auto;
  padding: 12px 0; margin-bottom: 18px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--line);
  scrollbar-width: none;
}
nav.tabs a {
  flex: 0 0 auto; color: var(--ink-3); text-decoration: none; font-size: 12.5px; font-weight: 500;
  padding: 5px 10px; border-radius: 8px; transition: .15s ease;
}
nav.tabs a:hover { color: var(--ink); background: var(--panel); }
nav.tabs a.active { color: var(--ink); background: var(--panel-hi); box-shadow: inset 0 0 0 1px var(--line); }

section { padding: 34px 0 6px; scroll-margin-top: 110px; }
.section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; }
.section-head .num { font-size: 11px; color: var(--ink-3); font-family: ui-monospace, Consolas, monospace; letter-spacing: .08em; }
.section-head h2 { margin: 0; font-size: 20px; letter-spacing: -.02em; font-weight: 640; }
.section-head p { margin: 0; color: var(--ink-3); font-size: 12.5px; }

.card {
  background: linear-gradient(180deg, color-mix(in srgb, var(--panel-hi) 55%, transparent), transparent), var(--panel);
  border: 1px solid var(--line); border-radius: 16px; padding: 20px;
  box-shadow: var(--shadow);
}
.grid { display: grid; gap: 14px; }
.grid.four { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); align-items: start; }
.summary-card header { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
.summary-card h3 { margin: 0; font-size: 14px; letter-spacing: -.01em; }
.card-icon { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; }
.summary-card.good .card-icon { background: rgba(74,222,128,.13); color: var(--green); }
.summary-card.bad .card-icon { background: rgba(251,113,133,.13); color: var(--rose); }
.summary-card.quick .card-icon { background: rgba(94,234,212,.13); color: var(--cyan); }
.summary-card.big .card-icon { background: rgba(139,157,255,.15); color: var(--violet); }
.summary-card ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
.summary-card li { position: relative; padding-left: 15px; color: var(--ink-2); font-size: 13px; line-height: 1.55; }
.summary-card li::before { content: ""; position: absolute; left: 0; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--line-strong); }
.summary-card.good li::before { background: var(--green); }
.summary-card.bad li::before { background: var(--rose); }
.summary-card.quick li::before { background: var(--cyan); }
.summary-card.big li::before { background: var(--violet); }

.chart-card { padding: 20px 20px 16px; }
.chart-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.chart-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.chart-head span { font-size: 12px; color: var(--ink-3); }

.heatmap { display: none; }
.calendar { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
.cal-dow { font-size: 10px; letter-spacing: .06em; color: var(--ink-3); text-align: center; padding-bottom: 2px; text-transform: uppercase; }
.cal-cell {
  position: relative; min-height: 48px; border-radius: 10px; padding: 5px 7px 4px;
  background: var(--panel-hi); box-shadow: inset 0 0 0 1px var(--line);
  display: flex; flex-direction: column; justify-content: space-between; transition: .15s;
}
.cal-cell:hover { box-shadow: inset 0 0 0 1px var(--line-strong); }
.cal-cell.blank { background: transparent; box-shadow: none; }
.cal-cell[data-level="1"] { background: color-mix(in srgb, var(--violet) 15%, var(--panel)); }
.cal-cell[data-level="2"] { background: color-mix(in srgb, var(--violet) 30%, var(--panel)); }
.cal-cell[data-level="3"] { background: color-mix(in srgb, var(--violet) 52%, var(--panel)); }
.cal-cell[data-level="4"] { background: color-mix(in srgb, var(--violet) 76%, var(--panel)); }
.cal-cell.today { box-shadow: inset 0 0 0 1.5px var(--cyan); }
.cal-day { font-size: 10px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.cal-count { font-size: 12.5px; font-weight: 600; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.cal-cell[data-level="3"] .cal-count, .cal-cell[data-level="4"] .cal-count { color: #f4f6ff; }
.cal-cell[data-level="3"] .cal-day, .cal-cell[data-level="4"] .cal-day { color: rgba(244,246,255,.72); }
.cal-cell.blank .cal-day, .cal-cell.blank .cal-count { display: none; }
.split { display: grid; grid-template-columns: 1.5fr 1fr; gap: 14px; }
.split .chart-card { display: flex; flex-direction: column; }
.split .hours { flex: 1; height: auto; min-height: 190px; }
@media (max-width: 860px) { .split { grid-template-columns: 1fr; } }

.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 11px; }
.bars li { display: grid; grid-template-columns: 108px 1fr 62px; align-items: center; gap: 10px; }
.bar-label { font-size: 12.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { height: 7px; border-radius: 99px; background: var(--panel-hi); overflow: hidden; }
.bar-fill { display: block; height: 100%; border-radius: 99px; opacity: .9; }
.bar-value { font-size: 12px; color: var(--ink-3); text-align: right; font-variant-numeric: tabular-nums; }

.day-bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-top: 6px; }
.day-bars .col { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 2px; min-width: 4px; height: 100%; position: relative; }
.day-bars .col i { display: block; background: var(--line); border-radius: 2px 2px 0 0; transition: .15s; }
.day-bars .col i.sessions { background: var(--cyan); opacity: .55; }
.day-bars .col i.messages { background: linear-gradient(180deg, var(--violet), color-mix(in srgb, var(--violet) 55%, transparent)); }
.day-bars .col:hover i { filter: brightness(1.25); }
.day-bars .col::after {
  content: attr(data-label); position: absolute; bottom: -20px; left: 50%; transform: translateX(-50%);
  font-size: 9px; color: var(--ink-3); white-space: nowrap; opacity: 0; transition: .15s;
}
.day-bars .col:hover::after { opacity: 1; }

.hours { display: flex; align-items: flex-end; gap: 4px; height: 208px; padding-bottom: 4px; }
.hours .h { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; position: relative; }
.hours .h i { background: var(--line-strong); border-radius: 3px 3px 0 0; display: block; }
.hours .h.peak i { background: linear-gradient(180deg, var(--cyan), color-mix(in srgb, var(--cyan) 40%, transparent)); }
.hours .h::after { content: attr(data-hour); position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%); font-size: 9px; color: var(--ink-3); }
.hours .h:nth-child(even)::after { content: ""; }

.donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.donut { width: 168px; height: 168px; flex: 0 0 auto; }
.donut-value { fill: var(--ink); font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
.donut-label { fill: var(--ink-3); font-size: 10px; }
.legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; min-width: 130px; }
.legend li { display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: block; }
.legend b { color: var(--ink-3); font-weight: 500; font-variant-numeric: tabular-nums; }

.distribution { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--line); background: var(--panel-hi); border-radius: 99px; padding: 5px 11px; font-size: 12px; color: var(--ink-2); }
.chip b { color: var(--ink); margin-left: 6px; font-variant-numeric: tabular-nums; }

.satisfaction { letter-spacing: 1px; color: var(--cyan); font-size: 11px; }
.satisfaction i { font-style: normal; color: var(--line-strong); }

.friction header { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 6px; }
.friction h3 { margin: 0; font-size: 14px; }
.friction .pill { margin-left: auto; font-size: 11px; color: var(--ink-3); border: 1px solid var(--line); border-radius: 99px; padding: 2px 9px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }
.dot[data-severity="high"] { background: var(--rose); box-shadow: 0 0 0 4px rgba(251,113,133,.12); }
.dot[data-severity="medium"] { background: var(--amber); box-shadow: 0 0 0 4px rgba(245,196,81,.10); }
.dot[data-severity="low"] { background: var(--ink-3); }
.evidence { margin: 10px 0 0; padding-left: 12px; border-left: 2px solid var(--line-strong); }
.evidence blockquote { margin: 0; color: var(--ink-2); font-size: 12.5px; }
.evidence figcaption { color: var(--ink-3); font-size: 11px; margin-top: 3px; }

.rules-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
.rules-head p { margin: 0; font-size: 12.5px; }
code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; background: var(--panel-hi); padding: 1px 5px; border-radius: 5px; font-size: 12px; border: 1px solid var(--line); }
.btn {
  border: 1px solid var(--line-strong); background: var(--panel-hi); color: var(--ink);
  padding: 7px 13px; border-radius: 9px; font-size: 12px; cursor: pointer; font-family: inherit; transition: .15s;
}
.btn:hover { background: var(--violet); color: #07090f; border-color: transparent; }
.rule {
  display: grid; grid-template-columns: auto 1fr auto; gap: 6px 12px; align-items: start;
  padding: 12px 0; border-top: 1px solid var(--line);
}
.rule p { margin: 0; font-size: 13.5px; color: var(--ink); line-height: 1.5; }
.rule small { grid-column: 2; color: var(--ink-3); font-size: 11.5px; }
.tag { font-size: 10.5px; letter-spacing: .04em; color: var(--ink-2); background: var(--panel-hi); border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; white-space: nowrap; }
.copy-mini {
  grid-column: 3; grid-row: 1; border: 1px solid var(--line); background: transparent; color: var(--ink-3);
  font-size: 11px; border-radius: 7px; padding: 2px 8px; cursor: pointer; font-family: inherit;
}
.copy-mini:hover { color: var(--ink); border-color: var(--line-strong); }

.features { display: flex; flex-wrap: wrap; }
.features .feature { flex: 1 1 300px; max-width: calc(50% - 7px); }
@media (max-width: 760px) { .features .feature { max-width: 100%; } }
.feature { position: relative; display: flex; flex-direction: column; gap: 8px; }
.feature-index { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--ink-3); }
.feature h3 { margin: 0; font-size: 15px; }
.feature p { margin: 0; color: var(--ink-2); font-size: 13px; }
.evidence-line { color: var(--ink-3) !important; font-size: 12px !important; font-variant-numeric: tabular-nums; }
.action { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--ink-2); }
.action span { color: var(--cyan); font-weight: 600; margin-right: 6px; }

.mini-title { margin: 0 0 12px; font-size: 14px; }
.repeat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.repeat-list li { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; font-size: 12.5px; color: var(--ink-2); }
.repeat-list b { color: var(--ink-3); font-weight: 500; font-size: 11.5px; }

.table-tools { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.table-tools input {
  flex: 1; max-width: 320px; background: var(--panel-hi); border: 1px solid var(--line);
  border-radius: 9px; padding: 8px 12px; color: var(--ink); font-family: inherit; font-size: 12.5px;
}
.table-tools input:focus { outline: none; border-color: var(--violet); }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 760px; }
thead th {
  position: sticky; top: 0; text-align: left; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--ink-3); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--line); background: var(--panel);
  cursor: default;
}
thead th[data-sort] { cursor: pointer; }
thead th[data-sort]:hover { color: var(--ink); }
tbody td { padding: 9px 10px; border-bottom: 1px solid var(--line); color: var(--ink-2); }
tbody tr:hover td { background: var(--panel-hi); }
.session-title { color: var(--ink); max-width: 320px; }
.session-title span { display: inline-block; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.mini-warn { font-style: normal; display: inline-grid; place-items: center; width: 15px; height: 15px; margin-left: 6px; border-radius: 50%; background: rgba(251,113,133,.16); color: var(--rose); font-size: 10px; font-weight: 700; }
.err { margin-left: 5px; color: var(--rose); font-size: 10.5px; background: rgba(251,113,133,.13); border-radius: 4px; padding: 0 4px; }
.empty { color: var(--ink-3); font-size: 13px; padding: 8px 0; }
.empty-state { margin-top: 18px; display: flex; flex-direction: column; gap: 6px; }
.empty-state strong { font-size: 14px; }
.empty-state p { margin: 0; font-size: 12.5px; }

footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--ink-3); font-size: 11.5px; display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.toast {
  position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 20px);
  background: var(--ink); color: var(--bg); padding: 8px 16px; border-radius: 99px;
  font-size: 12px; opacity: 0; pointer-events: none; transition: .2s; z-index: 60;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 720px) {
  nav.tabs { top: 53px; }
  .kpis { grid-template-columns: repeat(2, 1fr); }
  .grid.four, .grid.two { grid-template-columns: 1fr; }
  .bars li { grid-template-columns: 84px 1fr 50px; }
}
@media print {
  body { background: #fff; color: #111; }
  body::before, .topbar, nav.tabs, .table-tools, .copy, .copy-mini, .toast { display: none !important; }
  main { padding: 0; max-width: none; }
  .card { box-shadow: none; border-color: #ddd; break-inside: avoid; }
  section { break-inside: avoid; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand"><span class="mark">◈</span> DSH 洞察 <span class="sub">/insights</span></div>
  <div class="controls">
    <select id="tz" aria-label="时区"></select>
    <button id="theme" title="切换主题">明 / 暗</button>
    <button id="print" title="打印或导出 PDF">导出 PDF</button>
  </div>
</header>

<main>
  <section class="hero" style="padding-top:0;border:0">
    <p class="eyebrow">${esc(rangeFrom)} → ${esc(rangeTo)} · 最近 ${data.range.days} 天</p>
    <h1>你和 DSH 是怎么一起写代码的</h1>
    <p class="lede">${esc(data.summary.headline || `这段时间在 ${stats.projects} 个项目里开了 ${stats.sessions} 个会话、发出 ${stats.humanMessages} 条消息，累计 ${duration(stats.durationMs)}。报告只读取本机会话日志，不上传代码。`)}</p>
    <div class="meta">
      <span>生成于 ${esc(generated)}</span>
      <span>${esc(llmLabel)}</span>
      <span>时区 ${esc(data.timezone)}</span>
      ${data.llm.errors?.length ? `<span class="warn" title="${esc(data.llm.errors.join('；'))}">模型告警 ${data.llm.errors.length} 条</span>` : ''}
    </div>
  </section>

  <div class="kpis">${kpis}</div>
  ${isEmpty ? `<div class="card empty-state"><strong>这个窗口里没有可分析的会话</strong><p class="muted">尝试放宽天数（<code>/insights 30</code>）、去掉 <code>--project</code> 筛选，或先在这个项目里工作一会儿。</p></div>` : ''}

  <nav class="tabs" id="tabs">
    <a href="#overview">概览</a>
    <a href="#activity">活跃度</a>
    <a href="#tools">工具与语言</a>
    <a href="#composition">会话构成</a>
    <a href="#friction">摩擦点</a>
    <a href="#rules">AGENTS.md</a>
    <a href="#features">下一步</a>
    <a href="#detail">明细</a>
  </nav>

  <section id="overview">
    <div class="section-head"><span class="num">01</span><h2>一眼看完</h2><p>基于 ${stats.sessions} 个会话自动生成，不是通用建议。</p></div>
    <div class="grid four">${overview}</div>
  </section>

  <section id="activity">
    <div class="section-head"><span class="num">02</span><h2>活跃度</h2><p>按本地时区分桶，切换时区会即时重算。</p></div>
    <div class="split">
      <div class="card chart-card">
        <div class="chart-head"><h3>日历</h3><span id="activity-summary"></span></div>
        <div class="calendar" id="calendar" role="img" aria-label="按天活跃日历"></div>
      </div>
      <div class="card chart-card">
        <div class="chart-head"><h3>你在什么时候工作</h3><span id="peak-hour-label"></span></div>
        <div class="hours" id="hours"></div>
      </div>
    </div>
    <div class="card chart-card" style="margin-top:14px">
      <div class="chart-head"><h3>每天的用户消息</h3><span>柱高 = 消息数 · 悬停看会话数</span></div>
      <div class="day-bars" id="day-bars"></div>
    </div>
  </section>

  <section id="tools">
    <div class="section-head"><span class="num">03</span><h2>工具与语言</h2><p>工具调用决定了时间花在哪里，失败率决定了返工量。</p></div>
    <div class="grid two">
      <div class="card"><h3 class="mini-title">工具调用</h3>${barList(toolsWithErrors)}</div>
      <div class="card"><h3 class="mini-title">改动过的文件类型</h3>${barList(languages.map((item) => ({ name: item.name, count: item.files })))}</div>
    </div>
    ${repeated}
  </section>

  <section id="composition">
    <div class="section-head"><span class="num">04</span><h2>会话构成</h2><p>时间投在了哪类任务上，以及这些会话顺不顺利。</p></div>
    <div class="grid two">
      <div class="card"><h3 class="mini-title">任务目标</h3>${donut(stats.goals, goalsTotal, '会话')}</div>
      <div class="card">
        <h3 class="mini-title">会话类型</h3>
        <div class="distribution">${stats.types.map((item) => `<span class="chip">${esc(item.name)}<b>${item.count}</b></span>`).join('')}</div>
        ${
          satisfaction
            ? `<h3 class="mini-title" style="margin-top:20px">满意度</h3>
               <div class="distribution">${satisfaction.distribution
                 .map((item) => `<span class="chip">${item.score} 分<b>${item.count}</b></span>`)
                 .join('')}</div>
               <p class="muted" style="margin:10px 0 0;font-size:12px">平均 ${satisfaction.average} / 5，基于 ${satisfaction.samples} 个会话的模型判断。</p>`
            : '<p class="empty" style="margin-top:20px">启用模型分析后，这里会显示满意度分布。</p>'
        }
      </div>
    </div>
  </section>

  <section id="friction">
    <div class="section-head"><span class="num">05</span><h2>摩擦点</h2><p>最值得修的几件事，按影响的会话数排序。</p></div>
    <div class="grid two">${frictions}</div>
  </section>

  <section id="rules">
    <div class="section-head"><span class="num">06</span><h2>写进 AGENTS.md</h2><p>把每天重复的交代固化一次，之后每个会话都生效。</p></div>
    ${rulesSection(data.rules)}
  </section>

  <section id="features">
    <div class="section-head"><span class="num">07</span><h2>下一步</h2><p>针对你的实际用法，而不是功能清单。</p></div>
    ${featureCards(data.features)}
  </section>

  <section id="detail">
    <div class="section-head"><span class="num">08</span><h2>会话明细</h2><p>点击表头排序，输入关键词筛选。</p></div>
    ${sessionTable(data.sessions)}
  </section>

  <footer>
    <span>本地生成 · 数据来自 ~/.dsh/sessions · 不包含代码内容</span>
    <span>DSH Insights · ${data.sessions.length} 个会话 · 跳过 ${data.skipped.subagent} 个子代理 / ${data.skipped.empty} 个空会话</span>
  </footer>
</main>

<div class="toast" id="toast">已复制</div>

<script>
(function () {
  var DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  var tzSelect = document.getElementById('tz');
  var zones = ['Asia/Shanghai', 'UTC', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'];
  if (zones.indexOf(DATA.timezone) === -1) zones.unshift(DATA.timezone);
  zones.forEach(function (zone) {
    var option = document.createElement('option');
    option.value = zone;
    option.textContent = zone;
    if (zone === DATA.timezone) option.selected = true;
    tzSelect.appendChild(option);
  });

  function parts(ms, zone) {
    var formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
    var out = {};
    formatter.formatToParts(new Date(ms)).forEach(function (part) { out[part.type] = part.value; });
    out.hour = Number(out.hour) % 24;
    return out;
  }
  function key(ms, zone) { var p = parts(ms, zone); return p.year + '-' + p.month + '-' + p.day; }
  function eachDay(days, zone) {
    var list = [];
    var now = Date.now();
    for (var i = days - 1; i >= 0; i -= 1) list.push(key(now - i * 86400000, zone));
    return list;
  }
  function buckets(days, zone) {
    var map = {};
    var hours = new Array(24).fill(0);
    eachDay(days, zone).forEach(function (day) { map[day] = { messages: 0, sessions: 0 }; });
    DATA.stats.activity.messageTimes.forEach(function (time) {
      var p = parts(time, zone);
      var day = p.year + '-' + p.month + '-' + p.day;
      if (map[day]) map[day].messages += 1;
      hours[p.hour] += 1;
    });
    DATA.sessions.forEach(function (session) {
      var day = key(session.createdAt, zone);
      if (map[day]) map[day].sessions += 1;
    });
    return { map: map, hours: hours, days: eachDay(days, zone) };
  }
  function render(zone) {
    var data = buckets(DATA.range.days, zone);

    var cal = document.getElementById('calendar');
    cal.innerHTML = '';
    ['一', '二', '三', '四', '五', '六', '日'].forEach(function (name) {
      var head = document.createElement('div');
      head.className = 'cal-dow';
      head.textContent = name;
      cal.appendChild(head);
    });
    var first = new Date(data.days[0] + 'T12:00:00Z').getUTCDay();
    var pad = (first + 6) % 7;
    for (var p = 0; p < pad; p += 1) {
      var blank = document.createElement('div');
      blank.className = 'cal-cell blank';
      cal.appendChild(blank);
    }
    var max = Math.max(1, Math.max.apply(null, data.days.map(function (day) { return data.map[day].messages; })));
    var todayKey = key(Date.now(), zone);
    data.days.forEach(function (day) {
      var item = data.map[day];
      var cell = document.createElement('div');
      cell.className = 'cal-cell' + (day === todayKey ? ' today' : '');
      cell.dataset.level = String(item.messages === 0 ? 0 : Math.min(4, 1 + Math.floor((item.messages / max) * 3.2)));
      cell.title = day + ' · ' + item.messages + ' 条消息 · ' + item.sessions + ' 个会话';
      var dayLabel = document.createElement('span');
      dayLabel.className = 'cal-day';
      dayLabel.textContent = String(Number(day.slice(8)));
      var count = document.createElement('span');
      count.className = 'cal-count';
      count.textContent = item.messages ? String(item.messages) : '';
      cell.appendChild(dayLabel);
      cell.appendChild(count);
      cal.appendChild(cell);
    });

    var bars = document.getElementById('day-bars');
    bars.innerHTML = '';
    var maxMessages = Math.max(1, Math.max.apply(null, data.days.map(function (day) { return data.map[day].messages; })));
    data.days.forEach(function (day) {
      var item = data.map[day];
      var col = document.createElement('div');
      col.className = 'col';
      col.dataset.label = day.slice(5);
      col.title = day + ' · ' + item.messages + ' 条消息 · ' + item.sessions + ' 个会话';
      var messages = document.createElement('i');
      messages.className = 'messages';
      messages.style.height = (item.messages ? Math.max(3, (item.messages / maxMessages) * 100) : 0) + '%';
      col.appendChild(messages);
      bars.appendChild(col);
    });

    var hoursRoot = document.getElementById('hours');
    hoursRoot.innerHTML = '';
    var maxHour = Math.max.apply(null, data.hours.concat([0]));
    var peak = data.hours.indexOf(maxHour);
    var hourScale = maxHour || 1;
    data.hours.forEach(function (count, hour) {
      var wrap = document.createElement('div');
      wrap.className = 'h' + (hour === peak && count > 0 ? ' peak' : '');
      wrap.dataset.hour = hour + ':00';
      wrap.title = hour + ':00 — ' + count + ' 条消息';
      var bar = document.createElement('i');
      bar.style.height = (count ? Math.max(3, (count / hourScale) * 100) : 0) + '%';
      wrap.appendChild(bar);
      hoursRoot.appendChild(wrap);
    });

    var activeDays = data.days.filter(function (day) { return data.map[day].messages > 0 || data.map[day].sessions > 0; }).length;
    var totalMessages = data.days.reduce(function (sum, day) { return sum + data.map[day].messages; }, 0);
    var summary = document.getElementById('activity-summary');
    if (summary) summary.textContent = activeDays + ' 天活跃 · ' + totalMessages + ' 条消息';
    var peakLabel = document.getElementById('peak-hour-label');
    if (peakLabel) peakLabel.textContent = maxHour > 0 ? '高峰 ' + peak + ':00–' + ((peak + 1) % 24) + ':00' : '';
  }

  var currentZone = DATA.timezone;
  render(currentZone);
  tzSelect.addEventListener('change', function () { currentZone = tzSelect.value; render(currentZone); });

  var theme = document.getElementById('theme');
  var stored = null;
  try { stored = localStorage.getItem('dsh-insights-theme'); } catch (e) {}
  if (stored) document.documentElement.dataset.theme = stored;
  theme.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('dsh-insights-theme', next); } catch (e) {}
  });

  document.getElementById('print').addEventListener('click', function () { window.print(); });

  var toast = document.getElementById('toast');
  function notify(text) {
    toast.textContent = text || '已复制';
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 1400);
  }
  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-copy]');
    if (!target) return;
    var text = target.getAttribute('data-copy');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { notify(); }, function () { notify('复制失败'); });
    else notify('请手动选择复制');
  });

  var filter = document.getElementById('session-filter');
  if (filter) {
    filter.addEventListener('input', function () {
      var query = filter.value.trim().toLowerCase();
      var rows = document.querySelectorAll('#sessions tbody tr');
      var shown = 0;
      rows.forEach(function (row) {
        var match = !query || row.dataset.search.indexOf(query) !== -1;
        row.style.display = match ? '' : 'none';
        if (match) shown += 1;
      });
      document.getElementById('session-count').textContent = shown + ' 个会话';
    });
  }

  var sortState = { key: null, direction: 1 };
  var sortFields = { createdAt: 'created', durationMs: 'duration', messages: 'messages', tools: 'tools' };
  document.querySelectorAll('#sessions thead th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      var field = sortFields[key];
      sortState.direction = sortState.key === key ? -sortState.direction : -1;
      sortState.key = key;
      var rows = Array.prototype.slice.call(document.querySelectorAll('#sessions tbody tr'));
      rows.sort(function (a, b) {
        return (Number(a.dataset[field]) - Number(b.dataset[field])) * sortState.direction;
      });
      var body = document.querySelector('#sessions tbody');
      rows.forEach(function (row) { body.appendChild(row); });
    });
  });

  var links = Array.prototype.slice.call(document.querySelectorAll('#tabs a'));
  var sections = links.map(function (link) { return document.querySelector(link.getAttribute('href')); });
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      links.forEach(function (link) { link.classList.remove('active'); });
      var index = sections.indexOf(entry.target);
      if (index >= 0) links[index].classList.add('active');
    });
  }, { rootMargin: '-30% 0px -65% 0px' });
  sections.forEach(function (section) { if (section) observer.observe(section); });
})();
</script>
</body>
</html>`
}
