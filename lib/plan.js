/**
 * 「压缩计划」——把「想折哪些轮」翻译成一份可执行的方案（区间端点、估价、预览、护栏结论）。
 *
 * **工具路径（模型调用）与客户端路径（GUI 按钮）共用这一份实现**，避免两处各写一遍区间逻辑
 * 然后慢慢漂移。这里只做计算，不碰会话：调用方负责把 `session` / `measurement` / `outlineTurns`
 * 递进来，并决定执行与否。
 *
 * @module dsh-compaction-selective/plan
 */

import {
	REASON,
	REASON_TEXT,
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
} from './range.js';

/** 把模型/客户端参数里的数字宽化一下（schema 已做类型校验，这里只做防御）。 */
export function toInteger(value) {
	if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
	if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
	return undefined;
}

/**
 * 解析目标参数：`recent_turns` 与 `from_turn`/`to_turn` 互斥。
 * @param args - `{ recent_turns?, from_turn?, to_turn? }`。
 * @returns `{ ok: true, kind, ... }` 或 `{ ok: false, reason, detail }`。
 */
export function resolveTurnArgs(args) {
	const recent = toInteger(args?.recent_turns);
	const from = toInteger(args?.from_turn);
	const to = toInteger(args?.to_turn);
	const hasRecent = recent !== undefined;
	const hasPair = from !== undefined || to !== undefined;
	if (hasRecent && hasPair) return { ok: false, reason: REASON.BAD_ARGS, detail: 'recent_turns 与 from_turn/to_turn 不能同时给出' };
	if (hasRecent) {
		if (recent < 1) return { ok: false, reason: REASON.BAD_ARGS, detail: 'recent_turns 必须 ≥ 1' };
		return { ok: true, kind: 'recent', recent };
	}
	if (from === undefined || to === undefined) return { ok: false, reason: REASON.BAD_ARGS, detail: 'from_turn 与 to_turn 必须同时给出' };
	if (from < 1 || to < from) return { ok: false, reason: REASON.BAD_ARGS, detail: `轮号区间不合法：${from}..${to}` };
	return { ok: true, kind: 'turns', from, to };
}

/** 读取 turnOutline 投影，兼容「状态对象」与「线上值」两种形状。 */
export function readOutlineTurns(projections, session) {
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

/**
 * 生成压缩计划。
 * @param input - 会话、计量、大纲、目标参数、配置与可选的白名单 session 覆盖。
 * @returns 成功时 `{ ok: true, ... }`（含端点、估价、预览、涉及的轮号），
 *   失败时 `{ ok: false, reason, message }`（`message` 是给人看的一句话）。
 */
export function planFold(input) {
	const { session, measurement, outlineTurns, args, config } = input;
	const reject = (reason, detail = '') => ({
		ok: false,
		reason,
		detail,
		message: `${REASON_TEXT[reason] ?? reason}${detail === '' ? '' : `（${detail}）`}`,
	});

	const parsed = resolveTurnArgs(args);
	if (!parsed.ok) return reject(parsed.reason, parsed.detail);

	const surfaceSeqs = session?.surface?.nodes ?? [];
	if (surfaceSeqs.length === 0) return reject(REASON.BAD_RANGE, '可见历史为空');

	const events = collectEvents(session);
	const surfaceEvents = surfaceSeqs.map((seq) => events[seq]);
	const turns = attributeTurns(events, surfaceSeqs);
	const openTurn = findOpenTurn(events);

	let located = null;
	if (parsed.kind === 'recent') {
		const span = resolveRecentTurns(turns, openTurn, parsed.recent);
		if (span === null) return reject(REASON.UNKNOWN_TURN, `当前可见的已结束轮次不足 ${parsed.recent} 轮`);
		located = locateByTurns(turns, openTurn, span.from, span.to);
	} else {
		located = locateByTurns(turns, openTurn, parsed.from, parsed.to);
	}
	if (located === null) return reject(REASON.UNKNOWN_TURN);

	let flags;
	try {
		flags = balanceFlags(surfaceEvents);
	} catch (error) {
		return reject(REASON.BAD_RANGE, error instanceof Error ? error.message : String(error));
	}
	const snapped = snapBalanced(flags, located.startIdx, located.endIdx);
	if (snapped === null) return reject(REASON.UNBALANCED);

	const nodes = measurement?.nodes ?? [];
	const shadowedTokens = spanTokens(nodes, snapped.startIdx, snapped.endIdx);
	const totalTokens = measurement?.totalTokens ?? 0;
	const guard = checkGuards({
		startIdx: snapped.startIdx,
		endIdx: snapped.endIdx,
		turns,
		openTurn,
		shadowedTokens,
		totalTokens,
		config,
	});
	if (!guard.ok) return reject(guard.reason, guard.detail);

	const preview = describeSpan({ turns, startIdx: snapped.startIdx, endIdx: snapped.endIdx, outlineTurns });
	return {
		ok: true,
		startIdx: snapped.startIdx,
		endIdx: snapped.endIdx,
		startSeq: surfaceSeqs[snapped.startIdx],
		endSeq: surfaceSeqs[snapped.endIdx],
		nodeCount: snapped.endIdx - snapped.startIdx + 1,
		shadowedTokens,
		totalTokens,
		turnNumbers: preview.turnNumbers,
		lines: preview.lines,
		openTurn,
		label: (() => {
			const first = preview.turnNumbers[0] ?? 0;
			const last = preview.turnNumbers[preview.turnNumbers.length - 1] ?? 0;
			return first === last ? `${first}` : `${first}-${last}`;
		})(),
	};
}
