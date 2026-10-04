/**
 * dsh-android-fixes — CLIENT half.
 *
 * One Settings page that lists every Android/Termux compatibility fix with its
 * live state and, for the runtime-toggleable file patches, a switch. All state
 * and all writes live in the Host half; this page only reads
 * `GET /api/dsh-android-fixes/status` and posts to `/set`, `/set-all` and
 * `/settings`, so the page and the `android_compat` tool share one
 * implementation.
 *
 * Styling uses theme tokens only and no Harness Client package is imported;
 * React comes from the browser module table.
 *
 * @module @dsha/dsh-android-fixes/client
 */

window.__ModuleLoader__.load({
	id: '@dsha/dsh-android-fixes',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace owned by this plugin. */
		const NS = 'dsh-android-fixes'
		/** Route prefix served by the Host half. */
		const API = '/api/dsh-android-fixes'
		/** Style element id, so a reload replaces rather than stacks the rules. */
		const STYLE_ID = 'dsh-android-fixes-style'

		const CSS = `
.dshaf-row { display: flex; gap: 12px; padding: 14px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshaf-row:first-child { border-top: none; }
.dshaf-row-main { flex: 1 1 auto; min-width: 0; }
.dshaf-row-side { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }
.dshaf-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 1.5; }
.dshaf-desc { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; margin-top: 3px; }
.dshaf-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.6; margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.dshaf-pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 11px; line-height: 18px; white-space: nowrap; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dshaf-pill[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
.dshaf-pill[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.dshaf-pill[data-tone='bad'] { color: var(--dsw-alias-state-error-primary); }
.dshaf-pill[data-tone='idle'] { color: var(--dsw-alias-state-idle-primary); }
.dshaf-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dshaf-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l2); cursor: pointer; }
.dshaf-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dshaf-switch:disabled { cursor: default; opacity: .45; }
.dshaf-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshaf-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; }
.dshaf-switch[aria-checked='true'] .dshaf-thumb { transform: translateX(16px); }
.dshaf-btn { box-sizing: border-box; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.dshaf-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
.dshaf-btn:disabled { opacity: .45; cursor: default; }
.dshaf-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshaf-h2 { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; line-height: 1.5; margin: 26px 0 2px; }
.dshaf-lead { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; margin: 4px 0 0; }
.dshaf-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
.dshaf-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.6; margin-top: 10px; }
.dshaf-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.6; margin-top: 12px; }
`

		const zh = {
			nav: '安卓兼容',
			title: '安卓兼容修复',
			lead: '本页管理 DSH 在 Android/Termux 上的兼容修复。这些修复原本由安装脚本直接改文件实现，现在由插件持有：可以逐项检测、逐项开关；上游代码变动导致锚点失配时明确报错，绝不写出一个「只改了一半」的文件。',
			runtime: '可在运行时开关（文件补丁）',
			runtimeLead: '关闭会把文件还原成上游原样，开启会重新打上补丁。两者都是对当前磁盘内容的精确替换。',
			install: '安装期决定（只能检测，不能切换）',
			installLead: '这些事实在安装时就已经确定，运行中的 Harness 无法改变它们；插件只读取证据并给出结论。',
			refresh: '重新检测',
			enableAll: '全部开启',
			disableAll: '全部关闭',
			loading: '正在读取状态…',
			busy: '处理中…',
			failed: '无法读取状态：',
			state_applied: '已应用',
			state_reverted: '未应用',
			state_partial: '部分应用',
			state_blocked: '锚点失配',
			state_notApplicable: '不适用',
			state_satisfied: '已满足',
			state_unsatisfied: '未满足',
			state_unknown: '无法判定',
			targets: '目标文件',
			detail: '检测依据',
			autoReapply: '升级 dsh 后自动重新应用已开启的修复',
			autoReapplyHint: '升级会把打过补丁的文件覆盖回上游版本。打开后，插件在每次启动时按你的选择重新应用，锚点失配的项会跳过并告警。',
			restartHint: '文件补丁不会改变当前进程里已经加载的模块：改动在重启 dsh 之后生效。',
			dshLine: '已安装',
			versionUnknown: '未定位',
			item_flock_title: '会话锁降级为无锁',
			item_flock_desc: 'node-addon-system 只发布 darwin / linux 原生包，Android 上平台门禁直接抛 ERR_FLOCK_UNSUPPORTED_PLATFORM。补丁把它降级为「无锁可用」，等价 0.1.x：调用方仍然做 inode 比对。',
			item_session_title: '会话日志发布改用 rename',
			item_session_desc: '部分 Android ROM 禁用 link(2)，会话日志发布报 EACCES。补丁改用 rename 原子发布，并保留原 link 的 EEXIST 语义——调用方靠它判断「目标已存在，未发布新代」。',
			item_attachment_title: '附件发布 hardlink 兼容',
			item_attachment_desc: 'staged 附件发布之后紧跟着就 unlink 源文件，可以直接 rename；而内容寻址的「别名发布」必须保留源对象，改用 copyFile(..., COPYFILE_EXCL)——这里用 rename 会删掉源对象。',
			item_appboot_title: 'app-boot 原生 addon 兼容',
			item_appboot_desc: '0.1.6-alpha.2 起用 node-addon-require-builtin 读 Node 内部模块，而该 addon 没有 android 预编译包、包内也没有 C++ 源码。补丁改回 createRequire + --expose-internals，涉及 index.js 与 worker/profile-resolution-bootstrap.js 两个文件。',
			item_enter_title: '回车键 = 换行',
			item_enter_desc: 'Android 输入法没有 Shift+Enter。补丁让普通回车走编辑器默认行为（换行），只有 Ctrl/Cmd+Enter 或界面发送按钮才发送，并给作曲区设 enterkeyhint="newline"。官方设置项只覆盖「忙时回车」（queue/steer）；客户端插件拿不到作曲区编辑器实例（详见插件 README 的实测记录），所以这一项由插件持有文件补丁。',
			item_target_title: '编译目标 -target aarch64-linux-android30',
			item_target_desc: 'bionic 从 API 30 起才声明 statx()，否则 koffi 编译失败。这项只在安装时通过 CFLAGS/CXXFLAGS 生效，产物里不留下目标三元组；插件用「koffi / node-pty 已按 android-arm64 编译并能在本进程加载」作为证据。',
			item_allowscripts_title: '--allow-scripts 放行清单',
			item_allowscripts_desc: 'npm 默认拒绝执行原生构建脚本，必须显式放行 @deepseek-ai/dsh-subprocess-local、koffi、node-pty、@google/genai、protobufjs。npm 不在任何持久位置记录这个参数，插件以「这些包的原生构建产物确实存在」作为证据。',
			item_sharp_title: 'sharp WebAssembly 回退',
			item_sharp_desc: 'android-arm64 没有 libvips 原生包。0.1.x 里 sharp 是静态 import，加载失败会让整棵插件树加载失败、dsh 根本起不来；0.2.x 改成惰性 require，只影响图片与附件。检测 @img/sharp-wasm32 与 @emnapi 是否就位、sharp 能否加载。',
			item_wrapper_title: 'dsh 包装脚本（shebang + --expose-internals）',
			item_wrapper_desc: 'npm 只建软链，其 shebang 是 /usr/bin/env，而 Android 没有 /usr；另外 dsh 需要 --expose-internals 才能读 Node 内部模块。检测 $PREFIX/bin/dsh 的 shebang 与参数。',
			item_gyp_title: 'node-gyp android_ndk_path',
			item_gyp_desc: 'node-pty 的构建需要 node-gyp 的 common.gypi 里声明 android_ndk_path。同样是安装期补丁，检测 ~/.cache/node-gyp/<node 版本>/include/node/common.gypi。',
		}

		const en = {
			nav: 'Android',
			title: 'Android compatibility fixes',
			lead: 'This page manages the fixes that make DSH usable on Android/Termux. The installer used to edit these files directly; the plugin now owns them, so each fix can be inspected and switched individually, and an upstream anchor change is reported instead of writing a half-patched file.',
			runtime: 'Switchable at runtime (file patches)',
			runtimeLead: 'Switching off restores the upstream bytes; switching on re-applies the patch. Both are exact rewrites of what is on disk right now.',
			install: 'Decided at install time (detection only)',
			installLead: 'These facts were settled while the installer ran and a running Harness cannot change them; the plugin only reads evidence and reports a verdict.',
			refresh: 'Re-check',
			enableAll: 'Enable all',
			disableAll: 'Disable all',
			loading: 'Reading state…',
			busy: 'Working…',
			failed: 'Cannot read state: ',
			state_applied: 'Applied',
			state_reverted: 'Not applied',
			state_partial: 'Partly applied',
			state_blocked: 'Anchors moved',
			state_notApplicable: 'Not applicable',
			state_satisfied: 'Satisfied',
			state_unsatisfied: 'Unsatisfied',
			state_unknown: 'Undetermined',
			targets: 'Targets',
			detail: 'Evidence',
			autoReapply: 'Re-apply enabled fixes after a dsh upgrade',
			autoReapplyHint: 'An upgrade overwrites patched files with upstream bytes. With this on, the plugin re-applies what you switched on at every start, skipping any fix whose anchors moved and warning about it.',
			restartHint: 'A file patch does not change modules the current process already loaded: changes take effect after dsh restarts.',
			dshLine: 'Installed',
			versionUnknown: 'not located',
			item_flock_title: 'Session lock degrades to unlocked',
			item_flock_desc: 'node-addon-system ships only darwin/linux binaries and its platform gate throws ERR_FLOCK_UNSUPPORTED_PLATFORM on Android. The patch degrades it to "no lock available", exactly like 0.1.x, while callers keep doing their inode comparison.',
			item_session_title: 'Session log publication uses rename',
			item_session_desc: 'Some Android ROMs disable link(2), so session log publication fails with EACCES. The patch publishes with an atomic rename while preserving the original EEXIST contract, which callers read as "the target already exists, no new generation was published".',
			item_attachment_title: 'Attachment publication hardlink compatibility',
			item_attachment_desc: 'A staged attachment is unlinked right after publication, so rename is safe there; the content-addressed alias publication must keep the source object and uses copyFile(..., COPYFILE_EXCL) instead — renaming there would delete the source.',
			item_appboot_title: 'app-boot native addon compatibility',
			item_appboot_desc: 'Since 0.1.6-alpha.2 app-boot reads Node internals through node-addon-require-builtin, which has no android prebuild and ships no C++ source. The patch goes back to createRequire plus --expose-internals, in index.js and worker/profile-resolution-bootstrap.js.',
			item_enter_title: 'Enter inserts a newline',
			item_enter_desc: 'Android keyboards have no Shift+Enter. The patch lets plain Enter fall through to the editor default (a newline) and keeps Ctrl/Cmd+Enter or the on-screen Send button as the way to send, and sets enterkeyhint="newline" on the composer. The shipped setting only covers busy-Enter (queue/steer), and a Client plugin cannot reach the composer editor instance (see the plugin README), so the plugin owns this file patch.',
			item_target_title: 'Compile target -target aarch64-linux-android30',
			item_target_desc: 'bionic only declares statx() from API 30, and koffi fails to compile without it. The flag acts only at install time through CFLAGS/CXXFLAGS and leaves no target triple in the artefact, so the plugin reports the strongest available evidence: koffi and node-pty are built for android-arm64 and load in this process.',
			item_allowscripts_title: '--allow-scripts allow-list',
			item_allowscripts_desc: 'npm refuses to run native build scripts by default, so @deepseek-ai/dsh-subprocess-local, koffi, node-pty, @google/genai and protobufjs had to be allowed explicitly. npm records this flag nowhere durable, so the plugin uses the presence of those packages\u2019 native build outputs as evidence.',
			item_sharp_title: 'sharp WebAssembly fallback',
			item_sharp_desc: 'android-arm64 has no libvips binary. In 0.1.x sharp was a static import whose failure took the whole plugin tree down and dsh never started; 0.2.x makes it a lazy require that only affects images and attachments. Detects @img/sharp-wasm32 and @emnapi, and whether sharp loads.',
			item_wrapper_title: 'dsh wrapper (shebang + --expose-internals)',
			item_wrapper_desc: 'npm only creates a symlink whose shebang is /usr/bin/env, and Android has no /usr; dsh also needs --expose-internals to read Node internals. Checks the shebang and arguments of $PREFIX/bin/dsh.',
			item_gyp_title: 'node-gyp android_ndk_path',
			item_gyp_desc: 'Building node-pty needs android_ndk_path declared in node-gyp\u2019s common.gypi. Also an install-time patch; checks ~/.cache/node-gyp/<node version>/include/node/common.gypi.',
		}

		/** Item ids whose copy lives in this namespace, in display order. */
		const PATCH_ORDER = ['flock-session-lock', 'session-log-hardlink', 'attachment-hardlink', 'app-boot-native-addon', 'composer-enter']
		const CHECK_ORDER = ['android-compile-target', 'allow-scripts', 'sharp-wasm-fallback', 'dsh-wrapper', 'node-gyp-android-ndk']
		const COPY_KEY = {
			'flock-session-lock': 'flock',
			'session-log-hardlink': 'session',
			'attachment-hardlink': 'attachment',
			'app-boot-native-addon': 'appboot',
			'composer-enter': 'enter',
			'android-compile-target': 'target',
			'allow-scripts': 'allowscripts',
			'sharp-wasm-fallback': 'sharp',
			'dsh-wrapper': 'wrapper',
			'node-gyp-android-ndk': 'gyp',
		}
		/** Reported state -> pill tone; every other state reads as neutral. */
		const TONE = {
			applied: 'ok',
			satisfied: 'ok',
			reverted: 'idle',
			'not-applicable': 'idle',
			partial: 'warn',
			unknown: 'warn',
			blocked: 'bad',
			unsatisfied: 'bad',
		}
		const STATE_KEY = {
			applied: 'state_applied',
			reverted: 'state_reverted',
			partial: 'state_partial',
			blocked: 'state_blocked',
			'not-applicable': 'state_notApplicable',
			satisfied: 'state_satisfied',
			unsatisfied: 'state_unsatisfied',
			unknown: 'state_unknown',
		}

		function ensureStyles() {
			if (typeof document === 'undefined') return
			if (document.getElementById(STYLE_ID) !== null) return
			const element = document.createElement('style')
			element.id = STYLE_ID
			element.textContent = CSS
			document.head.appendChild(element)
		}

		function StatusPill(props) {
			const state = props.state
			const key = STATE_KEY[state]
			return h('span', { className: 'dshaf-pill', 'data-tone': TONE[state] ?? 'idle' }, props.t(key ?? state))
		}

		function Toggle(props) {
			return h('button', {
				type: 'button',
				className: 'dshaf-switch',
				role: 'switch',
				'aria-checked': props.checked,
				'aria-label': props.label,
				disabled: props.disabled,
				onClick: props.onChange,
			}, h('span', { className: 'dshaf-thumb' }))
		}

		function FixRow(props) {
			const item = props.item
			const key = COPY_KEY[item.id] ?? item.id
			const t = props.t
			const isPatch = item.kind === 'patch'
			const canToggle = isPatch && item.toggleable
			const checked = item.state === 'applied' || item.state === 'partial'
			return h('div', { className: 'dshaf-row' },
				h('div', { className: 'dshaf-row-main' },
					h('div', { className: 'dshaf-title' }, t(`item_${key}_title`)),
					h('div', { className: 'dshaf-desc' }, t(`item_${key}_desc`)),
					item.targets !== undefined && item.targets.length > 0
						? h('div', { className: 'dshaf-meta' }, `${t('targets')}: ${item.targets.join(', ')}`)
						: null,
					isPatch === false && item.detail !== undefined && item.detail !== ''
						? h('div', { className: 'dshaf-meta' }, `${t('detail')}: ${item.detail}`)
						: null,
					isPatch && item.files !== undefined && item.files.some((file) => file.reason !== undefined)
						? h('div', { className: 'dshaf-error' }, item.files.filter((file) => file.reason !== undefined).map((file) => `${file.rel}: ${file.reason}`).join(' | '))
						: null,
				),
				h('div', { className: 'dshaf-row-side' },
					h(StatusPill, { state: item.state, t }),
					canToggle
						? h(Toggle, {
								checked,
								disabled: props.busy,
								label: t(`item_${key}_title`),
								onChange: () => props.onToggle(item.id, checked === false),
							})
						: null,
				),
			)
		}

		function AndroidFixesPage() {
			const t = React.useContext(LocaleContext)
			const [status, setStatus] = React.useState(null)
			const [error, setError] = React.useState(null)
			const [busy, setBusy] = React.useState(false)

			const refresh = React.useCallback(async () => {
				setBusy(true)
				try {
					const response = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
					const payload = await response.json()
					if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
					setStatus(payload)
					setError(null)
				} catch (cause) {
					setError(cause?.message ?? String(cause))
				} finally {
					setBusy(false)
				}
			}, [])

			React.useEffect(() => {
				refresh()
			}, [refresh])

			const mutate = React.useCallback(
				async (path, body) => {
					setBusy(true)
					try {
						const response = await fetch(`${API}${path}`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(body),
						})
						await response.json()
						setError(null)
					} catch (cause) {
						setError(cause?.message ?? String(cause))
					} finally {
						await refresh()
					}
				},
				[refresh],
			)

			if (status === null) {
				return h('div', null,
					h('div', { className: 'dshaf-h2' }, t('title')),
					h('div', { className: 'dshaf-lead' }, error === null ? t('loading') : `${t('failed')}${error}`),
					error === null ? null : h('button', { className: 'dshaf-btn', type: 'button', onClick: refresh }, t('refresh')),
				)
			}

			const patches = PATCH_ORDER.map((id) => status.items.find((item) => item.id === id)).filter(Boolean)
			const checks = CHECK_ORDER.map((id) => status.items.find((item) => item.id === id)).filter(Boolean)
			const unchecked = patches.some((item) => item.state !== 'applied' && item.state !== 'not-applicable')

			const section = (heading, lead, items) =>
				h('div', null,
					h('div', { className: 'dshaf-h2' }, heading),
					h('p', { className: 'dshaf-lead' }, lead),
					items.map((item) => h(FixRow, { key: item.id, item, t, busy, onToggle: (id, enabled) => mutate('/set', { id, enabled }) })),
				)

			return h('div', null,
				h('div', { className: 'dshaf-h2', style: { marginTop: 0 } }, t('title')),
				h('p', { className: 'dshaf-lead' }, t('lead')),
				h('div', { className: 'dshaf-bar' },
					h('button', { className: 'dshaf-btn', type: 'button', disabled: busy, onClick: refresh }, busy ? t('busy') : t('refresh')),
					h('button', { className: 'dshaf-btn', type: 'button', disabled: busy || !unchecked, onClick: () => mutate('/set-all', { enabled: true }) }, t('enableAll')),
					h('button', { className: 'dshaf-btn', type: 'button', disabled: busy, onClick: () => mutate('/set-all', { enabled: false }) }, t('disableAll')),
				),
				h('div', { className: 'dshaf-note' }, `${t('dshLine')}: @deepseek-ai/dsh@${status.dshVersion} · ${status.dshDir}`),
				h('div', { className: 'dshaf-note' }, t('restartHint')),
				error === null ? null : h('div', { className: 'dshaf-error' }, `${t('failed')}${error}`),
				section(t('runtime'), t('runtimeLead'), patches),
				h('div', { className: 'dshaf-row' },
					h('div', { className: 'dshaf-row-main' },
						h('div', { className: 'dshaf-title' }, t('autoReapply')),
						h('div', { className: 'dshaf-desc' }, t('autoReapplyHint')),
					),
					h('div', { className: 'dshaf-row-side' },
						h(Toggle, {
							checked: status.settings.autoReapplyOnStart === true,
							disabled: busy,
							label: t('autoReapply'),
							onChange: () => mutate('/settings', { autoReapplyOnStart: status.settings.autoReapplyOnStart !== true }),
						}),
					),
				),
				section(t('install'), t('installLead'), checks),
			)
		}

		/** Fallback dictionary so the page still reads in Chinese naming only keys. */
		const LocaleContext = React.createContext((key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key))

		function apply(ctx) {
			ctx.effect(() => {
				ensureStyles()
				return () => {
					if (typeof document === 'undefined') return
					const element = document.getElementById(STYLE_ID)
					if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
				}
			}, 'dsh-android-fixes: styles')
			const locale = ctx.get === undefined ? undefined : ctx.get('locale')
			let t = (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key)
			let localeReady = false
			if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
				ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-android-fixes: dictionaries')
				const bound = locale.bind(NS)
				if (typeof bound === 'function') {
					t = bound
					localeReady = true
				}
			}
			const slots = ctx.get === undefined ? undefined : ctx.get('slots')
			if (slots === undefined) return
			slots.inject('settings.section', () =>
				slots.register(
					Object.assign(
						{ name: 'settings.section', id: 'dsh-android-fixes', order: 40, label: () => t('nav') },
						localeReady ? { locale: NS } : {},
					),
					() => h(LocaleContext.Provider, { value: t }, h(AndroidFixesPage, null)),
				),
			)
		}

		return { inject: ['slots'], apply }
	},
})
