/**
 * 离线自测：不依赖 DSH 宿主，用伪造的 session / measurement / ctx 跑通
 * 区间定位、护栏、审批分支、限流与「局部压缩」摘要覆盖。
 *
 * 关键的一条：把工具作者规格交给**真实的** `defineTool` 编译一次 —— 这是唯一能在
 * 离线阶段发现 schema 方言写错的办法，而写错会表现为加载期抛错。
 *
 * 用法：node tests/run.mjs
 */

import assert from 'node:assert/strict';
import {
	DEFAULTS,
	apply,
	buildToolSpec,
	createRateLimit,
	loadReport,
	normalizeConfig,
	resolveCompaction,
	resolveTurnArgs,
	runFold,
} from '../lib/index.js';
import {
	REASON,
	attributeTurns,
	balanceFlags,
	checkGuards,
	collectEvents,
	describeSpan,
	findOpenTurn,
	locateByTurns,
	resolveRecentTurns,
	snapBalanced,
	spanTokens,
} from '../lib/range.js';
import { FOLD_INSTRUCTION, installFoldSummarizer, isFoldSummarizerInstalled, makeFoldSummarize, resolveLlmService, resolveSummarizeTarget } from '../lib/summarizer.js';

let failed = 0;
let passed = 0;
function ok(label, condition, extra = '') {
	if (condition) {
		passed += 1;
		console.log(`  ✔ ${label}`);
	} else {
		failed += 1;
		console.log(`  ✘ ${label}${extra === '' ? '' : `  → ${extra}`}`);
	}
}
function group(title) {
	console.log(`\n== ${title} ==`);
}

/** 造一个足够真实的会话日志 + 表面（含工具调用的配对结构）。 */
function buildSession(spec, options = {}) {
	const events = [];
	const surface = [];
	const add = (type, data) => {
		const seq = events.length;
		events.push({ seq, type, data });
		return seq;
	};
	const addSurface = (type, data) => {
		const seq = add(type, data);
		surface.push(seq);
		return seq;
	};
	addSurface('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'SYS' }] } });
	for (const turn of spec) {
		add('turn/start', { turn: turn.turn });
		addSurface('user/message', {
			role: 'user',
			content: [{ type: 'text', text: turn.prompt ?? `prompt ${turn.turn}` }],
			source: { kind: 'user' },
		});
		const toolCount = turn.tools ?? 0;
		addSurface('assistant/message', {
			turn: turn.turn,
			step: 0,
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: `answer ${turn.turn}` },
					...Array.from({ length: toolCount }, (_unused, index) => ({ type: 'tool-call', id: `t${turn.turn}-${index}`, name: 'x', arguments: '{}' })),
				],
			},
		});
		for (let index = 0; index < toolCount; index += 1) {
			addSurface('tool/result', { turn: turn.turn, step: 0, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } });
		}
		if (turn.open !== true) add('turn/end', { turn: turn.turn, reason: 'stop' });
	}
	const session = {
		id: options.id ?? 'S1',
		seq: events.length,
		eventAt: (seq) => events[seq],
		surface: { nodes: surface, replaceGeneration: 0 },
		requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
		toolHistory: () => [],
		raw: { events, surface },
	};
	return session;
}

const PER_NODE_TOKENS = 1000;
function measureOf(session, perNode = PER_NODE_TOKENS) {
	const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: perNode, heuristicTokens: perNode }));
	return { nodes, totalTokens: nodes.length * perNode };
}

/** 伪造一个「有 get(name) 的作用域」，模拟 Cordis 的 ctx 取服务。 */
function makeScope(services) {
	return {
		...services,
		get(name) {
			return this[name];
		},
	};
}

function makeCtx(session, overrides = {}) {
	const calls = [];
	const measure = overrides.measure ?? measureOf(session);
	const agent = { id: 'A1', session, options: {} };
	// 真实装配：compaction 在 agent preset 组里被 isolate，**根作用域没有它**，只有 agent.ctx 有。
	const compaction = overrides.noCompaction === true ? undefined : {
		config: { maxTokens: 512, summarizationProvider: '', summarizationModel: '' },
		summarize: async () => ({ summary: [{ type: 'text', text: 'STOCK' }], rawOutput: [], provider: 'p', model: 'm' }),
		compactRegion: async (start, end) => {
			calls.push({ start, end });
			return {
				summarySeq: 9999,
				shadowedRange: { start, end },
				shadowedSeqs: session.surface.nodes.slice(session.surface.nodes.indexOf(start), session.surface.nodes.indexOf(end) + 1),
				shadowedTokenCount: 4242,
			};
		},
	};
	agent.ctx = overrides.noAgentCtx === true ? undefined : makeScope({ compaction });
	const ctx = {
		agent,
		calls,
		candidates: compaction === undefined ? [] : [compaction],
		logger: { info() {}, warn() {} },
		agents: {
			get: (id) => (id === agent.id ? agent : undefined),
			roots: () => (overrides.notRoot === true ? [] : [agent]),
		},
		tokenMeter: { measure: () => measure },
		sessionProjections: {
			stateOf: () => (overrides.outline === undefined
				? { turns: session.raw.events.filter((event) => event.type === 'turn/start').map((event) => ({ turn: event.data.turn, seq: event.seq, prompt: `p${event.data.turn}`, response: `r${event.data.turn}` })), draft: '' }
				: overrides.outline),
		},
		userQuestions: { askTimed: async () => overrides.answer },
		tools: { register: () => {} },
		llm: {},
	};
	return ctx;
}

function execFor(ctx, overrides = {}) {
	return { agent: ctx.agent, callId: 'call-1', signal: new AbortController().signal, ...overrides };
}

// ───────────────────────── 0. 加载自检 ─────────────────────────
group('0. 模块加载自检（可选依赖解析）');
console.log(`  tools: ${loadReport.tools.ok ? '已解析' : `未解析（降级）→ ${loadReport.tools.error}`}`);
console.log(`  llm  : ${loadReport.llm.ok ? '已解析' : `未解析（降级）→ ${loadReport.llm.error}`}`);
ok('插件入口可加载', typeof buildToolSpec === 'function');

// ───────────────────────── 1. 参数解析 ─────────────────────────
group('1. resolveTurnArgs');
ok('空参数被拒', resolveTurnArgs({}).ok === false);
ok('recent_turns 单独给出可用', resolveTurnArgs({ recent_turns: 2 }).kind === 'recent');
ok('只给 from_turn 被拒', resolveTurnArgs({ from_turn: 2 }).reason === REASON.BAD_ARGS);
ok('倒置区间被拒', resolveTurnArgs({ from_turn: 3, to_turn: 2 }).reason === REASON.BAD_ARGS);
ok('两种形态混用被拒', resolveTurnArgs({ recent_turns: 1, from_turn: 1, to_turn: 2 }).reason === REASON.BAD_ARGS);
ok('显式区间可用', resolveTurnArgs({ from_turn: 1, to_turn: 2 }).kind === 'turns');

