/**
 * 离线自检：跑一遍真实的 lib/client.js 握手，检查两个槽位注册项与 commandUi 贡献。
 * 用法：node check-client-handshake.mjs
 */
import { pathToFileURL } from 'node:url'

const clientPath = new URL('../../lib/client.js', import.meta.url)
let handshake = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { handshake = spec } } }
await import(`${clientPath.href}?t=${Date.now()}`)

const React = {
	Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (factory) => factory(),
}
const mod = handshake.factory((name) => {
	if (name === 'react') return React
	throw new Error(`unexpected require: ${name}`)
})

const registrations = []
let contribution = null
mod.apply({
	slots: { inject: (name, factory) => factory(), register: (options) => { registrations.push(options); return () => {} } },
	commandUi: { register: (value) => { contribution = value; return () => {} } },
})

const inputLeft = registrations.find((row) => row.name === 'conversation.input.left')
const bundleConfig = registrations.find((row) => row.name === 'plugins.bundle.config')
console.log('槽位注册项：', registrations.map((row) => `${row.name}${row.key ? `[key=${row.key}]` : `[id=${row.id}]`}`).join('  '))
console.log('input.left 的 inject 是函数：', typeof inputLeft?.inject === 'function')
console.log('inject("S-123") 的回传：', JSON.stringify(inputLeft?.inject?.('S-123')))
console.log('plugins.bundle.config 的 key：', bundleConfig?.key)
console.log('commandUi 贡献：', contribution === null ? '（无）' : `${contribution.name} / label=${contribution.label()} / ui=${contribution.ui.kind} / icon=${typeof contribution.icon}`)
// ── 回归：受限 ctx（属性访问会抛）不得让 apply 抛 ──
// 2026-11-10 事故：客户端 apply 里直接读 `ctx.locale`，在浏览器的受限服务面上抛错，
// 表现是整个 web boot 变成 "1 entry did not activate"、GUI 白屏。
{
	const traps = []
	const restricted = new Proxy({ slots: { inject: () => {}, register: () => ({}) }, commandUi: { register: () => {} } }, {
		get(target, key) {
			if (key in target) return target[key]
			traps.push(String(key))
			throw new Error(`restricted service access: ${String(key)}`)
		},
	})
	let threw = null
	try {
		mod.apply(restricted)
	} catch (error) {
		threw = error
	}
	console.log('受限 ctx 下 apply 是否抛错：', threw === null ? '否 ✔' : `是 ✘ ${threw.message}`)
	console.log('被探测到的受限属性：', traps.join(',') || '（无）')
	if (threw !== null) process.exit(1)
}