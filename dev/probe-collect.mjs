/** Print what the collector keeps for the local session history. */
import path from 'node:path'
import { collectSessions } from '../src/collect.js'

const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const result = collectSessions({ dshHome: home, days: Number(process.argv[2] ?? 30), maxSessions: 60 })
console.log('scanned', result.scannedFiles, 'kept', result.sessions.length, 'skipped', result.skipped)
for (const session of result.sessions) {
  console.log(
    [
      session.id.slice(0, 18),
      session.project.padEnd(20).slice(0, 20),
      `${Math.round(session.durationMs / 60000)}m`.padStart(5),
      `msgs ${session.humanMessages.length}`.padStart(8),
      `tools ${session.toolCalls.length}`.padStart(10),
      `errors ${session.toolErrors.length}`.padStart(11),
      JSON.stringify(session.title).slice(0, 40),
    ].join(' '),
  )
}
