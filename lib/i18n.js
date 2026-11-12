/**
 * 极简 i18n 层（宿主侧）。
 *
 * 设计取舍（重要，别改成常见的 `t('key')` 反查）：
 * - **中文原文就是 key**。查不到英文就原样返回中文 ⇒ 漏翻译只会「显示中文」，
 *   不会出现 `undefined` 或空标签；新增文案也不必先登记注册表。
 * - 客户端 `lib/client.js` 里有一份**同内容的英文表**（那个文件按设计必须自包含、不 import
 *   本包其它文件）。两份表的 key 必须一致 —— `tests/run.mjs` 有断言盯着。
 * - 语言判定：宿主 `locale` 服务 `getSnapshot().value.locale`；以 `zh` 开头 → 中文，
 *   其它明确值 → 英文，**取不到时保持中文**（未知宿主不擅自改变历史行为）。
 */

/** 中文原文 → 英文。按界面分区排列，便于核对。 */
export const EN = {
	// —— 入口 / 菜单 / 面板标题 ——
	'选择性压缩': 'Selective compaction',
	'选择性压缩：把已经结束的若干轮压缩成一条摘要': 'Selective compaction: fold a span of finished turns into one summary',
	'把已结束的若干轮压缩成摘要（选中即执行，没有二次确认）': 'Fold finished turns into one summary (runs on select, no second confirmation)',
	'压缩最近': 'Compact the last',
	'当前没有可压缩的轮次': 'Nothing to compact right now',
	'关闭': 'Close',
	'重试': 'Retry',
	'读取会话…': 'Loading session…',
	'选一个会话': 'Pick a session',

	// —— 面板：状态与动作 ——
	'当前空闲': 'idle',
	'按最近轮数': 'By recent turns',
	'或指定轮号区间': 'Or an explicit turn range',
	'压缩这段': 'Compact this span',
	'再点一次执行': 'Click again to run',
	'正在压缩': 'Compacting',
	'点一下选中，再点一下执行（压缩不可逆，所以是两段确认）；选中后 5 秒不动作会自动取消':
		'Click once to select, again to run (compaction is irreversible, hence two steps); the selection auto-cancels after 5 seconds',
	'只允许整轮；端点会自动吸附到工具配对平衡处；低于 3000 token 的选区会被拒绝。':
		'Whole turns only; endpoints snap to tool-pair balance; spans under 3000 tokens are rejected.',
	'这一步要把被压缩的轮次交给模型写成摘要，通常几秒到几十秒。期间原文未改；关掉面板不会取消执行，完成后结果仍会显示在这里。':
		'This hands the span to the model to write a summary — usually seconds to tens of seconds. Source text is unchanged meanwhile; closing the panel does not cancel it, and the result still shows up here.',
	'轮次': 'Turns',
	'轮': 'turn',
	'用量': 'size',
	'你说的话': 'your message',

	// —— 面板：无补丁降级 ——
	'这个环境不能直接点着折：后端缺少「空闲态折指定区间」的入口（上游 API 缺口）。':
		'This environment cannot fold from the panel: the backend lacks an idle-span entry point (upstream API gap).',
	'请在对话里直接说：压缩最近 N 轮（或「压缩 34-35 轮」）—— 会走官方压缩入口，并在执行前弹确认卡。下面仍可查看轮次与用量。':
		'Ask in the conversation instead: "compress the last N turns" (or "compress turns 34-35") — that goes through the official path and shows an approval card first. Turn list and sizes are still shown below.',

	// —— 宿主：确认卡 ——
	'压缩确认': 'Confirm compaction',
	'确认压缩': 'Confirm compaction',
	'取消': 'Cancel',
	'只看预览': 'Preview only',
	'什么都不会做': 'Nothing happens',
	'只看预览，不执行压缩': 'Preview only, do not compact',
	'把这几个轮次压缩成一段摘要。': 'Fold these turns into one summary.',
	'请输入你的答案': 'Type your answer',
	'跳过': 'Skip',
	'提交': 'Submit',

	'会话': 'session',
	'可见历史': 'visible history',
	'条表面节点': 'surface nodes',
	'摘要模板': 'summary template',
	'压缩通道': 'fold channel',
	'定位': 'resolution',
	'候选': 'candidates',
	'从': 'from',
	'到': 'to',
	'第': 'turn',
	'轮进行中': 'in progress',
	'自动判断不出来（宿主没把会话传进来），同时开着多个会话时只能由你指定一个。': 'Could not determine the session automatically (the host did not pass it in), and several sessions are open — please pick one.',
	'已选：': 'selected: ',
	'仅限轮内（补丁缺失）': 'during a turn only (local patch missing)',
	'空闲态（已打补丁）': 'idle, explicit span (patched)',
	'空闲态（补丁缺失）': 'idle, explicit span unavailable (patch missing)',

	'不可用': 'unavailable',
	'再点确认': 'click again to confirm',
	'再点一次执行': 'click again to run',
	'将压缩': 'will compact',
	'条节点': 'nodes',
	'条表面节点数': 'surface nodes',
	'约': 'about',
	'压缩最近': 'compact the last',
	'读取中…（若一直停在这里，说明 /compaction-selective/state 没通）': 'loading… (if this never finishes, /compaction-selective/state is not reachable)',
	'保存失败：': 'save failed: ',
	'已保存': 'saved',
	'项（即时生效，不需要重启）': 'item(s) — applied immediately, no restart needed',
	'保存中…': 'saving…',
	'保存（': 'save (',
	' 项改动）': ' change(s))',
	'保存': 'save',
	'撤销改动': 'revert changes',
	'配置诊断：': 'config diagnostics: ',
	'表单自查发现非法子节点：': 'form self-check found an invalid child: ',
	'类型': 'type',
	'键': 'key',
	'值': 'value',
	'参数表单渲染失败：': 'form render failed: ',
	'构造失败：': 'failed to build: ',
	'参数表单里出现了不能直接显示的对象（React #31）：': 'the form contains a value that cannot be rendered (React #31): ',
	'读取失败': 'load failed',

	// —— 宿主：错误与提示 ——
	'请求失败': 'Request failed',
	'空闲态折指定区间需要本地补丁 compactRange，当前后端上没有它':
		'Idle-span compaction needs the local compactRange patch, which this backend does not have',
	'需要给核心打本地补丁 compactRange（仓库的 patches/apply-compaction-patch.ps1）并重启宿主。没有改动任何内容。':
		'Apply the local compactRange patch to the core (patches/apply-compaction-patch.ps1 in the repo) and restart the host. Nothing was changed.',
	'压缩被拒绝': 'Compaction rejected',
	'压缩执行失败': 'Compaction failed',
	'没有找到压缩引擎': 'No compaction engine found',
}

