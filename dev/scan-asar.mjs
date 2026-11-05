import fs from 'node:fs'

const file = process.argv[2]
const needle = process.argv[3] ?? 'Plugin metadata for'
const before = Number(process.argv[4] ?? 600)
const after = Number(process.argv[5] ?? 600)

const buf = fs.readFileSync(file)
const text = buf.toString('latin1')
let index = -1
let count = 0
while ((index = text.indexOf(needle, index + 1)) !== -1 && count < 6) {
  count += 1
  const slice = text.slice(Math.max(0, index - before), index + after)
  const printable = slice.replace(/[^\x20-\x7e\n]/g, '·')
  console.log(`\n===== hit ${count} at ${index} =====`)
  console.log(printable)
}
console.log(`\nmatches shown: ${count}`)
