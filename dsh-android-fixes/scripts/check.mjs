/** Static checks: manifest shape, patch anchors present, both halves parse. */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const failures = []
const expect = (label, condition) => {
	console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`)
	if (!condition) failures.push(label)
}

expect('bundle patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
expect('client half declared for web', manifest.dsh?.client?.platform === 'web')
expect('client export declared', manifest.exports['./client'] === './client.js')
expect('locale files exported', manifest.exports['./locale/*.json'] === './locale/*.json')
expect('icon declared', typeof manifest.icon === 'string' && fs.existsSync(path.join(root, manifest.icon)))
for (const locale of ['en', 'zh']) {
	const file = path.join(root, 'locale', `${locale}.json`)
	const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
	expect(`locale/${locale}.json carries meta.title + meta.description`, typeof parsed.meta?.title === 'string' && typeof parsed.meta?.description === 'string')
}
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
expect('patch inserts the package row', patch.includes(`name: '${manifest.name}'`))

const { PATCH_ITEMS, MARKER } = await import('../src/patches.js')
expect(
	'every patched target carries the marker at least once',
	PATCH_ITEMS.every((item) => item.files.every((file) => file.pairs.some((pair) => pair[1].includes(MARKER)))),
)
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
expect('client half imports no Harness Client package', !/@deepseek-ai\/dsh-client/.test(clientSource))
const hostSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
expect('host half imports no Harness package', !/from '@deepseek-ai/.test(hostSource))

console.log(failures.length === 0 ? '\nCHECK PASSED' : `\nCHECK FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
