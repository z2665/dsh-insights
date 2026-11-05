/**
 * Self-contained interactive HTML report.
 *
 * Design system: data-dense editorial console (blue data palette, Fira Sans /
 * Fira Code stacks, hairline rules, tabular numerals). No external assets: the
 * avatar is embedded, charts are inline SVG or CSS, and the only runtime script
 * re-buckets activity by timezone and wires the small controls.
 */
import fs from 'node:fs'

const AVATAR = (() => {
  try {
    return `data:image/webp;base64,${fs.readFileSync(new URL('../assets/avatar.webp', import.meta.url)).toString('base64')}`
  } catch {
    return ''
  }
})()

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '1.0.0'
  } catch {
    return '1.0.0'
  }
})()

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

function durationShort(ms) {
  const total = Math.round(Number(ms) / 60000)
  if (!total) return '0m'
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return hours ? `${hours}h${minutes}m` : `${minutes}m`
}

function tokens(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

const PALETTE = [
  'var(--cat-1)',
  'var(--cat-2)',
  'var(--cat-3)',
  'var(--cat-4)',
  'var(--cat-5)',
  'var(--cat-6)',
  'var(--cat-7)',
  'var(--cat-8)',
]

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 11-13h-7l1-7Z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15 9-2.5 5.5L7 17l2.5-5.5Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"/>',
}

function icon(name, className = '') {
  return `<svg class="ico ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
}

function deltaChip(value, unit = '') {
  if (!value) return ''
  const sign = value > 0 ? '+' : ''
  const tone = value > 0 ? 'up' : 'down'
  return `<em class="delta ${tone}">${sign}${num(value)}${unit}</em>`
}

function sectionHead(number, title, description) {
  return `<div class="sec-head">
    <span class="sec-num">${number}</span>
    <h2>${esc(title)}</h2>
    <p class="sec-desc">${esc(description)}</p>
  </div>`
}

function kpi(label, value, sub, delta) {
  const plain = String(value).replace(/<[^>]+>/g, '')
  return `<div class="kpi">
    <span class="k-label">${esc(label)}</span>
    <span class="k-line">
      <span class="k-value${plain.length > 7 ? ' compact' : ''}">${value}</span>
      ${delta ?? ''}
    </span>
    <span class="k-sub">${esc(sub)}</span>
  </div>`
}

function briefItem(kind, title, items, iconName) {
  return `<article class="brief-item ${kind}">
    <h3><span class="brief-ico">${icon(iconName)}</span>${esc(title)}</h3>
    <ul>${items.length ? items.map((item) => `<li>${esc(item)}</li>`).join('') : '<li class="muted">数据不足</li>'}</ul>
  </article>`
}

function barRows(items, { max, unit = '', errorKey = null } = {}) {
  if (!items.length) return '<p class="empty">暂无数据</p>'
  const peak = Math.max(...items.map((item) => item.count), 1)
  return `<ul class="bars">${items
    .map((item, index) => {
      const share = Math.max(2, ((item.count / (max ?? peak)) * 100).toFixed(1))
      const error = errorKey && item[errorKey] ? `<span class="err-chip" title="${item[errorKey]} 次失败">×${item[errorKey]}</span>` : ''
      return `<li>
        <span class="b-label" title="${esc(item.name)}">${esc(item.name)}</span>
        <span class="b-track"><span class="b-fill" style="width:${share}%"></span></span>
        <span class="b-value">${num(item.count)}${unit}${error}</span>
      </li>`
    })
    .join('')}</ul>`
}

function donut(items, total, caption, palette = PALETTE) {
  const size = 172
  const radius = 62
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const segments = items
    .map((item, index) => {
      const fraction = total ? item.count / total : 0
      const dash = fraction * circumference
      const segment = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" style="stroke:${palette[index % palette.length]}" stroke-width="14" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`
      offset += dash
      return segment
    })
    .join('')
  return `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(caption)}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="var(--line)" stroke-width="14"/>
      ${segments}
      <text x="${size / 2}" y="${size / 2 - 4}" text-anchor="middle" class="donut-value">${num(total)}</text>
      <text x="${size / 2}" y="${size / 2 + 16}" text-anchor="middle" class="donut-label">${esc(caption)}</text>
    </svg>
    <ul class="legend">${items
      .map(
        (item, index) =>
          `<li><i style="background:${palette[index % palette.length]}"></i><span>${esc(item.name)}</span><b>${num(item.count)}</b></li>`,
      )
      .join('')}</ul>
  </div>`
}