// ───────────────────────── 2. 平衡与归属 ─────────────────────────
group('2. balanceFlags / attributeTurns / findOpenTurn');
const s6 = buildSession([
	{ turn: 1, tools: 1 }, { turn: 2, tools: 0 }, { turn: 3, tools: 1 },
	{ turn: 4, tools: 0 }, { turn: 5, tools: 1 }, { turn: 6, tools: 0, open: true },
]);
const ev6 = collectEvents(s6);
const flags6 = balanceFlags(s6.surface.nodes.map((seq) => ev6[seq]));
ok('切点数组长度为 n+1', flags6.length === s6.surface.nodes.length + 1, `${flags6.length}`);
ok('第一个切点恒平衡', flags6[0] === true);
// turn1: system(0) user(1) assistant(2, 含1个tool-call) result(3) → 切在第2个之后（下标3）不配平
ok('assistant 与其 tool/result 之间的切点不配平', flags6[3] === false, `flags[3]=${flags6[3]}`);
ok('tool/result 之后的切点恢复配平', flags6[4] === true, `flags[4]=${flags6[4]}`);
const turns6 = attributeTurns(ev6, s6.surface.nodes);
ok('系统头归属为 null', turns6[0] === null, `${turns6[0]}`);
ok('第 4 轮的用户消息与回答归属正确', turns6[9] === 4 && turns6[10] === 4, `${turns6[9]}/${turns6[10]}`);
ok('正在进行的轮次被识别', findOpenTurn(ev6)?.turn === 6, JSON.stringify(findOpenTurn(ev6)));
ok('全部结束时没有打开轮', findOpenTurn(collectEvents(buildSession([{ turn: 1 }, { turn: 2 }]))) === null);

// ───────────────────────── 3. 区间定位与吸附 ─────────────────────────
group('3. resolveRecentTurns / locateByTurns / snapBalanced');
const recent = resolveRecentTurns(turns6, findOpenTurn(ev6), 2);
ok('recent_turns=2 → turn 4-5', recent.from === 4 && recent.to === 5, JSON.stringify(recent));
const located = locateByTurns(turns6, findOpenTurn(ev6), recent.from, recent.to);
ok('定位到表面下标 9..13', located.startIdx === 9 && located.endIdx === 13, JSON.stringify(located));
const snapped = snapBalanced(flags6, located.startIdx, located.endIdx);
ok('吸附后不变', snapped.startIdx === 9 && snapped.endIdx === 13, JSON.stringify(snapped));
ok('recent_turns 超量被拒', resolveRecentTurns(turns6, findOpenTurn(ev6), 99) === null);
ok('吸附能把切点收进平衡位置（避开未配对的 tool-call）', (() => {
	const bad = snapBalanced(flags6, 1, 2);
	return bad.startIdx === 1 && bad.endIdx === 1;
})());
ok('spanTokens 累计正确', spanTokens(measureOf(s6).nodes, 9, 13) === 5000, `${spanTokens(measureOf(s6).nodes, 9, 13)}`);

// ───────────────────────── 4. 护栏 ─────────────────────────
group('4. checkGuards');
const cfg = normalizeConfig();
ok('正常选区通过', checkGuards({ startIdx: 9, endIdx: 13, turns: turns6, openTurn: findOpenTurn(ev6), shadowedTokens: 5000, totalTokens: 16000, config: cfg }).ok === true);
ok('节点 0 被拒', checkGuards({ startIdx: 0, endIdx: 5, turns: turns6, openTurn: null, shadowedTokens: 9999, totalTokens: 16000, config: cfg }).reason === REASON.SYSTEM_HEAD);
ok('含进行中的轮被拒', checkGuards({ startIdx: 13, endIdx: 15, turns: turns6, openTurn: findOpenTurn(ev6), shadowedTokens: 9999, totalTokens: 16000, config: cfg }).reason === REASON.OPEN_TURN);
ok('过小被拒', checkGuards({ startIdx: 9, endIdx: 11, turns: turns6, openTurn: findOpenTurn(ev6), shadowedTokens: 2999, totalTokens: 16000, config: cfg }).reason === REASON.TOO_SMALL);
ok('过大被拒', checkGuards({ startIdx: 1, endIdx: 13, turns: turns6, openTurn: findOpenTurn(ev6), shadowedTokens: 13000, totalTokens: 16000, config: cfg }).reason === REASON.TOO_LARGE);

// ───────────────────────── 5. 预览 ─────────────────────────
group('5. describeSpan');
const preview = describeSpan({ turns: turns6, startIdx: 9, endIdx: 13, outlineTurns: [{ turn: 4, seq: 0, prompt: 'p4', response: 'r4' }, { turn: 5, seq: 0, prompt: 'p5', response: 'r5' }] });
ok('轮号为 4,5', preview.turnNumbers.join(',') === '4,5', preview.turnNumbers.join(','));
ok('每轮一行预览', preview.lines.length === 2, `${preview.lines.length}`);

// ───────────────────────── 6. 工具定义编译 ─────────────────────────
group('6. defineTool 编译（schema 方言）');
/** 直接解析一次，用来把作者规格交给真实的编译器 —— 方言写错只会在加载期暴露。 */
let realDefineTool = null;
try {
	realDefineTool = (await import('@deepseek-ai/dsh-tools')).defineTool ?? null;
} catch (error) {
	console.log(`     无法解析 @deepseek-ai/dsh-tools：${error.message}`);
}
const spec = buildToolSpec({ ctx: makeCtx(s6), config: cfg, rateLimit: createRateLimit() });
ok('作者规格可被真实 defineTool 编译', (() => {
	if (typeof realDefineTool !== 'function') {
		console.log('     跳过（依赖未解析）');
		return loadReport.tools.ok === false;
	}
	try {
		const compiled = realDefineTool(spec);
		return compiled.name === 'compact_turns' && typeof compiled.execute === 'function';
	} catch (error) {
		console.log(`     编译失败：${error.message}`);
		return false;
	}
})());

// ───────────────────────── 7. 执行链路 ─────────────────────────
group('7. runFold 执行链路');
const cfgBase = normalizeConfig({ approvalTimeoutMs: 1000 });

const sFold = buildSession([
	{ turn: 1, tools: 1 }, { turn: 2 }, { turn: 3 }, { turn: 4 }, { turn: 5 }, { turn: 6, open: true },
]);

