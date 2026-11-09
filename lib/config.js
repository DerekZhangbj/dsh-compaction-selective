/**
 * 配置与设置存储。
 *
 * **为什么不把设置写回 `cordis.patch.yml`**：本 profile 不支持热重载（写入会得到
 * `dsh: profile reload requires the root Include entry` —— 与 memory-eternal 的配置保存是同一个坑）。
 * 所以设置落在**插件自己的 JSON 文件**里：宿主每次读即时生效，既不需要重启，也不需要组合重载。
 *
 * 三层优先级：**内置默认值 < 组合行 config < 设置文件**（设置界面写的是最后一层）。
 *
 * @module dsh-compaction-selective/config
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 可用配置的默认值（与 DESIGN.md §12 的决策记录一致）。 */
export const DEFAULTS = Object.freeze({
	enabled: true,
	/** 选区下限：低于它的压缩必然被官方「摘要必须更小」校验拒绝，故提前拒绝。 */
	minShadowedTokens: 3000,
	/** 单次上限：最多压缩表面的这个比例。 */
	maxSurfaceShare: 0.6,
	/** 审批卡片等待时间；超时视为未确认。 */
	approvalTimeoutMs: 180000,
	/** 同一轮内最多压缩几次。 */
	maxPerTurn: 1,
	/** 是否把摘要模板换成「局部压缩」版本。 */
	foldSummary: true,
});

/** 每个键的类型，用于设置界面的逐键校验。 */
export const CONFIG_TYPES = Object.freeze({
	enabled: 'boolean',
	foldSummary: 'boolean',
	minShadowedTokens: 'integer',
	approvalTimeoutMs: 'integer',
	maxPerTurn: 'integer',
	maxSurfaceShare: 'ratio',
});

/** 设置文件的默认位置（与宿主数据同层，便于备份与人工查看）。 */
export function settingsPath(home = homedir()) {
	return join(home, '.dsh', 'compaction-selective.json');
}

/**
 * 校验单个配置值（设置界面按 key 提交，所以要能单独校验）。
 * @param key - 配置键。
 * @param value - 候选值。
 * @returns 原值（校验通过）。
 * @throws 当键未知或值越界时。
 */
export function validateEntry(key, value) {
	const type = CONFIG_TYPES[key];
	if (type === undefined) throw new Error(`未知配置键 "${key}"（可用：${Object.keys(CONFIG_TYPES).join(', ')}）`);
	if (type === 'boolean') {
		if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
		return value;
	}
	if (type === 'integer') {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须是 ≥1 的整数`);
		return value;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${key} 必须是 (0, 1] 之间的小数`);
	return value;
}

/**
 * 校验并补全一份完整配置。
 * @param config - 原始配置（组合行 config，或与其他层合并后的对象）。
 * @returns 冻结后的配置。
 * @throws 当某个值越界时（配置错误应在加载期就炸，而不是运行期）。
 */
export function normalizeConfig(config = {}) {
	const merged = { ...DEFAULTS, ...(config ?? {}) };
	for (const key of Object.keys(merged)) {
		if (CONFIG_TYPES[key] === undefined) throw new Error(`dsh-compaction-selective: 未知配置键 "${key}"`);
		validateEntry(key, merged[key]);
	}
	return Object.freeze(merged);
}

/**
 * 读设置文件。缺失或损坏都退回 `{}` 并带回一条诊断，绝不让坏文件挡住插件加载。
 * @param path - 设置文件路径。
 * @returns `{ values, error }`。
 */
export function loadSettings(path = settingsPath()) {
	try {
		if (!existsSync(path)) return { values: {}, error: null };
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { values: {}, error: `${path} 的内容不是对象` };
		const values = {};
		const skipped = [];
		for (const [key, value] of Object.entries(raw)) {
			try {
				values[key] = validateEntry(key, value);
			} catch (error) {
				skipped.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { values, error: skipped.length === 0 ? null : `已忽略 ${skipped.length} 个非法键（${skipped.join('；')}）` };
	} catch (error) {
		return { values: {}, error: String(error instanceof Error ? error.message : error) };
	}
}

/**
 * 原子写回设置文件（先写临时文件再改名，失败不破坏原文件）。
 * @param patch - 要合并的键值。
 * @param path - 设置文件路径。
 * @returns 写入后的完整设置。
 * @throws 当任一只键非法时（此时**不写盘**）。
 */
export function saveSettings(patch, path = settingsPath()) {
	const current = loadSettings(path).values;
	const next = { ...current };
	const keys = Object.keys(patch ?? {});
	if (keys.length === 0) throw new Error('没有要保存的配置键');
	for (const key of keys) next[key] = validateEntry(key, patch[key]);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
	renameSync(tmp, path);
	return next;
}

/**
 * 三层合并后的生效配置。
 *
 * ⚠ `values` 是**设置文件里的内容对象**（不是路径！）—— 2026-10-16 那次「插件详情页表单崩溃」
 * 就是把它当路径塞进了 API 的 `settingsPath`，客户端拿它当子节点渲染 ⇒ `React #31（object with keys {}）`。
 * 路径要用 `settingsPath()` 拿。
 * @param composition - 组合行（`cordis.patch.yml`）里的 config。
 * @param path - 设置文件路径。
 * @returns `{ config, values, error, origin }`；`origin` 标出每个键来自哪一层。
 */
export function effectiveConfig(composition = {}, path = settingsPath()) {
	const loaded = loadSettings(path);
	const values = loaded.values;
	const merged = {};
	const origin = {};
	for (const key of Object.keys(DEFAULTS)) {
		if (Object.hasOwn(values, key)) {
			merged[key] = values[key];
			origin[key] = 'settings-file';
		} else if (Object.hasOwn(composition ?? {}, key)) {
			merged[key] = composition[key];
			origin[key] = 'composition';
		} else {
			merged[key] = DEFAULTS[key];
			origin[key] = 'default';
		}
	}
	return { config: normalizeConfig(merged), values, error: loaded.error, origin };
}