function stackedBar(items, total) {
  if (!total) return '<p class="empty">暂无数据</p>'
  return `<div class="stack" role="img" aria-label="文件类型占比">${items
    .map(
      (item, index) =>
        `<span style="width:${((item.count / total) * 100).toFixed(1)}%;background:${PALETTE[index % PALETTE.length]}" title="${esc(
          item.name,
        )} ${item.count}"></span>`,
    )
    .join('')}</div>`
}

function frictionRows(frictions) {
  if (!frictions.length) return '<p class="empty">没有识别到明显的摩擦点。</p>'
  return `<div class="friction-list">${frictions
    .map(
      (friction) => `<details class="friction sev-${esc(friction.severity)}">
        <summary>
          <span class="dot" aria-hidden="true"></span>
          <span class="f-label">${esc(friction.label)}</span>
          <span class="f-meter" aria-hidden="true"><i style="width:${Math.min(100, friction.share)}%"></i></span>
          <span class="f-count"><b>${friction.sessions}</b> 会话 · ${num(friction.count)} 次</span>
        </summary>
        <div class="f-body">
          ${friction.examples
            .map(
              (example) => `<figure class="quote">
                <blockquote>${esc(example.quote || example.detail)}</blockquote>
                <figcaption>${esc(example.title || example.session)}</figcaption>
              </figure>`,
            )
            .join('')}
        </div>
      </details>`,
    )
    .join('')}</div>`
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

function rulesBlock(rules) {
  if (!rules.length) return '<p class="empty">这次没有足够证据生成规则。</p>'
  const markdown = rulesMarkdown(rules)
  return `<div class="card rules">
    <div class="rules-head">
      <p class="muted">粘贴到项目根目录的 <code>AGENTS.md</code>，下一次会话就会生效。</p>
      <button class="btn copy" data-copy="${esc(markdown)}">${icon('copy')}复制全部</button>
    </div>
    ${rules
      .map(
        (rule) => `<div class="rule">
          <span class="tag">${esc(rule.category)}</span>
          <p>${esc(rule.rule)}</p>
          <small>${esc(rule.why)}</small>
          <button class="copy-mini" data-copy="${esc(`- ${rule.rule}`)}" aria-label="复制这条规则">${icon('copy')}</button>
        </div>`,
      )
      .join('')}
  </div>`
}

function stepList(features) {
  if (!features.length) return ''
  return `<ol class="steps">${features
    .map(
      (feature, index) => `<li>
        <span class="step-num">${String(index + 1).padStart(2, '0')}</span>
        <div class="step-copy">
          <h3>${esc(feature.title)}</h3>
          <p>${esc(feature.body)}</p>
          <p class="ev">${esc(feature.evidence)}</p>
        </div>
        <p class="step-action"><span>试试</span>${esc(feature.action)}</p>
      </li>`,
    )
    .join('')}</ol>`
}

function sessionTable(sessions) {
  if (!sessions.length) return '<p class="empty">这个窗口里没有可分析的会话。</p>'
  return `<div class="card table-card">
    <div class="table-tools">
      <input id="session-filter" type="search" placeholder="筛选会话、项目或目标…" aria-label="筛选会话" autocomplete="off">
      <span class="muted" id="session-count">${sessions.length} 个会话</span>
    </div>
    <div class="table-scroll">
      <table id="sessions">
        <caption class="sr-only">会话明细，可按日期、时长、消息数、工具调用排序</caption>
        <thead><tr>
          <th scope="col" data-sort="createdAt">日期</th>
          <th scope="col">会话</th>
          <th scope="col">项目</th>
          <th scope="col" data-sort="durationMs" class="num">时长</th>
          <th scope="col" data-sort="messages" class="num">消息</th>
          <th scope="col" data-sort="tools" class="num">工具</th>
          <th scope="col">目标</th>
          <th scope="col">满意度</th>
        </tr></thead>
        <tbody>${sessions
          .map(
            (session) => `<tr data-created="${session.createdAt}" data-duration="${session.durationMs}" data-messages="${
              session.messages
            }" data-tools="${session.tools}" data-search="${esc(
              `${session.title} ${session.project} ${session.goal} ${session.type}`.toLowerCase(),
            )}">
              <td class="mono">${esc(session.date)}</td>
              <td class="t-title"><span title="${esc(session.summary || session.title)}">${esc(session.title)}</span>${
                session.frictions.length ? `<i class="warn-dot" title="${esc(session.frictions.join('、'))}">!</i>` : ''
              }</td>
              <td>${esc(session.project)}</td>
              <td class="num mono">${duration(session.durationMs)}</td>
              <td class="num mono">${num(session.messages)}</td>
              <td class="num mono">${num(session.tools)}${session.errors ? `<span class="err-chip">${session.errors}</span>` : ''}</td>
              <td><span class="tag">${esc(session.goal)}</span></td>
              <td>${
                session.satisfaction
                  ? `<span class="sat" aria-label="满意度 ${session.satisfaction} / 5">${'■'.repeat(session.satisfaction)}<i>${'□'.repeat(5 - session.satisfaction)}</i></span>`
                  : '<span class="muted">—</span>'
              }</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>
  </div>`
}

const STYLE = `
:root {
  color-scheme: light;
  --bg: #f5f7fb;
  --surface: #ffffff;
  --surface-2: #f8fafc;
  --ink: #0f172a;
  --ink-2: #3f4c63;
  --ink-3: #5b6a83;
  --line: #e3e8f0;
  --line-2: #c9d3e3;
  --blue: #1e40af;
  --blue-2: #2563eb;
  --blue-soft: #e8eefc;
  --amber: #92400e;
  --amber-2: #f59e0b;
  --amber-soft: #fef3c7;
  --green: #047857;
  --green-soft: #d9f5e8;
  --red: #b91c1c;
  --red-soft: #fde4e4;
  --shadow: 0 1px 2px rgba(15, 23, 42, .05);
  --radius: 12px;
  --cat-1: #1e40af;
  --cat-2: #0d9488;
  --cat-3: #d97706;
  --cat-4: #7c3aed;
  --cat-5: #be123c;
  --cat-6: #0369a1;
  --cat-7: #4d7c0f;
  --cat-8: #64748b;
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%235b6a83' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  --sans: "Fira Sans", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: "Fira Code", "Cascadia Mono", "Cascadia Code", ui-monospace, Consolas, monospace;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #070b14;
  --surface: #0d1422;
  --surface-2: #121b2c;
  --ink: #e8eefb;
  --ink-2: #b3c0d6;
  --ink-3: #8b99b1;
  --line: rgba(148, 163, 184, .16);
  --line-2: rgba(148, 163, 184, .32);
  --blue: #93b4ff;
  --blue-2: #60a5fa;
  --blue-soft: rgba(59, 130, 246, .16);
  --amber: #fbbf24;
  --amber-2: #f59e0b;
  --amber-soft: rgba(245, 158, 11, .14);
  --green: #34d399;
  --green-soft: rgba(16, 185, 129, .15);
  --red: #f87171;
  --red-soft: rgba(248, 113, 113, .14);
  --shadow: none;
  --cat-1: #93b4ff;
  --cat-2: #2dd4bf;
  --cat-3: #fbbf24;
  --cat-4: #a78bfa;
  --cat-5: #fb7185;
  --cat-6: #38bdf8;
  --cat-7: #a3e635;
  --cat-8: #94a3b8;
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238b99b1' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "tnum" 1;
}
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.skip {
  position: absolute; left: 12px; top: -48px; z-index: 100;
  background: var(--blue-2); color: #fff; padding: 8px 14px; border-radius: 8px;
  text-decoration: none; font-size: 13px; transition: top .15s ease;
}
.skip:focus { top: 10px; }
.ico { width: 16px; height: 16px; flex: 0 0 auto; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-3); }
.num { text-align: right; }
.empty { color: var(--ink-3); font-size: 13px; padding: 10px 0; margin: 0; }

:focus-visible { outline: 2px solid var(--blue-2); outline-offset: 2px; border-radius: 6px; }

.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 10px clamp(16px, 4vw, 40px);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 9px; font-weight: 600; letter-spacing: -.01em; }
.avatar { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; background: var(--surface-2); }
.avatar-fallback {
  display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%;
  background: var(--blue); color: #fff; font-size: 12px; font-weight: 700;
}
.brand-name { font-size: 13.5px; }
.brand-ver {
  font-family: var(--mono); font-size: 10.5px; color: var(--ink-3);
  border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; line-height: 18px;
}
.controls { display: flex; align-items: center; gap: 8px; }
.controls select {
  appearance: none; border: 1px solid var(--line); background: var(--surface);
  color: var(--ink-2); border-radius: 8px; padding: 6px 26px 6px 10px; font: inherit; font-size: 12px;
  cursor: pointer; min-height: 32px;
  background-image: var(--chevron); background-repeat: no-repeat; background-position: right 9px center;
}
.controls select:hover { border-color: var(--line-2); }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
  padding: 6px 11px; min-height: 32px; border-radius: 8px; font: inherit; font-size: 12px;
  cursor: pointer; transition: border-color .15s ease, color .15s ease, background .15s ease;
}
.btn:hover { border-color: var(--line-2); color: var(--ink); }
.btn-ghost { padding: 6px; }
.btn-ghost .ico { width: 17px; height: 17px; }

.shell { max-width: 1160px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 40px); }

.masthead {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px;
  padding: 48px 0 30px; border-bottom: 1px solid var(--line);
}
.eyebrow {
  margin: 0 0 10px; font-family: var(--mono); font-size: 11px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--blue);
}
h1 { margin: 0 0 12px; font-size: clamp(30px, 4vw, 42px); line-height: 1.1; letter-spacing: -.035em; font-weight: 700; }
.standfirst { margin: 0 0 16px; max-width: 62ch; font-size: clamp(16px, 1.6vw, 18px); line-height: 1.55; color: var(--ink-2); }
.meta { margin: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--ink-3); }
.meta b { color: var(--ink-2); font-weight: 500; }
.masthead-figure { display: flex; align-items: flex-start; gap: 2px; padding-top: 6px; }
.figure-num { font-family: var(--mono); font-size: 64px; line-height: .9; font-weight: 600; color: var(--line-2); letter-spacing: -.04em; }
.figure-unit { font-size: 12px; color: var(--ink-3); padding-top: 6px; }

.kpis {
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 1px; margin: 26px 0 0; background: var(--line);
  border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
}
.kpi { background: var(--surface); padding: 13px 15px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.k-label { font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
.k-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.k-value { font-family: var(--mono); font-size: 23px; line-height: 1.25; font-weight: 600; letter-spacing: -.02em; white-space: nowrap; }
.k-value.compact { font-size: 17px; }
.k-sub { font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.delta { font-style: normal; font-weight: 600; font-size: 11px; font-family: var(--mono); }
.delta.up { color: var(--green); }
.delta.down { color: var(--red); }

.jump {
  position: sticky; top: 52px; z-index: 30;
  display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none;
  padding: 10px 0; margin: 18px 0 6px;
  background: color-mix(in srgb, var(--bg) 90%, transparent);
  border-bottom: 1px solid var(--line);
}
.jump::-webkit-scrollbar { display: none; }
.jump a {
  flex: 0 0 auto; color: var(--ink-3); text-decoration: none; font-size: 12.5px;
  padding: 5px 10px; border-radius: 7px; transition: color .15s ease, background .15s ease;
}
.jump a:hover { color: var(--ink); background: var(--surface); }
.jump a.active { color: var(--blue); background: var(--blue-soft); font-weight: 500; }

section { padding: 40px 0 8px; scroll-margin-top: 116px; }
.sec-head { display: flex; align-items: baseline; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line); margin-bottom: 20px; flex-wrap: wrap; }
.sec-num { font-family: var(--mono); font-size: 11px; color: var(--blue); letter-spacing: .08em; }
.sec-head h2 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.02em; }
.sec-desc { margin: 0 0 0 auto; font-size: 12px; color: var(--ink-3); }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.card-pad { padding: 18px; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.card-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
.card-head span { font-size: 11.5px; color: var(--ink-3); font-family: var(--mono); }

.brief { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.brief-item { background: var(--surface); padding: 18px 20px; border-left: 3px solid transparent; }
.brief-item.pos { border-left-color: var(--green); }
.brief-item.neg { border-left-color: var(--red); }
.brief-item.win { border-left-color: var(--amber-2); }
.brief-item.big { border-left-color: var(--blue-2); }
.brief-item h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.brief-ico { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; }
.brief-item.pos .brief-ico { background: var(--green-soft); color: var(--green); }
.brief-item.neg .brief-ico { background: var(--red-soft); color: var(--red); }
.brief-item.win .brief-ico { background: var(--amber-soft); color: var(--amber); }
.brief-item.big .brief-ico { background: var(--blue-soft); color: var(--blue); }
.brief-item ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.brief-item li { position: relative; padding-left: 14px; font-size: 13px; line-height: 1.55; color: var(--ink-2); }
.brief-item li::before { content: ""; position: absolute; left: 0; top: .62em; width: 5px; height: 1px; background: var(--line-2); }

.grid { display: grid; gap: 14px; }
.grid-12 { grid-template-columns: repeat(12, minmax(0, 1fr)); }
.span-7 { grid-column: span 7; }
.span-5 { grid-column: span 5; }
.span-6 { grid-column: span 6; }
.span-12 { grid-column: span 12; }

.calendar { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.cal-dow { font-size: 10px; letter-spacing: .08em; text-align: center; color: var(--ink-3); padding-bottom: 4px; text-transform: uppercase; }
.cal-cell {
  position: relative; display: flex; flex-direction: column; justify-content: space-between;
  min-height: 44px; padding: 4px 6px; border-radius: 7px;
  background: var(--surface-2); border: 1px solid var(--line);
}
.cal-cell.blank { background: transparent; border-color: transparent; }
.cal-cell[data-level="1"] { background: color-mix(in srgb, var(--blue-2) 12%, var(--surface)); border-color: transparent; }
.cal-cell[data-level="2"] { background: color-mix(in srgb, var(--blue-2) 26%, var(--surface)); border-color: transparent; }
.cal-cell[data-level="3"] { background: color-mix(in srgb, var(--blue-2) 46%, var(--surface)); border-color: transparent; }
.cal-cell[data-level="4"] { background: var(--blue-2); border-color: transparent; }
.cal-cell.today { box-shadow: inset 0 0 0 2px var(--amber-2); }
.cal-day { font-family: var(--mono); font-size: 9.5px; color: var(--ink-3); }
.cal-count { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--ink-2); }
.cal-cell[data-level="3"] .cal-day, .cal-cell[data-level="4"] .cal-day { color: rgba(255, 255, 255, .8); }
.cal-cell[data-level="3"] .cal-count, .cal-cell[data-level="4"] .cal-count { color: #fff; }
.cal-cell.blank .cal-day, .cal-cell.blank .cal-count { display: none; }

.hours { display: flex; align-items: flex-end; gap: 3px; height: 172px; padding-top: 8px; }
.hour { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; gap: 6px; }
.hour i { display: block; background: var(--blue-soft); border-radius: 3px 3px 0 0; min-height: 2px; }
.hour.peak i { background: var(--blue-2); }
.hour b { font-family: var(--mono); font-size: 9px; color: var(--ink-3); text-align: center; font-weight: 400; height: 12px; overflow: hidden; }
.hour:nth-child(even) b { visibility: hidden; }

.trend { width: 100%; height: auto; display: block; }
.trend .grid-line { stroke: var(--line); stroke-width: 1; }
.trend .axis-label { fill: var(--ink-3); font-size: 10px; font-family: var(--mono); }
.trend .area { fill: color-mix(in srgb, var(--blue-2) 16%, transparent); }
.trend .line { fill: none; stroke: var(--blue-2); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.trend .dot { fill: var(--surface); stroke: var(--blue-2); stroke-width: 1.5; }

.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.bars li { display: grid; grid-template-columns: 96px minmax(0, 1fr) 78px; align-items: center; gap: 10px; }
.b-label { font-size: 12.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.b-track { height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.b-fill { display: block; height: 100%; border-radius: 999px; background: var(--blue-2); }
.b-value { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.err-chip {
  font-family: var(--mono); font-size: 10px; color: var(--red);
  background: var(--red-soft); border-radius: 4px; padding: 0 4px; line-height: 16px;
}

.stack { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--surface-2); }
.stack span { display: block; height: 100%; }
.legend { list-style: none; margin: 14px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 14px; }
.legend li { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-2); }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: block; }
.legend b { font-family: var(--mono); font-weight: 500; color: var(--ink-3); font-size: 11px; }

.donut-wrap { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.donut { width: 172px; height: 172px; flex: 0 0 auto; }
.donut-value { fill: var(--ink); font-family: var(--mono); font-size: 26px; font-weight: 600; }
.donut-label { fill: var(--ink-3); font-size: 10px; letter-spacing: .08em; }

.facts { display: flex; flex-direction: column; gap: 16px; }
.fact { border-top: 1px solid var(--line); padding-top: 12px; }
.fact:first-child { border-top: 0; padding-top: 0; }
.fact h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--surface-2); border-radius: 999px; padding: 3px 9px; font-size: 11.5px; color: var(--ink-2); }
.chip b { font-family: var(--mono); font-size: 11px; color: var(--ink); }
.sat-bar { display: flex; gap: 2px; }
.sat-bar span { height: 8px; border-radius: 2px; background: var(--blue-2); }
.sat-bar span.zero { background: var(--surface-2); border: 1px solid var(--line); }
.sat-legend { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--ink-3); margin-top: 4px; }

.friction-list { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.friction { border-top: 1px solid var(--line); }
.friction:first-child { border-top: 0; }
.friction summary {
  display: grid; grid-template-columns: 10px minmax(120px, 200px) minmax(0, 1fr) auto;
  align-items: center; gap: 14px; padding: 13px 18px; cursor: pointer; list-style: none;
}
.friction summary::-webkit-details-marker { display: none; }
.friction summary:hover { background: var(--surface-2); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }
.sev-high .dot { background: var(--red); }
.sev-medium .dot { background: var(--amber-2); }
.sev-low .dot { background: var(--line-2); }
.f-label { font-size: 13px; font-weight: 500; color: var(--ink); }
.f-meter { height: 4px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.f-meter i { display: block; height: 100%; background: var(--blue-2); border-radius: 999px; opacity: .62; }
.sev-high .f-meter i { background: var(--red); }
.sev-medium .f-meter i { background: var(--amber-2); }
.f-count { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); white-space: nowrap; }
.f-count b { color: var(--ink-2); }
.f-body { padding: 2px 18px 16px 42px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.quote { margin: 0; padding-left: 12px; border-left: 2px solid var(--line-2); }
.quote blockquote { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--ink-2); }
.quote figcaption { margin-top: 4px; font-size: 11px; color: var(--ink-3); }

.repeat { margin-top: 14px; }
.repeat h3 { margin: 0 0 10px; font-size: 13px; }
.repeat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.repeat-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 12px; align-items: center; font-size: 12.5px; color: var(--ink-2); }
.repeat-list b { font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-weight: 400; }

.rules-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.rules-head p { margin: 0; font-size: 12.5px; }
code { font-family: var(--mono); font-size: 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }
.rules { padding: 18px; }
.rule {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 12px;
  align-items: start; padding: 13px 0; border-top: 1px solid var(--line);
}
.rule:first-of-type { border-top: 0; }
.rule p { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--ink); }
.rule small { grid-column: 2; font-size: 11.5px; color: var(--ink-3); }
.tag { justify-self: start; font-size: 10.5px; letter-spacing: .04em; color: var(--ink-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; padding: 1px 7px; white-space: nowrap; }
.copy-mini {
  grid-column: 3; grid-row: 1; display: inline-grid; place-items: center; width: 28px; height: 28px;
  border: 1px solid var(--line); background: transparent; color: var(--ink-3); border-radius: 6px;
  cursor: pointer; transition: color .15s ease, border-color .15s ease;
}
.copy-mini:hover { color: var(--ink); border-color: var(--line-2); }
.copy-mini .ico { width: 14px; height: 14px; }

.steps { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.steps li { display: grid; grid-template-columns: 40px minmax(0, 1fr) minmax(0, 34%); gap: 18px; padding: 18px 0; border-bottom: 1px solid var(--line); }
.step-num { font-family: var(--mono); font-size: 11px; color: var(--blue); padding-top: 3px; }
.step-copy h3 { margin: 0 0 5px; font-size: 14.5px; }
.step-copy p { margin: 0 0 4px; font-size: 13px; color: var(--ink-2); }
.step-copy .ev { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.step-action { margin: 0; align-self: center; font-size: 12.5px; color: var(--ink-2); }
.step-action span { display: inline-block; color: var(--blue); font-weight: 600; margin-right: 6px; }

.table-card { padding: 16px 18px 6px; }
.table-tools { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.table-tools input {
  flex: 1; max-width: 320px; min-height: 34px; background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 11px; color: var(--ink); font: inherit; font-size: 12.5px;
}
.table-tools input::placeholder { color: var(--ink-3); }
.table-tools input:focus { border-color: var(--blue-2); outline: none; box-shadow: 0 0 0 3px var(--blue-soft); }
.table-tools span { font-size: 12px; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 820px; }
thead th {
  position: sticky; top: 0; z-index: 1; text-align: left; padding: 7px 10px;
  font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; font-weight: 600;
  color: var(--ink-3); background: var(--surface); border-bottom: 1px solid var(--line-2);
}
thead th[data-sort] { cursor: pointer; user-select: none; }
thead th[data-sort]:hover { color: var(--ink); }
thead th.num { text-align: right; }
tbody td { padding: 9px 10px; border-bottom: 1px solid var(--line); color: var(--ink-2); }
tbody tr:hover td { background: var(--surface-2); }
tbody tr:last-child td { border-bottom: 0; }
.t-title { color: var(--ink); max-width: 340px; }
.t-title span { display: inline-block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.warn-dot {
  display: inline-grid; place-items: center; width: 15px; height: 15px; margin-left: 6px;
  border-radius: 50%; background: var(--red-soft); color: var(--red); font-size: 10px; font-weight: 700; font-style: normal;
}
.sat { font-family: var(--mono); font-size: 10px; letter-spacing: 1px; color: var(--blue-2); }
.sat i { font-style: normal; color: var(--line-2); }

.site-foot {
  max-width: 1160px; margin: 40px auto 0; padding: 18px clamp(16px, 4vw, 40px) 40px;
  border-top: 1px solid var(--line);
  display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--ink-3);
}
.site-foot b { color: var(--ink-2); font-weight: 500; }

.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 12px);
  background: var(--ink); color: var(--bg); font-size: 12px; padding: 8px 16px;
  border-radius: 999px; opacity: 0; pointer-events: none; transition: opacity .18s ease, transform .18s ease; z-index: 60;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 1080px) {
  .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .span-7, .span-5, .span-6 { grid-column: span 12; }
}
@media (max-width: 760px) {
  body { font-size: 15px; }
  .sec-head { gap: 8px 12px; }
  .sec-desc { flex-basis: 100%; margin-left: 0; margin-top: -4px; }
  .topbar { padding: 8px 14px; gap: 8px; }
  .brand { min-width: 0; }
  .brand-name { max-width: 132px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .brand-ver { display: none; }
  .controls { gap: 6px; flex: 0 0 auto; }
  .controls select { max-width: 128px; padding: 6px 8px; }
  .topbar .btn-label { display: none; }
  .topbar #print { padding: 6px; }
  .masthead { grid-template-columns: 1fr; padding-top: 32px; }
  .masthead-figure { display: none; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpis .kpi:last-child:nth-child(odd) { grid-column: span 2; }
  .brief { grid-template-columns: 1fr; }
  .friction summary { grid-template-columns: 10px minmax(0, 1fr) auto; }
  .f-meter { display: none; }
  .f-body { grid-template-columns: 1fr; padding-left: 42px; }
  .steps li { grid-template-columns: 32px minmax(0, 1fr); }
  .step-action { grid-column: 2; }
  .legend { grid-template-columns: 1fr; }
  .jump { top: 50px; }
  .hours { height: 140px; gap: 2px; }
  .btn, .controls select { min-height: 40px; }
  .copy-mini { width: 36px; height: 36px; }
}
@media (pointer: coarse) {
  .btn, .controls select, .copy-mini { min-height: 44px; min-width: 44px; }
  .jump a { padding: 10px 12px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
@page { margin: 14mm 12mm; }
@media print {
  html, body { background: #fff; }
  html, html[data-theme="dark"] {
    --bg: #fff; --surface: #fff; --surface-2: #f5f5f5; --ink: #111; --ink-2: #333; --ink-3: #666;
    --line: #ddd; --line-2: #bbb; --blue: #1e3a8a; --blue-2: #2563eb; --blue-soft: #eef2fb;
    --cat-1: #1e40af; --cat-2: #0f766e; --cat-3: #b45309; --cat-4: #6d28d9;
    --cat-5: #9f1239; --cat-6: #0c4a6e; --cat-7: #3f6212; --cat-8: #475569;
  }
  .topbar, .jump, .table-tools, .copy-mini, .btn, .toast { display: none !important; }
  .shell, .site-foot { max-width: none; padding: 0; }
  body { font-size: 11pt; }
  section, .card, .brief, .kpis, .friction-list, .steps li { break-inside: avoid; }
  .card { box-shadow: none; }
}
`

const CLIENT = `
(function () {
  var DATA = __DATA__;
  var root = document.documentElement;
  var tzSelect = document.getElementById('tz');
  var zone = DATA.timezone;
  var zones = ['Asia/Shanghai', 'Asia/Tokyo', 'UTC', 'Europe/London', 'America/Los_Angeles'];
  if (zones.indexOf(zone) === -1) zones.unshift(zone);
  zones.forEach(function (item) {
    var option = document.createElement('option');
    option.value = item;
    option.textContent = item;
    if (item === zone) option.selected = true;
    tzSelect.appendChild(option);
  });

  function parts(ms, tz) {
    var formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
    var out = {};
    formatter.formatToParts(new Date(ms)).forEach(function (part) { out[part.type] = part.value; });
    out.hour = Number(out.hour) % 24;
    return out;
  }
  function keyOf(ms, tz) { var p = parts(ms, tz); return p.year + '-' + p.month + '-' + p.day; }
  function dayList(count, tz) {
    var list = [];
    var now = Date.now();
    for (var i = count - 1; i >= 0; i -= 1) list.push(keyOf(now - i * 86400000, tz));
    return list;
  }
  function bucketize(tz) {
    var days = dayList(DATA.range.days, tz);
    var map = {};
    var hours = [];
    for (var h = 0; h < 24; h += 1) hours.push(0);
    days.forEach(function (day) { map[day] = { messages: 0, sessions: 0 }; });
    (DATA.stats.activity.messageTimes || []).forEach(function (ms) {
      var p = parts(ms, tz);
      var day = p.year + '-' + p.month + '-' + p.day;
      if (map[day]) map[day].messages += 1;
      hours[p.hour] += 1;
    });
    DATA.sessions.forEach(function (session) {
      var day = keyOf(session.createdAt, tz);
      if (map[day]) map[day].sessions += 1;
    });
    return { days: days, map: map, hours: hours };
  }

  function renderCalendar(b) {
    var host = document.getElementById('calendar');
    host.innerHTML = '';
    ['一', '二', '三', '四', '五', '六', '日'].forEach(function (label) {
      var h = document.createElement('div');
      h.className = 'cal-dow';
      h.textContent = label;
      host.appendChild(h);
    });
    var first = new Date(b.days[0] + 'T12:00:00Z').getUTCDay();
    var pad = (first + 6) % 7;
    for (var p = 0; p < pad; p += 1) {
      var blank = document.createElement('div');
      blank.className = 'cal-cell blank';
      host.appendChild(blank);
    }
    var max = 1;
    b.days.forEach(function (day) { if (b.map[day].messages > max) max = b.map[day].messages; });
    var today = keyOf(Date.now(), zone);
    b.days.forEach(function (day) {
      var item = b.map[day];
      var cell = document.createElement('div');
      cell.className = 'cal-cell' + (day === today ? ' today' : '');
      cell.dataset.level = String(item.messages === 0 ? 0 : Math.min(4, 1 + Math.floor((item.messages / max) * 3.2)));
      cell.title = day + ' · ' + item.messages + ' 条消息 · ' + item.sessions + ' 个会话';
      var d = document.createElement('span');
      d.className = 'cal-day';
      d.textContent = String(Number(day.slice(8)));
      var c = document.createElement('span');
      c.className = 'cal-count';
      c.textContent = item.messages ? String(item.messages) : '';
      cell.appendChild(d);
      cell.appendChild(c);
      host.appendChild(cell);
    });
    var active = 0;
    var messages = 0;
    b.days.forEach(function (day) {
      if (b.map[day].messages > 0 || b.map[day].sessions > 0) active += 1;
      messages += b.map[day].messages;
    });
    var caption = document.getElementById('calendar-caption');
    if (caption) caption.textContent = active + ' 天活跃 · ' + messages + ' 条消息';
  }

  function renderHours(b) {
    var host = document.getElementById('hours');
    host.innerHTML = '';
    var max = 0;
    b.hours.forEach(function (v) { if (v > max) max = v; });
    var peak = b.hours.indexOf(max);
    b.hours.forEach(function (count, hour) {
      var wrap = document.createElement('div');
      wrap.className = 'hour' + (hour === peak && count > 0 ? ' peak' : '');
      wrap.title = hour + ':00 — ' + count + ' 条消息';
      var bar = document.createElement('i');
      bar.style.height = (count && max ? Math.max(3, (count / max) * 100) : 0) + '%';
      var label = document.createElement('b');
      label.textContent = hour;
      wrap.appendChild(bar);
      wrap.appendChild(label);
      host.appendChild(wrap);
    });
    var peakLabel = document.getElementById('peak-label');
    if (peakLabel) peakLabel.textContent = max > 0 ? '高峰 ' + peak + ':00 – ' + ((peak + 1) % 24) + ':00' : '暂无数据';
  }

  function renderTrend(b) {
    var host = document.getElementById('trend');
    if (!host) return;
    var values = b.days.map(function (day) { return b.map[day].messages; });
    var W = Math.max(320, Math.round(host.clientWidth || 960));
    var H = W < 560 ? 150 : 210;
    var L = W < 560 ? 30 : 40, R = 14, T = 14, B = 26;
    var innerW = W - L - R, innerH = H - T - B;
    var max = Math.max.apply(null, values.concat([1]));
    var n = values.length;
    function x(i) { return n <= 1 ? L + innerW / 2 : L + (i / (n - 1)) * innerW; }
    function y(v) { return T + innerH - (v / max) * innerH; }
    var svg = '<svg class="trend" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="每日用户消息趋势">';
    [0, 0.5, 1].forEach(function (f) {
      var gy = T + innerH - f * innerH;
      svg += '<line class="grid-line" x1="' + L + '" y1="' + gy + '" x2="' + (W - R) + '" y2="' + gy + '"/>';
      svg += '<text class="axis-label" x="' + (L - 8) + '" y="' + (gy + 3) + '" text-anchor="end">' + Math.round(f * max) + '</text>';
    });
    var line = '';
    var area = '';
    values.forEach(function (v, i) {
      var px = x(i).toFixed(2);
      var py = y(v).toFixed(2);
      line += (i === 0 ? 'M' : 'L') + px + ' ' + py;
      area += (i === 0 ? 'M' : 'L') + px + ' ' + py;
    });
    area += 'L' + x(n - 1).toFixed(2) + ' ' + (T + innerH) + 'L' + x(0).toFixed(2) + ' ' + (T + innerH) + 'Z';
    svg += '<path class="area" d="' + area + '"/>';
    svg += '<path class="line" d="' + line + '"/>';
    var step = Math.max(1, Math.round(n / 12));
    for (var i = 0; i < n; i += step) {
      svg += '<circle class="dot" cx="' + x(i).toFixed(2) + '" cy="' + y(values[i]).toFixed(2) + '" r="2.5"><title>' + b.days[i] + ' · ' + values[i] + ' 条</title></circle>';
    }
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (index) {
      if (index < 0) return;
      svg += '<text class="axis-label" x="' + x(index).toFixed(2) + '" y="' + (H - 8) + '" text-anchor="' + (index === 0 ? 'start' : index === n - 1 ? 'end' : 'middle') + '">' + b.days[index].slice(5) + '</text>';
    });
    svg += '</svg>';
    host.innerHTML = svg;
    var peak = document.getElementById('trend-peak');
    if (peak) peak.textContent = '单日峰值 ' + Math.max.apply(null, values);
  }

  function refresh() {
    var b = bucketize(zone);
    renderCalendar(b);
    renderHours(b);
    renderTrend(b);
  }

  var stored = null;
  try { stored = localStorage.getItem('dsh-insights-theme'); } catch (e) {}
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = stored || (prefersDark ? 'dark' : 'light');
  var themeButton = document.getElementById('theme');
  function paintThemeButton() {
    var dark = root.dataset.theme === 'dark';
    themeButton.innerHTML = dark
      ? '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"/></svg>';
  }
  paintThemeButton();
  themeButton.addEventListener('click', function () {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    paintThemeButton();
    try { localStorage.setItem('dsh-insights-theme', root.dataset.theme); } catch (e) {}
  });

  tzSelect.addEventListener('change', function () { zone = tzSelect.value; refresh(); });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refresh, 160);
  });
  document.getElementById('print').addEventListener('click', function () { window.print(); });

  var toast = document.getElementById('toast');
  var timer = null;
  function notify(text) {
    toast.textContent = text || '已复制';
    toast.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function () { toast.classList.remove('show'); }, 1600);
  }
  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-copy]');
    if (!target) return;
    var text = target.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { notify(); }, function () { notify('复制失败'); });
    } else {
      notify('请手动选择复制');
    }
  });

  var filter = document.getElementById('session-filter');
  if (filter) {
    filter.addEventListener('input', function () {
      var query = filter.value.trim().toLowerCase();
      var rows = document.querySelectorAll('#sessions tbody tr');
      var shown = 0;
      rows.forEach(function (row) {
        var hit = !query || row.dataset.search.indexOf(query) !== -1;
        row.style.display = hit ? '' : 'none';
        if (hit) shown += 1;
      });
      document.getElementById('session-count').textContent = shown + ' 个会话';
    });
  }

  var sortState = { key: null, direction: 1 };
  var sortFields = { createdAt: 'created', durationMs: 'duration', messages: 'messages', tools: 'tools' };
  document.querySelectorAll('#sessions thead th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      sortState.direction = sortState.key === key ? -sortState.direction : -1;
      sortState.key = key;
      var rows = Array.prototype.slice.call(document.querySelectorAll('#sessions tbody tr'));
      rows.sort(function (a, b) { return (Number(a.dataset[sortFields[key]]) - Number(b.dataset[sortFields[key]])) * sortState.direction; });
      var body = document.querySelector('#sessions tbody');
      rows.forEach(function (row) { body.appendChild(row); });
    });
  });

  var links = Array.prototype.slice.call(document.querySelectorAll('.jump a'));
  var sections = links.map(function (link) { return document.querySelector(link.getAttribute('href')); });
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (link) { link.classList.remove('active'); });
        var index = sections.indexOf(entry.target);
        if (index >= 0) links[index].classList.add('active');
      });
    }, { rootMargin: '-28% 0px -62% 0px' });
    sections.forEach(function (section) { if (section) observer.observe(section); });
  }

  refresh();
})();
`

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
  const deltas = isEmpty ? null : data.deltas ?? null

  const llmLabel = data.llm.used
    ? `${esc(data.llm.model ?? '默认模型')} · 新分析 ${data.llm.analyzed} / 缓存 ${data.llm.cached}${data.llm.failed ? ` / 失败 ${data.llm.failed}` : ''}`
    : data.llm.cached
      ? `复用 ${data.llm.cached} 个会话的历史分析（本次未调用模型）`
      : '规则模式（未调用模型）'

  const kpis = [
    kpi('会话', num(stats.sessions), `最近 ${data.range.days} 天`, deltas ? deltaChip(deltas.sessions) : ''),
    kpi(
      '用户消息',
      num(stats.humanMessages),
      `平均 ${(stats.humanMessages / Math.max(1, stats.sessions)).toFixed(1)} 条/会话`,
      deltas ? deltaChip(deltas.humanMessages) : '',
    ),
    kpi('累计时长', durationShort(stats.durationMs), `平均 ${duration(stats.avgSessionMs)}`, ''),
    kpi('工具调用', num(stats.toolCalls), `失败率 ${stats.errorRate}%`, deltas ? deltaChip(deltas.toolErrors, ' 失败') : ''),
    kpi('编辑文件', num(stats.files), `${num(stats.edits)} 次编辑`, ''),
    kpi('活跃天数', num(stats.activeDays), `连续 ${stats.streak} 天`, deltas ? deltaChip(deltas.activeDays, ' 天') : ''),
    kpi('Token', `${tokens(stats.tokens.input)} / ${tokens(stats.tokens.output)}`, '输入 / 输出', ''),
  ].join('')

  const overview = [
    briefItem('pos', '什么在起作用', data.summary.working, 'check'),
    briefItem('neg', '什么在拖后腿', data.summary.hindering, 'alert'),
    briefItem('win', '快赢', data.summary.quickWins, 'bolt'),
    briefItem('big', '更大的机会', data.summary.opportunities, 'compass'),
  ].join('')

  const tools = stats.tools.slice(0, 8).map((tool) => ({ name: tool.name, count: tool.calls, errors: tool.errors }))
  const languages = stats.languages.slice(0, 7)
  const languageTotal = languages.reduce((sum, item) => sum + item.files, 0) || 1
  const goalsTotal = stats.goals.reduce((sum, item) => sum + item.count, 0)
  const satisfaction = stats.satisfaction
  const satisfactionTotal = satisfaction ? satisfaction.distribution.reduce((sum, item) => sum + item.count, 0) : 0

  const repeated = data.repeated.length
    ? `<div class="card card-pad repeat">
        <h3>反复出现的指令</h3>
        <ul class="repeat-list">${data.repeated
          .map(
            (item) =>
              `<li><span>${esc(item.text)}</span><b>${item.sessions} 个会话</b><button class="copy-mini" data-copy="${esc(
                item.text,
              )}" aria-label="复制这条指令">${icon('copy')}</button></li>`,
          )
          .join('')}</ul>
      </div>`
    : ''

  const frictionContent = frictionRows(data.frictions)

  const satisfactionBlock = satisfaction
    ? `<div class="fact">
        <h4>满意度</h4>
        <div class="sat-bar" role="img" aria-label="满意度分布">${satisfaction.distribution
          .map((item) => {
            const width = satisfactionTotal ? Math.max(6, (item.count / satisfactionTotal) * 100) : 20
            const tint = item.count
              ? `background:color-mix(in srgb, var(--blue-2) ${30 + item.score * 14}%, var(--surface-2))`
              : ''
            return `<span class="${item.count ? '' : 'zero'}" style="width:${width.toFixed(1)}%;${tint}" title="${item.score} 分 · ${item.count} 个会话"></span>`
          })
          .join('')}</div>
        <div class="sat-legend"><span>1 分</span><span>5 分</span></div>
        <p class="muted" style="margin:6px 0 0;font-size:12px">平均 ${satisfaction.average} / 5 · 基于 ${satisfaction.samples} 个会话</p>
      </div>`
    : `<div class="fact"><h4>满意度</h4><p class="empty">启用模型分析后显示</p></div>`

  const emptyState = isEmpty
    ? `<div class="card card-pad" style="margin-top:22px">
        <strong style="font-size:14px">这个窗口里没有可分析的会话</strong>
        <p class="muted" style="margin:6px 0 0;font-size:13px">放宽天数（<code>/insights 30</code>）、去掉 <code>--project</code> 筛选，或先在这个项目里工作一会儿。</p>
      </div>`
    : ''

  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>DSH 会话洞察 · 最近 ${data.range.days} 天</title>
<script>try{var s=localStorage.getItem('dsh-insights-theme');if(!s&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)s='dark';if(s)document.documentElement.dataset.theme=s}catch(e){}</script>
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#overview">跳到内容</a>
<header class="topbar">
  <div class="brand">
    ${AVATAR ? `<img class="avatar" src="${AVATAR}" alt="" width="26" height="26">` : '<span class="avatar-fallback">◈</span>'}
    <span class="brand-name">DSH 会话洞察</span>
    <span class="brand-ver">v${esc(VERSION)}</span>
  </div>
  <div class="controls">
    <label class="sr-only" for="tz">时区</label>
    <select id="tz"></select>
    <button id="theme" class="btn btn-ghost" aria-label="切换深浅色"></button>
    <button id="print" class="btn" aria-label="导出 PDF">${icon('download')}<span class="btn-label">导出 PDF</span></button>
  </div>
</header>

<main class="shell">
  <header class="masthead">
    <div>
      <p class="eyebrow">${esc(rangeFrom)} → ${esc(rangeTo)} · 最近 ${data.range.days} 天</p>
      <h1>会话洞察</h1>
      <p class="standfirst">${esc(data.summary.headline || `这段时间在 ${stats.projects} 个项目里开了 ${stats.sessions} 个会话，累计 ${duration(stats.durationMs)}。`)}</p>
      <p class="meta">
        <span>生成于 <b>${esc(generated)}</b></span>
        <span>模型 <b>${llmLabel}</b></span>
        <span>跳过 <b>${data.skipped.subagent}</b> 个子代理 / <b>${data.skipped.empty}</b> 个空会话</span>
      </p>
    </div>
    <div class="masthead-figure" aria-hidden="true"><span class="figure-num">${data.range.days}</span><span class="figure-unit">天</span></div>
  </header>

  <div class="kpis">${kpis}</div>
  ${emptyState}

  <nav class="jump" aria-label="报告章节">
    <a href="#overview">概览</a>
    <a href="#activity">活跃度</a>
    <a href="#tools">工具与语言</a>
    <a href="#composition">会话构成</a>
    <a href="#friction">摩擦点</a>
    <a href="#rules">AGENTS.md</a>
    <a href="#next">下一步</a>
    <a href="#detail">明细</a>
  </nav>

  <section id="overview">
    ${sectionHead('01', '一眼看完', '基于你的会话自动生成，不是通用建议')}
    <div class="brief">${overview}</div>
  </section>

  <section id="activity">
    ${sectionHead('02', '活跃度', '按本地时区分桶，切换时区即时重算')}
    <div class="grid grid-12">
      <div class="card card-pad span-7">
        <div class="card-head"><h3>日历</h3><span id="calendar-caption"></span></div>
        <div class="calendar" id="calendar" role="img" aria-label="按天活跃日历"></div>
      </div>
      <div class="card card-pad span-5">
        <div class="card-head"><h3>时段分布</h3><span id="peak-label"></span></div>
        <div class="hours" id="hours" role="img" aria-label="按小时的消息分布"></div>
      </div>
      <div class="card card-pad span-12">
        <div class="card-head"><h3>每日用户消息</h3><span id="trend-peak"></span></div>
        <div id="trend"></div>
      </div>
    </div>
  </section>

  <section id="tools">
    ${sectionHead('03', '工具与语言', '工具调用决定时间去向，失败率决定返工量')}
    <div class="grid grid-12">
      <div class="card card-pad span-7">
        <div class="card-head"><h3>工具调用</h3><span>共 ${num(stats.toolCalls)} 次 · 失败 ${num(stats.toolErrors)} 次</span></div>
        ${barRows(tools, { errorKey: 'errors' })}
      </div>
      <div class="card card-pad span-5">
        <div class="card-head"><h3>文件类型</h3><span>${num(languageTotal)} 个文件</span></div>
        ${stackedBar(languages.map((item) => ({ name: item.name, count: item.files })), languageTotal)}
        <ul class="legend">${languages
          .map(
            (item, index) =>
              `<li><i style="background:${PALETTE[index % PALETTE.length]}"></i><span>${esc(item.name)}</span><b>${num(item.files)}</b></li>`,
          )
          .join('')}</ul>
      </div>
      ${repeated ? `<div class="span-12">${repeated}</div>` : ''}
    </div>
  </section>

  <section id="composition">
    ${sectionHead('04', '会话构成', '时间投在哪类任务上，以及这些会话顺不顺利')}
    <div class="grid grid-12">
      <div class="card card-pad span-6">
        <div class="card-head"><h3>任务目标</h3><span>${num(goalsTotal)} 个会话</span></div>
        ${donut(stats.goals, goalsTotal, '会话')}
      </div>
      <div class="card card-pad span-6">
        <div class="card-head"><h3>类型与感受</h3><span>${num(stats.sessions)} 个会话</span></div>
        <div class="facts">
          <div class="fact">
            <h4>会话类型</h4>
            <div class="chips">${stats.types.map((item) => `<span class="chip">${esc(item.name)}<b>${item.count}</b></span>`).join('')}</div>
          </div>
          ${satisfactionBlock}
          <div class="fact">
            <h4>项目</h4>
            <div class="chips">${stats.projectsList
              .slice(0, 6)
              .map((item) => `<span class="chip">${esc(item.name)}<b>${item.count}</b></span>`)
              .join('')}</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="friction">
    ${sectionHead('05', '摩擦点', '按影响的会话数排序，展开看原始证据')}
    ${frictionContent}
  </section>

  <section id="rules">
    ${sectionHead('06', '写进 AGENTS.md', '把每天重复的交代固化一次，之后每个会话都生效')}
    ${rulesBlock(data.rules)}
  </section>

  <section id="next">
    ${sectionHead('07', '下一步', '针对你的实际用法，而不是功能清单')}
    ${stepList(data.features)}
  </section>

  <section id="detail">
    ${sectionHead('08', '会话明细', '点击表头排序，输入关键词筛选')}
    ${sessionTable(data.sessions)}
  </section>
</main>

<footer class="site-foot">
  <span>本地生成 · 数据来自 <b>~/.dsh/sessions</b> · 不含代码文件内容</span>
  <span>DSH Insights v${esc(VERSION)} · ${data.sessions.length} 个会话</span>
</footer>

<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>${CLIENT.replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'))}</script>
</body>
</html>`

  return body
}
