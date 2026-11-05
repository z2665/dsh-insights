import fs from 'node:fs'

const file = process.argv[2]
const buf = fs.readFileSync(file)
const text = buf.toString('latin1')
let index = -1
let count = 0
while ((index = text.indexOf('insights-dev', index + 1)) !== -1 && count < 5) {
  count += 1
  const start = Math.max(0, index - 700)
  const slice = text.slice(start, index + 500)
  const printable = slice.replace(/[^\x20-\x7e\u00a0-\u024f]/g, '·')
  console.log(`\n===== hit ${count} at ${index} =====`)
  console.log(printable)
}
if (count === 0) console.log('no hits')
