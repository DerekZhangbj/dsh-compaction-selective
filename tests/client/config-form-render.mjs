/**
 * 离线复现 `plugins.bundle.config` 表单的 React error #31（对象当子节点）。
 *
 * 思路：`createElement(type, props, objectChild)` 自己不会抛 —— React 是在**渲染这棵树**时才抛的，
 * 所以组件里的 try/catch 抓不到（这正是上次「包了 try/catch 还是崩」的原因）。这里改成主动**遍历
 * 我构造出来的树**，逐个检查子节点是否是合法的 React 子节点（字符串/数字/元素/数组/null），
 * 一旦发现对象就把它的键、类型和父链打出来。
 *
 * 用法：node check-config-form-render.mjs
 */
import { pathToFileURL } from 'node:url'

const clientPath = new URL('../../lib/client.js', import.meta.url)

// 真实的 /state 响应（2026-10-16 从 http://127.0.0.1:3080/compaction-selective/state 抓的）
const REAL_STATE = JSON.parse(process.env.CS_STATE ?? 'null') ?? {   // 形状照 2026-10-16 抓的活响应（含那个对象字段）
	config: { enabled: true, minShadowedTokens: 3000, maxSurfaceShare: 0.6, approvalTimeoutMs: 180000, maxPerTurn: 1, foldSummary: true },
	origin: { enabled: 'default', minShadowedTokens: 'default', maxSurfaceShare: 'default', approvalTimeoutMs: 'default', maxPerTurn: 'default', foldSummary: 'default' },
	defaults: { enabled: true, minShadowedTokens: 3000, maxSurfaceShare: 0.6, approvalTimeoutMs: 180000, maxPerTurn: 1, foldSummary: true },
	types: { enabled: 'boolean', foldSummary: 'boolean', minShadowedTokens: 'integer', approvalTimeoutMs: 'integer', maxPerTurn: 'integer', maxSurfaceShare: 'ratio' },
	settingsPath: {},   // ← 2026-10-16 崩溃真因：这里曾是对象（设置文件的内容），不是路径
	configError: null,
	error: null,
	sessions: [],
	session: null,
}

const isElement = (value) => typeof value === 'object' && value !== null && value.type !== undefined

/** 收集树里所有文本（用来断言不该出现 [object Object]）。 */
function textsOf(node, out = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return out
	if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
	if (Array.isArray(node)) { for (const child of node) textsOf(child, out); return out }
	const children = node.props?.children
	if (children === undefined) return out
	for (const child of (Array.isArray(children) ? children : [children])) textsOf(child, out)
	return out
}

/** 树里是否挂了错误边界（渲染期异常只有它能接住）。 */
function hasBoundary(node) {
	if (node === null || node === undefined || typeof node !== 'object') return false
	if (Array.isArray(node)) return node.some(hasBoundary)
	if (typeof node.type === 'function' && /Boundary/.test(node.type.name ?? '')) return true
	const children = node.props?.children
	if (children === undefined) return false
	return (Array.isArray(children) ? children : [children]).some(hasBoundary)
}

/** 遍历树，返回所有非法子节点。 */
function findBadChildren(node, path, out = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return out
	if (typeof node === 'string' || typeof node === 'number') return out
	if (Array.isArray(node)) {
		node.forEach((child, index) => findBadChildren(child, `${path}[${index}]`, out))
		return out
	}
	if (isElement(node)) {
		const props = node.props ?? {}
		const childPath = `${path}>${typeof node.type === 'string' ? node.type : (node.type?.name ?? 'Component')}`
		for (const [key, value] of Object.entries(props)) {
			// style/props 里的对象是合法的；只查「会被当成子节点渲染」的位置
			if (key === 'children' || key === 'style') continue
		}
		const children = props.children !== undefined ? props.children : (node.c ?? [])
		const list = Array.isArray(children) ? children : [children]
		list.forEach((child, index) => {
			if (child === null || child === undefined || typeof child === 'boolean') return
			if (typeof child === 'string' || typeof child === 'number' || isElement(child) || Array.isArray(child)) {
				findBadChildren(child, `${childPath}[${index}]`, out)
				return
			}
			out.push({ path: `${childPath}[${index}]`, value: child })
		})
		return out
	}
	out.push({ path, value: node })
	return out
}

let handshake = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { handshake = spec } } }
await import(`${clientPath.href}?t=${Date.now()}`)

// 假 fetch：/state 返回上面的真实响应
globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes('/config') ? { ok: true, ...REAL_STATE } : REAL_STATE) })

