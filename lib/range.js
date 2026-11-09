/**
 * 纯逻辑层：把「轮次」翻译成表面位置上的连续区间，做平衡吸附、护栏检查、估价与预览。
 *
 * 本文件**不 import 任何 `@deepseek-ai/*`**：所有依赖都通过参数传入（表面事件数组、
 * 轮次归属数组、token 计量结果）。这样既避免外挂插件走原生解析时解析不到核心包，
 * 也让全部决策逻辑可以脱离宿主单测。
 *
 * 术语：
 *   - **表面（surface）** = 模型可见的历史，是会话日志的投影；`surface.nodes` 是按
 *     模型可见顺序排列的事件 seq 数组。替换（压缩）会让 seq 非单调，因此本文件一律
 *     在**表面位置**（下标）上工作，绝不用 seq 大小比较先后。
 *   - **切点平衡** = 官方 `toolPairingBalancedBefore/After` 的同一规则：切点两侧不能
 *     留下未配对的 tool-call / tool-result。
 *
 * @module dsh-compaction-selective/range
 */

/** 拒绝理由码（进审批前就用来拒绝，不打扰人类）。 */
export const REASON = Object.freeze({
	BAD_ARGS: 'BAD_ARGS',
	BAD_RANGE: 'BAD_RANGE',
	UNKNOWN_TURN: 'UNKNOWN_TURN',
	OPEN_TURN: 'OPEN_TURN',
	SYSTEM_HEAD: 'SYSTEM_HEAD',
	TOO_SMALL: 'TOO_SMALL',
	TOO_LARGE: 'TOO_LARGE',
	UNBALANCED: 'UNBALANCED',
	RATE_LIMIT: 'RATE_LIMIT',
	NOT_ROOT: 'NOT_ROOT',
	NO_SERVICE: 'NO_SERVICE',
});

/** 可读的拒绝理由，直接进工具返回文本。 */
export const REASON_TEXT = Object.freeze({
	BAD_ARGS: '参数不合法：recent_turns 与 from_turn/to_turn 必须二选一，且轮号必须是正整数。',
	BAD_RANGE: '这段区间在当前的可见历史上找不到对应的连续位置，没有改动任何内容。',
	UNKNOWN_TURN: '找不到你说的轮次（可能已被压缩、或轮号超出当前会话）。没有改动任何内容。',
	OPEN_TURN: '选区跨越了正在进行中的这一轮。只能压缩已经结束的轮次。没有改动任何内容。',
	SYSTEM_HEAD: '选区碰到了系统提示所在的第一个节点，不允许压缩。没有改动任何内容。',
	TOO_SMALL: '这段历史太小，压缩不划算（摘要不会比原文更短）。没有改动任何内容。',
	TOO_LARGE: '一次要压缩的范围超过了允许的上限。没有改动任何内容。',
	UNBALANCED: '选区边界落在了一次工具调用的中间，无法安全切分。没有改动任何内容。',
	RATE_LIMIT: '本轮已经压缩过一次了，同一轮内不再重复压缩。没有改动任何内容。',
	NOT_ROOT: '只有会话根智能体可以压缩历史（子智能体不能改父会话）。没有改动任何内容。',
	NO_SERVICE: '取不到这个会话的压缩服务（它在 agent preset 作用域里隔离），因此无法压缩。没有改动任何内容。',
});

/**
 * 一个表面事件对「未闭合 tool-call 计数」的增量（与官方 eventDelta 同规则）。
 * @param event - 表面节点对应的事件。
 * @returns 该事件带来的未闭合 tool-call 数量变化。
 */
export function eventDelta(event) {
	switch (event.type) {
		case 'assistant/message':
			return event.data.message.content.filter((block) => block.type === 'tool-call').length;
		case 'tool/result':
			return -1;
		default:
			return 0;
	}
}

/**
 * 计算每个切点的平衡状态。
 * @param surfaceEvents - 表面节点对应的事件，按表面顺序。
 * @returns 长度 n+1 的布尔数组：`flags[i]` = 「切在第 i 个节点之前」是否平衡。
 *   `flags[0]` 恒为 true；`flags[n]` = 「切在最后一个节点之后」是否平衡。
 * @throws 当某个 tool/result 找不到对应的 tool-call（表面损坏）时。
 */
