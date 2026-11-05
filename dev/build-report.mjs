/**
 * Build a report from the real session history without going through DSH.
 *
 *   node dev/build-report.mjs [days] [output]
 */
import fs from 'node:fs'
import path from 'node:path'
import { collectSessions } from '../src/collect.js'
import { generateInsightData, writeRunSnapshot } from '../src/insights.js'
import { renderReport } from '../src/report.js'

const here = import.meta.dirname
const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const days = Number(process.argv[2] ?? 30)
const out = process.argv[3] ?? path.join(here, 'report.html')
const dataDir = path.join(here, '.data')

const { sessions, skipped, window } = collectSessions({ dshHome: home, days, maxSessions: 60 })
const started = Date.now()
const data = await generateInsightData({
  sessions,
  skipped,
  window,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  days,
  llm: null,
  model: null,
  cacheDir: dataDir,
  reportDir: dataDir,
  onProgress: (progress) => process.stderr.write(`${JSON.stringify(progress)}\n`),
})

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, renderReport(data))
writeRunSnapshot(dataDir, data)
console.log(JSON.stringify({ sessions: sessions.length, elapsedMs: Date.now() - started, out }))