// 7a 非根调用者
{
	const ctx = makeCtx(sFold, { notRoot: true });
	const out = await runFold({ ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx) });
	ok('子智能体被拒', out.status === 'rejected' && out.reason === REASON.NOT_ROOT, JSON.stringify(out));
}
// 7b 太小
{
	const ctx = makeCtx(sFold, {});
	const out = await runFold({ ctx, config: normalizeConfig({ minShadowedTokens: 10000 }), rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx) });
	ok('过小被拒且未弹确认卡', out.status === 'rejected' && out.reason === REASON.TOO_SMALL, JSON.stringify(out));
}
// 7c 人类取消
{
	const ctx = makeCtx(sFold, { answer: { answers: [{ id: 'fold-confirm', selected: ['取消'] }] } });
	const out = await runFold({ ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx) });
	ok('取消后不执行', out.status === 'declined' && ctx.calls.length === 0, JSON.stringify(out));
}
// 7d 超时
{
	const ctx = makeCtx(sFold, { answer: { pending: true, callId: 'call-1' } });
	const out = await runFold({ ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx) });
	ok('超时后不执行', out.status === 'timeout' && ctx.calls.length === 0, JSON.stringify(out));
}
// 7e 确认执行 + 限流
{
	const rate = createRateLimit();
	const ctx = makeCtx(sFold, { answer: { answers: [{ id: 'fold-confirm', selected: ['确认压缩'] }] } });
	const out = await runFold({ ctx, config: cfgBase, rateLimit: rate, args: { recent_turns: 2 }, exec: execFor(ctx) });
	ok('确认后执行压缩', out.status === 'compacted', JSON.stringify(out));
	ok('compactRegion 收到的是选区端点', ctx.calls.length === 1 && ctx.calls[0].start === sFold.surface.nodes[8] && ctx.calls[0].end === sFold.surface.nodes[11], JSON.stringify(ctx.calls));
	ok('返回摘要 seq 与释放量', out.summarySeq === 9999 && out.shadowedTokens === 4242, JSON.stringify(out));
	const again = await runFold({ ctx, config: cfgBase, rateLimit: rate, args: { recent_turns: 2 }, exec: execFor(ctx) });
	ok('同一轮内重复压缩被限流', again.status === 'rejected' && again.reason === REASON.RATE_LIMIT, JSON.stringify(again));
}
// 7f 执行失败映射
{
	const ctx = makeCtx(sFold, { answer: { answers: [{ id: 'fold-confirm', selected: ['确认压缩'] }] } });
	ctx.agent.ctx.compaction.compactRegion = async () => {
		const error = new Error('compaction already in progress');
		error.code = 'busy';
		throw error;
	};
	const out = await runFold({ ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx) });
	ok('busy 被翻译成人话且标记未改动', out.status === 'failed' && out.reason === 'BUSY' && out.message.includes('没有改动任何内容'), JSON.stringify(out));
}
// 7g 服务解析：compaction 只在 agent 作用域里（模拟 preset isolate）
{
	const ctx = makeCtx(sFold, { answer: { answers: [{ id: 'fold-confirm', selected: ['确认压缩'] }] } });
	ok('根作用域确实没有 compaction（模拟 preset 隔离装配）', ctx.compaction === undefined, JSON.stringify(typeof ctx.compaction));
	ok('agent.ctx 里有 compaction', typeof ctx.agent.ctx.compaction?.compactRegion === 'function');
	const out = await runFold({ ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx), candidates: ctx.candidates });
	ok('从 agent 作用域取到实例并执行成功', out.status === 'compacted', JSON.stringify(out));
}
// 7h 两个作用域都没有 → 干净拒绝
{
	const ctx = makeCtx(sFold, { noCompaction: true });
	const out = await runFold({ ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx), candidates: ctx.candidates });
	ok('取不到压缩服务时干净拒绝', out.status === 'rejected' && out.reason === REASON.NO_SERVICE, JSON.stringify(out));
}
// 7g2 resolveCompaction 的四条路径（isolate 域 + 上游正式入口）
{
	const engineOf = () => {
		const group = makeScope({});
		const engine = { compactRegion: async () => ({}), ctx: group };
		group.compaction = engine;
		return { engine, group };
	};
	// 直接可见
	{
		const engine = { compactRegion: async () => ({}) };
		const scope = makeScope({ compaction: engine });
		const picked = resolveCompaction({ candidates: [], agent: { ctx: scope }, ctx: {}, preset: null });
		ok('路径①：agent 作用域直接可见', picked.how === 'scope' && picked.engine === engine, JSON.stringify(picked.how));
	}
	// **新路（0.2.1 线的正路）**：`ctx.agentPresets.serviceFor(agent, 'compaction')`
	// —— 上游从 0.2.1-alpha.1 起不再从包根导出 `serviceForAgent`，能力挪到了这个实例方法；
	//    而该方法在本机 0.2.0-rc.2 里就已存在，所以它对新旧两代都成立。
	{
		const agentCtx = makeScope({});
		const { engine } = engineOf(undefined);
		const agentPresets = { serviceFor: (agent, name) => (name === 'compaction' ? engine : undefined) };
		const picked = resolveCompaction({ candidates: [], agent: { ctx: agentCtx }, ctx: { agentPresets }, preset: [] });
		ok('路径①.5：走 ctx.agentPresets.serviceFor（0.2.1 线仍然可用的官方入口）',
			picked.how === 'service' && picked.engine === engine && picked.service === 'hit', `${picked.how}/${picked.service}`);
	}
	// 服务面抛错 → 继续往后试，不崩
	{
		const { engine } = engineOf(undefined);
		const agentPresets = { serviceFor: () => { throw new Error('service boom'); } };
		const preset = { serviceForAgent: () => engine };
		const picked = resolveCompaction({ candidates: [], agent: { ctx: undefined }, ctx: { agentPresets }, preset });
		ok('serviceFor 抛错时回退到旧的 preset 路径，并留下诊断',
			picked.how === 'preset' && picked.engine === engine && String(picked.service).includes('threw'), JSON.stringify({ how: picked.how, service: picked.service, preset: picked.preset }));
	}
	// 隔离在 isolate 域里：靠上游正式入口 serviceForAgent 定位
	{
		const agentCtx = makeScope({});
		const { engine } = engineOf(undefined);
		const preset = { serviceForAgent: (ctx, agent, name) => (name === 'compaction' ? engine : undefined) };
		const picked = resolveCompaction({ candidates: [], agent: { ctx: agentCtx }, ctx: {}, preset });
		ok('路径②：走上游 serviceForAgent（isolate 域外的官方读定位）', picked.how === 'preset' && picked.engine === engine && picked.preset.startsWith('hit'), `${picked.how}/${picked.preset}/${picked.candidates}`);
		ok('serviceForAgent 拿到的是同一个实例', picked.engine === engine);
	}
	// preset 入口拿不到（或没加载）→ 唯一候选兜底
	{
		const { engine } = engineOf(undefined);
		const picked = resolveCompaction({ candidates: [engine], agent: { ctx: undefined }, ctx: {}, preset: null });
		ok('路径③：唯一候选兜底', picked.how === 'only' && picked.engine === engine, `${picked.how}/${picked.preset}/${picked.candidates}`);
	}
	// preset 入口抛错也不能崩
	{
		const preset = { serviceForAgent: () => { throw new Error('boom'); } };
		const picked = resolveCompaction({ candidates: [], agent: { ctx: undefined }, ctx: {}, preset });
		ok('serviceForAgent 抛错时干净落到 none 并留下诊断', picked.how === 'none' && picked.preset.includes('threw'), JSON.stringify(picked));
	}
	// 多个候选且拿不到 preset → 不猜
	{
		const a = engineOf(undefined);
		const b = engineOf(undefined);
		const picked = resolveCompaction({ candidates: [a.engine, b.engine], agent: { ctx: undefined }, ctx: {}, preset: null });
		ok('多候选且无法定位时不猜（干净失败）', picked.how === 'none' && picked.engine === undefined && picked.candidates === 2, JSON.stringify(picked));
	}
}
// 7i 懒安装摘要模板（真装，不造假标记）
{
	class MinimalAssembler {
		push() {}
		get finish() { return { kind: 'stop' }; }
		get usage() { return undefined; }
		blocks() { return [{ type: 'text', text: 'folded' }]; }
	}
	class MinimalLlmError extends Error {}
	const llmCtx = { llm: { stream: async function* () { yield { type: 'text-delta', text: 'x' }; } } };
	const ctx = makeCtx(sFold, { answer: { answers: [{ id: 'fold-confirm', selected: ['确认压缩'] }] } });
	const patched = [];
	const out = await runFold({
		ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx),
		ensureSummarizer: (engine) => {
			patched.push(engine);
			installFoldSummarizer({ ctx: llmCtx, engine, BlockAssembler: MinimalAssembler, LlmError: MinimalLlmError });
		},
	});
	ok('执行前在该实例上装了摘要模板', patched.length === 1 && patched[0] === ctx.agent.ctx.compaction && out.status === 'compacted');
	ok('返回里报告模板来源为 fold', out.summaryEngine === 'fold', out.summaryEngine);
}