export function balanceFlags(surfaceEvents) {
	const flags = [true];
	let open = 0;
	for (const event of surfaceEvents) {
		if (event === undefined) throw new Error('surface event is missing (corrupt surface)');
		open += eventDelta(event);
		if (open < 0) throw new Error('tool/result at a surface node has no matching tool-call (corrupt surface)');
		flags.push(open === 0);
	}
	return flags;
}

/**
 * 把会话日志读成按下标寻址的事件数组。
 * @param session - 提供 `seq` 与 `eventAt` 的会话。
 * @returns 长度等于日志长度的事件数组。
 */
export function collectEvents(session) {
	const events = new Array(session.seq);
	for (let seq = 0; seq < session.seq; seq += 1) events[seq] = session.eventAt(seq);
	return events;
}

/**
 * 为每个表面节点标出它所属的轮次号。
 *
 * 规则与压缩后端一致：`assistant/message` / `tool/call` 一类携带 `turn` 的事件直接用它，
 * 其余（人类提示等）沿用当时最近一次 `turn/start` 的轮号。压缩产生的检查点消息在日志里
 * 位置靠后、在表面上位置靠前，因此它的归属可能不准；调用方必须靠预览让人类复核。
 *
 * @param events - `collectEvents` 的结果。
 * @param surfaceSeqs - `session.surface.nodes`。
 * @returns 与表面等长的数组，元素为轮次号或 `null`（位于任何 `turn/start` 之前）。
 */
export function attributeTurns(events, surfaceSeqs) {
	const positionOf = new Map();
	surfaceSeqs.forEach((seq, index) => positionOf.set(seq, index));
	const turns = new Array(surfaceSeqs.length).fill(null);
	let current = null;
	for (let seq = 0; seq < events.length; seq += 1) {
		const event = events[seq];
		if (event === undefined) continue;
		if (event.type === 'turn/start') {
			current = event.data.turn;
			continue;
		}
		const index = positionOf.get(seq);
		if (index === undefined) continue;
		const own = event.data !== null && typeof event.data === 'object' && typeof event.data.turn === 'number'
			? event.data.turn
			: current;
		turns[index] = own;
	}
	return turns;
}

/**
 * 找到当前「正在进行、尚未结束」的那一轮。
 * @param events - `collectEvents` 的结果。
 * @returns `{ turn, startSeq }`，或 `null`（会话空闲）。
 */
export function findOpenTurn(events) {
	for (let seq = events.length - 1; seq >= 0; seq -= 1) {
		const event = events[seq];
		if (event === undefined) continue;
		if (event.type === 'turn/end') return null;
		if (event.type === 'turn/start') return { turn: event.data.turn, startSeq: event.seq };
	}
	return null;
}

/**
 * 把 `recent_turns: N` 解析成轮号区间（含刚结束的那一轮，不含进行中的那一轮）。
 * @param turns - `attributeTurns` 的结果。
 * @param openTurn - `findOpenTurn` 的结果。
 * @param count - 要压缩的轮数。
 * @returns `{ from, to }`，或 `null`（可见轮数不足）。
 */
export function resolveRecentTurns(turns, openTurn, count) {
	const numbers = [...new Set(turns.filter((turn) => turn !== null && (openTurn === null || turn !== openTurn.turn)))].sort((a, b) => a - b);
	if (numbers.length < count) return null;
	return { from: numbers[numbers.length - count], to: numbers[numbers.length - 1] };
}

/**
 * 在表面位置空间里定位一个轮号区间的连续切片。
 * @param turns - `attributeTurns` 的结果。
 * @param openTurn - `findOpenTurn` 的结果。
 * @param from - 起始轮号（含）。
 * @param to - 结束轮号（含）。
 * @returns `{ startIdx, endIdx }`（最小覆盖切片），或 `null`（区间内没有可见节点）。
 */
