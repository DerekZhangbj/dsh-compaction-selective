/**
 * 宿主侧 HTTP API —— 客户端半边靠它读写。
 *
 * 三个端点（同源 fetch，与 housekeeper 同一套做法）：
 *   GET  /compaction-selective/state?sessionId=…   生效配置 + 轮次表 + 最近 N 轮建议 + 压缩通道 + 定位诊断
 *   POST /compaction-selective/config {patch}      写插件的 JSON 设置文件（即时生效，不碰组合文件）
 *   POST /compaction-selective/fold  {…, confirm}  执行压缩（**必须** confirm: true；空闲态走本地补丁的 compactRange）
 *
 * 三条入口（输入框按钮、插件详情页表单、＋菜单里的 commandUi 贡献）都只用这里的接口，
 * 压缩逻辑本身与工具路径共用 `planFold()`：同一份护栏、同一套拒绝理由。
 *
 * ⚠ 这个文件在 2026-10-15 被一次误操作清空过，现按离线测试（tests/run.mjs 第 14 节）重建；
 *    `suggestions` / `turns` / 失败体的字段形状都以那份测试为准。
 */
import { CONFIG_TYPES, DEFAULTS, effectiveConfig, saveSettings, settingsPath } from './config.js';
import { planFold, readOutlineTurns } from './plan.js';
import { attributeTurns, clip, collectEvents, findOpenTurn, spanTokens } from './range.js';

/** 把压缩失败翻译成人话（与 index.js 的 `mapFailure` 同一套语义，原文一律未变）。 */
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

/** 读请求体（这里只有很小的 JSON；超过 64 KB 直接拒绝）。 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 65536) throw new Error('请求体过大');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * 写一个 JSON 响应。
 * @param res - 宿主给的响应对象（只需要 writeHead / end）。
 * @param status - HTTP 状态码。
 * @param payload - 可 JSON 化的负载。
 */
export function sendJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(payload));
}

/**
 * 会话的轮次表：面板里那张「轮 / 用量 / 你说的话」。
 *
 * 轮次归属由 `attributeTurns` 算（它给的是「每个表面位置属于哪一轮」），这里把连续同轮的
 * 位置合并成区间再取用量；文本取自 `turnOutline` 投影（没有投影就留空，不影响压缩）。
 * @param projections - `sessionProjections` 服务。
 * @param session - 会话。
 * @param measurement - `tokenMeter.measure(session)` 的结果。
 * @returns `{ openTurn, turns }`；`openTurn` 是进行中的轮号，或 `null`（空闲）。
 */
export function turnTable(projections, session, measurement) {
	const surfaceSeqs = session?.surface?.nodes ?? [];
	const events = collectEvents(session);
	const owners = attributeTurns(events, surfaceSeqs);
	const open = findOpenTurn(events);
	const outline = readOutlineTurns(projections, session);
	const nodes = measurement?.nodes ?? [];

	const spans = new Map();
	owners.forEach((turn, index) => {
		if (typeof turn !== 'number') return;
		const current = spans.get(turn);
		if (current === undefined) spans.set(turn, { turn, startIdx: index, endIdx: index });
		else current.endIdx = index;
	});

	const turns = [...spans.values()]
		.sort((a, b) => a.turn - b.turn)
		.map((span) => {
			const text = outline.find((row) => row?.turn === span.turn) ?? {};
			return {
				turn: span.turn,
				nodes: span.endIdx - span.startIdx + 1,
				tokens: spanTokens(nodes, span.startIdx, span.endIdx),
				prompt: clip(text.prompt ?? '', 120),
				response: clip(text.response ?? '', 600),
				// 「可折」= 整轮已结束（进行中的那一轮不能折）。
				foldable: open === null || span.turn !== open.turn,
			};
		});

	return { openTurn: open === null ? null : open.turn, turns };
}