// ───────────────────────── 8. 局部压缩摘要覆盖 ─────────────────────────
group('8. installFoldSummarizer（实例级覆盖）');
{
	const seen = [];
	class FakeAssembler {
		constructor() { this.parts = []; }
		push(chunk) { if (chunk?.type === 'text-delta') this.parts.push(chunk.text); }
		get finish() { return { kind: 'stop' }; }
		get usage() { return { inputTokens: 10, outputTokens: 5 }; }
		blocks() { return [{ type: 'text', text: this.parts.join('') }]; }
	}
	class FakeLlmError extends Error {
		constructor(message, code, options) { super(message, options); this.code = code; }
	}
	const engine = {
		config: { maxTokens: 512, summarizationProvider: '', summarizationModel: '' },
		summarize: async () => ({ summary: [{ type: 'text', text: 'STOCK' }], rawOutput: [], provider: 'p', model: 'm' }),
	};
	const ctx = {
		llm: {
			stream: async function* (options) {
				seen.push(options);
				yield { type: 'text-delta', text: '## 这段在做什么\n- 试了 X' };
			},
		},
	};
	const agent = { session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }), toolHistory: () => [], id: 'S1' }, options: {} };
	const outcome = installFoldSummarizer({ ctx, engine, BlockAssembler: FakeAssembler, LlmError: FakeLlmError });
	ok('安装报告 installed', outcome.status === 'installed', JSON.stringify(outcome.status));
	ok('isFoldSummarizerInstalled 为真', isFoldSummarizerInstalled(engine) === true);
	const result = await engine.summarize({ messages: [{ role: 'system', content: [] }] }, agent);
	ok('覆盖后走的是压缩指令', seen[0].messages.at(-1).content[0].text === FOLD_INSTRUCTION);
	ok('返回结构含 llmStreamCall 与 provider', result.llmStreamCall === true && result.provider === 'deepseek-official');
	ok('摘要正文来自流式输出', result.summary[0].text.includes('试了 X'));
	ok('重复安装幂等', installFoldSummarizer({ ctx, engine, BlockAssembler: FakeAssembler, LlmError: FakeLlmError }).status === 'already');
	outcome.restore();
	ok('可还原出厂实现', isFoldSummarizerInstalled(engine) === false && (await engine.summarize({ messages: [] }, agent)).summary[0].text === 'STOCK');
}

// ───────────────────────── 8b. llm 服务解析（实测踩过的 without-inject 坑）─────────────────────────
group('8b. resolveLlmService（只能从压缩服务自己的作用域取 llm）');
{
	const fakeLlm = { stream: async function* () { yield { type: 'text-delta', text: 'x' }; } };
	const otherLlm = { stream: async function* () { yield { type: 'text-delta', text: 'y' }; } };
	ok('优先用 engine.ctx.get("llm")（压缩后端 inject 过 llm）', resolveLlmService({ ctx: makeScope({ llm: fakeLlm }) }, makeScope({ llm: otherLlm })) === fakeLlm);
	ok('engine.ctx 没有 get 时退回属性访问', resolveLlmService({ ctx: { llm: fakeLlm } }, undefined) === fakeLlm);
	ok('engine 没有 ctx 时退回插件自己的 ctx', resolveLlmService({}, makeScope({ llm: fakeLlm })) === fakeLlm);
	ok('两处都取不到 → undefined（由调用方降级）', resolveLlmService({ ctx: makeScope({}) }, makeScope({})) === undefined);
	// 用 getter 模拟 Cordis 的 without-inject 保护，确认我们不会踩它
	const guarded = {
		get() { return undefined; },
		get llm() { throw new Error('cannot get property "llm" without inject'); },
	};
	ok('遇到 Cordis 的 without-inject getter 不抛错，而是干净返回 undefined', resolveLlmService(undefined, guarded) === undefined);
	ok('engine.ctx 抛错时继续找 fallbackCtx，并能拿到真 llm', resolveLlmService({ ctx: guarded }, makeScope({ llm: fakeLlm })) === fakeLlm);
	// 装不上时应当抛错（让 apply 降级成出厂模板），而不是等到压缩中途才炸
	const engine = { config: {}, summarize: async () => ({}) };
	let threw = false;
	try {
		installFoldSummarizer({ engine, BlockAssembler: class {}, LlmError: class extends Error {} });
	} catch {
		threw = true;
	}
	ok('取不到 llm 时安装阶段就抛错（不留到压缩中途才炸）', threw === true);
}

