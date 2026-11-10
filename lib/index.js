/**
 * dsh-compaction-selective —— 由人类指令驱动的「指定区间压缩」插件。
 *
 * 它在官方压缩之上补三件官方没有的东西：
 *   1. **入口**：一个模型可见工具 `compact_turns`，让「把上一段压掉」这句话能被执行。
 *   2. **区间定位**：用 `turnOutline` 投影 + 表面位置映射 + 切点平衡吸附，把轮号变成
 *      一段合法的表面区间；模型只负责搬运参数，不负责判断压什么。
 *   3. **审批门禁**：执行前必须由人类在确认卡上点「确认压缩」，超时=不执行。
 *
 * 执行原语是官方契约里的 `ctx.compaction.compactRegion(start, end, agent, signal)`
 * （`dsh-compaction` 的三个抽象操作之一，专为「调用方指定区间」而设），因此：
 *   - 压缩事务的锁、稳定性校验、摘要收敛校验、checkpoint 标记全部复用官方实现；
 *   - 不需要人类处于空闲态：人类发出指令的那条消息本身就打开了新一轮。
 *
 * 设计依据与全部护栏见 `DESIGN.md`。
 * @module dsh-compaction-selective
 */

import { REASON, REASON_TEXT } from './range.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, CONFIG_TYPES, effectiveConfig, normalizeConfig, settingsPath, validateEntry } from './config.js';
import { planFold, readOutlineTurns, resolveTurnArgs } from './plan.js';
import { makeT, pickLang } from './i18n.js';
import { registerRoutes } from './host-api.js';
import { installFoldSummarizer, isFoldSummarizerInstalled } from './summarizer.js';

/**
 * 可选依赖用**动态 import + 失败降级**：
 * 本插件以外挂（linked）形态安装，`dsh-app-boot` 对 linked 层走 `routeLinked`，
 * 优先看本包 package.json 的 peerDependencies，其次回到原生解析（本包自带的
 * `node_modules` 目录联接）。任何一步失败都只应降级，绝不能让插件加载失败。
 */
let defineTool = null;
let defineToolFailure = null;
try {
	const mod = await import('@deepseek-ai/dsh-tools');
	if (typeof mod.defineTool === 'function') defineTool = mod.defineTool;
	else defineToolFailure = new Error('@deepseek-ai/dsh-tools 没有 defineTool 导出');
} catch (error) {
	defineToolFailure = error;
}

let llmDeps = null;
let llmFailure = null;
try {
	const mod = await import('@deepseek-ai/dsh-llm');
	if (typeof mod.BlockAssembler === 'function' && typeof mod.LlmError === 'function') {
		llmDeps = { BlockAssembler: mod.BlockAssembler, LlmError: mod.LlmError };
	} else {
		llmFailure = new Error('@deepseek-ai/dsh-llm 缺少 BlockAssembler / LlmError');
	}
} catch (error) {
	llmFailure = error;
}

/**
 * 上游为「已经持有 Agent、但身处 isolate 域之外」的调用方准备的正式入口。
 *
 * `serviceForAgent(ctx, agent, 'compaction')` 的文档原文很直接：
 * *"Preset revisions publish services behind an `isolate` realm. Browser RPCs hold the Agent but
 * resolve outside that realm, so they locate its revision through the Agent's scope parent."*
 * 而且 `standingMountFor` 明确写着 *"the mount is not under the agent's fiber"* —— 所以靠纤维祖先链
 * 认领实例是**注定失败**的（本项目第一版就是这么写的，实测候选恒为 0）。
 *
 * ⚠ 它读的是**模块级** mount 记录，必须与宿主解析到**同一个模块实例**。2026-10-15 实测：**宿主加载的是
 * CLI 安装树那一份**（证据：profile 副本已打补丁、CLI 副本没有，宿主仍报「补丁缺失」）。所以不再赌
 * 哪一棵树，而是**两棵树都加载**，运行时逐个试到出结果为止；注入器「哪一个在跑」由运行时决定。
 */