/** 按调用序号注入 hook 取值：0 state / 1 error / 2 draft / 3 message / 4 busy */
function render(hookValues, props) {
	let index = 0
	const setCalls = []
	const React = {
		Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
		createElement: (type, props_, ...children) => ({ type, props: { ...props_, ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }),
		useState: (initial) => {
			const at = index
			index += 1
			const value = Object.hasOwn(hookValues, at) ? hookValues[at] : (typeof initial === 'function' ? initial() : initial)
			return [value, (next) => setCalls.push({ at, next })]
		},
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
		useRef: () => ({ current: null }),
	}
	const mod = handshake.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))
	let factory = null
	mod.apply({
		slots: { inject: (name, f) => f(), register: (options, f) => { if (options?.name === 'plugins.bundle.config') factory = f; return () => {} } },
		commandUi: { register: () => () => {} },
	})
	if (factory === null) throw new Error('没拿到 plugins.bundle.config 的组件')
	const element = factory()
	const wrapped = typeof element.type === 'function' && /Boundary/.test(element.type.name ?? '')
	const merged = { ...props, ...(element.props ?? {}) }
	const tree = (typeof element.type === 'function' && element.type.prototype !== undefined && typeof element.type.prototype.render === 'function')
		? new element.type(merged).render()
		: element.type(merged)
	return { tree, setCalls, wrapped }
}

const scenarios = [
	['读取中（state=null）', { 0: null }],
	['已加载（state=真实响应，draft=config）', { 0: REAL_STATE, 2: { ...REAL_STATE.config } }],
	['summary 视图', { 0: REAL_STATE, 2: { ...REAL_STATE.config } }, { view: 'summary' }],
	// 真实条件：框架把我注册的元素 clone 一遍并注入自己的 children（对象）——
	// 旧写法会把我的表单顶掉并让这个对象被当子节点渲染（React #31）。
	['框架注入了 children（对象）', { 0: REAL_STATE, 2: { ...REAL_STATE.config } }, { view: 'page', children: { entryKey: 'x', form: {} } }],
]

/**
 * 关键修正（2026-10-16）：上一版只走到错误边界那一层就停了 ——
 * `BundleConfigEntry` 返回的是 `h(SectionBoundary, null, h(PluginConfigSection, …))`，里面的组件**没有被调用**，
 * 所以我"树是干净的"结论只覆盖了外壳。React 会继续往下渲染，而崩溃就在更里面。
 * 这里按 React 的方式**递归渲染开**：函数组件直接调用、类组件调 `render()`，再逐层查子节点。
 */
function deepRender(node, hookValues, depth = 0) {
	if (node === null || node === undefined || typeof node === 'boolean') return node
	if (typeof node === 'string' || typeof node === 'number') return node
	if (Array.isArray(node)) return node.map((child) => deepRender(child, hookValues, depth))
	if (typeof node !== 'object' || node.type === undefined) return node
	const { type, props } = node
	if (typeof type === 'string') {
		const children = props?.children
		if (children === undefined) return node
		return { ...node, props: { ...props, children: deepRender(children, hookValues, depth + 1) } }
	}
	if (typeof type === 'function') {
		if (type.prototype !== undefined && typeof type.prototype.render === 'function') {
			const instance = new type(props ?? {})
			instance.props = props ?? {}
			instance.state = instance.state ?? {}
			const out = instance.render()
			return depth < 8 ? deepRender(out, hookValues, depth + 1) : out
		}
		const out = type(props ?? {})
		return depth < 8 ? deepRender(out, hookValues, depth + 1) : out
	}
	return node
}

let bad = 0
for (const [name, hooks, props] of scenarios) {
	const { tree } = render(hooks, props ?? { view: 'page' })
	const outer = findBadChildren(tree, 'root')       // ① 外壳
	let inner = []                                    // ② 渲染开之后的整棵树
	let renderFailure = null
	try {
		inner = findBadChildren(deepRender(tree, hooks), 'rendered')
	} catch (failure) {
		renderFailure = failure
	}
	if (renderFailure !== null) {
		bad += 1
		console.log(`  ✘ ${name}：渲染时直接抛错 —— ${renderFailure.message}`)
		continue
	}
	const problems = [...outer, ...inner]
	if (problems.length === 0) {
		// 再加一道：`[object Object]` 说明某个动态值不是字符串（2026-10-16 的崩溃就是这样露出来的）。
		const dumped = JSON.stringify(textsOf(deepRender(tree, hooks)))
		if (dumped.includes('[object Object]')) {
			bad += 1
			console.log(`  ✘ ${name}：页面里出现了 [object Object]（有动态值不是字符串）`)
			continue
		}
		console.log(`  ✔ ${name}：无非法子节点，也没有 [object Object]`)
		continue
	}
	bad += problems.length
	console.log(`  ✘ ${name}：发现 ${problems.length} 个非法子节点`)
	for (const problem of problems.slice(0, 5)) {
		const kind = problem.value === null ? 'null' : (problem.value?.constructor?.name ?? typeof problem.value)
		console.log(`     路径 ${problem.path}`)
		console.log(`     类型 ${kind}｜键 ${JSON.stringify(Object.keys(problem.value ?? {}))}`)
		console.log(`     预览 ${String(problem.value).slice(0, 140)}`)
	}
}
console.log(bad === 0 ? '结果：全部通过' : `结果：${bad} 个非法子节点`)
process.exit(bad === 0 ? 0 : 1)
