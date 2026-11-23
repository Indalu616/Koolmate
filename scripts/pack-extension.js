'use strict'
/**
 * Builds the file to upload to the Chrome Web Store and Microsoft Edge Add-ons:
 *   release/koolmate-blackboard-<version>.zip  (manifest.json at the top of the zip, as the stores require)
 * Usage: npm run pack:extension
 */
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

const SRC = path.join(__dirname, '..', 'electron', 'extension')
const OUT = path.join(__dirname, '..', 'release')

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'))
  const problems = []
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3')
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) problems.push('version must look like 1.0.0')
  if ((manifest.description || '').length > 132) problems.push(`description is ${manifest.description.length} characters (max 132)`)
  for (const icon of Object.values(manifest.icons || {})) if (!fs.existsSync(path.join(SRC, icon))) problems.push(`missing icon ${icon}`)
  if (problems.length) { console.error('Not ready to upload:\n- ' + problems.join('\n- ')); process.exit(1) }

  const zip = new JSZip()
  for (const name of fs.readdirSync(SRC).sort()) {
    if (name.startsWith('.')) continue
    zip.file(name, fs.readFileSync(path.join(SRC, name)), { date: new Date('2026-01-01T00:00:00Z') })
  }
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `koolmate-blackboard-${manifest.version}.zip`)
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  console.log(`Ready to upload: ${file} (${Math.round(fs.statSync(file).size / 1024)} KB, version ${manifest.version})`)
}

main().catch(e => { console.error(e); process.exit(1) })
