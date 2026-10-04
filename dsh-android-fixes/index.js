/**
 * dsh-android-fixes — HOST half.
 *
 * Owns the Android/Termux compatibility fixes as *data* rather than as
 * install-time edits: `src/patches.js` lists the exact anchors the installer
 * used, `src/engine.js` applies and reverts them, `src/checks.js` reads the
 * facts that were decided at install time and cannot be switched. This half
 * exposes both to the browser half through one authenticated prefix route on
 * `webServer`, and to the agent through one tool that calls the same functions.
 *
 * Nothing here runs at apply time except registration, unless the user has
 * explicitly turned on "re-apply after an upgrade".
 *
 * @module @dsha/dsh-android-fixes
 */

import fs from 'node:fs'
import path from 'node:path'
import { inspectAllPatches, inspectPatchItem, patchItemById, readSettings, resolveDshDir, writePatchItem, writeSettings } from './src/engine.js'
import { inspectAllChecks } from './src/checks.js'
import { rejectionFor } from './src/trust.js'

/** Route prefix owned by this plugin; longer than `/api`, so it wins dispatch. */
const API_PREFIX = '/api/dsh-android-fixes'

function dshVersion(dshDir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8')).version
	} catch {
		return 'unknown'
	}
}

/** One full status document: every fix, plus the install-time facts. */
function buildStatus() {
	const resolved = resolveDshDir(undefined)
	if ('error' in resolved) {
		return { ok: false, error: resolved.error, items: [] }
	}
	const settings = readSettings()
	return {
		ok: true,
		dshDir: resolved.dir,
		dshVersion: dshVersion(resolved.dir),
		settings: { autoReapplyOnStart: settings.autoReapplyOnStart },
		items: [...inspectAllPatches(resolved.dir), ...inspectAllChecks(resolved.dir)],
	}
}

/** Apply or revert one item and report its fresh state. */
function setItem(id, enabled) {
	const resolved = resolveDshDir(undefined)
	if ('error' in resolved) return { ok: false, code: 'NO_DSH_DIR', error: resolved.error }
	const item = patchItemById(id)
	if (item === undefined) return { ok: false, code: 'UNKNOWN_ITEM', error: `unknown fix "${id}"` }
	try {
		const result = writePatchItem(item, resolved.dir, enabled === true)
		const settings = readSettings()
		settings.desired[id] = enabled === true
		writeSettings(settings)
		return { ok: true, changed: result.changed, backups: result.backups, item: inspectPatchItem(item, resolved.dir) }
	} catch (error) {
		return { ok: false, code: error?.code ?? 'WRITE_FAILED', error: error?.message ?? String(error), item: inspectPatchItem(item, resolved.dir) }
	}
}

/** Every toggleable fix at once; one blocked item never stops the others. */
function setAll(enabled) {
	const resolved = resolveDshDir(undefined)
	if ('error' in resolved) return { ok: false, code: 'NO_DSH_DIR', error: resolved.error, results: [] }
	const results = []
	for (const state of inspectAllPatches(resolved.dir)) {
		if (state.state === 'not-applicable') continue
		results.push({ id: state.id, ...setItem(state.id, enabled) })
	}
	return { ok: results.every((entry) => entry.ok), results }
}

/** Re-apply everything the user had switched on, after a dsh upgrade wiped it. */
function reconcileOnStart(log) {
	const settings = readSettings()
	if (!settings.autoReapplyOnStart) return
	const resolved = resolveDshDir(undefined)
	if ('error' in resolved) {
		log('warn', `cannot re-apply: ${resolved.error}`)
		return
	}
	for (const state of inspectAllPatches(resolved.dir)) {
		if (settings.desired[state.id] !== true) continue
		if (state.state === 'applied' || state.state === 'not-applicable') continue
		if (state.state === 'blocked') {
			log('warn', `${state.id}: upstream anchors changed, refusing to write`)
			continue
		}
		const outcome = setItem(state.id, true)
		log(outcome.ok ? 'info' : 'warn', outcome.ok ? `${state.id}: re-applied` : `${state.id}: ${outcome.error}`)
	}
}

async function readJson(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > 262144) throw new Error('request body too large')
		chunks.push(chunk)
	}
	if (size === 0) return {}
	const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object')
	return parsed
}

