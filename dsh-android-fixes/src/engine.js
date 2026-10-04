/**
 * File-patch engine for the Android/Termux compatibility fixes.
 *
 * The engine never guesses: it reads each target file, decides one of four
 * states from the exact anchors in `src/patches.js`, and refuses to write
 * anything unless **every** pair of every existing target matches exactly once.
 * A mismatch is reported as `blocked` and leaves the tree untouched, because a
 * half-applied patch is worse than an unapplied one.
 *
 * Reversal is the exact inverse substitution (`patchedText -> upstreamText`),
 * so switching a fix off restores the upstream bytes rather than a remembered
 * copy. A timestamped byte backup is written to `$DSH_HOME/state/dsh-android-fixes`
 * before any mutation as a second line of defence.
 *
 * @module src/engine
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { MARKER, PATCH_ITEMS } from './patches.js'

/** Harness home; honours `DSH_HOME` the way the rest of the process does. */
export function dshHome() {
	return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Directory this plugin owns for its own durable state and backups. */
export function stateDir() {
	return path.join(dshHome(), 'state', 'dsh-android-fixes')
}

function settingsFile() {
	return path.join(stateDir(), 'settings.json')
}

function backupDir() {
	return path.join(stateDir(), 'backups')
}

/** @returns {{autoReapplyOnStart: boolean, desired: Record<string, boolean>}} */
export function readSettings() {
	const fallback = { autoReapplyOnStart: false, desired: {} }
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
		const desired = parsed !== null && typeof parsed === 'object' && parsed.desired !== null && typeof parsed.desired === 'object' ? { ...parsed.desired } : {}
		return { autoReapplyOnStart: parsed?.autoReapplyOnStart === true, desired }
	} catch {
		return fallback
	}
}

/** Persist plugin settings; failures are reported to the caller, never thrown away. */
export function writeSettings(next) {
	fs.mkdirSync(stateDir(), { recursive: true })
	const tmp = path.join(stateDir(), `.settings.${process.pid}.tmp`)
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
	fs.renameSync(tmp, settingsFile())
}

/**
 * Locate the installed `@deepseek-ai/dsh` package.
 *
 * The profile's `node_modules` is not inside the dsh installation, so this is
 * resolved rather than derived: an explicit override first, then the loaded
 * `lib/bin.js` path, then Node resolution, then the Termux prefix.
 *
 * @param {string} [explicit] - `dshDir` from the plugin config, when set.
 * @returns {{dir: string} | {error: string}}
 */