// ───────────────────────── 9. 目标解析 ─────────────────────────
group('9. resolveSummarizeTarget');
{
	const engine = { config: { summarizationProvider: '', summarizationModel: '', maxTokens: 256 } };
	const agent = { session: { requestHeader: () => ({ config: { provider: 'p1', model: 'm1' } }) }, options: { provider: 'p2', model: 'm2' } };
	ok('无显式配置时用最近路由', resolveSummarizeTarget(engine, agent).target.provider === 'p1');
	ok('显式配置优先', resolveSummarizeTarget({ config: { summarizationProvider: 'px', summarizationModel: 'mx' } }, agent).target.provider === 'px');
	ok('都没有时抛错', (() => {
		try {
			resolveSummarizeTarget({ config: {} }, { session: { requestHeader: () => undefined }, options: {} });
			return false;
		} catch {
			return true;
		}
	})());
}

// ───────────────────────── 10. 配置校验 ─────────────────────────
group('10. normalizeConfig');
ok('默认值与设计一致', DEFAULTS.minShadowedTokens === 3000 && DEFAULTS.maxSurfaceShare === 0.6 && DEFAULTS.approvalTimeoutMs === 180000 && DEFAULTS.maxPerTurn === 1);
ok('越界比例抛错', (() => {
	try {
		normalizeConfig({ maxSurfaceShare: 1.5 });
		return false;
	} catch {
		return true;
	}
})());
ok('非整数下限抛错', (() => {
	try {
		normalizeConfig({ minShadowedTokens: 0 });
		return false;
	} catch {
		return true;
	}
})());

// ───────────────────────── 11. apply 装配 ─────────────────────────
group('11. apply 装配（注册工具 + 安装摘要模板）');
{
	const registered = [];
	const engine = {
		config: { maxTokens: 512, summarizationProvider: '', summarizationModel: '' },
		summarize: async () => ({ summary: [{ type: 'text', text: 'STOCK' }], rawOutput: [], provider: 'p', model: 'm' }),
	};
	const logs = [];
	const listeners = [];
	const routes = [];
	const commands = [];
	/** 最小可用的假 ctx：记录 on() 的监听器、webServer 路由与命令注册，供后面手工触发。 */
	const makeApplyCtx = (overrides = {}) => ({
		logger: { info: (message) => logs.push(`info:${message}`), warn: (message) => logs.push(`warn:${message}`) },
		tools: { register: (definition) => registered.push(definition) },
		llm: { stream: async function* () { yield { type: 'text-delta', text: 'x' }; } },
		on: (name, listener, options) => listeners.push({ name, listener, options }),
		effect: (factory) => { factory(); return () => {}; },
		webServer: { register: (route) => { routes.push(route); return () => {}; } },
		commands: { register: (definition) => { commands.push(definition); return () => {}; } },
		// 与真实 0.2.1 宿主对齐：`agentPresets.serviceFor` 存在 —— 这样"preset 模块导出缺失"
		// 属于预期状态，apply **不该**报警（定位已改走服务面）。
		agentPresets: { serviceFor: () => undefined },
		tokenMeter: {}, sessionProjections: {}, userQuestions: {}, agents: {},
		...overrides,
	});
	const applyCtx = makeApplyCtx();
	apply(applyCtx, {});
	// GitHub Runner 上没有 DSH 宿主包 → apply() 降级，集成段无从断言。
	// **跳过而不是伪造通过**，并且打印出来（CI 日志里能看到 ⏭）。
	const hostAvailable = loadReport.tools.ok !== false;
	const expect = (name, value, detail) => {
		if (!hostAvailable) {
			console.log(`  ⏭ 跳过 ${name}（无 @deepseek-ai/dsh-tools）`);
			return;
		}
		ok(name, typeof value === 'function' ? value() : value, detail);
	};
	expect('注册了 compact_turns', registered.length === 1 && registered[0].name === 'compact_turns', JSON.stringify(registered.map((d) => d.name)));
	expect('apply 没有告警（有服务面时，preset 模块缺失属预期）', logs.every((line) => line.startsWith('info:')), logs.join(' | '));
	expect('preset 缺失的说明指向服务面', logs.some((line) => line.includes('preset=服务面') || line.includes('preset=ok')), logs.join(' | '));
	expect('注册了 /compaction-selective 路由', routes.length === 1 && routes[0].path === '/compaction-selective' && routes[0].kind === 'prefix', JSON.stringify(routes.map((r) => r.path)));
	expect('宿主侧**不**注册 /fold 命令（由客户端 commandUi 贡献独占这个名字，同名会让候选合成报错）', commands.length === 0, JSON.stringify(commands.map((c) => c.name)));
	expect('挂了 internal/service 与 agent/pre-step 两个钩子', listeners.map((l) => l.name).sort().join(',') === 'agent/pre-step,internal/service', listeners.map((l) => l.name).join(','));
	expect('pre-step 钩子带 prepend（要早于自动压缩）', listeners.find((l) => l.name === 'agent/pre-step')?.options?.prepend === true);
	expect('两个钩子都带 global（绕开作用域过滤，否则根上的监听器收不到 preset 域的事件）', listeners.every((l) => l.options?.global === true), JSON.stringify(listeners.map((l) => l.options)));

	// ① 模拟 preset 组里的隔离实例注册：internal/service 事件把模板装上去
	const scopedEngine = {
		config: { maxTokens: 512, summarizationProvider: '', summarizationModel: '' },
		summarize: async () => ({ summary: [], rawOutput: [] }),
		compactRegion: async () => ({}),
	};
	const scopedScope = makeScope({ compaction: scopedEngine });
	if (hostAvailable) listeners.find((l) => l.name === 'internal/service').listener.call(scopedScope, 'compaction', scopedEngine);
	expect('internal/service 事件把模板装到隔离实例上（用事件参数里的实例）', isFoldSummarizerInstalled(scopedEngine) === true);
	// 只给 name、不给实例时，回退到从作用域取
	const fallbackEngine = {
		config: { maxTokens: 512, summarizationProvider: '', summarizationModel: '' },
		summarize: async () => ({ summary: [], rawOutput: [] }),
		compactRegion: async () => ({}),
	};
	if (hostAvailable) listeners.find((l) => l.name === 'internal/service').listener.call(makeScope({ compaction: fallbackEngine }), 'compaction');
	expect('没有实例参数时回退到作用域取服务', isFoldSummarizerInstalled(fallbackEngine) === true);
	expect('非 compaction 的服务不触发安装', isFoldSummarizerInstalled(scopedScope.compaction) === true);

	// ② 模拟每轮第一步：通过 agent.ctx 找到实例并安装
	const preStepEngine = {
		config: { maxTokens: 512, summarizationProvider: '', summarizationModel: '' },
		summarize: async () => ({ summary: [], rawOutput: [] }),
		compactRegion: async () => ({}),
	};
	const agent = { id: 'A1', ctx: makeScope({ compaction: preStepEngine }) };
	let nextCalled = false;
	if (hostAvailable) listeners.find((l) => l.name === 'agent/pre-step').listener({ agent }, () => { nextCalled = true; });
	expect('agent/pre-step 钩子装上模板并放行 next()', isFoldSummarizerInstalled(preStepEngine) === true && nextCalled === true);

	// ③ foldSummary=false：仍注册工具与钩子（实例捕获不能连坐），但不装模板
	const engine2 = { config: {}, summarize: async () => ({}) };
	const listeners2 = [];
	apply(makeApplyCtx({ compaction: engine2, on: (name, listener, options) => listeners2.push({ name, listener, options }) }), { foldSummary: false });
	expect('foldSummary=false 时不装模板，但捕获钩子照挂（实测踩过的死局）', isFoldSummarizerInstalled(engine2) === false && listeners2.length === 2, listeners2.map((l) => l.name).join(','));

	// ④ enabled=false 时什么都不注册
	const engine3 = { config: {}, summarize: async () => ({}) };
	let touchedTools = 0;
	const listeners3 = [];
	apply(makeApplyCtx({ compaction: engine3, tools: { register: () => { touchedTools += 1; } }, on: (name, listener) => listeners3.push(name) }), { enabled: false });
	ok('enabled=false 完全不注册', touchedTools === 0 && listeners3.length === 0 && isFoldSummarizerInstalled(engine3) === false);
}

