/**
 * Integration test for the Host half.
 *
 * Mounts the real `apply()` from `index.js` on a minimal fake Cordis context,
 * captures the `/api/dsh-android-fixes` route it registers on `webServer`, and
 * drives that handler with Fetch-shaped requests — the same bytes the settings
 * page sends. It therefore exercises the plugin's own request handling, patch
 * engine and state file, not a reimplementation of them.
 *
 * `--mutate` is required before the script will touch the real dsh tree: without
 * it only `GET /status` runs, so the default invocation is read-only.
 *
 * Usage: node scripts/integration.mjs [--mutate]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshDir } from '../src/engine.js'
import { apply } from '../index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mutate = process.argv.includes('--mutate')
const failures = []
function check(label, condition, extra) {
	console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${condition || extra === undefined ? '' : ` — ${extra}`}`)
	if (!condition) failures.push(label)
}

/** Capture everything apply() registers on its fake context. */
const captured = { route: null, tool: null, effects: 0 }
function makeScope(tools) {
	return {
		webServer: {
			register(route) {
				captured.route = route
				return () => {}
			},
		},
		...(tools === undefined ? {} : { tools }),
		effect(fn) {
			captured.effects += 1
			return fn()
		},
	}
}
const ctx = {
	inject(services, callback) {
		if (services.includes('webServer')) callback(makeScope())
		if (services.includes('tools')) callback(makeScope({ register(definition) { captured.tool = definition; return () => {} } }))
	},
	get() {
		return undefined
	},
	effect(fn) {
		captured.effects += 1
		return fn()
	},
}

apply(ctx)
check('apply() registered the API prefix route', captured.route?.path === '/api/dsh-android-fixes' && captured.route?.kind === 'prefix')
check('apply() registered the android_compat tool', captured.tool?.name === 'android_compat')

function makeRequest(method, routePath, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
	return {
		method,
		url: routePath,
		headers: { host: '127.0.0.1:3080' },
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk
		},
	}
}
function makeResponse() {
	return {
		status: 0,
		payload: null,
		writeHead(status) {
			this.status = status
		},
		end(body) {
			this.payload = body === undefined ? null : JSON.parse(body)
		},
	}
}
async function call(method, routePath, body) {
	const response = makeResponse()
	await captured.route.handler(makeRequest(method, routePath, body), response)
	return response
}

const resolved = resolveDshDir(undefined)
const targets = {
	'flock-session-lock': ['@deepseek-ai/node-addon-system/lib/flock.js'],
	'session-log-hardlink': ['@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'],
	'attachment-hardlink': ['@deepseek-ai/dsh-attachment-local/lib/index.js'],
	'app-boot-native-addon': ['@deepseek-ai/dsh-app-boot/lib/index.js', '@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js'],
	'composer-enter': ['@deepseek-ai/dsh-client-ui-conversation/lib/client.js'],
}
const allFiles = Object.values(targets).flat()
const digests = (files) =>
	Object.fromEntries(files.map((rel) => [rel, fs.readFileSync(path.join(resolved.dir, 'node_modules', rel), 'utf8')]))
const markers = (files) => files.map((rel) => fs.readFileSync(path.join(resolved.dir, 'node_modules', rel), 'utf8').includes('dsh-android'))

console.log('\n1. GET /status through the plugin handler')
const statusResponse = await call('GET', '/api/dsh-android-fixes/status')
check('status is 200', statusResponse.status === 200, String(statusResponse.status))
check('status reports ok', statusResponse.payload?.ok === true, JSON.stringify(statusResponse.payload))
check('status lists ten fixes', statusResponse.payload?.items?.length === 10, String(statusResponse.payload?.items?.length))
check('five are toggleable patches', statusResponse.payload?.items?.filter((item) => item.toggleable).length === 5)
check('five are install-time facts', statusResponse.payload?.items?.filter((item) => item.kind === 'install').length === 5)
check('dsh version is reported', typeof statusResponse.payload?.dshVersion === 'string' && statusResponse.payload.dshVersion !== 'unknown')
for (const item of statusResponse.payload?.items ?? []) console.log(`       ${item.id.padEnd(24)} ${item.state}`)