export function resolveDshDir(explicit) {
	const candidates = []
	if (typeof explicit === 'string' && explicit.trim() !== '') candidates.push(explicit.trim())
	if (process.env.DSH_DIR) candidates.push(process.env.DSH_DIR)
	const argv1 = process.argv[1]
	if (typeof argv1 === 'string' && argv1.endsWith(path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
		candidates.push(path.resolve(path.dirname(argv1), '..'))
	}
	try {
		candidates.push(path.dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')))
	} catch {
		/* Not resolvable from this profile; the prefix candidates below still apply. */
	}
	for (const prefix of [process.env.DSH_PREFIX, process.env.PREFIX]) {
		if (prefix) candidates.push(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
	}
	for (const candidate of candidates) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'))
			if (manifest?.name === '@deepseek-ai/dsh') return { dir: candidate }
		} catch {
			/* Try the next candidate. */
		}
	}
	return { error: 'cannot locate the @deepseek-ai/dsh installation (set dshDir in this plugin config)' }
}

function countOccurrences(haystack, needle) {
	if (needle === '') return 0
	let count = 0
	let index = haystack.indexOf(needle)
	while (index !== -1) {
		count += 1
		index = haystack.indexOf(needle, index + needle.length)
	}
	return count
}

/** Absolute path of one patch target inside the dsh installation. */
export function targetPath(dshDir, target) {
	return path.join(dshDir, 'node_modules', target.package, target.file)
}

/**
 * Decide one target file's state without writing.
 *
 * @returns {{state: 'applied'|'ready'|'blocked'|'absent', abs: string, reason?: string, content?: string}}
 */
function analyzeFile(dshDir, target) {
	const abs = targetPath(dshDir, target)
	let content
	try {
		content = fs.readFileSync(abs, 'utf8')
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return { state: 'absent', abs }
		return { state: 'blocked', abs, reason: `cannot read: ${error?.message ?? error}` }
	}
	const patchedCounts = target.pairs.map((pair) => countOccurrences(content, pair[1]))
	if (patchedCounts.every((count) => count === 1)) return { state: 'applied', abs, content }
	const upstreamCounts = target.pairs.map((pair) => countOccurrences(content, pair[0]))
	if (upstreamCounts.every((count) => count === 1)) return { state: 'ready', abs, content }
	const detail = target.pairs
		.map((_pair, index) => `pair ${index + 1}: upstream ${upstreamCounts[index]}x, patched ${patchedCounts[index]}x`)
		.join('; ')
	const foreign = content.includes(MARKER)
		? `file already carries a "${MARKER}" marker but not this revision's exact text`
		: 'upstream anchors do not match'
	return { state: 'blocked', abs, content, reason: `${foreign} (${detail})` }
}

/**
 * Roll one item's target files up into a single reported state.
 *
 * `applied`   every existing target carries the patch;
 * `reverted`  every existing target is upstream and every anchor matches;
 * `partial`   some targets are patched and some are not;
 * `blocked`   at least one anchor set does not match — never written to;
 * `not-applicable` no target file exists in this dsh version.
 */
export function inspectPatchItem(item, dshDir) {
	const files = item.files.map((target) => {
		const result = analyzeFile(dshDir, target)
		return {
			rel: `${target.package}/${target.file}`,
			state: result.state,
			reason: result.reason,
			abs: result.abs,
			target,
			content: result.content,
		}
	})
	const states = new Set(files.map((file) => file.state))
	let state
	if (states.has('blocked')) state = 'blocked'
	else if (files.every((file) => file.state === 'absent')) state = 'not-applicable'
	else if (states.size === 1 && states.has('applied')) state = 'applied'
	else if ([...states].every((value) => value === 'ready' || value === 'absent')) state = 'reverted'
	else state = 'partial'
	return {
		id: item.id,
		kind: 'patch',
		state,
		toggleable: state !== 'not-applicable',
		targets: files.map((file) => file.rel),
		files: files.map(({ target, content, ...rest }) => rest),
	}
}

/* ------------------------------------------------------------------ writes */

/**
 * Snapshot one file before it is written.
 *
 * Backups are content-addressed (`<name>.<sha256-16>.bak`) rather than
 * timestamped: switching a fix on and off repeatedly then costs one backup per
 * distinct byte image instead of one per write, and the same upstream file
 * shared by two items is stored once.
 */
function snapshot(abs, rel, content) {
	const dir = path.join(backupDir(), path.dirname(rel))
	fs.mkdirSync(dir, { recursive: true })
	const digest = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
	const copy = path.join(dir, `${path.basename(rel)}.${digest}.bak`)
	if (!fs.existsSync(copy)) fs.copyFileSync(abs, copy)
	return copy
}

/** Write one file in place, preserving mode, through a same-directory temp file. */
function writeInPlace(abs, content) {
	const mode = fs.statSync(abs).mode & 0o7777
	const tmp = `${abs}.dsh-android-fixes.${process.pid}.tmp`
	fs.writeFileSync(tmp, content, { encoding: 'utf8', mode })
	fs.chmodSync(tmp, mode)
	fs.renameSync(tmp, abs)
}

/**
 * Apply or revert every existing target of one item.
 *
 * The plan is computed for all targets before the first byte is written, and a
 * failed write rolls the already-written targets back to their pre-call bytes,
 * so a partial failure never leaves a mixed tree behind.
 *
 * @param {object} item - registry entry from `src/patches.js`.
 * @param {string} dshDir - resolved dsh installation directory.
 * @param {boolean} enabled - true applies, false reverts.
 * @returns {{changed: string[], backups: string[]}}
 */
export function writePatchItem(item, dshDir, enabled) {
	const plan = []
	for (const target of item.files) {
		const analyzed = analyzeFile(dshDir, target)
		if (analyzed.state === 'absent') continue
		if (analyzed.state === 'blocked') {
			throw Object.assign(new Error(`${target.package}/${target.file}: ${analyzed.reason}`), { code: 'ANCHOR_MISMATCH' })
		}
		if (analyzed.state === (enabled ? 'applied' : 'ready')) continue
		let next = analyzed.content
		const pairs = enabled
			? target.pairs
			: [...target.pairs].reverse().map(([upstream, patched]) => [patched, upstream])
		for (const [from, to] of pairs) {
			const occurrences = countOccurrences(next, from)
			if (occurrences !== 1) {
				throw Object.assign(
					new Error(`${target.package}/${target.file}: expected exactly one match while rewriting, found ${occurrences}`),
					{ code: 'ANCHOR_MISMATCH' },
				)
			}
			next = next.replace(from, to)
		}
		if (!enabled && next.includes(MARKER)) {
			throw Object.assign(new Error(`${target.package}/${target.file}: marker survives the revert; refusing to write`), { code: 'ANCHOR_MISMATCH' })
		}
		plan.push({ abs: analyzed.abs, rel: `${target.package}/${target.file}`, before: analyzed.content, after: next })
	}
	const backups = []
	const done = []
	try {
		for (const step of plan) {
			backups.push(snapshot(step.abs, step.rel, step.before))
			writeInPlace(step.abs, step.after)
			done.push(step)
		}
	} catch (error) {
		for (const step of [...done].reverse()) {
			try {
				writeInPlace(step.abs, step.before)
			} catch {
				/* The backup written above is the recovery path for this target. */
			}
		}
		throw error
	}
	return { changed: plan.map((step) => step.rel), backups }
}

/** @returns {object[]} every patch item with its current state. */
export function inspectAllPatches(dshDir) {
	return PATCH_ITEMS.map((item) => inspectPatchItem(item, dshDir))
}

/** @returns {object|undefined} the registry entry with this id. */
export function patchItemById(id) {
	return PATCH_ITEMS.find((item) => item.id === id)
}