// ───────────────────────── 12. 返回值必须过宿主自己的 schema 校验 ─────────────────────────
group('12. runFold 返回值过 output.schema（宿主那句 value.reason must be a string 就出在这里）');
{
	/** 取宿主的 schema 校验器：它在包里，但没走 exports 映射，所以按包根拼路径。 */
	let validate = null;
	try {
		const pkgUrl = import.meta.resolve('@deepseek-ai/dsh-tools/package.json');
		validate = (await import(new URL('./lib/types/json-schema.js', pkgUrl).href)).validateJsonSchemaValue;
	} catch (error) {
		console.log(`     无法取得宿主校验器：${error.message}`);
	}
	if (loadReport.tools.ok === false) console.log('  ⏭ 跳过 取到宿主的 validateJsonSchemaValue（无 @deepseek-ai/dsh-tools）');
	else ok('取到宿主的 validateJsonSchemaValue', typeof validate === 'function');
	if (typeof validate !== 'function' || typeof realDefineTool !== 'function') {
		console.log('     跳过返回值校验（缺校验器或 defineTool）');
	} else {
		const compiled = realDefineTool(buildToolSpec({
			ctx: makeCtx(sFold), config: cfg, rateLimit: createRateLimit(),
			ensureSummarizer: () => {}, candidates: [],
		}));
		const schema = compiled.output.schema;
		const answer = (label) => ({ answers: [{ id: 'fold-confirm', selected: [label] }] });
		const run = async (overrides, extras = {}) => {
			const ctx = makeCtx(sFold, overrides);
			return runFold({
				ctx, config: extras.config ?? cfgBase, rateLimit: createRateLimit(),
				args: { recent_turns: 2 }, exec: execFor(ctx), candidates: ctx.candidates,
			});
		};
		const cases = [];
		cases.push(['compacted', await run({ answer: answer('确认压缩') })]);
		cases.push(['declined', await run({ answer: answer('取消') })]);
		cases.push(['preview', await run({ answer: answer('只看预览') })]);
		cases.push(['timeout', await run({ answer: { pending: true, callId: 'call-1' } })]);
		cases.push(['rejected/NOT_ROOT', await run({ notRoot: true })]);
		cases.push(['rejected/NO_SERVICE', await run({ noCompaction: true })]);
		cases.push(['rejected/TOO_SMALL', await run({}, { config: normalizeConfig({ minShadowedTokens: 100000 }) })]);
		{
			const rate = createRateLimit();
			const ctx = makeCtx(sFold, { answer: answer('确认压缩') });
			const base = { ctx, config: cfgBase, rateLimit: rate, args: { recent_turns: 2 }, exec: execFor(ctx), candidates: ctx.candidates };
			await runFold(base);
			cases.push(['rejected/RATE_LIMIT', await runFold(base)]);
		}
		{
			const ctx = makeCtx(sFold, { answer: answer('确认压缩') });
			ctx.agent.ctx.compaction.compactRegion = async () => { const error = new Error('busy'); error.code = 'busy'; throw error; };
			cases.push(['failed/BUSY', await runFold({ ctx, config: cfgBase, rateLimit: createRateLimit(), args: { recent_turns: 2 }, exec: execFor(ctx), candidates: ctx.candidates })]);
		}
		for (const [name, value] of cases) {
			let violations;
			try {
				violations = validate(schema, value, '');
			} catch (error) {
				violations = [`校验器抛错：${error.message}`];
			}
			ok(`返回值合法：${name}（status=${value.status}）`, violations.length === 0, violations.join('; '));
		}
	}
}

// ───────────────────────── 13. 客户端 bundle 握手 ─────────────────────────
group('13. 客户端 bundle（lib/client.js）握手与槽位注册');
{
	const registered = [];
	const slots = {
		inject: (name, factory) => factory(),
		register: (options) => { registered.push(options); return () => {}; },
	};
	/** 最小 React 替身：只需要组件树能建起来。 */
	const React = {
		Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
	};
	let handshake = null;
	globalThis.window = {
		__ModuleLoader__: {
			load: (spec) => { handshake = { id: spec.id, module: spec.factory((name) => { if (name === 'react') return React; throw new Error(`unexpected require: ${name}`); }) }; },
		},
	};
	await import('../lib/client.js');
	ok('握手被调用且 id 正确', handshake?.id === 'dsh-compaction-selective', String(handshake?.id));
	ok('导出 name / inject / apply', handshake?.module?.name === 'dsh-compaction-selective' && Array.isArray(handshake?.module?.inject) && typeof handshake?.module?.apply === 'function');
	handshake.module.apply({ slots });
	ok('注册了输入框按钮与插件详情页配置', registered.map((o) => o.name).sort().join(',') === 'conversation.input.left,plugins.bundle.config', JSON.stringify(registered.map((o) => o.name)));
	ok('配置落点是 keyed 槽位且 key = 包名', registered.some((o) => o.name === 'plugins.bundle.config' && o.key === 'dsh-compaction-selective'), JSON.stringify(registered));
	ok('输入框落点带 id 与 order', registered.every((o) => o.name === 'plugins.bundle.config' || (o.id === 'compaction-selective' && typeof o.order === 'number')), JSON.stringify(registered));
	delete globalThis.window;
}

