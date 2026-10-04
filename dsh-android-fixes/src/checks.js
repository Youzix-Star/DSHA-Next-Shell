/**
 * Install-time facts that cannot be switched at runtime.
 *
 * Everything here was decided while `install-dsh.sh` ran: the compiler target
 * and the script allow-list live only in the built artefacts, the sharp
 * fallback is a copied package tree, and the `dsh` wrapper is a generated file.
 * None of them can be toggled from a running Harness, so this module **reads
 * evidence** and reports `satisfied`, `unsatisfied`, `unknown` or
 * `not-applicable` — it never writes.
 *
 * @module src/checks
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

function exists(target) {
	try {
		fs.accessSync(target)
		return true
	} catch {
		return false
	}
}

function requireFrom(dshDir, id) {
	try {
		const loader = createRequire(path.join(dshDir, 'package.json'))
		const resolved = loader.resolve(id)
		loader(resolved)
		return { ok: true, resolved }
	} catch (error) {
		return { ok: false, error: String(error?.code ?? '') === 'ERR_MODULE_NOT_FOUND' ? 'not installed' : (error?.message ?? String(error)).split('\n')[0] }
	}
}

/** Native artefacts that only exist once a package's own build script has run. */
const NATIVE_ARTEFACTS = [
	{ id: 'node-pty', rel: 'node-pty/build/Release/pty.node', note: 'compiled from source (no android prebuild ships)' },
	{ id: 'koffi', rel: 'koffi/build/koffi/android_arm64/koffi.node', note: 'compiled for android-arm64' },
]