export function locateByTurns(turns, openTurn, from, to) {
	const inRange = (turn) => turn !== null && turn >= from && turn <= to && (openTurn === null || turn !== openTurn.turn);
	const startIdx = turns.findIndex(inRange);
	if (startIdx === -1) return null;
	let endIdx = -1;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		if (inRange(turns[index])) {
			endIdx = index;
			break;
		}
	}
	return endIdx === -1 ? null : { startIdx, endIdx };
}

/**
 * 把区间向内吸附到平衡切点（端点落在工具调用中间时向里收）。
 * @param flags - `balanceFlags` 的结果。
 * @param startIdx - 候选起点下标。
 * @param endIdx - 候选终点下标。
 * @returns `{ startIdx, endIdx }`，或 `null`（吸附后为空）。
 */
export function snapBalanced(flags, startIdx, endIdx) {
	let start = startIdx;
	let end = endIdx;
	while (start <= end && flags[start] !== true) start += 1;
	while (end >= start && flags[end + 1] !== true) end -= 1;
	return start > end ? null : { startIdx: start, endIdx: end };
}

/**
 * 估算选区的路由 token 数。
 * @param measurementNodes - `ctx.tokenMeter.measure(session).nodes`（与表面等长且对齐）。
 * @param startIdx - 起点下标。
 * @param endIdx - 终点下标。
 * @returns token 合计。
 */
export function spanTokens(measurementNodes, startIdx, endIdx) {
	let total = 0;
	for (let index = startIdx; index <= endIdx; index += 1) total += measurementNodes[index]?.tokens ?? 0;
	return total;
}

/**
 * 执行审批之前的全部硬护栏。
 * @param input - 选区、归属、计量与配置。
 * @returns `{ ok: true }` 或 `{ ok: false, reason, detail }`。
 */
export function checkGuards(input) {
	const { startIdx, endIdx, turns, openTurn, shadowedTokens, totalTokens, config } = input;
	if (startIdx > endIdx) return { ok: false, reason: REASON.BAD_RANGE, detail: `${startIdx} > ${endIdx}` };
	if (startIdx === 0) {
		return {
			ok: false,
			reason: REASON.SYSTEM_HEAD,
			detail: '选区包含表面节点 0',
		};
	}
	if (openTurn !== null) {
		for (let index = startIdx; index <= endIdx; index += 1) {
			if (turns[index] === openTurn.turn) return { ok: false, reason: REASON.OPEN_TURN, detail: `turn ${openTurn.turn} 正在进行` };
		}
	}
	if (shadowedTokens < config.minShadowedTokens) {
		return {
			ok: false,
			reason: REASON.TOO_SMALL,
			detail: `约 ${shadowedTokens} tokens < 下限 ${config.minShadowedTokens}`,
		};
	}
	if (totalTokens > 0 && shadowedTokens > totalTokens * config.maxSurfaceShare) {
		return {
			ok: false,
			reason: REASON.TOO_LARGE,
			detail: `约 ${shadowedTokens} tokens > 表面 ${totalTokens} 的 ${Math.round(config.maxSurfaceShare * 100)}%`,
		};
	}
	return { ok: true };
}

/**
 * 生成审批卡片要展示的预览。
 * @param input - 归属、区间与轮次大纲。
 * @returns `{ turnNumbers, lines }`：涉及的轮号（升序）与逐轮预览行。
 */
export function describeSpan(input) {
	const { turns, startIdx, endIdx, outlineTurns } = input;
	const turnNumbers = [...new Set(turns.slice(startIdx, endIdx + 1).filter((turn) => turn !== null))].sort((a, b) => a - b);
	const byTurn = new Map((outlineTurns ?? []).map((entry) => [entry.turn, entry]));
	const lines = turnNumbers.map((turn) => {
		const entry = byTurn.get(turn);
		if (entry === undefined) return `· turn ${turn}  （无预览）`;
		const prompt = clip(entry.prompt, 50);
		const response = clip(entry.response, 120);
		return `· turn ${turn}  你: ${prompt || '（无文本）'}${response === '' ? '' : `\n           我: ${response}`}`;
	});
	return { turnNumbers, lines };
}

/**
 * 单行截断（保留尾部省略号）。
 * @param text - 原始文本。
 * @param max - 最大字符数。
 * @returns 截断后的文本。
 */
export function clip(text, max) {
	const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