const presetModules = [];
const presetFailures = [];
async function loadPresetCopy(specifier, label) {
	try {
		const mod = await import(specifier);
		if (typeof mod.serviceForAgent === 'function') {
			if (!presetModules.includes(mod)) presetModules.push(mod);
			return;
		}
		presetFailures.push(`${label}: 没有 serviceForAgent 导出`);
	} catch (error) {
		presetFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
await loadPresetCopy('@deepseek-ai/dsh-agent-preset-registry', 'junction');
// 两棵已知的树都按绝对路径再试一遍（同一文件只会入列一次）：宿主实际用哪一棵由它决定，这里不猜。
{
	const appData = process.env.APPDATA;
	const home = homedir();
	const files = [];
	if (typeof appData === 'string' && appData.length > 0) {
		files.push(['cli-tree', join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'lib', 'index.js')]);
	}
	files.push(['profile', join(home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'lib', 'index.js')]);
	for (const [label, file] of files) await loadPresetCopy(pathToFileURL(file).href, label);
}

/** 加载自检结果：供 `apply` 记日志，也供离线测试断言。 */
export const loadReport = {
	tools: defineTool === null ? { ok: false, error: String(defineToolFailure?.message ?? defineToolFailure) } : { ok: true },
	llm: llmDeps === null ? { ok: false, error: String(llmFailure?.message ?? llmFailure) } : { ok: true },
	preset: presetModules.length === 0 ? { ok: false, error: presetFailures.join('；') } : { ok: true, copies: presetModules.length, failures: presetFailures },
};

/** 语言在 apply 时按宿主 locale 定；未定时原样返回中文。 */
let T = (zh) => zh;

export const name = 'compaction-selective';
/**
 * 依赖清单。
 *
 * **`compaction` 故意不在里面**：web-app 层把根作用域的 `compaction-basic` / `command-compact`
 * 禁用（`--dump-config` 里能看到 `disabled: true`），改成在每个 agent preset 内部用
 * `- id: compaction / name: cordis:group / isolate: { compaction: true }` 挂载 —— 也就是
 * **每个 preset 一份互相隔离的 compaction 实例**。挂在 profile 根作用域、再 `inject: ['compaction']`
 * 会永远 pending（实测：`pending (waiting for service: compaction)`，工具根本不会出现）。
 * 正确做法：工具在根注册（`tools` 是全局的），执行时用 `agent.ctx` 去取**该 agent 自己作用域**里的实例。
 */
export const inject = ['tools', 'agents', 'tokenMeter', 'sessionProjections', 'userQuestions', 'webServer'];

/**
 * 从作用域里安全地取一个服务（缺失/未就绪返回 `undefined`，不抛）。
 * @param scope - 任意 Cordis 上下文（根 ctx 或 `agent.ctx`）。
 * @param name - 服务名。
 * @returns 服务实例，或 `undefined`。
 */
export function safeService(scope, name) {
	if (scope === undefined || scope === null) return undefined;
	try {
		if (typeof scope.get === 'function') {
			const viaGet = scope.get(name);
			if (viaGet !== undefined) return viaGet;
		}
	} catch {
		/* 落到属性访问 */
	}
	try {
		return scope[name];
	} catch {
		return undefined;
	}
}

/**
 * 解析本次调用该用哪一套服务。
 *
 * `compaction` 由 `pickCompaction` 单独处理（preset 隔离，可能有多份实例）；
 * 其余服务是根级共享的，取到哪儿都一样。
 * @param agent - 调用方 agent。
 * @param ctx - 插件自己的（根）上下文。
 * @returns 服务句柄。
 */
export function agentServices(agent, ctx) {
	const scope = agent?.ctx ?? ctx;
	return {
		tokenMeter: safeService(scope, 'tokenMeter') ?? safeService(ctx, 'tokenMeter'),
		sessionProjections: safeService(scope, 'sessionProjections') ?? safeService(ctx, 'sessionProjections'),
		userQuestions: safeService(scope, 'userQuestions') ?? safeService(ctx, 'userQuestions'),
	};
}

/**
 * 挑出属于这个 agent 的那一份 compaction 实例。
 *
 * web-app 把 compaction 做成**每个 agent preset 一份、发布在 isolate 域里**的服务
 * （`--dump-config`：根上的 `compaction-basic` 是 `disabled: true`，每个 `preset-*` 里另有
 * `- id: compaction / name: cordis:group / isolate: { compaction: true }`）。所以：
 *   1. `agent.ctx` / 根 ctx 能直接看到就用它（免费，先试）；
 *   2. 否则走上游正式入口 `serviceForAgent(ctx, agent, 'compaction')` —— 这正是为
 *      「持有 Agent 但在 isolate 域之外」的调用方准备的读定位；
 *   3. 都不行时，若捕获到的候选恰好只有一个，就用它；
 *   4. 仍不行 → 干净失败，并回报诊断（候选数 / preset 入口是否可用），绝不猜。
 * @param input - 候选实例、agent、根 ctx 与可选的 preset 模块。
 * @returns `{ engine, how, candidates, preset }`；取不到时 `engine` 为 `undefined`。
 */
export function resolveCompaction(input) {
	const { candidates, agent, ctx, preset } = input;
	const direct = safeService(agent?.ctx ?? ctx, 'compaction') ?? safeService(ctx, 'compaction');
	if (typeof direct?.compactRegion === 'function') return { engine: direct, how: 'scope', candidates: 0, preset: 'skipped', service: 'skipped' };

	// ② 服务面（0.2.1 线的正路）：`ctx.agentPresets.serviceFor(agent, 'compaction')`。
	//    上游把「跨 isolate 定位」从模块导出 `serviceForAgent` 挪到了这个**实例方法**上
	//    （**0.2.1-alpha.1 起包根不再导出** `serviceForAgent`，此后 6 个 tag 一路未回补），
	//    而该方法在本机的 0.2.0-rc.2 里就已经存在（`AgentPresetRegistry#serviceFor`，内部仍转调
	//    老的 `serviceForAgent`）—— 所以这条路对**新旧两代都成立**，且不依赖"两棵树各 import 一份"。
	//    实测依据：`super(ctx, "agentPresets")` + d.ts `agentPresets: AgentPresetRegistry`。
	let serviceState = 'unavailable';
	try {
		const registry = safeService(ctx, 'agentPresets');
		if (registry !== undefined && registry !== null && typeof registry.serviceFor === 'function') {
			const viaService = registry.serviceFor(agent, 'compaction');
			if (typeof viaService?.compactRegion === 'function') {
				return { engine: viaService, how: 'service', candidates: 0, preset: 'skipped', service: 'hit' };
			}
			serviceState = 'empty';
		}
	} catch (error) {
		serviceState = `threw:${error instanceof Error ? error.message : String(error)}`;
	}

	const list = Array.isArray(candidates) ? candidates.filter((engine) => typeof engine?.compactRegion === 'function') : [];
	// `preset` 可以是单个模块，也可以是**多棵树各一份**的数组：逐个试到出结果为止
	// （模块级 mount 记录只在「宿主实际在用的那一份」里，所以不猜）。
	const presets = Array.isArray(preset) ? preset : (preset === null || preset === undefined ? [] : [preset]);
	let presetState = presets.length === 0 ? 'unavailable' : `tried:0/${presets.length}`;
	let tried = 0;
	for (const mod of presets) {
		if (typeof mod?.serviceForAgent !== 'function') continue;
		tried += 1;
		try {
			const viaPreset = mod.serviceForAgent(ctx, agent, 'compaction');
			if (typeof viaPreset?.compactRegion === 'function') {
				return { engine: viaPreset, how: 'preset', candidates: list.length, preset: `hit@${tried}/${presets.length}`, service: serviceState };
			}
			presetState = `empty@${tried}/${presets.length}`;
		} catch (error) {
			presetState = `threw@${tried}/${presets.length}:${error instanceof Error ? error.message : String(error)}`;
		}
	}
	if (list.length === 1) return { engine: list[0], how: 'only', candidates: 1, preset: presetState, service: serviceState };
	return { engine: undefined, how: 'none', candidates: list.length, preset: presetState, service: serviceState };
}

/**
 * 配置默认值、校验与设置存储都在 `lib/config.js`；这里**重新导出**，让既有调用方与测试
 * 继续从入口导入（`DEFAULTS` / `normalizeConfig` / `resolveTurnArgs` 都从入口可见）。
 */
export { DEFAULTS, normalizeConfig } from './config.js';
export { resolveTurnArgs } from './plan.js';
export { REASON, REASON_TEXT } from './range.js';

/** 审批问题的稳定 id（答案按 id 回传）。 */
const QUESTION_ID = 'fold-confirm';
const OPTION_APPROVE = T('确认压缩');
const OPTION_CANCEL = T('取消');
const OPTION_PREVIEW = T('只看预览');

/**
 * 配置校验、设置存储与区间参数解析都不再在这里重复定义：
 * 配置在 `lib/config.js`，`resolveTurnArgs` 在 `lib/plan.js`，二者都由本模块在顶部重新导出。
 */

/** 每轮限流：会话 id → `{ turn, count }`。 */
export function createRateLimit() {
	const seen = new Map();
	return {
		/**
		 * 判断本轮是否还允许压缩（只读，不计数）。
		 * @param session - 目标会话。
		 * @param openTurn - 当前轮，或 null。
		 * @param maxPerTurn - 每轮上限。
		 * @returns 是否允许。
		 */
		allow(session, openTurn, maxPerTurn) {
			const state = seen.get(session.id);
			if (state === undefined) return true;
			if (openTurn !== null && state.turn === openTurn.turn) return state.count < maxPerTurn;
			return true;
		},
		/**
		 * 记录一次成功的压缩。
		 * @param session - 目标会话。
		 * @param openTurn - 当前轮，或 null。
		 */
		record(session, openTurn) {
			const turn = openTurn === null ? null : openTurn.turn;
			const state = seen.get(session.id);
			if (state === undefined || state.turn !== turn) {
				seen.set(session.id, { turn, count: 1 });
				return;
			}
			state.count += 1;
		},
	};
}

/** 读取 turnOutline 投影，兼容「状态对象」与「线上值」两种形状。 */
function readOutline(projections, session) {
	if (projections === undefined || typeof projections.stateOf !== 'function') return [];
	try {
		const raw = projections.stateOf(session, 'turnOutline');
		if (Array.isArray(raw)) return raw;
		if (raw !== null && typeof raw === 'object' && Array.isArray(raw.turns)) return raw.turns;
	} catch {
		/* 投影缺失只是没有预览，不影响压缩 */
	}
	return [];
}

/** 组装审批卡片的文本。 */
function approvalText(input) {
	const { turnNumbers, lines, nodeCount, shadowedTokens, totalTokens, minShadowedTokens, note } = input;
	const span = turnNumbers.length === 0 ? '（无轮号）' : (turnNumbers[0] === turnNumbers[turnNumbers.length - 1] ? `turn ${turnNumbers[0]}` : `turn ${turnNumbers[0]}-${turnNumbers[turnNumbers.length - 1]}`);
	const parts = [
		`范围：${span}，共 ${turnNumbers.length} 轮 / ${nodeCount} 条表面节点`,
		'',
		'预览',
		...(lines.length === 0 ? ['· （无预览：轮次大纲投影不可用）'] : lines),
		'',
		'预计',
		`· 释放约 ${shadowedTokens} 路由 token（当前可见历史约 ${totalTokens}）`,
		`· 摘要约几百 token 回填到原位；低于 ${minShadowedTokens} token 的压缩会被官方校验拒绝，本插件提前拦截`,
		'',
		'须知',
		'· 表面层不可逆：这些轮次之后不会再进入我的上下文（原文仍在会话日志中，可回放、可在「上下文已压缩」处展开摘要）',
		'· 摘要不会保留逐轮细节；若要保留某条，请先取消并说明',
	];
	if (typeof note === 'string' && note.trim().length > 0) parts.splice(2, 0, `你要求保留：${note.trim()}`, '');
	return { question: `压缩 ${span}？共 ${turnNumbers.length} 轮 / ${nodeCount} 条表面节点`, detail: parts.join('\n') };
}

/**
 * 双通道日志。
 *
 * ⚠ 实测（2026-10-14）：`ctx.logger.info` 的输出**不会**出现在 `~/.dsh/restart-web.{out,err}.log` 里
 * （插件自己的 `console.*` 才会）。所以凡是要靠那两份日志排查的诊断，必须两条通道都走。
 * @param ctx - 上下文（取其 logger）。
 * @param level - `info` / `warn` / `error`。
 * @param text - 单行诊断文本。
 */
export function report(ctx, level, text) {
	try {
		ctx.logger?.[level]?.(text);
	} catch {
		/* logger 不可用不致命 */
	}
	try {
		console.error(`[compaction-selective] ${text}`);
	} catch {
		/* 忽略 */
	}
}

/** 把压缩失败翻译成人话（原文一律未变，除 commit 阶段）。 */
function mapFailure(error) {
	const code = error?.code;
	const detail = error instanceof Error ? error.message : String(error);
	switch (code) {
		case 'busy':
			return { status: 'failed', reason: 'BUSY', message: `压缩没能开始：这个会话已经有一次压缩在进行中。没有改动任何内容。（${detail}）` };
		case 'changed':
			return { status: 'failed', reason: 'CHANGED', message: `压缩期间可见历史被改写了（例如有人插话），本次压缩作废。没有改动任何内容。（${detail}）` };
		case 'summary':
			return { status: 'failed', reason: 'SUMMARY', message: `摘要没能产出比原文更短的结果，本次压缩作废。没有改动任何内容。（${detail}）` };
		case 'commit':
			return { status: 'failed', reason: 'COMMIT', message: `压缩没有干净提交，可能只改了一部分 —— 请检查当前会话状态。（${detail}）` };
		case 'cancelled':
			return { status: 'failed', reason: 'CANCELLED', message: '压缩被取消。没有改动任何内容。' };
		case 'persistence':
			return { status: 'failed', reason: 'PERSISTENCE', message: `压缩已完成但会话没能保存，请检查宿主日志。（${detail}）` };
		default:
			return { status: 'failed', reason: 'ERROR', message: `压缩失败：${detail}。没有改动任何内容。` };
	}
}

/**
 * 工具的执行体（独立导出以便离线单测）。
 * @param input - 上下文、配置、限流状态与本次调用。
 * @returns 符合 `output.schema` 的结果值。
 */
export async function runFold(input) {
	const { ctx, config, rateLimit, args, exec } = input;
	// ⚠ 返回值会被注册表层按 `output.schema` 校验（`defineTool` 只校验入参！）。
	//   所以可选的字符串字段一律给 `''`，**绝不能给 `null`** —— 否则宿主报
	//   `value.reason must be a string`，而压缩本身已经生效，表现成「活干了但工具报错」。
	const blank = {
		status: 'rejected',
		reason: '',
		message: '',
		turnsLabel: '',
		startSeq: 0,
		endSeq: 0,
		shadowedNodes: 0,
		shadowedTokens: 0,
		summarySeq: 0,
		summaryEngine: 'stock',
	};
	const reject = (reason, extra = '') => ({
		...blank,
		reason,
		message: `${REASON_TEXT[reason] ?? reason}${extra === '' ? '' : `（${extra}）`}`,
	});

	// ① 调用者必须是会话根智能体：子智能体不能改父会话的历史。
	const agent = exec?.agent;
	if (agent === undefined || agent.session === undefined) return reject(REASON.NOT_ROOT, '没有识别到调用方会话');
	if (typeof ctx.agents?.get === 'function' && ctx.agents.get(agent.id) !== agent) return reject(REASON.NOT_ROOT, '调用方不是当前活跃实例');
	if (typeof ctx.agents?.roots === 'function' && !ctx.agents.roots().includes(agent)) return reject(REASON.NOT_ROOT, '调用方不是根智能体');

	// ①b 取这个 agent 自己该用的 compaction 实例（preset isolate 域，根作用域看不到）。
	const services = agentServices(agent, ctx);
	const picked = resolveCompaction({ candidates: input.candidates, agent, ctx, preset: input.preset ?? presetModules });
	const compaction = picked.engine;
	if (compaction === undefined) {
		const diag = `候选 ${picked.candidates} 个；preset 入口 ${picked.preset}；preset 模块 ${loadReport.preset.ok ? '可加载' : `不可加载（${loadReport.preset.error}）`}`;
		report(ctx, 'warn', `没找到可用的 compaction 实例 —— ${diag}`);
		return reject(REASON.NO_SERVICE, diag);
	}
	report(ctx, 'info', `选中 compaction 实例：路径「${picked.how}」，候选 ${picked.candidates} 个，preset 入口 ${picked.preset}`);
	// 摘要模板懒安装：确保人类确认之后真正干活的是「局部压缩」版（幂等、且绝不让它挡住压缩）。
	if (typeof input.ensureSummarizer === 'function') {
		try {
			input.ensureSummarizer(compaction);
		} catch {
			/* 装不上就退回出厂模板 */
		}
	}
	blank.summaryEngine = isFoldSummarizerInstalled(compaction) ? 'fold' : 'stock';

	// ② 生成压缩计划 —— 与客户端按钮路径共用 `planFold()`，区间逻辑只有一份。
	const session = agent.session;
	const measurement = services.tokenMeter.measure(session);
	const outlineTurns = readOutlineTurns(services.sessionProjections, session);
	const planned = planFold({ session, measurement, outlineTurns, args, config });
	if (!planned.ok) return reject(planned.reason, planned.detail);
	const { shadowedTokens, totalTokens, nodeCount, startSeq, endSeq } = planned;
	const turnNumbers = planned.turnNumbers;

	// ③ 每轮限流。
	if (!rateLimit.allow(session, planned.openTurn, config.maxPerTurn)) return reject(REASON.RATE_LIMIT);

	// ④ 预览 + 审批（硬门禁）。计划里的 `lines`/`turnNumbers` 就是确认卡要展示的内容。
	const card = approvalText({
		turnNumbers: planned.turnNumbers,
		lines: planned.lines,
		nodeCount,
		shadowedTokens,
		totalTokens,
		minShadowedTokens: config.minShadowedTokens,
		note: args?.note,
	});
	let answer;
	try {
		answer = await services.userQuestions.askTimed(
			{
				questions: [{
					id: QUESTION_ID,
					header: T('压缩确认'),
					question: card.question,
					detail: card.detail,
					options: [
						{ label: OPTION_APPROVE, description: T('把这几个轮次压缩成一段摘要。') },
						{ label: OPTION_CANCEL, description: T('什么都不做。') },
						{ label: OPTION_PREVIEW, description: T('只看预览，不执行压缩。') },
					],
				}],
				agent,
				signal: exec.signal,
			},
			exec.callId,
			config.approvalTimeoutMs,
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			...blank,
			status: 'failed',
			reason: 'APPROVAL',
			message: `没能向你确认，因此没有执行压缩。（${detail}）`,
			turnsLabel: turnNumbers.join(','),
		};
	}
	const base = { ...blank, turnsLabel: planned.label, shadowedNodes: nodeCount, shadowedTokens };
	if (answer !== null && typeof answer === 'object' && answer.pending === true) {
		return { ...base, status: 'timeout', message: `等待确认超时（${Math.round(config.approvalTimeoutMs / 1000)} 秒），没有执行压缩。原文未变。` };
	}
	const item = answer?.answers?.find((entry) => entry.id === QUESTION_ID);
	const choice = item?.selected?.[0] ?? item?.custom ?? '';
	if (!choice.includes('确认')) {
		const previewOnly = choice.includes('预览');
		return {
			...base,
			status: 'declined',
			message: previewOnly
				? `你选择了只看预览，因此没有压缩。将压缩的范围是 turn ${planned.label}（${nodeCount} 条表面节点，约 ${shadowedTokens} token）。`
				: '你取消了这次压缩，原文未变。',
		};
	}

	// ⑤ 执行：官方压缩事务，替换原位。区间端点是表面位置上的两个 seq（计划里已算好）。
	try {
		const result = await compaction.compactRegion(startSeq, endSeq, agent, exec.signal);
		rateLimit.record(session, planned.openTurn);
		const tokens = result?.shadowedTokenCount ?? shadowedTokens;
		return {
			status: 'compacted',
			reason: '',
			message: `已压缩 turn ${planned.label}（${result?.shadowedSeqs?.length ?? nodeCount} 条表面节点，约释放 ${tokens} token）。原文仍在会话日志中，可回放或展开摘要查看。`,
			turnsLabel: planned.label,
			startSeq: result?.shadowedRange?.start ?? startSeq,
			endSeq: result?.shadowedRange?.end ?? endSeq,
			shadowedNodes: result?.shadowedSeqs?.length ?? nodeCount,
			shadowedTokens: tokens,
			summarySeq: result?.summarySeq ?? 0,
			summaryEngine: isFoldSummarizerInstalled(compaction) ? 'fold' : 'stock',
		};
	} catch (error) {
		if (exec.signal?.aborted === true) return { ...base, status: 'failed', reason: 'CANCELLED', message: '压缩被取消。没有改动任何内容。' };
		return { ...base, ...mapFailure(error) };
	}
}

/**
 * 构造工具定义（未编译的作者规格；测试会把它交给真实的 `defineTool` 编译一次）。
 * @param deps - 配置、限流状态与执行体。
 * @returns 工具作者规格对象。
 */
export function buildToolSpec(deps) {
	const { config, rateLimit } = deps;
	return {
		name: 'compact_turns',
		description: [
			'把本次会话中**已经结束的若干轮**压缩成一条摘要消息，释放上下文，其余对话保持不变。',
			'只有人类在本轮**明确要求**压缩/压掉/省略一段历史时才调用它（例如「把上一段压掉」「压缩 42-45 轮」）。',
			'不要自行发起：不要因为上下文变长、token 紧张、或你自己认为某段内容不重要而调用。',
			'人类会在执行前看到范围与预览并确认；人类取消或未回答时不会改动任何内容。',
		].join('\n'),
		parameters: {
			recent_turns: {
				type: 'number',
				description: T('压缩当前轮之前的最近 N 轮（1 = 刚刚结束的那一轮）。与 from_turn/to_turn 互斥。'),
			},
			from_turn: {
				type: 'number',
				description: T('要压缩的首个轮号（含）。必须与 to_turn 同时给出。'),
			},
			to_turn: {
				type: 'number',
				description: T('要压缩的最后一个轮号（含）。必须与 from_turn 同时给出。'),
			},
			note: {
				type: 'string',
				description: T('可选：人类希望从这段里保留的内容，会显示在确认卡片上。'),
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					status: { type: 'string', required: true, enum: ['compacted', 'declined', 'timeout', 'rejected', 'failed'], description: '本次调用的结局。' },
					reason: { type: 'string', description: '未执行或被拒绝时的稳定理由码。' },
					message: { type: 'string', required: true, description: '给人看的一句话结论。' },
					turnsLabel: { type: 'string', description: '涉及的轮号，形如 "42-45"。' },
					startSeq: { type: 'number', description: '选区在表面上的起始事件 seq。' },
					endSeq: { type: 'number', description: '选区在表面上的结束事件 seq。' },
					shadowedNodes: { type: 'number', description: '被替换掉的表面节点数。' },
					shadowedTokens: { type: 'number', description: '估算释放的路由 token 数。' },
					summarySeq: { type: 'number', description: '摘要记录的日志 seq（0 = 未执行）。' },
					summaryEngine: { type: 'string', enum: ['fold', 'stock'], description: '本次使用的摘要模板（fold = 局部压缩版）。' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: JSON.stringify({
					status: value.status,
					reason: value.reason === '' || value.reason === undefined ? null : value.reason,
					turns: value.turnsLabel,
					shadowedNodes: value.shadowedNodes,
					shadowedTokens: value.shadowedTokens,
					summaryEngine: value.summaryEngine,
					message: value.message,
				}),
			}],
		},
		// `config` 既可以是对象，也可以是**每次调用现读的函数**（设置页保存后立即生效）。
		execute: (args, exec) => runFold({
			ctx: deps.ctx,
			config: typeof config === 'function' ? config() : config,
			rateLimit,
			args,
			exec,
			ensureSummarizer: deps.ensureSummarizer,
			candidates: deps.candidates,
		}),
		presentCall: (args) => ({
			card: 'generic',
			title: 'Fold turns',
			kind: 'other',
			rawInput: args?.recent_turns !== undefined
				? `recent: ${args.recent_turns}`
				: `${args?.from_turn ?? '?'}-${args?.to_turn ?? '?'}`,
		}),
	};
}

/**
 * 挂载插件。
 * @param ctx - Cordis 上下文。
 * @param config - composition 行提供的配置。
 */
function applyInner(ctx, config = {}) {
	T = makeT(pickLang(ctx));
	// 组合行 config 只是「出厂基线」，真正的生效配置每次现读（设置文件 > 组合 > 默认），
	// 这样设置页保存后**立即生效**，不需要重启（本 profile 不支持组合热重载）。
	const compositionConfig = config ?? {};
	const resolved = effectiveConfig(compositionConfig).config;
	if (!resolved.enabled) {
		report(ctx, 'info', 'disabled by config');
		return;
	}
	if (defineTool === null) {
		report(ctx, 'warn', `无法加载 @deepseek-ai/dsh-tools（${loadReport.tools.error}），compact_turns 未注册`);
		return;
	}

	// ── 摘要模板 + 实例捕获 ──
	// compaction 是每个 agent preset 一份、发布在 isolate 域里的服务，所以：
	//   ① 模板要装到**每一个**实例上，不能只在根 ctx 装一次；
	//   ② 把见过的实例收进 candidates，作为 resolveCompaction 的最后兜底。
	// ⚠ 这两个钩子必须**先于**任何早退注册：早退（例如 dsh-llm 加载失败）只应影响「模板」，
	//   绝不能连实例捕获一起关掉 —— 否则会出现「工具在，但永远取不到实例」的死局（实测踩过）。
	const installed = new WeakSet();
	const candidates = [];
	let installedCount = 0;
	const ensureSummarizer = (engine) => {
		if (engine === undefined || engine === null) return;
		if (typeof engine.compactRegion === 'function' && !candidates.includes(engine)) {
			candidates.push(engine);
			report(ctx, 'info', `捕获到第 ${candidates.length} 个 compaction 实例`);
		}
		if (resolved.foldSummary !== true || llmDeps === null) return;
		if (installed.has(engine)) return;
		try {
			// 用根 ctx 调 LLM：`llm` 是根级共享服务，不会随 agent 作用域被回收。
			installFoldSummarizer({ ctx, engine, ...llmDeps });
			installed.add(engine);
			installedCount += 1;
			report(ctx, 'info', `已为第 ${installedCount} 个 compaction 实例装上局部压缩摘要模板`);
		} catch (error) {
			installed.add(engine);
			report(ctx, 'warn', `装局部压缩摘要失败，该实例保留出厂模板（${error instanceof Error ? error.message : String(error)}）`);
		}
	};

	// ① 服务在哪个作用域出现就装到哪个实例上。
	//    `global: true` 绕开 dsh-scope 的作用域过滤（否则根上的监听器收不到 preset 域里的事件）。
	ctx.on('internal/service', function (name, value) {
		if (name !== 'compaction') return;
		ensureSummarizer(value ?? safeService(this, 'compaction'));
	}, { global: true });
	// ② 每轮第一步之前（prepend 保证早于 compaction-basic 自己的压力压缩），
	//    这样自动压缩也用压缩模板，而不必等第一次 compact_turns 调用。
	ctx.on('agent/pre-step', ({ agent }, next) => {
		ensureSummarizer(resolveCompaction({ candidates, agent, ctx, preset: presetModules }).engine);
		return next();
	}, { global: true, prepend: true });

	const rateLimit = createRateLimit();
	// 工具的执行体每次现读生效配置（`buildToolSpec` 支持传函数）。
	ctx.tools.register(defineTool(buildToolSpec({
		ctx,
		config: () => effectiveConfig(compositionConfig).config,
		rateLimit,
		ensureSummarizer,
		candidates,
	})));
	report(ctx, 'info', `compact_turns registered（minShadowedTokens=${resolved.minShadowedTokens}, maxSurfaceShare=${resolved.maxSurfaceShare}, approvalTimeoutMs=${resolved.approvalTimeoutMs}）`);
	// `preset` 这个"可选依赖"在新版上**必然**缺失：0.2.1-alpha.1 起 `serviceForAgent` 不再从包根导出
	// （此后 6 个 tag 未回补）。而我们的实例定位已经**优先走服务面** `ctx.agentPresets.serviceFor`，
	// 所以模块导出缺失是**预期状态**，不该报警 —— 只有连服务面也没有时才是真降级。
	const serviceFaceAvailable = typeof safeService(ctx, 'agentPresets')?.serviceFor === 'function';
	const presetLine = loadReport.preset.ok
		? 'preset=ok（模块导出可用）'
		: (serviceFaceAvailable
			? 'preset=服务面（模块导出在 0.2.1 起已移除，改用 ctx.agentPresets.serviceFor）'
			: `preset=${loadReport.preset.error}`);
	report(
		ctx,
		loadReport.preset.ok || serviceFaceAvailable ? 'info' : 'warn',
		`可选依赖：tools=${loadReport.tools.ok ? 'ok' : loadReport.tools.error}；llm=${loadReport.llm.ok ? 'ok' : loadReport.llm.error}；${presetLine}`,
	);

	if (resolved.foldSummary !== true) report(ctx, 'info', 'foldSummary=false，保留出厂摘要模板');
	else if (llmDeps === null) report(ctx, 'warn', `无法加载 @deepseek-ai/dsh-llm（${loadReport.llm.error}），保留出厂模板（不影响压缩功能本身）`);

	// ③ 根作用域（理论上不存在，装了也不亏）。
	ensureSummarizer(safeService(ctx, 'compaction'));

	// ④ 客户端插件用的 HTTP 路由（同源 fetch；空闲态压缩走本地补丁的 compactRange）。
	if (safeService(ctx, 'webServer') === undefined) {
		report(ctx, 'warn', '没有 webServer 服务，客户端面板的 API 未注册（工具路径不受影响）');
		return;
	}
	const resolveAgent = (sessionId) => {
		const agents = ctx.agents;
		if (typeof sessionId === 'string' && sessionId.length > 0) {
			const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
			if (agent !== undefined) return { agent };
			return { agent: undefined, error: `会话 ${sessionId} 当前没有活跃的 agent（在界面里打开它、随便发一条消息再试）。` };
		}
		const roots = typeof agents?.roots === 'function' ? agents.roots() : [];
		if (roots.length === 1) return { agent: roots[0] };
		return {
			agent: undefined,
			error: roots.length === 0 ? '当前没有活跃会话。' : `有 ${roots.length} 个活跃会话，无法判断要对哪个操作（客户端没传 sessionId）。`,
		};
	};
	const engineOf = (agent) => resolveCompaction({ candidates, agent, ctx, preset: presetModules }).engine;
	// 定位诊断：面板会直接显示这几项，避免「补丁缺失」与「没找到实例」被混为一谈。
	const resolutionOf = (agent) => {
		const picked = resolveCompaction({ candidates, agent, ctx, preset: presetModules });
		return {
			how: picked.how,
			candidates: picked.candidates,
			preset: picked.preset,
			service: picked.service,
			engine: picked.engine !== undefined,
			patched: typeof picked.engine?.compactRange === 'function',
			summarizer: picked.engine !== undefined && isFoldSummarizerInstalled(picked.engine) ? 'fold' : 'stock',
			presetCopies: presetModules.length,
		};
	};
	const deps = {
		resolveAgent,
		resolveEngine: engineOf,
		resolution: resolutionOf,
		// 活跃会话清单：客户端拿不到 sessionId 时（多会话同时开着）由人来选。
		// 每条都带「最新轮号 + 最后一句话的摘要」，否则一堆 `session-…` 根本分不清谁是谁。
		listSessions: () => {
			const roots = typeof ctx.agents?.roots === 'function' ? ctx.agents.roots() : [];
			return roots.map((agent) => {
				let tokens = 0;
				let nodes = 0;
				let lastTurn = 0;
				let prompt = '';
				try {
					const services = agentServices(agent, ctx);
					const measured = services.tokenMeter?.measure?.(agent.session);
					tokens = measured?.totalTokens ?? 0;
					nodes = agent.session?.surface?.nodes?.length ?? 0;
					const outline = readOutlineTurns(services.sessionProjections, agent.session);
					const last = outline[outline.length - 1];
					if (last !== undefined) {
						lastTurn = typeof last.turn === 'number' ? last.turn : 0;
						prompt = String(last.prompt ?? '').replace(/\s+/g, ' ').slice(0, 40);
					}
				} catch {
					/* 量不到就只报 id，够做人认了 */
				}
				const id = agent?.session?.id ?? agent?.id ?? '';
				return { id, tokens, nodes, lastTurn, prompt };
			}).filter((row) => row.id !== '');
		},
		tokenMeter: (agent) => agentServices(agent, ctx).tokenMeter,
		projections: (agent) => agentServices(agent, ctx).sessionProjections,
		engineLabel: (agent) => (isFoldSummarizerInstalled(engineOf(agent)) ? 'fold' : 'stock'),
		foldPath: (agent) => {
			const engine = engineOf(agent);
			if (engine === undefined) return '未定位到压缩实例';
			return typeof engine.compactRange === 'function' ? '空闲态（已打补丁）' : '仅限轮内（补丁缺失）';
		},
		compositionConfig,
		defaults: DEFAULTS,
		types: CONFIG_TYPES,
	};
	ctx.effect(() => registerRoutes({ ctx, deps, report: (level, text) => report(ctx, level, text) }), 'dsh-compaction-selective: web routes');
	report(ctx, 'info', '客户端 API 已注册：/compaction-selective/{state,config,fold}');
	// 注：`/fold` **刻意不在这里注册**。客户端用 `ctx.commandUi.register` 注册同名贡献 ——
	// 只有 `CommandContribution` 带 label()（中文名）与 icon；而贡献与宿主命令**同名会在
	// 候选合成时报错**（契约原话：fails loud, never shadows），所以改由客户端独占这一行。

}

export function apply(ctx, config = {}) {
	// 兜底：任何未预期异常都只影响本插件，不让宿主 boot 失败（2026-11-10 事故：桌面端整机起不来）。
	try {
		return applyInner(ctx, config);
	} catch (error) {
		const detail = error?.stack ?? String(error);
		try {
			ctx?.logger?.error?.(`[compaction-selective] 激活失败，插件已自行停用（不影响宿主）：${detail}`);
		} catch {
			/* 连 logger 都没有时也不能抛 */
		}
		if (globalThis.__DSH_COMPACTION_SELECTIVE_STRICT__ === true) throw error;
		return undefined;
	}
}

export { FOLD_INSTRUCTION, installFoldSummarizer, isFoldSummarizerInstalled } from './summarizer.js';
export { CONFIG_TYPES, effectiveConfig, loadSettings, saveSettings, settingsPath, validateEntry } from './config.js';
export { planFold, readOutlineTurns } from './plan.js';