export const CHECK_ITEMS = [
	{
		id: 'android-compile-target',
		/** `-target aarch64-linux-android30` on CFLAGS/CXXFLAGS: bionic only declares statx() from API 30. */
		detect(dshDir) {
			const missing = NATIVE_ARTEFACTS.filter((entry) => !exists(path.join(dshDir, 'node_modules', entry.rel)))
			const load = NATIVE_ARTEFACTS.map((entry) => ({ entry, result: requireFrom(dshDir, entry.id) }))
			const broken = load.filter(({ result }) => !result.ok)
			if (missing.length === NATIVE_ARTEFACTS.length) {
				return { state: 'unsatisfied', detail: 'no android-arm64 native build found; the packages never compiled' }
			}
			if (missing.length > 0 || broken.length > 0) {
				const parts = [
					...missing.map((entry) => `${entry.id}: no ${entry.rel}`),
					...broken.map(({ entry, result }) => `${entry.id}: loads failed (${result.error})`),
				]
				return { state: 'unsatisfied', detail: parts.join('; ') }
			}
			return {
				state: 'satisfied',
				detail: `evidence: ${NATIVE_ARTEFACTS.map((entry) => `${entry.id} (${entry.note})`).join(' + ')} are present and load in-process. The compiler target itself leaves no marker in the artefact — koffi is the package that cannot compile without the API-30 target, so its presence is the strongest available proof.`,
			}
		},
	},
	{
		id: 'allow-scripts',
		/** `--allow-scripts=...` on the install command: without it pnpm refuses to run the native builds. */
		detect(dshDir) {
			if (!exists(path.join(dshDir, 'node_modules', 'node-pty'))) {
				return { state: 'not-applicable', detail: 'this dsh version has no node-pty dependency' }
			}
			const built = NATIVE_ARTEFACTS.filter((entry) => exists(path.join(dshDir, 'node_modules', entry.rel)))
			if (built.length === NATIVE_ARTEFACTS.length) {
				return {
					state: 'satisfied',
					detail: `evidence: ${built.map((entry) => `${entry.id} build output present`).join(', ')}. These only appear when each package's install script was allowed to run; npm records the flag nowhere durable.`,
				}
			}
			const absent = NATIVE_ARTEFACTS.filter((entry) => !exists(path.join(dshDir, 'node_modules', entry.rel)))
			return { state: 'unsatisfied', detail: `missing build output: ${absent.map((entry) => `${entry.id} (${entry.rel})`).join(', ')}` }
		},
	},
	{
		id: 'sharp-wasm-fallback',
		/** `@img/sharp-wasm32` copied in because android-arm64 has no libvips binary. */
		detect(dshDir) {
			const modules = path.join(dshDir, 'node_modules')
			if (!exists(path.join(modules, 'sharp'))) {
				return { state: 'not-applicable', detail: 'this dsh version does not depend on sharp' }
			}
			const wasm = exists(path.join(modules, '@img', 'sharp-wasm32'))
			const emnapi = exists(path.join(modules, '@emnapi'))
			const load = requireFrom(dshDir, 'sharp')
			if (load.ok && wasm && emnapi) {
				return { state: 'satisfied', detail: 'sharp loads and @img/sharp-wasm32 + @emnapi are present, so the WebAssembly fallback is what is running.' }
			}
			if (load.ok) {
				return { state: 'satisfied', detail: `sharp loads, but the wasm fallback tree is incomplete (sharp-wasm32: ${wasm ? 'present' : 'missing'}, @emnapi: ${emnapi ? 'present' : 'missing'}) — a native libvips path must be serving instead.` }
			}
			return { state: 'unsatisfied', detail: `sharp does not load (${load.error}); wasm32 ${wasm ? 'present' : 'missing'}, @emnapi ${emnapi ? 'present' : 'missing'}. Image and attachment features are unavailable.` }
		},
	},
	{
		id: 'dsh-wrapper',
		/** The generated `$PREFIX/bin/dsh`: Termux has no `/usr/bin/env`, and app-boot needs `--expose-internals`. */
		detect() {
			const prefix = process.env.PREFIX
			if (!prefix) return { state: 'unknown', detail: 'PREFIX is not set, so $PREFIX/bin/dsh cannot be located' }
			const wrapper = path.join(prefix, 'bin', 'dsh')
			let text
			try {
				text = fs.readFileSync(wrapper, 'utf8')
			} catch {
				return { state: 'unsatisfied', detail: `${wrapper} is missing; npm's own symlink would break on Termux` }
			}
			const shebang = text.split('\n', 1)[0]
			const envShebang = shebang.includes('/usr/bin/env')
			const expose = text.includes('--expose-internals')
			try {
				fs.accessSync(wrapper, fs.constants.X_OK)
			} catch {
				return { state: 'unsatisfied', detail: `${wrapper} is not executable` }
			}
			if (envShebang || !expose) {
				const parts = []
				if (envShebang) parts.push('shebang still goes through /usr/bin/env, which does not exist on Android')
				if (!expose) parts.push('--expose-internals is missing, so app-boot cannot read Node internals')
				return { state: 'unsatisfied', detail: parts.join('; ') }
			}
			return { state: 'satisfied', detail: `${wrapper}: ${shebang} + --expose-internals` }
		},
	},
	{
		id: 'node-gyp-android-ndk',
		/** Step 2 of the installer: `android_ndk_path` in node-gyp's common.gypi, needed to build node-pty. */
		detect() {
			const gyp = path.join(os.homedir(), '.cache', 'node-gyp', process.versions.node, 'include', 'node', 'common.gypi')
			let text
			try {
				text = fs.readFileSync(gyp, 'utf8')
			} catch {
				return { state: 'unknown', detail: `${gyp} not found; headers are installed lazily by \`npx node-gyp install\`` }
			}
			if (text.includes("'android_ndk_path%'")) {
				return { state: 'satisfied', detail: `android_ndk_path is declared in ${gyp}` }
			}
			return { state: 'unsatisfied', detail: `android_ndk_path is absent from ${gyp}; a future node-pty rebuild will fail` }
		},
	},
]

/** @returns {object[]} every install-time item with its freshly detected state. */
export function inspectAllChecks(dshDir) {
	return CHECK_ITEMS.map((item) => {
		try {
			const result = item.detect(dshDir)
			return { id: item.id, kind: 'install', state: result.state, toggleable: false, detail: result.detail, targets: [] }
		} catch (error) {
			return { id: item.id, kind: 'install', state: 'unknown', toggleable: false, detail: `detection failed: ${error?.message ?? error}`, targets: [] }
		}
	})
}
