import fs from 'node:fs'
import path from 'node:path'
import { readSessionLog } from '../src/zstd.js'
import { findSessionFiles } from '../src/collect.js'

const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
const needle = process.argv[2] ?? 'Plugin metadata for'
const files = findSessionFiles(home)
let found = 0
for (const file of files) {
  const { records } = readSessionLog(file.filePath)
  records.forEach((record, index) => {
    const text = JSON.stringify(record)
    if (!text.includes(needle)) return
    found += 1
    console.log(`\n=== ${path.basename(file.filePath)} record #${index} ${record.type} seq=${record.seq} ===`)
    console.log(text.slice(0, 900))
  })
}
console.log(`\nmatches: ${found} across ${files.length} files`)