function createHandler(getConnection) {
	return async function handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/' : '/'
		const method = String(req.method ?? 'GET').toUpperCase()
		const send = (status, payload) => {
			res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
			res.end(JSON.stringify(payload))
		}
		let connection
		try {
			connection = getConnection()
		} catch {
			connection = undefined
		}
		const rejection = rejectionFor(req, connection)
		if (rejection !== undefined) return send(rejection, { ok: false, code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
		try {
			if (method === 'GET' && route === '/status') {
				const status = buildStatus()
				return send(status.ok ? 200 : 500, status)
			}
			if (method === 'POST' && route === '/set') {
				const body = await readJson(req)
				if (typeof body.id !== 'string' || body.id === '') return send(400, { ok: false, code: 'BAD_REQUEST', error: 'id is required' })
				if (typeof body.enabled !== 'boolean') return send(400, { ok: false, code: 'BAD_REQUEST', error: 'enabled must be a boolean' })
				const outcome = setItem(body.id, body.enabled)
				return send(outcome.ok ? 200 : outcome.code === 'ANCHOR_MISMATCH' ? 409 : 400, outcome)
			}
			if (method === 'POST' && route === '/set-all') {
				const body = await readJson(req)
				if (typeof body.enabled !== 'boolean') return send(400, { ok: false, code: 'BAD_REQUEST', error: 'enabled must be a boolean' })
				const outcome = setAll(body.enabled)
				return send(200, outcome)
			}
			if (method === 'POST' && route === '/settings') {
				const body = await readJson(req)
				const settings = readSettings()
				if (typeof body.autoReapplyOnStart === 'boolean') settings.autoReapplyOnStart = body.autoReapplyOnStart
				writeSettings(settings)
				return send(200, { ok: true, settings: { autoReapplyOnStart: settings.autoReapplyOnStart } })
			}
			return send(404, { ok: false, code: 'NOT_FOUND', error: `no such route: ${method} ${route}` })
		} catch (error) {
			return send(500, { ok: false, code: 'INTERNAL', error: error?.message ?? String(error) })
		}
	}
}

/** One agent-facing surface over the same operations the settings page uses. */
function registerTool(ctx, logger) {
	ctx.inject(['tools'], (scope) => {
		scope.effect(
			() =>
				scope.tools.register({
					name: 'android_compat',
					description:
						'Inspect and toggle the Android/Termux compatibility fixes of this DSH installation. `status` lists every fix with its kind (runtime-toggleable file patch vs. install-time fact), its current state, and what it targets. `enable`/`disable` apply or revert one runtime-toggleable patch by id and report the files it rewrote; they fail loudly when the upstream anchors moved instead of writing a half-patched file. Install-time facts cannot be changed here.',
					parameters: {
						type: 'object',
						properties: {
							action: { type: 'string', enum: ['status', 'enable', 'disable'], description: 'status lists everything; enable/disable change one patch by id.' },
							id: { type: 'string', description: 'Fix id from `status`, required by enable and disable.' },
						},
						required: ['action'],
						additionalProperties: false,
					},
					output: {
						schema: {
							type: 'object',
							properties: { summary: { type: 'string' } },
							required: ['summary'],
							additionalProperties: false,
						},
						render(_args, value) {
							return [{ type: 'text', text: value.summary }]
						},
					},
					execute(args) {
						if (args.action === 'status') {
							const status = buildStatus()
							return Promise.resolve({ summary: JSON.stringify(status, null, 2) })
						}
						if (typeof args.id !== 'string' || args.id === '') {
							return Promise.resolve({ summary: `android_compat: \`id\` is required for action "${args.action}"` })
						}
						const outcome = setItem(args.id, args.action === 'enable')
						if (!outcome.ok) logger('warn', `android_compat ${args.action} ${args.id} failed: ${outcome.error}`)
						return Promise.resolve({ summary: JSON.stringify(outcome, null, 2) })
					},
				}),
			'dsh-android-fixes: android_compat tool',
		)
	})
}

/**
 * Mount the host half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
	const logger = (level, message) => {
		const line = `dsh-android-fixes: ${message}`
		if (level === 'warn') console.warn(line)
		else console.log(line)
	}
	logger('info', 'host half active')
	try {
		reconcileOnStart(logger)
	} catch (error) {
		logger('warn', `startup reconcile failed: ${error?.message ?? error}`)
	}
	ctx.inject(['webServer'], (scope) => {
		scope.effect(
			() => scope.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: createHandler(() => ctx.get('connection')) }),
			'dsh-android-fixes: api routes',
		)
	})
	registerTool(ctx, logger)
}