/** 配置三件套 + 路径：每个响应都带它，客户端据此画表单。 */
function configBase(deps) {
	const eff = effectiveConfig(deps.compositionConfig ?? {}, settingsPath());
	return {
		config: eff.config,
		origin: eff.origin,
		defaults: deps.defaults ?? DEFAULTS,
		types: deps.types ?? CONFIG_TYPES,
		// ⚠ 这里必须是**路径字符串**（`settingsPath()`）。曾经误写成 `eff.file` —— 那是「设置文件里的
		// **内容对象**」，客户端把它当子节点渲染 ⇒ `React #31（object with keys {}）`，详情页表单整块崩掉。
		settingsPath: settingsPath(),
		configError: eff.error ?? null,
	};
}

/**
 * 组装 `GET /state` 的响应体。
 * @param input - `{ ctx, deps, sessionId }`。
 * @returns 与客户端约定好的对象（失败时 `error` 有值、`session` 为 `null`，**不抛**）。
 */
export async function sessionState(input) {
	const { deps, sessionId } = input;
	const base = configBase(deps);
	// 活跃会话清单：客户端拿不到 sessionId 时（例如同时开着两个会话）由人来选 —— 压缩不可逆，绝不猜。
	const sessions = typeof deps.listSessions === 'function' ? deps.listSessions() : [];
	const resolved = deps.resolveAgent(sessionId);
	if (resolved.agent === undefined) {
		return { ...base, error: resolved.error ?? '找不到这个会话', sessions, session: null };
	}
	const agent = resolved.agent;
	const session = agent.session;
	const projections = deps.projections(agent);
	const measurement = deps.tokenMeter(agent).measure(session);
	const outlineTurns = readOutlineTurns(projections, session);
	const table = turnTable(projections, session, measurement);

	const suggestions = [1, 2, 3, 5].map((recent) => {
		const planned = planFold({ session, measurement, outlineTurns, args: { recent_turns: recent }, config: base.config });
		return planned.ok
			? { recent, ok: true, label: planned.label, tokens: planned.shadowedTokens, nodes: planned.nodeCount }
			: { recent, ok: false, message: planned.message };
	});

	return {
		...base,
		error: null,
		sessions,
		session: {
			id: session.id,
			openTurn: table.openTurn,
			totalTokens: measurement?.totalTokens ?? 0,
			surfaceNodes: session.surface?.nodes?.length ?? 0,
			turns: table.turns,
			suggestions,
			engine: deps.engineLabel(agent),
			foldPath: deps.foldPath(agent),
			resolution: typeof deps.resolution === 'function' ? deps.resolution(agent) : undefined,
		},
	};
}

/**
 * 执行一次压缩（`POST /fold`）。
 *
 * 顺序刻意如此：**先确认 → 再定位（planFold 的全部护栏）→ 最后才碰压缩服务**，所以任何拒绝
 * 都发生在改动之前。`confirm` 是硬门禁：客户端必须先让人类确认过一次。
 * @param input - `{ ctx, deps, body }`（`body.sessionId` / `recent_turns` / `from_turn`+`to_turn` / `confirm`）。
 * @returns `{ http, body }`。
 */
