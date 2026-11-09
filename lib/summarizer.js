/**
 * Phase 2（D 方案）：把压缩后端的 `summarize()` 换成一版「局部压缩」摘要。
 *
 * 为什么不是子类化：`BasicCompactionEngine` 的 `regionDependencies()` 里写的是
 * `summarize: (input, owner, abort) => this.summarize(input, owner, abort)` —— 一次
 * **实例属性查找**。因此在**已加载的压缩服务实例**上放一个同名的自有属性，即可覆盖
 * 原型上的 `summarize`，而：
 *   - 不必 disable `compaction-basic`、不改组合、不动其它压缩路径的装配；
 *   - 不必让外挂插件 import `@deepseek-ai/dsh-compaction`（本机 profile 里根本没有这个包）；
 *   - 不存在「第二份 cordis / Service 身份不一致」导致服务注册失败的风险。
 * 代价：`this.config` 按服务级配置读取（见 `resolveSummarizeTarget` 的注释）。
 *
 * @module dsh-compaction-selective/summarizer
 */

/**
 * 「局部压缩」摘要指令。
 *
 * 出厂指令是硬编码的英文 8 段「工作前史」模板（Primary Request and Intent / Next Step …）。
 * 它假设你在压缩整个工作的前史，而这里压的是**一段被人类主动要求丢掉的支线**，且摘要调用
 * 只把选区本身发给模型（`buildSummarizationInput` 只取被遮蔽的 seqs），模型看不到主线，
 * 模板必然跑偏。所以换成这套以「可回溯锚点」为第一优先的四节结构。
 */
export const FOLD_INSTRUCTION = [
	'这**一段历史**被人类主动要求压缩。它不是对话的起点，而是一段已经被处理掉的支线。',
	'把它压缩成一段短检查点，让后续对话能继续，同时不丢失可回溯的锚点。',
	'',
	'只输出以下四节，顺序不变，总长不超过 200 字。每节都要出现，没有内容就写「（无）」。',
	'',
	'## 这段在做什么',
	'- 一到两句：这段对话在处理什么问题。',
	'',
	'## 结论与产出物',
	'- 保留确切的文件名、路径、命令、参数、版本号、错误字符串、结果数字。',
	'- 这些是后续回读的锚点：宁可罗列，也不要概括掉。',
	'',
	'## 被搁置的支线',
	'- 本可以继续但没有继续的方向，以及搁置原因。',
	'',
	'## 可安全丢弃的细节',
	'- 哪部分确认没有长期价值。',
	'',
	'规则：',
	'- 语言跟随原文的主体语言（中文对话一律用中文，不要写英文工程散文）。',
	'- 不要复述工具输出的原文，不要写「下一步」，不要提到这次压缩本身。',
	'- 只输出检查点正文：不要调用任何工具，不要输出解释或前后缀。',
].join('\n');

/** 递归冻结（保持与出厂后端一致的不可变消息约定，且不额外依赖 util 包）。 */
function deepFreeze(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return Object.freeze(value);
}

/** 把终止状态映射成失败错误（与出厂实现同规则）。 */
function finishError(finish, LlmError) {
	switch (finish.kind) {
		case 'error':
		case 'aborted':
			return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
		case 'max-tokens': {
			const error = new Error('summarization truncated at the token cap (incomplete checkpoint)');
			error.code = 'MAX_TOKENS';
			return error;
		}
		default:
			return undefined;
	}
}

/** 只保留文本块；遇到图像输出直接拒绝（与出厂实现同规则）。 */
function summaryText(blocks, LlmError) {
	if (blocks.some((block) => block.type === 'image')) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT');
	return blocks.filter((block) => block.type === 'text');
}

/**
 * 解析摘要调用使用的 provider/model。
 *
 * 与出厂 `summarizeWithLlm` 同样的优先级：显式配置 → 最近一次真实请求的路由 → agent 选项。
 * 差异（已知且有意）：出厂实现还会按路由查 `modelPolicies[]` 取该模型的 `maxTokens`；
 * 这里退回服务级 `config.maxTokens`。只有在显式配了 per-model `maxTokens` 时才有区别。
 * @param engine - 已加载的压缩服务实例。
 * @param agent - 调用方提供的 agent 上下文。
 * @returns `{ target, maxTokens }`。
 * @throws 当没有可用的 provider/model 时。
 */
export function resolveSummarizeTarget(engine, agent) {
	const config = engine?.config ?? {};
	const latest = agent?.session?.requestHeader()?.config;
	const configured = typeof config.summarizationProvider === 'string' && config.summarizationProvider.length > 0
		? { provider: config.summarizationProvider, model: config.summarizationModel }
		: undefined;
	const options = agent?.options ?? {};
	const agentTarget = typeof options.provider === 'string' && options.provider.length > 0
		&& typeof options.model === 'string' && options.model.length > 0
		? { provider: options.provider, model: options.model }
		: undefined;
	const target = configured ?? latest ?? agentTarget;
	if (target === undefined) {
		throw new Error('no provider/model available for summarization: set both summarizationProvider and summarizationModel, route one request, or set both agent provider and model');
	}
	return { target, maxTokens: config.maxTokens };
}