if (!mutate) {
	console.log('\nread-only run: pass --mutate to exercise apply/revert on the real tree')
	console.log(failures.length === 0 ? '\nINTEGRATION PASSED' : `\nINTEGRATION FAILED (${failures.length})`)
	process.exit(failures.length === 0 ? 0 : 1)
}

const before = digests(allFiles)

console.log('\n2. POST /set disables one fix and restores the upstream bytes')
const disabled = await call('POST', '/api/dsh-android-fixes/set', { id: 'flock-session-lock', enabled: false })
check('disable is 200', disabled.status === 200, JSON.stringify(disabled.payload))
check('disable reports the file it rewrote', disabled.payload?.changed?.length === 1, JSON.stringify(disabled.payload?.changed))
check('the target no longer carries the marker', markers(targets['flock-session-lock'])[0] === false)
check('the file is shorter than the patched one', fs.readFileSync(path.join(resolved.dir, 'node_modules', targets['flock-session-lock'][0]), 'utf8').length < before[targets['flock-session-lock'][0]].length)

console.log('\n3. POST /set re-enables it and restores the patched bytes exactly')
const enabled = await call('POST', '/api/dsh-android-fixes/set', { id: 'flock-session-lock', enabled: true })
check('enable is 200', enabled.status === 200, JSON.stringify(enabled.payload))
check(
	'bytes are identical to the pre-test file',
	fs.readFileSync(path.join(resolved.dir, 'node_modules', targets['flock-session-lock'][0]), 'utf8') === before[targets['flock-session-lock'][0]],
)

console.log('\n4. POST /set-all false, then true, over every patch item')
const off = await call('POST', '/api/dsh-android-fixes/set-all', { enabled: false })
check('set-all false succeeded', off.payload?.ok === true, JSON.stringify(off.payload?.results?.filter((entry) => !entry.ok)))
check('no target carries the marker', markers(allFiles).every((value) => value === false))
const on = await call('POST', '/api/dsh-android-fixes/set-all', { enabled: true })
check('set-all true succeeded', on.payload?.ok === true, JSON.stringify(on.payload?.results?.filter((entry) => !entry.ok)))
const after = digests(allFiles)
check('every file is byte-identical to its pre-test content', allFiles.every((rel) => after[rel] === before[rel]), allFiles.filter((rel) => after[rel] !== before[rel]).join(', '))

console.log('\n5. error handling')
const unknown = await call('POST', '/api/dsh-android-fixes/set', { id: 'nope', enabled: true })
check('an unknown id is rejected', unknown.status === 400 && unknown.payload?.code === 'UNKNOWN_ITEM', JSON.stringify(unknown.payload))
const badBody = await call('POST', '/api/dsh-android-fixes/set', { id: 'flock-session-lock', enabled: 'yes' })
check('a non-boolean enabled is rejected', badBody.status === 400 && badBody.payload?.code === 'BAD_REQUEST', JSON.stringify(badBody.payload))
const missing = await call('GET', '/api/dsh-android-fixes/nope')
check('an unknown route is 404', missing.status === 404, String(missing.status))

console.log('\n6. POST /settings round-trips the auto-reapply flag')
const settingsFile = path.join(process.env.DSH_HOME ?? path.dirname(path.dirname(resolved.dir)), 'state', 'dsh-android-fixes', 'settings.json')
const previous = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null
const onResponse = await call('POST', '/api/dsh-android-fixes/settings', { autoReapplyOnStart: true })
check('settings write is acknowledged', onResponse.payload?.settings?.autoReapplyOnStart === true, JSON.stringify(onResponse.payload))
if (previous === null) fs.rmSync(settingsFile, { force: true })
else fs.writeFileSync(settingsFile, previous, 'utf8')
check('settings file restored to its previous content', previous === null ? !fs.existsSync(settingsFile) : fs.readFileSync(settingsFile, 'utf8') === previous)

console.log(failures.length === 0 ? '\nINTEGRATION PASSED' : `\nINTEGRATION FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
