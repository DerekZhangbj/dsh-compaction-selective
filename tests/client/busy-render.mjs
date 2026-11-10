/**
 * 离线渲染面板的「进行中」分支。
 *
 * 为什么要这么做：上一轮我两次「读代码觉得没问题」，结果都要等用户重启才发现不生效。
 * 这里用索引式 hook 桩**强制** busy=true，把 FoldButton 真渲染一遍，断言：
 *   · 出现「正在压缩…」状态块（面板路径与 ＋菜单路径的反馈要对齐）
 *   · 提示文案说明「关掉面板不会取消执行」
 *   · 执行中的那个按钮**不再是警示红**（红是「待确认」，看起来像报错）
 * 用法：node check-busy-render.mjs
 */
import { pathToFileURL } from 'node:url'

const clientPath = new URL('../../lib/client.js', import.meta.url)
let handshake = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { handshake = spec } } }
await import(`${clientPath.href}?t=${Date.now()}`)

// FoldButton 里 useState 的调用顺序（useRef 单独计数，不占号）：
// 0 domSessionId / 1 open / 2 state / 3 error / 4 busy / 5 pending / 6 dots / 7 result
// 8 from / 9 to / 10 armed / 11 hover / 12 chosen
const FAKE_STATE = {
	error: null,
	sessions: [],
	session: {
		id: 'session-aab20709-e41a-4b52-a563-973fa60668a6',
		openTurn: null,
		totalTokens: 529200,
		surfaceNodes: 387,
		turns: [],
		suggestions: [
			{ recent: 1, ok: false, message: '太小' },
			{ recent: 2, ok: true, label: '34-35', tokens: 18000, nodes: 4 },
		],
		engine: 'fold',
		foldPath: '空闲态（已打补丁）',
	},
}

function makeReact(values) {
	let stateIndex = 0
	return {
		Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
		createElement: (type, props, ...children) => ({ type, props, c: children }),
		useState: (initial) => {
			const index = stateIndex
			stateIndex += 1
			const value = Object.hasOwn(values, index) ? values[index] : (typeof initial === 'function' ? initial() : initial)
			return [value, () => {}]
		},
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
		useRef: () => ({ current: null }),
	}
}

/** 用给定的 hook 取值渲染一次展开的面板。 */
function render(values) {
	const React = makeReact(values)
	const mod = handshake.factory((name) => {
		if (name === 'react') return React
		throw new Error(`unexpected require: ${name}`)
	})
	let element = null
	mod.apply({
		slots: { inject: (name, factory) => factory(), register: (options, factory) => { if (options?.name === 'conversation.input.left') element = factory(); return () => {} } },
		commandUi: { register: () => () => {} },
	})
	if (element === null) throw new Error('没拿到 conversation.input.left 的组件')
	return element.type(element.props ?? {})
}

function texts(node, out = []) {
	if (node === null || node === undefined || node === false || node === true) return out
	if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
	if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
	if (typeof node === 'object' && node.c !== undefined) for (const child of node.c) texts(child, out)
	return out
}

/** 收集所有带文本的节点（用于按文本找按钮、看它的样式）。 */
function nodes(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out
	if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out }
	if (node.c !== undefined) {
		out.push(node)
		for (const child of node.c) nodes(child, out)
	}
	return out
}

const DANGER = 'var(--dsw-alias-state-error-primary, #d4685c)'
const base = { 1: true, 2: FAKE_STATE, 4: true, 5: 'turn 34-35（约 18.0k token）', 6: 2 }
const results = []

// 场景 A：区间按钮是正在执行的那一个
{
	const tree = render({ ...base, 10: 'range', 8: '34', 9: '35' })
	const all = texts(tree)
	const busyLine = all.find((text) => text.includes('正在压缩'))
	const rangeNode = nodes(tree).find((row) => texts(row).includes('正在压缩..') && row.type === 'button')
	results.push(['渲染没抛异常（区间场景）', true])
	results.push(['出现「正在压缩…」状态块', busyLine !== undefined])
	results.push(['省略号跟随 dots（此处两个点）', typeof busyLine === 'string' && busyLine.includes('正在压缩..')])
	results.push(['状态块写明正在折的范围', typeof busyLine === 'string' && busyLine.includes('turn 34-35')])
	results.push(['提示「关掉面板不会取消执行」', all.some((text) => text.includes('关掉面板不会取消执行'))])
	results.push(['区间按钮显示进度文案', rangeNode !== undefined])
	results.push(['区间按钮不再警示红', rangeNode !== undefined && rangeNode.props?.style?.color !== DANGER])
	const someDisabled = nodes(tree).some((row) => row.type === 'button' && row.props?.disabled === true)
	results.push(['执行中其它按钮被禁用', someDisabled])
}

// 场景 B：快捷按钮是正在执行的那一个
{
	const tree = render({ ...base, 10: 'r2' })
	const quickNode = nodes(tree).find((row) => row.type === 'button' && texts(row).includes('正在压缩..'))
	results.push(['快捷按钮显示进度文案', quickNode !== undefined])
	results.push(['快捷按钮不再警示红', quickNode !== undefined && quickNode.props?.style?.color !== DANGER])
}

// 场景 C：后端没有 compactRange（桌面端 app.asar 情形）→ 动作按钮禁用 + 给出对话指令指引
{
	const tree = render({ ...base, 10: '', 2: { ...FAKE_STATE, session: { ...FAKE_STATE.session, resolution: { how: 'service', candidates: 0, preset: 'skipped', service: 'hit', patched: false } } } })
	const all = texts(tree)
	const guide = all.find((text) => text.includes('这个环境不能直接点着折'))
	const buttons = nodes(tree).filter((row) => row.type === 'button')
	const actionButtons = buttons.filter((row) => ['压缩这段', '再点一次执行', '2 轮 ≈18.0k'].some((label) => texts(row).join('').includes(label)))
	results.push(['无补丁时显示对话指令指引', guide !== undefined])
	results.push(['无补丁时动作按钮全部禁用', actionButtons.length > 0 && actionButtons.every((row) => row.props?.disabled === true), `共 ${actionButtons.length} 个`])
}

let failed = 0
for (const [name, pass] of results) {
	console.log(`  ${pass ? '✔' : '✘'} ${name}`)
	if (!pass) failed += 1
}
console.log(`结果：${results.length - failed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