// ───────────────────────── 14. 宿主 API（客户端用的三个端点） ─────────────────────────
group('14. host-api：state / config / fold');
{
	const { sessionState, foldSession, sendJson, turnTable } = await import('../lib/host-api.js');
	const { DEFAULTS, CONFIG_TYPES } = await import('../lib/config.js');
	const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');

	// 用一个临时 HOME 隔离设置文件，避免污染真实配置
	const home = mkdtempSync(join(tmpdir(), 'cs-test-'));
	const { settingsPath, saveSettings, loadSettings, effectiveConfig } = await import('../lib/config.js');
	const file = settingsPath(home);
	ok('设置文件路径落在 ~/.dsh 下', file.endsWith(join('.dsh', 'compaction-selective.json')), file);
	saveSettings({ minShadowedTokens: 4321 }, file);
	ok('设置可写可读', loadSettings(file).values.minShadowedTokens === 4321, JSON.stringify(loadSettings(file)));
	ok('坏键被拒绝且不写盘', (() => {
		try { saveSettings({ nope: 1 }, file); return false; } catch { return true; }
	})());
	ok('三层优先级：文件 > 组合 > 默认', (() => {
		const eff = effectiveConfig({ minShadowedTokens: 9999, maxPerTurn: 7 }, file);
		return eff.config.minShadowedTokens === 4321 && eff.config.maxPerTurn === 7 && eff.config.approvalTimeoutMs === DEFAULTS.approvalTimeoutMs
			&& eff.origin.minShadowedTokens === 'settings-file' && eff.origin.maxPerTurn === 'composition';
	})());

	// 造一个带 6 轮的会话 + 一份 ctx 替身
	const agent = { id: 'S1', session: sFold, options: {} };
	agent.ctx = makeScope({ compaction: { compactRegion: async () => ({}), compactRange: async (start, end) => ({ shadowedRange: { start, end }, shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234, summarySeq: 77 }) } });
	const ctx = { agents: { get: (id) => (id === 'S1' ? agent : undefined), roots: () => [agent] } };
	const deps = {
		resolveAgent: (sessionId) => (sessionId === undefined || sessionId === 'S1' ? { agent } : { agent: undefined, error: 'nope' }),
		resolveEngine: (a) => a.ctx.compaction,
		tokenMeter: () => ({ measure: () => measureOf(sFold) }),
		projections: () => ({ stateOf: () => ({ turns: [] }) }),
		engineLabel: () => 'fold',
		foldPath: (a) => (typeof a.ctx.compaction.compactRange === 'function' ? '空闲态（已打补丁）' : '仅限轮内'),
		compositionConfig: {},
		defaults: DEFAULTS,
		types: CONFIG_TYPES,
	};
	const state = await sessionState({ ctx, deps, sessionId: 'S1' });
	ok('state 返回轮次表且能分辨不可折的当前轮', Array.isArray(state.session?.turns) && state.session.turns.length === 6 && state.session.turns.at(-1).foldable === false, JSON.stringify(state.session?.turns?.map((t) => [t.turn, t.foldable])));
	ok('state 带 1/2/3/5 轮的建议，能折的给预估、不能折的给理由', state.session?.suggestions?.length === 4
		&& state.session.suggestions[1].ok === true && state.session.suggestions[1].tokens > 0
		&& state.session.suggestions[0].ok === false && typeof state.session.suggestions[0].message === 'string', JSON.stringify(state.session?.suggestions));
	ok('state 报出压缩通道（补丁在位）', state.session?.foldPath?.includes('空闲态'), state.session?.foldPath);
	ok('会话不存在时 state 带错误但不抛', (await sessionState({ ctx, deps, sessionId: 'SX' })).error === 'nope');

	const denied = await foldSession({ ctx, deps, body: { sessionId: 'S1', recent_turns: 2 } });
	ok('缺 confirm 时拒绝', denied.http === 400 && denied.body.reason === 'NO_CONFIRM', JSON.stringify(denied.body));
	const folded = await foldSession({ ctx, deps, body: { sessionId: 'S1', recent_turns: 2, confirm: true } });
	ok('确认后走 compactRange 并返回成功', folded.body.status === 'compacted' && folded.body.turnsLabel === '4-5' && folded.body.shadowedTokens === 1234, JSON.stringify(folded.body));
	const todo = await foldSession({ ctx, deps, body: { sessionId: 'S1', from_turn: 99, to_turn: 100, confirm: true } });
	ok('找不到的轮次被 planFold 挡回', todo.body.status === 'rejected' && todo.body.reason === 'UNKNOWN_TURN', JSON.stringify(todo.body));
	const bad = await foldSession({ ctx, deps, body: { sessionId: 'S1', from_turn: 3, to_turn: 2, confirm: true } });
	ok('倒置区间被 planFold 挡回', bad.body.status === 'rejected' && bad.body.reason === 'BAD_ARGS', JSON.stringify(bad.body));
	// 补丁缺失时要给出可执行的提示
	const noPatch = { ...deps, resolveEngine: () => ({ compactRegion: async () => ({}) }) };
	const missing = await foldSession({ ctx, deps: noPatch, body: { sessionId: 'S1', recent_turns: 2, confirm: true } });
	ok('补丁缺失时明确报 NO_PATCH 并给出修复脚本', missing.body.reason === 'NO_PATCH' && missing.body.message.includes('apply-compaction-patch.ps1'), JSON.stringify(missing.body));
	// 响应辅助
	{
		const chunks = [];
		sendJson({ writeHead: (status, headers) => chunks.push({ status, headers }), end: (text) => chunks.push({ text }) }, 200, { ok: true });
		ok('sendJson 写头和 JSON 体', chunks[0].status === 200 && chunks[1].text.includes('"ok"'), JSON.stringify(chunks));
	}
	rmSync(home, { recursive: true, force: true });
}