export async function foldSession(input) {
	const { deps, body } = input;
	if (body?.confirm !== true) {
		return { http: 400, body: { status: 'rejected', reason: 'NO_CONFIRM', message: '缺少 confirm: true（客户端必须先让人类确认一次）' } };
	}
	const resolved = deps.resolveAgent(body?.sessionId);
	if (resolved.agent === undefined) {
		return { http: 200, body: { status: 'rejected', reason: 'NO_AGENT', message: resolved.error ?? '找不到这个会话' } };
	}
	const agent = resolved.agent;
	const base = configBase(deps);
	if (base.config.enabled !== true) {
		return { http: 200, body: { status: 'rejected', reason: 'DISABLED', message: '插件已在设置里停用。没有改动任何内容。' } };
	}
	const session = agent.session;
	const measurement = deps.tokenMeter(agent).measure(session);
	const outlineTurns = readOutlineTurns(deps.projections(agent), session);
	const planned = planFold({ session, measurement, outlineTurns, args: body ?? {}, config: base.config });
	if (!planned.ok) {
		return { http: 200, body: { status: 'rejected', reason: planned.reason, message: planned.message, turnsLabel: '' } };
	}

	const engine = deps.resolveEngine(agent);
	if (engine === undefined) {
		return { http: 200, body: { status: 'rejected', reason: 'NO_SERVICE', message: '取不到这个会话的压缩服务（未定位到实例）。没有改动任何内容。' } };
	}
	if (typeof engine.compactRange !== 'function') {
		return {
			http: 200,
			body: {
				status: 'rejected',
				reason: 'NO_PATCH',
				message: '空闲态折指定区间需要本地补丁 compactRange，当前后端上没有它 —— 需要给核心打本地补丁 compactRange（仓库的 patches/apply-compaction-patch.ps1）并重启宿主。没有改动任何内容。',
			},
		};
	}

	try {
		const result = await engine.compactRange(planned.startSeq, planned.endSeq, agent, new AbortController().signal);
		const nodes = result?.shadowedSeqs?.length ?? planned.nodeCount;
		const tokens = result?.shadowedTokenCount ?? planned.shadowedTokens;
		return {
			http: 200,
			body: {
				status: 'compacted',
				reason: '',
				message: `已压缩 turn ${planned.label}（${nodes} 条表面节点，约释放 ${tokens} token）。原文仍在会话日志中，可回放或展开摘要查看。`,
				turnsLabel: planned.label,
				startSeq: result?.shadowedRange?.start ?? planned.startSeq,
				endSeq: result?.shadowedRange?.end ?? planned.endSeq,
				shadowedNodes: nodes,
				shadowedTokens: tokens,
				summarySeq: result?.summarySeq ?? 0,
				engine: deps.engineLabel(agent),
			},
		};
	} catch (error) {
		return { http: 200, body: mapFailure(error) };
	}
}

/**
 * 注册客户端用的 HTTP 路由（`kind: 'prefix'`：同一前缀下的路径都交给这里）。
 * @param input - `{ ctx, deps, report }`。
 * @returns 注册的 disposer。
 */
export function registerRoutes(input) {
	const { ctx, deps, report } = input;
	const PREFIX = '/compaction-selective';
	return ctx.webServer.register({
		kind: 'prefix',
		path: PREFIX,
		handler: async (req, res) => {
			let url;
			try {
				url = new URL(req.url ?? PREFIX, 'http://localhost');
			} catch {
				sendJson(res, 400, { error: 'bad url' });
				return;
			}
			const suffix = url.pathname.slice(PREFIX.length);
			try {
				if (req.method === 'GET' && suffix === '/state') {
					const sessionId = url.searchParams.get('sessionId') ?? undefined;
					sendJson(res, 200, await sessionState({ ctx, deps, sessionId }));
					return;
				}
				if (req.method === 'POST' && suffix === '/config') {
					const body = JSON.parse((await readBody(req)) || '{}');
					try {
						saveSettings(body?.patch ?? {});
					} catch (error) {
						sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
						return;
					}
					report('info', `设置已更新：${JSON.stringify(body?.patch ?? {})}`);
					sendJson(res, 200, { ok: true, ...configBase(deps) });
					return;
				}
				if (req.method === 'POST' && suffix === '/ui-locale') {
					// 客户端上报界面语言：宿主的确认卡用它决定用哪种语言渲染。
					const body = JSON.parse((await readBody(req)) || '{}');
					deps.setReportedLocale?.(body?.locale);
					sendJson(res, 200, { ok: true });
					return;
				}
				if (req.method === 'POST' && suffix === '/fold') {
					const body = JSON.parse((await readBody(req)) || '{}');
					const outcome = await foldSession({ ctx, deps, body });
					report(outcome.http === 200 && outcome.body.status === 'compacted' ? 'info' : 'warn', `客户端压缩：${outcome.body.status}${outcome.body.reason ? `/${outcome.body.reason}` : ''} — ${outcome.body.message}`);
					sendJson(res, outcome.http, outcome.body);
					return;
				}
				sendJson(res, 404, { error: 'no such endpoint' });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				report('warn', `API 出错：${message}`);
				sendJson(res, 500, { error: message });
			}
		},
	});
}