/**
 * 解析可用的 `llm` 服务。
 *
 * ⚠ 这里有个实测踩过的坑：**不能直接读根 ctx 的 `ctx.llm`** —— Cordis 对未在 `inject` 里声明的
 * 服务会抛 `cannot get property "llm" without inject`（本插件的 inject 只有 tools/agents/tokenMeter/
 * sessionProjections/userQuestions）。两条正确取法：
 *   1. **优先用压缩服务自己作用域里那一份**（`engine.ctx`）—— `dsh-compaction-basic` 的
 *      `static inject` 里就有 `llm`，所以它的 ctx 上这一项是合法可读的，语义也最正确；
 *   2. `scope.get('llm')` **绕开** without-inject 保护（官方取可选服务就是这么写的：
 *      `const prune = this.ctx.get("toolResultPruner")`）。
 * @param engine - 已加载的压缩服务实例（首选它的作用域）。
 * @param fallbackCtx - 兜底作用域（插件自己的 ctx）。
 * @returns `llm` 服务，或 `undefined`。
 */
export function resolveLlmService(engine, fallbackCtx) {
	for (const scope of [engine?.ctx, fallbackCtx]) {
		if (scope === undefined || scope === null) continue;
		try {
			const viaGet = typeof scope.get === 'function' ? scope.get('llm') : undefined;
			if (typeof viaGet?.stream === 'function') return viaGet;
		} catch {
			/* 换下一种取法 */
		}
		try {
			const direct = scope.llm;
			if (typeof direct?.stream === 'function') return direct;
		} catch {
			/* 换下一个作用域 */
		}
	}
	return undefined;
}

/**
 * 构造覆盖用的 `summarize` 实现。
 * @param input - 已解析的 `llm` 服务与编解码依赖。
 * @returns 可直接挂到压缩服务实例上的 `summarize(input, agent, signal)`。
 */
export function makeFoldSummarize(input) {
	const { llm, BlockAssembler, LlmError, instruction = FOLD_INSTRUCTION } = input;
	if (typeof llm?.stream !== 'function') throw new Error('fold summarize requires a resolved llm service');
	return async function foldSummarize(conversation, agent, signal) {
		const { target, maxTokens } = resolveSummarizeTarget(this, agent);
		const assembler = new BlockAssembler();
		const messages = [
			...conversation.messages,
			deepFreeze({ role: 'user', content: [{ type: 'text', text: instruction }] }),
		];
		const options = {
			provider: target.provider,
			model: target.model,
			messages,
			toolHistory: agent.session.toolHistory(),
			...(conversation.tools === undefined ? {} : { tools: [...conversation.tools] }),
			...(maxTokens === undefined ? {} : { maxTokens }),
			sessionId: agent.session.id,
			purpose: 'compaction',
			...(signal === undefined ? {} : { signal }),
		};
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
		const error = finishError(assembler.finish, LlmError);
		if (error !== undefined) throw error;
		const rawOutput = assembler.blocks();
		const summary = summaryText(rawOutput, LlmError);
		if (!summary.some((block) => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content');
		return {
			summary,
			rawOutput,
			llmStreamCall: true,
			provider: options.provider,
			model: options.model,
			...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
			...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
		};
	};
}

/** 覆盖标记：放在实例上，保证幂等且可被人为检查。 */
const PATCH_KEY = '__compactionSelectiveSummary';

/**
 * 把一个「局部压缩」摘要实现装到已加载的压缩服务实例上（幂等）。
 * @param input - 上下文、依赖与开关。
 * @returns `{ status: 'installed' | 'already', restore? }`，或抛错（由调用方降级处理）。
 */
export function installFoldSummarizer(input) {
	const { engine, ctx } = input;
	if (typeof engine?.summarize !== 'function') throw new Error('compaction service has no summarize() to override');
	const existing = engine[PATCH_KEY];
	if (existing !== undefined) return { status: 'already', restore: existing.restore };
	const llm = input.llm ?? resolveLlmService(engine, ctx);
	if (llm === undefined) {
		throw new Error('no llm service reachable for the fold summarizer（engine.ctx 与根 ctx 都取不到 llm）');
	}
	const original = engine.summarize;
	const patched = makeFoldSummarize({ ...input, llm });
	Object.defineProperty(engine, 'summarize', {
		value: patched,
		writable: true,
		configurable: true,
		enumerable: false,
	});
	const restore = () => {
		if (engine[PATCH_KEY] === undefined) return;
		delete engine[PATCH_KEY];
		Object.defineProperty(engine, 'summarize', {
			value: original,
			writable: true,
			configurable: true,
			enumerable: false,
		});
	};
	Object.defineProperty(engine, PATCH_KEY, {
		value: { patched, original, restore },
		writable: false,
		configurable: true,
		enumerable: false,
	});
	return { status: 'installed', restore };
}

/** 查询实例上是否已装上压缩摘要。 */
export function isFoldSummarizerInstalled(engine) {
	return engine?.[PATCH_KEY] !== undefined;
}
