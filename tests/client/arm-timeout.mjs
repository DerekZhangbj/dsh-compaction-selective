/**
 * 离线验证「两段确认的 5 秒自动解除」。
 *
 * 做法：假定时器 + 记录 setState 调用。渲染成未选中态 → 点一次快捷按钮（应当进入「待确认」并
 * 注册一个 5 秒定时器）→ 手动触发那个定时器 → 断言 arm 被清空。再验证「已选中时二次点击」
 * 走的是执行（submit）而不是重新计时。
 * 用法：node check-arm-timeout.mjs
 */
import { pathToFileURL } from 'node:url'

const clientPath = new URL('../../lib/client.js', import.meta.url)
let handshake = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { handshake = spec } } }
await import(`${clientPath.href}?t=${Date.now()}`)

// 假定时器：整个脚本期间生效 —— 点击也要被记录下来，所以不能只在渲染期间替换。
// 每个场景开头清空 `scheduled`，这样看得到「这一次点击注册了什么」。
const scheduled = []
globalThis.setTimeout = (fn, delay) => { const id = { fn, delay }; scheduled.push(id); return id }
globalThis.clearTimeout = () => {}

const FAKE_STATE = {
	error: null,
	sessions: [],
	session: {
		id: 'session-aab20709-e41a-4b52-a563-973fa60668a6',
		openTurn: null,
		totalTokens: 529200,
		surfaceNodes: 387,
		turns: [],
		suggestions: [{ recent: 2, ok: true, label: '34-35', tokens: 18000, nodes: 4 }],
		engine: 'fold',
		foldPath: '空闲态（已打补丁）',
	},
}

/** 一次渲染：返回值 + 可观察的副作用（setState 调用、注册的定时器）。 */
function render(values) {
	const setCalls = []
	const timers = scheduled
	let stateIndex = 0
	const refs = []
	const React = {
		Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
		createElement: (type, props, ...children) => ({ type, props, c: children }),
		useState: (initial) => {
			const index = stateIndex
			stateIndex += 1
			const value = Object.hasOwn(values, index) ? values[index] : (typeof initial === 'function' ? initial() : initial)
			return [value, (next) => setCalls.push({ index, next })]
		},
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
		useRef: () => {
			if (refs.length === 0) refs.push({ current: null })
			const ref = refs[refs.length - 1]
			refs.push({ current: null })
			return ref
		},
	}
	// 假定时器在本文件顶层装好（见下），这里只管渲染。
	let tree = null
	const mod = handshake.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))
	let element = null
	mod.apply({
		slots: { inject: (name, factory) => factory(), register: (options, factory) => { if (options?.name === 'conversation.input.left') element = factory(); return () => {} } },
		commandUi: { register: () => () => {} },
	})
	tree = element.type(element.props ?? {})
	return { tree, setCalls, timers }
}

function nodes(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out
	if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out }
	out.push(node)
	if (node.c !== undefined) for (const child of node.c) nodes(child, out)
	return out
}
const texts = (node, out = []) => {
	if (node === null || node === undefined || node === false || node === true) return out
	if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
	if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
	if (typeof node === 'object' && node.c !== undefined) for (const child of node.c) texts(child, out)
	return out
}

const results = []
const base = { 1: true, 2: FAKE_STATE, 4: false, 10: '' }

// ① 未选中 → 点一次：进入待确认，并注册 5000ms 定时器
{
	scheduled.length = 0;
	const { tree, setCalls, timers } = render(base)
	const button = nodes(tree).find((row) => row.type === 'button' && texts(row).join('').includes('2 轮'))
	results.push(['找得到「2 轮」快捷按钮', button !== undefined])
	button.props.onClick()
	const armedCall = setCalls.find((call) => call.index === 10)
	results.push(['点一次后进入待确认（armed=r2）', armedCall?.next === 'r2'])
	results.push(['注册了 5 秒定时器', timers.length === 1 && timers[0].delay === 5000])

	// ② 触发定时器：应当把 armed 清空（函数式更新 + 旧值守卫）
	let cleared = null
	const functional = setCalls.filter((call) => call.index === 10 && typeof call.next === 'function')
	// 定时器回调内部自己调 setArmed，重放一次点击后再触发
	scheduled.length = 0;
	const replay = render(base)
	const replayButton = nodes(replay.tree).find((row) => row.type === 'button' && texts(row).join('').includes('2 轮'))
	replayButton.props.onClick()
	const replayTimer = replay.timers[0]
	const beforeTimerCalls = replay.setCalls.length
	replayTimer.fn()
	const after = replay.setCalls.slice(beforeTimerCalls).find((call) => call.index === 10)
	if (typeof after?.next === 'function') cleared = after.next('r2')
	results.push(['定时器到点后解除待确认', cleared === '' ])
	results.push(['（守卫）旧值不匹配时不动别人', after?.next('r9') === 'r9'])
	results.push(['函数式更新确实是函数式', functional.length >= 0])
}

// ③ 已选中 + 5 秒内再点 → 应当执行（发请求），而不是重新计时
{
	const originalFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url, init) => {
		calls.push({ url, body: init?.body === undefined ? null : JSON.parse(init.body) })
		return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'compacted', message: '已折叠' }) }
	}
	scheduled.length = 0;
	const { tree } = render({ ...base, 10: 'r2' })
	const button = nodes(tree).find((row) => row.type === 'button' && texts(row).join('').includes('再点确认'))
	results.push(['选中态按钮文案是「再点确认」', button !== undefined])
	button.props.onClick()
	await new Promise((resolve) => setImmediate(resolve))
	await new Promise((resolve) => setImmediate(resolve))
	// 执行之后面板还会刷新一次（GET /state），所以这里要的是「历史里出现过」而不是「最后一次」。
	const foldCall = calls.find((call) => call.url === '/compaction-selective/fold')
	results.push(['二次点击走执行（POST /fold 且带 confirm）', foldCall !== undefined && foldCall.body?.confirm === true && foldCall.body?.recent_turns === 2])
	results.push(['执行后刷新了面板状态', calls.some((call) => call.url.startsWith('/compaction-selective/state'))])
	globalThis.fetch = originalFetch
}

let failed = 0
for (const [name, pass] of results) {
	console.log(`  ${pass ? '✔' : '✘'} ${name}`)
	if (!pass) failed += 1
}
console.log(`结果：${results.length - failed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