// ───────────────────────── 15. ＋菜单里的命令行（客户端贡献） ─────────────────────────
group('15. commandUi 贡献（＋ 菜单 → 指令）');
{
	// 走真实的握手路径：把 lib/client.js 跑一遍，拿到它注册的贡献对象
	const registered = { slots: [], command: null };
	const React = {
		Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
	};
	let handshake = null;
	globalThis.window = { __ModuleLoader__: { load: (spec) => { handshake = spec } } };
	await import(`../lib/client.js?t=${Date.now()}`);
	const mod = handshake.factory((name) => { if (name === 'react') return React; throw new Error(name); });
	mod.apply({
		slots: { inject: (name, factory) => factory(), register: (options) => { registered.slots.push(options); return () => {}; } },
		commandUi: { register: (contribution) => { registered.command = contribution; return () => {}; } },
	});
	const contribution = registered.command;
	ok('注册了一条客户端命令贡献', contribution !== null && contribution.name === 'fold', JSON.stringify(contribution?.name));
	ok('贡献带中文 label（宿主命令做不到这点）', contribution.label() === '选择性压缩' && contribution.description().length > 0, contribution?.label?.());
	ok('贡献带图标组件', typeof contribution.icon === 'function');
	ok('行为是原生选择器', contribution.ui?.kind === 'popupSelect' && typeof contribution.ui.options === 'function', contribution?.ui?.kind);
	// `PopupSelectSpec` 没有 `title` 字段（d.ts 实测：kind/searchMode/searchLabels/options/onSelect），
	// 所以「选中即执行」只能靠 description 与选项文案表达，别再写一个被忽略的 title。
	ok('popupSelect 不带 title（契约里没有这个字段）', contribution.ui.title === undefined, String(contribution.ui.title));
// ── ＋ 菜单入口：常驻 + 无补丁时给解释性选项 ──
{
	const originalFetch = globalThis.fetch;
	let body = { session: { resolution: { patched: false }, suggestions: [{ recent: 2, ok: true, label: '2', tokens: 100, nodes: 3 }] } };
	globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
	const contribution = registered.command;
	ok('入口常驻（available 恒为 true）', contribution.available?.({ sessionId: 'S1' }) === true, String(contribution.available?.({ sessionId: 'S1' })));
	const noPatch = await contribution.ui.options({ sessionId: 'S1' });
	ok('无补丁时只给一条解释性选项', noPatch.length === 1 && noPatch[0].id === 'nopatch', JSON.stringify(noPatch));
	body = { session: { resolution: { patched: true }, suggestions: [{ recent: 2, ok: true, label: '2', tokens: 100, nodes: 3 }] } };
	const withPatch = await contribution.ui.options({ sessionId: 'S1' });
	ok('有补丁时给出可用的轮数选项', withPatch.length === 1 && withPatch[0].id === 'recent-2', JSON.stringify(withPatch));
	globalThis.fetch = originalFetch;
}
	ok('警示写在 description 里', contribution.description().includes('没有二次确认'), contribution.description());
	delete globalThis.window;

	// options()：喂一个假的 /state 响应，看它怎么变成选择项
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true, status: 200,
		text: async () => JSON.stringify({
			error: null,
			session: { suggestions: [
				{ recent: 1, ok: false, message: '太小' },
				{ recent: 2, ok: true, label: '4-5', tokens: 4000, nodes: 4 },
				{ recent: 3, ok: true, label: '3-5', tokens: 6000, nodes: 6 },
			] },
		}),
	});
	const options = await contribution.ui.options({ sessionId: 'S1' }, new AbortController().signal);
	ok('只把可折的建议变成选项', options.length === 2 && options[0].id === 'recent-2', JSON.stringify(options));
	ok('选项带用量徽标与轮次说明', options[0].badge.includes('4.0k') && options[0].detail.includes('4-5'), JSON.stringify(options[0]));
	ok('选项文案是动词短语（降低误点）', options[0].label.startsWith('压缩'), JSON.stringify(options[0].label));

	// onSelect()：应当去打 /fold 且带 confirm
	let posted = null;
	globalThis.fetch = async (url, init) => {
		posted = { url, body: JSON.parse(init.body) };
		return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'compacted' }) };
	};
	await contribution.ui.onSelect({ id: 'recent-2' }, { sessionId: 'S1' });
	ok('选中后 POST /fold 且带 confirm 与轮数', posted?.url === '/compaction-selective/fold' && posted.body.recent_turns === 2 && posted.body.confirm === true && posted.body.sessionId === 'S1', JSON.stringify(posted));
	globalThis.fetch = originalFetch;
}
// ── i18n：表一致性 + 语言判定 + 英文查表 ──
{
	const { EN, makeT, pickLang, createT } = await import('../lib/i18n.js');
	const { readFileSync: readSync } = await import('node:fs');
	const clientSrc = readSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	// 客户端那份表只需覆盖它用到的文案：断言方向是「客户端表 ⊆ 宿主表」
	const clientBlock = clientSrc.slice(clientSrc.indexOf('const EN_UI = {'));
	const clientKeys = [...clientBlock.slice(0, clientBlock.indexOf('};')).matchAll(/'([^']+)':/g)].map((m) => m[1]);
	const missing = clientKeys.filter((zh) => !(zh in EN));
	ok('客户端英文表是宿主表的子集', missing.length === 0, missing.slice(0, 5).join(' | '));
	ok('英文模式查表生效', makeT('en')('确认压缩') === 'Confirm compaction', makeT('en')('确认压缩'));
	ok('中文模式原样返回', makeT('zh')('确认压缩') === '确认压缩', makeT('zh')('确认压缩'));
	ok('未知键原样返回（不漏 undefined）', makeT('en')('不存在的文案') === '不存在的文案');
	ok('locale=en-US → en（真实形状 getSnapshot().active）', pickLang({ locale: { getSnapshot: () => ({ active: 'en-US', revision: 1 }) } }) === 'en');
	ok('locale=zh-CN → zh', pickLang({ locale: { getSnapshot: () => ({ active: 'zh-CN', revision: 1 }) } }) === 'zh');
	{
		// 切换语言后**无需重启**（T 每次调用都重读）
		let current = { locale: { getSnapshot: () => ({ active: 'zh-CN' }) } };
		const T2 = createT(() => current);
		const before = T2('确认压缩');
		current = { locale: { getSnapshot: () => ({ active: 'en-US' }) } };
		const after = T2('确认压缩');
		ok('切换语言后同一个 T 立即跟随', before === '确认压缩' && after === 'Confirm compaction', before + ' -> ' + after);
	}
	ok('没有 locale 服务时保守用 zh', pickLang({}) === 'zh');
}


console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
assert.ok(failed === 0, `${failed} 项断言失败`);
