/**
 * Offline self-test for the patch engine.
 *
 * Builds a sandbox dsh tree out of the live installation by reversing the
 * patch pairs in memory, then exercises the full cycle there: inspect ->
 * apply -> revert -> blocked. Nothing under the real dsh installation is
 * written, so this is safe to run at any time.
 *
 * Usage: node scripts/selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectPatchItem, patchItemById, resolveDshDir, writePatchItem } from '../src/engine.js'
import { PATCH_ITEMS } from '../src/patches.js'
import { inspectAllChecks } from '../src/checks.js'

const failures = []
function check(label, condition, extra) {
	if (condition) {
		console.log(`  ok   ${label}`)
		return
	}
	failures.push(label)
	console.log(`  FAIL ${label}${extra === undefined ? '' : ` — ${extra}`}`)
}

const resolved = resolveDshDir(undefined)
if ('error' in resolved) {
	console.error(`cannot locate the dsh installation: ${resolved.error}`)
	process.exit(1)
}
const liveDir = resolved.dir
console.log(`live dsh: ${liveDir}`)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-android-fixes-selftest-'))
console.log(`sandbox:  ${sandbox}\n`)

/** Live patched bytes per target, for the byte-identity assertions. */
const live = new Map()
/** Sandbox upstream bytes per target, built by reversing the pairs. */
const pristine = new Map()
for (const item of PATCH_ITEMS) {
	for (const target of item.files) {
		const rel = `${target.package}/${target.file}`
		const abs = path.join(liveDir, 'node_modules', rel)
		if (!fs.existsSync(abs)) continue
		const patched = fs.readFileSync(abs, 'utf8')
		let upstream = patched
		for (const [oldText, newText] of [...target.pairs].reverse()) {
			if (!upstream.includes(newText)) throw new Error(`${rel}: live file does not carry the patched text`)
			upstream = upstream.replace(newText, oldText)
		}
		live.set(rel, patched)
		pristine.set(rel, upstream)
		const dest = path.join(sandbox, 'node_modules', rel)
		fs.mkdirSync(path.dirname(dest), { recursive: true })
		fs.writeFileSync(dest, upstream, 'utf8')
	}
}

console.log('1. inspect on an upstream tree')
for (const item of PATCH_ITEMS) {
	const state = inspectPatchItem(item, sandbox)
	check(`${item.id}: reverted`, state.state === 'reverted', state.state)
}

console.log('\n2. apply every item')
for (const item of PATCH_ITEMS) {
	try {
		writePatchItem(item, sandbox, true)
	} catch (error) {
		check(`${item.id}: apply`, false, error.message)
		continue
	}
	const state = inspectPatchItem(item, sandbox)
	check(`${item.id}: applied`, state.state === 'applied', state.state)
	const identical = item.files.every((target) => {
		const rel = `${target.package}/${target.file}`
		const dest = path.join(sandbox, 'node_modules', rel)
		return fs.readFileSync(dest, 'utf8') === live.get(rel)
	})
	check(`${item.id}: bytes identical to the installer's output`, identical)
}

console.log('\n3. revert every item')
for (const item of PATCH_ITEMS) {
	try {
		writePatchItem(item, sandbox, false)
	} catch (error) {
		check(`${item.id}: revert`, false, error.message)
		continue
	}
	const state = inspectPatchItem(item, sandbox)
	check(`${item.id}: reverted again`, state.state === 'reverted', state.state)
	const identical = item.files.every((target) => {
		const rel = `${target.package}/${target.file}`
		const dest = path.join(sandbox, 'node_modules', rel)
		return fs.readFileSync(dest, 'utf8') === pristine.get(rel)
	})
	check(`${item.id}: bytes identical to upstream`, identical)
}

console.log('\n4. a moved anchor must block and must not write')
const victim = patchItemById('flock-session-lock')
const victimRel = `${victim.files[0].package}/${victim.files[0].file}`
const victimAbs = path.join(sandbox, 'node_modules', victimRel)
const beforeCorruption = fs.readFileSync(victimAbs, 'utf8')
fs.writeFileSync(victimAbs, beforeCorruption.replace('export async function tryLockExclusive(fd) {', 'export async function tryLockExclusive(fd, options) {'), 'utf8')
const corrupted = fs.readFileSync(victimAbs, 'utf8')
check('blocked state is reported', inspectPatchItem(victim, sandbox).state === 'blocked')
let threw = false
try {
	writePatchItem(victim, sandbox, true)
} catch (error) {
	threw = error?.code === 'ANCHOR_MISMATCH'
}
check('apply refuses with ANCHOR_MISMATCH', threw)
check('the file was left untouched', fs.readFileSync(victimAbs, 'utf8') === corrupted)

console.log('\n5. install-time checks run without throwing')
const checks = inspectAllChecks(liveDir)
check('five checks reported', checks.length === 5, String(checks.length))
check(
	'every check returns a known state',
	checks.every((entry) => ['satisfied', 'unsatisfied', 'unknown', 'not-applicable'].includes(entry.state)),
	JSON.stringify(checks.map((entry) => [entry.id, entry.state])),
)
for (const entry of checks) console.log(`       ${entry.id}: ${entry.state}`)

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nSELFTEST PASSED' : `\nSELFTEST FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