/**
 * 由宿主 `locale` 服务判定语言。
 * @returns {'zh' | 'en'}
 */
/** 把 locale id（如 `en-US`）归一成 `'en' | 'zh'`。 */
function normalizeLocale(id) {
	if (typeof id !== 'string' || id === '') return null
	return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * 从宿主/客户端的 `locale` 服务读当前语言。
 * 真实形状是 `getSnapshot() -> { active: LocaleId, ... }`；同时兼容旧的几种猜测形状。
 * @returns {'zh' | 'en'}
 */
export function pickLang(source) {
	try {
		const service = source?.locale ?? source
		const snapshot = service?.getSnapshot?.() ?? service?.getLocale?.() ?? service
		const id =
			snapshot?.active ??
			snapshot?.value?.locale ??
			snapshot?.locale ??
			snapshot?.value?.lang ??
			snapshot?.lang
		const normalized = normalizeLocale(id)
		if (normalized !== null) return normalized
	} catch {
		/* 服务形状不同或受限访问：按未知处理 */
	}
	return 'zh'
}

/**
 * 造一个"活"的翻译函数：**每次调用**都重新读语言，
 * 因此用户在设置里切换语言后，无需重启插件即可生效。
 * @param {() => unknown} getSource 返回 locale 服务（或含 locale 的对象）
 */
export function createT(getSource) {
	return (zh) => (pickLang(getSource()) === 'en' ? (EN[zh] ?? zh) : zh)
}

export function makeT(lang) {
	if (lang !== 'en') return (zh) => zh
	return (zh) => EN[zh] ?? zh
}
