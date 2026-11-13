/**
 * 客户端半边（浏览器）——dsh-compaction-selective。
 *
 * 手写 CJS + `window.__ModuleLoader__` 握手，**不需要打包器**：只 `require('react')`。
 *
 * 两条铁律（都踩过）：
 *   1. **样式一律用宿主的设计变量**（`--dsh-content-font-size-secondary`、`--dsw-alias-label-secondary`、
 *      `--dsw-alias-border-l2` …），不要硬编码 px/rgba —— 否则和「完全权限」那类原生控件不是一个长相。
 *   2. **先把每一块算成变量，再拼装**，不在 `createElement` 参数里写深层嵌套的三元 / map，括号层级固定。
 *
 * 落点（槽位契约取自 `dsh-cordis-client-runner` 的槽位目录）：
 *   - `conversation.input.left`：输入框工具行左侧一格 → 「压缩 ⌄」按钮 + 弹层
 *   - `settings.general.item`：设置→通用里一行 → 参数表单（**待迁**：更适合 `plugins.bundle.config`）
 */
window.__ModuleLoader__.load({
	id: 'dsh-compaction-selective',
	factory: (require) => {
		// 等价于 esbuild 的 CJS banner：手写文件必须自己声明这两个名字。
		const module = { exports: {} };
		const exports = module.exports;
		const React = require('react');
		const { useCallback, useEffect, useState } = React;
		const h = React.createElement;

		// ── i18n（客户端必须自包含：不 import 本包其它文件）──
		// 中文原文就是 key；查不到英文就原样返回中文。与 lib/i18n.js 的 EN 表必须同 key
		// （tests/run.mjs 有断言盯着两份表一致）。
		const EN_UI = {
			'选择性压缩': 'Selective compaction',
			'选择性压缩：把已经结束的若干轮压缩成一条摘要': 'Selective compaction: fold a span of finished turns into one summary',
			'把已结束的若干轮压缩成摘要（选中即执行，没有二次确认）': 'Fold finished turns into one summary (runs on select, no second confirmation)',
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
			'这里不能直接折（缺少本地补丁）': 'cannot fold from here (local patch missing)',
			'请在对话里说「压缩最近 N 轮」——会弹确认卡': 'say “compress the last N turns” in the conversation — that shows an approval card',
			'关闭': 'Close',
			'重试': 'Retry',
			'读取会话…': 'Loading session…',
			'选一个会话': 'Pick a session',
			'当前空闲': 'idle',
			'按最近轮数': 'By recent turns',
			'或指定轮号区间': 'Or an explicit turn range',
			'压缩这段': 'Compact this span',
			'再点一次执行': 'Click again to run',
			'正在压缩': 'Compacting',
			'轮次': 'Turns',
			'轮': 'turn',
			'用量': 'size',
			'你说的话': 'your message',
			'点一下选中，再点一下执行（压缩不可逆，所以是两段确认）；选中后 5 秒不动作会自动取消':
				'Click once to select, again to run (compaction is irreversible, hence two steps); the selection auto-cancels after 5 seconds',
			'只允许整轮；端点会自动吸附到工具配对平衡处；低于 3000 token 的选区会被拒绝。':
				'Whole turns only; endpoints snap to tool-pair balance; spans under 3000 tokens are rejected.',
			'这一步要把被压缩的轮次交给模型写成摘要，通常几秒到几十秒。期间原文未改；关掉面板不会取消执行，完成后结果仍会显示在这里。':
				'This hands the span to the model to write a summary — usually seconds to tens of seconds. Source text is unchanged meanwhile; closing the panel does not cancel it, and the result still shows up here.',
			'这个环境不能直接点着折：后端缺少「空闲态折指定区间」的入口（上游 API 缺口）。':
				'This environment cannot fold from the panel: the backend lacks an idle-span entry point (upstream API gap).',
			'请在对话里直接说：压缩最近 N 轮（或「压缩 34-35 轮」）—— 会走官方压缩入口，并在执行前弹确认卡。下面仍可查看轮次与用量。':
				'Ask in the conversation instead: "compress the last N turns" (or "compress turns 34-35") — that goes through the official path and shows an approval card first. Turn list and sizes are still shown below.',
		};
		/** 未知语言时保持中文（老宿主/测试环境不擅自变英文）。 */
		const normalizeLocale = (id) => {
			if (typeof id !== 'string' || id === '') return null;
			return id.toLowerCase().startsWith('zh') ? 'zh' : 'en';
		};
		/** 真实形状：`ctx.locale.getSnapshot().active`（如 'en-US'），兼容旧猜测形状。 */
		const pickLang = (source) => {
			try {
				const service = source?.locale ?? source;
				const snapshot = service?.getSnapshot?.() ?? service?.getLocale?.() ?? service;
				const id = snapshot?.active ?? snapshot?.value?.locale ?? snapshot?.locale ?? snapshot?.value?.lang ?? snapshot?.lang;
				const normalized = normalizeLocale(id);
				if (normalized !== null) return normalized;
			} catch {
				/* 受限访问：按未知处理 */
			}
			return 'zh';
		};
		/** 交给 createT 的"当前 locale 服务"引用：apply 时赋值，每次渲染都会重读。 */
		let localeRef = null;
		const T = (zh) => (pickLang(localeRef) === 'en' ? EN_UI[zh] ?? zh : zh);
		/** foldPath 是后端产出的稳定值，按值查表（查不到就原样显示）。 */
		const TF = (value) => (pickLang(localeRef) === 'en' ? EN_UI[value] ?? value : value);

		// ── 与原生控件对齐的样式（全部走宿主变量） ──
		const fontSmall = 'var(--dsh-content-font-size-secondary, 13px)';
		// 工具行按钮：**无边框**（与「完全权限」那种原生胶囊一致），只在 hover/展开时出现底色。
		const btn = {
			display: 'inline-flex', alignItems: 'center', gap: 4,
			fontFamily: 'inherit', fontSize: fontSmall, lineHeight: '18px',
			color: 'var(--dsw-alias-label-secondary)',
			background: 'transparent',
			border: '1px solid transparent',
			borderRadius: 'var(--dsw-radius-md, 6px)',
			padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
		};
		const btnHover = { ...btn, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))' };
		const btnPrimary = { ...btn, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))' };
		const btnDanger = { ...btnPrimary, color: 'var(--dsw-alias-state-error-primary, #d4685c)', borderColor: 'var(--dsw-alias-state-error-primary, #d4685c)' };
		const btnOff = { ...btn, opacity: 0.45, cursor: 'not-allowed' };
		// 两个图标都照抄 @deepseek-ai/dsh-client-ui-primitives 的原件（同 viewBox、同 path、同 strokeWidth），
		// 这样和原生控件是**同一套画法**，不是「近似」：
		//   · CompactIcon = IconCompactOutlineRegular（内置 /compact 命令用的那个：圆 + 一段弧）
		//   · ChevronIcon = IconChevronDownOutlineRegular（「完全权限」旁边那个）
		// 尺寸与颜色也照原生：胶囊里 `.triggerIcon svg { width:14px; height:14px }`，
		// 箭头 `.chevron { color: var(--dsw-alias-label-caption); display:inline-flex; transition:transform .12s }`。
		function CompactIcon() {
			return h('span', { style: { display: 'inline-flex', flex: 'none' } },
				h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': 'true' },
					h('path', { opacity: 0.35, d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z', stroke: 'currentColor' }),
					h('path', { d: 'M8 1.5C8.85359 1.5 9.69883 1.66813 10.4874 1.99478C11.2761 2.32144 11.9926 2.80022 12.5962 3.40381C13.1998 4.00739 13.6786 4.72394 14.0052 5.51256C14.3319 6.30117 14.5 7.14641 14.5 8', stroke: 'currentColor' }),
				));
		}
		function ChevronIcon(props) {
			const open = props?.open === true;
			return h('span', {
				style: {
					display: 'inline-flex', flex: 'none',
					color: 'var(--dsw-alias-label-caption)',
					transition: 'transform .12s',
					transform: open ? 'rotate(180deg)' : 'none',
				},
			}, h('svg', {
				width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': 'true',
			}, h('path', { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' })));
		}

		const panel = {
			position: 'absolute', bottom: 'calc(100% + 8px)', left: 0,
			width: 520, maxWidth: '84vw', maxHeight: '64vh', overflow: 'auto',
			background: 'var(--dsw-alias-bg-base, #1b1b1f)', color: 'var(--dsw-alias-label-primary)',
			border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
			borderRadius: 'var(--dsw-radius-panel, 10px)',
			boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
			padding: '12px 14px 14px', zIndex: 60,
			fontFamily: 'inherit', fontSize: fontSmall, lineHeight: '20px',
		};
		const panelHead = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 };
		const title = { fontSize: 14, fontWeight: 650 };
		const divider = { height: 1, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.25))', margin: '10px 0' };
		const sectionTitle = { fontSize: 12, fontWeight: 650, marginTop: 14, marginBottom: 6 };
		const hint = { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' };
		const meta = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: '17px' };
		const input = {
			fontFamily: 'inherit', fontSize: fontSmall, lineHeight: '18px',
			color: 'var(--dsw-alias-label-primary)',
			background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
			border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
			borderRadius: 'var(--dsw-radius-md, 6px)', padding: '2px 8px', width: 64,
		};
		const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
		const table = { width: '100%', borderCollapse: 'collapse', fontSize: 11 };
		const th = { padding: '4px 6px', textAlign: 'left', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 500, borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' };
		const td = { padding: '3px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14))', verticalAlign: 'top' };
		const cellPrompt = { ...td, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
		const success = { color: 'var(--dsw-alias-state-success-primary, #5aa87a)' };
		const warning = { color: 'var(--dsw-alias-state-warning-primary, #c9973f)' };
		const danger = { color: 'var(--dsw-alias-state-error-primary, #d4685c)' };
		const resultBox = {
			marginTop: 12, padding: '8px 10px', borderRadius: 'var(--dsw-radius-md, 6px)',
			border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
			background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
		};

		function fmt(n) {
			if (typeof n !== 'number') return '—';
			return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
		}

		async function callJson(url, init) {
			let res;
			try {
				res = await fetch(url, { cache: 'no-store', ...(init ?? {}) });
			} catch (error) {
				return { ok: false, status: 0, body: { error: `${T('请求失败：')}${String(error?.message ?? error)}` } };
			}
			const text = await res.text();
			try {
				return { ok: res.ok, status: res.status, body: JSON.parse(text) };
			} catch {
				return { ok: false, status: res.status, body: { error: text.slice(0, 200) } };
			}
		}

		// ─────────────────────── 输入框工具行：「压缩 ⌄」+ 弹层 ───────────────────────
		/**
		 * 从 DOM 里读出**当前会话**。
		 *
		 * 为什么必须这样：`conversation.input.left` 这个槽位的内容**收不到任何 props**（宿主渲染时
		 * 传的是 `{}`，实测 props 为空），注册项的 `inject` 也没送到，会话 hook 同样拿不到。
		 * 而 `dsh-client-ui-conversation` 在会话根节点上写了 `data-conversation-session=<sessionId>`
		 * —— 输入框就在那棵树里面，所以从自己的节点往上找最近的祖先即可。
		 * 拿到的 id 还要用宿主返回的会话清单校验一次（见 load），不匹配就退回「让人选」。
		 * @param node - 本插件渲染的 DOM 节点。
		 * @returns 会话 id，或 `null`。
		 */
		function sessionIdFromDom(node) {
			let current = node;
			while (current !== null && current !== undefined && typeof current.querySelector === 'function') {
				const found = current.querySelector('[data-conversation-session]');
				const id = found?.getAttribute?.('data-conversation-session');
				if (typeof id === 'string' && id !== '') return id;
				current = current.parentElement;
			}
			return null;
		}

		/** 两段确认的窗口（毫秒）：第一次点击「选中」后超过它没再点，就自动解除。 */
		const ARM_WINDOW_MS = 5000;

		function FoldButton(props) {
			const sessionId = props?.sessionId ?? null;
			const rootRef = React.useRef(null);
			const armTimer = React.useRef(null);
			const [domSessionId, setDomSessionId] = useState(null);
			const [open, setOpen] = useState(false);
			const [state, setState] = useState(null);
			const [error, setError] = useState('');
			const [busy, setBusy] = useState(false);
			// 「正在进行」的可见反馈：压缩要跑几秒到几十秒（中间要调模型写摘要），
			// 没有提示的话界面上只是按钮变红 —— 看起来像卡死或出错。见下面的 busy 状态块。
			const [pending, setPending] = useState(null);
			const [dots, setDots] = useState(1);
			const [result, setResult] = useState(null);
			const [from, setFrom] = useState('');
			const [to, setTo] = useState('');
			const [armed, setArmed] = useState('');
			const [hover, setHover] = useState(false);
			// 上面两条都不通时的最后兑底：由人在面板里选一个会话 —— 宁可多点一下，也不替他猜。
			const [chosen, setChosen] = useState(null);
			// 优先级：宿主给的 prop → 人选的 → 从 DOM 读到的（正常情况下 DOM 这条就够，见 sessionIdFromDom）。
			const effectiveId = sessionId ?? chosen ?? domSessionId;

			const load = useCallback(async () => {
				// 每次打开都重读一次 DOM：切换会话后同一个按钮要跟着换会话。
				const fromDom = sessionId === null && chosen === null ? sessionIdFromDom(rootRef.current) : null;
				if (fromDom !== null && fromDom !== domSessionId) {
					setDomSessionId(fromDom);
					return; // 状态变化会再触发一次 load（依赖里有 effectiveId）
				}
				const query = effectiveId === null || effectiveId === undefined ? '' : `?sessionId=${encodeURIComponent(effectiveId)}`;
				const res = await callJson(`/compaction-selective/state${query}`);
				if (res.ok) {
					// 宿主不认这个 id（例如读错了节点）→ 丢掉 DOM 值，退回「让人选」。
					const known = (res.body?.sessions ?? []).some((row) => row.id === effectiveId);
					if (effectiveId !== null && effectiveId !== undefined && res.body?.session === null && !known && domSessionId === effectiveId) {
						setDomSessionId(null);
					}
					setState(res.body);
					setError(res.body?.error ?? '');
				} else {
					setState(null);
					setError(res.body?.error ?? `http ${res.status}`);
				}
			}, [effectiveId, chosen, sessionId, domSessionId]);

			useEffect(() => {
				if (open) load();
			}, [open, load]);

			// 进行中的省略号动画（用定时器自己画，不依赖宿主有没有 keyframes）。
			useEffect(() => {
				if (!busy) {
					setDots(1);
					return undefined;
				}
				const timer = setInterval(() => setDots((n) => (n % 3) + 1), 450);
				return () => clearInterval(timer);
			}, [busy]);

			// 两段确认的窗口：点第一次「选中」后 5 秒内没有第二次点击，就自动退回未选中。
			// 防手滑 —— 压缩不可逆，误触的代价是原文不再出现在模型的可见上下文里。
			const disarm = useCallback(() => {
				if (armTimer.current !== null) {
					clearTimeout(armTimer.current);
					armTimer.current = null;
				}
				setArmed('');
			}, []);
			const arm = useCallback((token) => {
				if (armTimer.current !== null) clearTimeout(armTimer.current);
				setArmed(token);
				armTimer.current = setTimeout(() => {
					armTimer.current = null;
					setArmed((previous) => (previous === token ? '' : previous));
				}, ARM_WINDOW_MS);
			}, []);
			useEffect(() => () => {
				if (armTimer.current !== null) clearTimeout(armTimer.current);
			}, []);

			const submit = useCallback(async (args, label) => {
				setBusy(true);
				setPending(label ?? '');
				setResult(null);
				const res = await callJson('/compaction-selective/fold', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId: effectiveId, confirm: true, ...args }),
				});
				setBusy(false);
				setPending(null);
				disarm();
				setResult(res.body);
				if (res.body?.status === 'compacted') load();
			}, [effectiveId, load, disarm]);

			const toggle = h('button', {
				style: open || hover ? btnHover : btn,
				title: T('选择性压缩：把已经结束的若干轮压缩成一条摘要'),
				onClick: () => setOpen(!open),
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
			}, h(CompactIcon), h('span', null, T('选择性压缩')), h(ChevronIcon, { open }));
			if (!open) return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } }, toggle);

			const session = state?.session ?? null;
			const blocks = [];
			blocks.push(h('div', { key: 'h', style: panelHead },
				h('span', { style: title }, T('选择性压缩')),
				h('button', { style: btn, onClick: () => { disarm(); setOpen(false); } }, T('关闭')),
			));
			blocks.push(h('div', { key: 'd1', style: divider }));

			// 进行中：显式告诉人「在干活、大概在做什么、关掉面板会不会取消」。
			if (busy) {
				blocks.push(h('div', { key: 'busy', style: { ...resultBox, marginTop: 0 } },
					h('div', { style: { ...meta, color: 'var(--dsw-alias-label-primary)' } },
						`${T('正在压缩')}${'.'.repeat(dots)}${pending === null || pending === '' ? '' : `　${pending}`}`),
					h('div', { style: { ...hint, marginTop: 4 } },
						T('这一步要把被压缩的轮次交给模型写成摘要，通常几秒到几十秒。期间原文未改；关掉面板不会取消执行，完成后结果仍会显示在这里。')),
				));
			}

			if (state === null && error === '') blocks.push(h('div', { key: 'load', style: { ...meta, padding: '6px 0' } }, T('读取会话…')));
			if (error !== '') {
				blocks.push(h('div', { key: 'err', style: { ...danger, padding: '6px 0' } }, error));
				blocks.push(h('div', { key: 'retry', style: row }, h('button', { style: btn, onClick: load }, T('重试'))));
			}

			// 拿不到会话（宿主没传 sessionId 且活跃会话不止一个）→ 让人选，绝不替他猜。
			const candidates = state?.sessions ?? [];
			if (session === null && candidates.length > 0) {
				blocks.push(h('div', { key: 'pick-title', style: sectionTitle }, T('选一个会话')));
				const pickers = candidates.map((row) => {
					const tail = String(row.id).slice(-8);
					const bits = [`…${tail}`];
					if (row.lastTurn > 0) bits.push(`#${row.lastTurn}`);
					bits.push(`${fmt(row.tokens)} token`);
					const label = bits.join(' · ');
					const titleText = row.prompt === '' ? row.id : `${row.prompt}（${row.id}）`;
					return h('button', {
						key: row.id,
						style: chosen === row.id ? btnPrimary : btn,
						title: titleText,
						onClick: () => { setChosen(row.id); setError(''); },
					}, label);
				});
				blocks.push(h('div', { key: 'pick', style: row }, pickers));
				const preview = chosen === null
					? ''
					: (candidates.find((row) => row.id === chosen)?.prompt ?? '');
				blocks.push(h('div', { key: 'pick-hint', style: { ...hint, marginTop: 6 } },
					chosen === null
						? T('自动判断不出来（宿主没把会话传进来），同时开着多个会话时只能由你指定一个。')
						: `${T('已选：')}${preview === '' ? String(chosen).slice(-8) : preview}`));
			}

			if (session !== null) {
				const turnLabel = session.openTurn === null ? T('当前空闲') : `${T('第')} ${session.openTurn} ${T('轮进行中')}`;
				const res = session.resolution;
				blocks.push(h('div', { key: 'meta', style: meta },
					`${T('会话')} ${String(session.id ?? '').slice(0, 8)}… · ${T('可见历史')} ${fmt(session.totalTokens)} token · ${session.surfaceNodes} ${T('条表面节点')} · ${turnLabel}`,
					h('br', null),
					`${T('摘要模板')} ${session.engine} · ${T('压缩通道')} ${TF(session.foldPath)}`,
					res === undefined ? null : ` · ${T('定位')} ${res.how}（${T('候选')} ${res.candidates}／preset ${res.preset}）`,
				));

				// 这个环境能不能"直接折"？取决于后端有没有 `compactRange`（本地补丁）。
				// 桌面端（Electron）的核心打包在 app.asar 里，补丁无处可落 ⇒ `patched=false`。
				// 此时**不让人白点**：动作按钮全部禁用 + 一条明确指引（对话指令走官方 compactRegion）。
				const canFold = res === undefined || res.patched !== false;
				if (!canFold) {
					blocks.push(h('div', { key: 'nopatch', style: { ...resultBox, marginTop: 10 } },
						h('div', { style: { ...meta, color: 'var(--dsw-alias-label-primary)' } },
							T('这个环境不能直接点着折：后端缺少「空闲态折指定区间」的入口（上游 API 缺口）。')),
						h('div', { style: { ...hint, marginTop: 4 } },
							T('请在对话里直接说：压缩最近 N 轮（或「压缩 34-35 轮」）—— 会走官方压缩入口，并在执行前弹确认卡。下面仍可查看轮次与用量。')),
					));
				}

				blocks.push(h('div', { key: 's1', style: sectionTitle }, T('按最近轮数')));
				const quick = (session.suggestions ?? []).map((item) => {
					const isArmed = armed === `r${item.recent}`;
					const running = busy && isArmed;
					// 执行中**不要**保持红色（红色是「待确认」的意思，看起来像报错）。
					const label = !item.ok
						? `${item.recent} ${T('轮')} ${T('不可用')}`
						: running
							? `${T('正在压缩')}${'.'.repeat(dots)}`
							: `${item.recent} ${T('轮')} ≈${fmt(item.tokens)}${isArmed ? ` · ${T('再点确认')}` : ''}`;
					const style = !item.ok || !canFold || (busy && !running) ? btnOff : (isArmed && !busy ? btnDanger : btnPrimary);
					const titleText = item.ok ? `${T('将压缩')} turn ${item.label}（${item.nodes} ${T('条节点')}，${T('约')} ${fmt(item.tokens)} token）` : item.message;
					const detail = item.ok ? `turn ${item.label}（${T('约')} ${fmt(item.tokens)} token）` : '';
					return h('button', {
						key: item.recent, style, title: titleText, disabled: !item.ok || busy || !canFold,
						onClick: () => (isArmed ? submit({ recent_turns: item.recent }, detail) : arm(`r${item.recent}`)),
					}, label);
				});
				blocks.push(h('div', { key: 'quick', style: row }, quick));
				blocks.push(h('div', { key: 's1hint', style: { ...hint, marginTop: 6 } }, T('点一下选中，再点一下执行（压缩不可逆，所以是两段确认）；选中后 5 秒不动作会自动取消')));

				blocks.push(h('div', { key: 's2', style: sectionTitle }, T('或指定轮号区间')));
				const ready = from !== '' && to !== '';
				const rangeArmed = armed === 'range';
				const rangeButton = h('button', {
					style: !ready || !canFold ? btnOff : (busy && rangeArmed ? btnPrimary : (rangeArmed ? btnDanger : btnPrimary)),
					disabled: !ready || busy || !canFold,
					onClick: () => (rangeArmed
						? submit({ from_turn: from, to_turn: to }, `turn ${from}-${to}`)
						: arm('range')),
				}, busy && rangeArmed ? `${T('正在压缩')}${'.'.repeat(dots)}` : (rangeArmed ? T('再点一次执行') : T('压缩这段')));
				blocks.push(h('div', { key: 'range', style: { ...row, marginTop: 6 } },
					h('span', { style: meta }, T('从')),
					h('input', { style: input, value: from, placeholder: '34', onChange: (event) => { setFrom(event.target.value.replace(/[^0-9]/g, '')); disarm(); } }),
					h('span', { style: meta }, T('到')),
					h('input', { style: input, value: to, placeholder: '35', onChange: (event) => { setTo(event.target.value.replace(/[^0-9]/g, '')); disarm(); } }),
					h('span', { style: { flex: 1 } }),
					rangeButton,
				));

				const turns = session.turns ?? [];
				blocks.push(h('div', { key: 's3', style: sectionTitle }, `${T('轮次')}（${turns.length}）`));
				const head = h('tr', null,
					h('th', { style: { ...th, width: 46 } }, T('轮')),
					h('th', { style: { ...th, width: 62 } }, T('用量')),
					h('th', { style: th }, T('你说的话')),
				);
				const body = turns.slice(-20).reverse().map((turn) => h('tr', { key: turn.turn },
					h('td', { style: { ...td, ...(turn.foldable ? {} : { opacity: 0.5 }) } }, `#${turn.turn}`),
					h('td', { style: td }, fmt(turn.tokens)),
					h('td', { style: cellPrompt, title: `${turn.prompt}\n${turn.response}` }, turn.prompt || '—'),
				));
				blocks.push(h('div', { key: 'turns', style: { maxHeight: 190, overflow: 'auto', marginTop: 2, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))', borderRadius: 'var(--dsw-radius-md, 6px)' } },
					h('table', { style: table }, h('thead', null, head), h('tbody', null, body)),
				));
				blocks.push(h('div', { key: 's3hint', style: { ...hint, marginTop: 8 } }, T('只允许整轮；端点会自动吸附到工具配对平衡处；低于 3000 token 的选区会被拒绝。')));
			}

			if (result !== null) {
				const tone = result.status === 'compacted' ? success : warning;
				blocks.push(h('div', { key: 'res', style: { ...resultBox, ...tone } }, result.message));
			}

			return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } }, toggle, h('div', { style: panel }, blocks));
		}

		// ─────────────────────── 设置 → 通用：参数行（待迁到 plugins.bundle.config） ───────────────────────
		const LABELS = {
			enabled: ['启用插件', '关掉后工具与客户端按钮都不再工作'],
			minShadowedTokens: ['选区下限（token）', '低于它的压缩必然被官方「摘要更小」校验拒绝，故提前拒绝'],
			maxSurfaceShare: ['单次上限（占可见历史比例）', '0–1 之间的小数，例如 0.6'],
			approvalTimeoutMs: ['确认卡等待（毫秒）', '超时视为未确认，零改动'],
			maxPerTurn: ['每轮最多压缩次数', '同一轮内重复压缩会被拒绝'],
			foldSummary: ['使用「局部压缩」摘要模板', '关掉则用出厂那套英文 8 段模板'],
		};

		/**
		 * 遍历自己构造的树，挑出**非法的子节点**（React error #31 的成因）。
		 *
		 * 为什么需要：`createElement(type, props, someObject)` 自己**不会抛** —— React 是在渲染这棵树时
		 * 才抛的，所以组件里的 try/catch 抓不到它（这就是 2026-10-16 那次「包了 try/catch 仍然崩」的原因）。
		 * 主动在返回之前走一遍，就能把「哪个位置、什么对象」直接显示到页面上。
		 * @param node - 待检查的节点。
		 * @param path - 人类可读的路径，用于报错定位。
		 * @param out - 收集非法节点。
		 * @returns 非法节点列表（空数组表示可安全交给 React）。
		 */
		function collectBadChildren(node, path, out = []) {
			if (node === null || node === undefined || typeof node === 'boolean') return out;
			if (typeof node === 'string' || typeof node === 'number') return out;
			if (Array.isArray(node)) {
				node.forEach((child, index) => collectBadChildren(child, `${path}[${index}]`, out));
				return out;
			}
			if (typeof node === 'object' && node.type !== undefined) {
				const name = typeof node.type === 'string' ? node.type : (node.type?.name ?? 'Component');
				const children = node.props?.children;
				const list = children === undefined ? [] : (Array.isArray(children) ? children : [children]);
				list.forEach((child, index) => {
					if (child === null || child === undefined || typeof child === 'boolean') return;
					if (typeof child === 'string' || typeof child === 'number') return;
					if (typeof child === 'object' && child.type !== undefined) {
						collectBadChildren(child, `${path}>${name}[${index}]`, out);
						return;
					}
					if (Array.isArray(child)) {
						collectBadChildren(child, `${path}>${name}[${index}]`, out);
						return;
					}
					out.push({ path: `${path}>${name}[${index}]`, value: child });
				});
				return out;
			}
			out.push({ path, value: node });
			return out;
		}

		/**
		 * 错误边界：**唯一**能接住「渲染期」异常的办法（try/catch 只能接住构造期）。
		 *
		 * 我在插件详情页那块表单上花了两次都没定位到崩溃点（控制台只给 combo 里的行号、
		 * 且行号与我的文件行数对不上 —— 那个 #31 很可能来自别的插件注册进同一槽位的 entry）。
		 * 无论如何，本 entry 从此**不会再把控制台刷屏**：出错就地显示成可读的诊断。
		 */
		class SectionBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failure: null };
			}
			static getDerivedStateFromError(failure) {
				return { failure };
			}
			componentDidCatch(failure) {
				console.error('[compaction-selective] 参数表单渲染失败', failure);
			}
			render() {
				const failure = this.state.failure;
				if (failure === null || failure === undefined) return this.props.children;
				const detail = failure instanceof Error ? failure.message : String(failure);
				return h('div', { style: { ...warning, fontSize: 12, lineHeight: '18px' } },
					'参数表单渲染失败（插件功能本身不受影响：下面的开关、输入框按钮、＋菜单、模型工具都照常）',
					h('br', null),
					detail);
			}
		}

		function PluginConfigSection(props) {
			const [state, setState] = useState(null);
			const [error, setError] = useState('');
			const [draft, setDraft] = useState({});
			const [message, setMessage] = useState('');
			const [busy, setBusy] = useState(false);

			const load = useCallback(async () => {
				const res = await callJson('/compaction-selective/state');
				if (!res.ok) {
					setError(res.body?.error ?? `http ${res.status}`);
					return;
				}
				setError(res.body?.configError ?? '');
				setState(res.body);
				setDraft(res.body?.config ?? {});
			}, []);
			useEffect(() => { load(); }, [load]);

			// 这个 entry 在 2026-10-16 崩过一次（浏览器控制台：`slot entry crashed in
			// 'plugins.bundle.config'` + React error #31「对象不能当子节点」），但我读代码没定位到
			// 具体那一个节点。框架按 entry 隔离了它（按钮/菜单/工具都没受影响），所以这里**不追**，
			// 只把渲染体包进 try/catch：既能止住控制台刷屏，又能把真实报错**显示在页面上**。
			// 想彻底修的话，从这里显示的报错正文入手最快。
			try {

			// `plugins.bundle.config` 的契约说 bundle 配置**只以 `page` 渲染**；
			// 但「详情页里表单消失」那次排查发现：任何 `view !== 'page'` 的调用都会被我提前 return，
			// 从而表现为「整块不见了」。所以现在**不再按 view 分支**：无论哪种视图都把表单画出来
			// （契约本来也只叫 page）。
			if (state === null) {
				return h('div', { style: { fontSize: fontSmall, ...hint } },
					`${T('读取中…（若一直停在这里，说明 /compaction-selective/state 没通）')}${error === '' ? '' : ` —— ${error}`}`);
			}

			const keys = Object.keys(state.defaults ?? {});
			const changed = keys.filter((key) => draft[key] !== state.config?.[key]);
			const originLabel = (key) => {
				const origin = state.origin?.[key];
				if (origin === 'settings-file') return '设置文件';
				return origin === 'composition' ? '组合配置' : '默认值';
			};

			const save = async () => {
				setBusy(true);
				setMessage('');
				const patch = {};
				for (const key of changed) {
					const raw = draft[key];
					const type = state.types?.[key];
					if (type === 'boolean') patch[key] = raw === true;
					else if (type === 'ratio') patch[key] = Number(raw);
					else patch[key] = Number.parseInt(String(raw), 10);
				}
				const res = await callJson('/compaction-selective/config', {
					method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch }),
				});
				setBusy(false);
				if (!res.ok || res.body?.ok !== true) {
					setMessage(`${T('保存失败：')}${res.body?.error ?? res.body?.message ?? `http ${res.status}`}`);
					return;
				}
				setMessage(`${T('已保存')} ${changed.length} ${T('项（即时生效，不需要重启）')}`);
				load();
			};

			const rows = keys.map((key) => {
				const def = LABELS[key] ?? [key, ''];
				const type = state.types?.[key];
				const value = draft[key];
				const control = type === 'boolean'
					? h('input', { type: 'checkbox', checked: value === true, onChange: (event) => setDraft({ ...draft, [key]: event.target.checked }) })
					: h('input', { style: { ...input, width: 110 }, value: value === undefined ? '' : String(value), onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) });
				// ⚠ 每个动态值都 `String()` 包一层：React error #31 只可能来自"把对象当子节点"，
				// 强制转字符串后，无论数据长什么样都不再可能崩（第 45x 行那次排查的保险）。
				return h('tr', { key: String(key) },
					h('td', { style: { ...td, width: 230 } }, String(def[0] ?? ''), h('div', { style: { ...hint, fontSize: 10 } }, String(def[1] ?? ''))),
					h('td', { style: td }, control),
					h('td', { style: { ...td, width: 80, ...hint } }, String(originLabel(key))),
				);
			});

			const saveButton = h('button', { style: changed.length > 0 ? btnPrimary : btnOff, disabled: changed.length === 0 || busy, onClick: save },
				busy ? T('保存中…') : (changed.length > 0 ? `${T('保存（')}${changed.length}${T(' 项改动）')}` : T('保存')));

			const tree = h('div', { style: { padding: '4px 0', display: 'flex', flexDirection: 'column', gap: 8 } },
				h('div', { style: title }, T('选择性压缩')),
				h('div', { style: hint }, '把已经结束的若干轮压缩成一条摘要（按人类指令、输入框的「选择性压缩」按钮、或 ＋菜单触发）。'),
				h('table', { style: table }, h('tbody', null, rows)),
				h('div', { style: row },
					saveButton,
					h('button', { style: btn, onClick: () => setDraft(state.config) }, T('撤销改动')),
					h('span', { style: { ...hint, fontSize: 11 } }, String(message || state.settingsPath || '')),
				),
				error === '' || error === null || error === undefined ? null : h('div', { style: { ...warning, fontSize: 11 } }, `${T('配置诊断：')}${String(error)}`),
			);

			// 在**真实数据**下再自检一遍（离线 harness 用的是我抓的响应，这里用的是网页里实际的那份）。
			const problems = collectBadChildren(tree, 'form');
			if (problems.length > 0) {
				const first = problems[0];
				return h('div', { style: { ...warning, fontSize: 11 } },
					`${T('表单自查发现非法子节点：')}${first.path}`,
					h('br', null),
					`${T('类型')} ${first.value === null ? 'null' : (first.value?.constructor?.name ?? typeof first.value)}｜${T('键')} ${JSON.stringify(Object.keys(first.value ?? {}))}`,
					h('br', null),
					'（把这一行发我即可定位；插件功能不受影响）');
			}
			return tree;
			} catch (failure) {
				const detail = failure instanceof Error ? failure.message : String(failure);
				return h('div', { style: { ...warning, fontSize: 11 } },
					`${T('参数表单渲染失败：')}${detail}`, h('br', null),
					'（插件功能本身不受影响：设置里的开关、输入框按钮、＋菜单、模型工具都照常）');
			}
		}

		/** 能安全交给 React 的子节点判定（对象／函数／Promise 会让 React 抛 #31）。 */
		function isRenderableChild(child) {
			if (child === null || child === undefined || typeof child === 'boolean') return false;
			if (typeof child === 'string' || typeof child === 'number') return true;
			if (Array.isArray(child)) return child.some(isRenderableChild);
			return typeof child === 'object' && child.type !== undefined;
		}

		/**
		 * `plugins.bundle.config` 的入口。
		 *
		 * ⚠ **踩过的坑（2026-10-16，就是表单消失的真因）**：内容**不能**作为注册元素的 children 传进来 ——
		 * 槽位框架会把**它自己的东西**作为 children 注入这个元素（`cloneElement` 语义），于是：
		 *   ① 我原本的 children 被顶掉 → 表单“整块不见了”；
		 *   ② 被注入的那个对象被当作子节点渲染 → `React error #31（object with keys {}）`。
		 * 所以现在：**内容在自己 `render()` 里造**（框架注入的 children 碰不到它），注入的 children 一律
		 * 过滤掉（并往控制台记一行，方便日后核对框架到底注入了什么）。
		 *
		 * 三层防护仍在：构造期 try/catch → 返回前主动树校验 → `SectionBoundary` 错误边界（渲染期异常）。
		 */
		class BundleConfigEntry extends React.Component {
			render() {
				const raw = this.props?.children;
				const injected = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
				const dropped = injected.filter((child) => !isRenderableChild(child));
				if (injected.length > 0) {
					console.warn('[compaction-selective] plugins.bundle.config 被注入了 children，已忽略：',
						dropped.length > 0 ? '其中含非法子节点' : '全部可渲染',
						injected.map((child) => (child === null ? 'null' : (child?.constructor?.name ?? typeof child))));
				}
				const inspected = inspectTree(() => h(PluginConfigSection, { view: this.props?.view ?? 'page' }), 'bundle-config');
				if (inspected.bad !== null) return inspected.bad;
				return h(SectionBoundary, null, inspected.tree);
			}
		}

		/** 构造一棵树；顺手做非法子节点检查（发现就返回可读诊断而不是崩）。 */
		function inspectTree(build, where) {
			let tree = null;
			try {
				tree = build();
			} catch (failure) {
				const detail = failure instanceof Error ? failure.message : String(failure);
				return { tree: null, bad: h('div', { style: { ...warning, fontSize: 11 } }, `${T('构造失败：')}${detail}${T('')}`) };
			}
			const problems = collectBadChildren(tree, where);
			if (problems.length === 0) return { tree, bad: null };
			const first = problems[0];
			const kind = first.value === null ? 'null' : (first.value?.constructor?.name ?? typeof first.value);
			console.error('[compaction-selective] 发现非法子节点', problems);
			return {
				tree: null,
				bad: h('div', { style: { ...warning, fontSize: 11 } },
					`${T('参数表单里出现了不能直接显示的对象（React #31）：')}${first.path}`,
					h('br', null),
					`${T('类型')} ${kind}｜${T('键')} ${JSON.stringify(Object.keys(first.value ?? {}))}｜${T('值')} ${String(first.value).slice(0, 80)}`,
					h('br', null),
					'（插件功能本身不受影响；把这一行原文发我即可定位）'),
			};
		}

		// ────────────────── ＋ 菜单 →「指令」里的一行（客户端自有命令） ──────────────────
		// 用 `ctx.commandUi.register` 而不是宿主命令：`CommandContribution` 才带 `label()`
		// 与 `icon`（宿主命令在菜单里只能显示命令名、且没有图标位）。契约明确：贡献与宿主
		// 命令**同名会在候选合成时直接报错**，所以宿主侧那条 /fold 命令已撤掉，由这里独占。
		// 行为仍走同一套 HTTP API（与输入框那个按钮共用），`ui: popupSelect` 会开出原生选择器。
		function foldContribution() {
			const options = async (session) => {
				const sessionId = session?.sessionId;
				const res = await callJson(`/compaction-selective/state?sessionId=${encodeURIComponent(String(sessionId ?? ''))}`);
				const patched = res.body?.session?.resolution?.patched;
				// 后端没有 compactRange（桌面端核心在 app.asar 里）→ 不给人假按钮，直接解释。
				if (res.ok && patched === false) {
					return [
						{
							id: 'nopatch',
							label: T('这里不能直接折（缺少本地补丁）'),
							detail: T('请在对话里说「压缩最近 N 轮」——会弹确认卡'),
						},
					];
				}
				const suggestions = res.body?.session?.suggestions ?? [];
				const usable = suggestions.filter((item) => item.ok === true);
				if (!res.ok || usable.length === 0) {
					return [{ id: 'none', label: '当前没有可压缩的轮次', detail: res.body?.error ?? '可能太小、超过单次上限，或这一轮还没结束' }];
				}
				return usable.map((item) => ({
					id: `recent-${item.recent}`,
					label: `${T('压缩最近')} ${item.recent} ${T('轮')}`,
					badge: `≈${fmt(item.tokens)}`,
					detail: `turn ${item.label} · ${item.nodes} ${T('条表面节点')}`,
				}));
			};
			const onSelect = async (option, session) => {
				const match = /^recent-(\d+)$/.exec(String(option?.id ?? ''));
				if (match === null) return;
				await callJson('/compaction-selective/fold', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId: session?.sessionId, recent_turns: Number(match[1]), confirm: true }),
				});
			};
			return {
				name: 'fold',
				label: () => T('选择性压缩'),
				description: () => T('把已结束的若干轮压缩成摘要（选中即执行，没有二次确认）'),
				icon: CompactIcon,
				// `available` 是**同步**的（每次候选合成都会调一次，只拿到 `{sessionId}`），
				// 所以这里读"能力缓存"：探测到后端没有 `compactRange`（例如桌面端核心在 app.asar 里）
				// 就让这一行**不出现** —— 避免用户点下去才收到 NO_PATCH。
				available: () => true, // 入口常驻：能否真折由 options() 打开时解释（见下）
				// popupSelect 只给「列表 + 选中」两件事，没有二次确认的位置 —— 所以把后果写进标题，
				// 选项文案也写成动词短语（「压缩最近 2 轮」），降低误点概率。
				// 注意：PopupSelectSpec 只有 kind/searchMode/searchLabels/options/onSelect —— **没有 title**。
				// （实测 d.ts：原先写的 	itle 被静默忽略，所以「选中即执行」这句警告其实从未显示过。）
				// 真正的警示靠 description() 与动词化的选项文案（「压缩最近 N 轮」）。
				ui: { kind: 'popupSelect', options, onSelect },
			};
		}

		// ─────────────────────── 插件入口 ───────────────────────
		exports.name = 'dsh-compaction-selective';
		exports.inject = ['slots', 'commandUi', 'locale'];
		exports.apply = function apply(ctx) {
			// ⚠ 属性访问本身就可能抛：客户端 ctx 是**受限服务面**，直接读 `ctx.locale` 这类未注入的属性会抛
			// （2026-11-10 事故：这一行把整个 web boot 拖成 "1 entry did not activate"）。
			// 所以 ① 语言读取整体包 try/catch（且不在 try 之外求值 ctx.locale）
			//      ② 整个注册过程 fail-soft —— 客户端条目失败不能连坐宿主 UI。
			try {
				localeRef = ctx.locale ?? null;
			} catch {
				localeRef = null;
			}
			// 宿主拿不到浏览器端的 locale（那是客户端服务），所以把界面语言上报一次 ——
			// 确认卡由宿主渲染，靠这个值决定用哪种语言。
			try {
				const snapshot = localeRef?.getSnapshot?.() ?? localeRef?.getLocale?.();
				const active = snapshot?.active ?? snapshot?.value?.locale ?? snapshot?.locale;
				if (typeof active === 'string' && active !== '') {
					callJson('/compaction-selective/ui-locale', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ locale: active }),
					}).catch(() => {});
				}
			} catch {
				/* 上报失败不影响插件 */
			}
			try {
			const slots = ctx.slots;
			if (slots === undefined) {
				console.warn('[compaction-selective] 没有 slots 服务，客户端半边不注册');
				return;
			}
			// ⚠ `conversation.input.left` 的 **ownerProps 是空的**（宿主渲染时传的就是 `{}`），
			// 所以 sessionId 不能指望从 props 里来 —— 必须用注册项的 `inject` 面：
			// 宿主会以当前 sessionId 调用它，返回值并进组件 props（权限胶囊用的就是这条）。
			// 少这一行，多会话同时打开时面板只会说「无法判断要对哪个操作」。
			slots.inject('conversation.input.left', () => slots.register(
				{
					name: 'conversation.input.left',
					id: 'compaction-selective',
					order: 200,
					label: () => T('选择性压缩'),
					inject: (sessionId) => ({ sessionId }),
				},
				() => h(FoldButton),
			));
			// 设置表单挂到**本插件自己的详情页**上：`plugins.bundle.config` 是 keyed 槽位，
			// key 必须等于 bundle 的包名（插件管理面板按这个 key 分发到对应条目）。
			slots.inject('plugins.bundle.config', () => slots.register(
				{ name: 'plugins.bundle.config', key: 'dsh-compaction-selective' },
				() => h(BundleConfigEntry),
			));
			if (ctx.commandUi !== undefined) ctx.commandUi.register(foldContribution());
			else console.warn('[compaction-selective] 没有 commandUi 服务，＋ 菜单里的那一行不会出现');
			} catch (error) {
				// 客户端注册失败只应让"插件不可用"，不应让宿主 UI 起不来。
				console.warn(`[compaction-selective] 客户端注册失败，本体已跳过：${error?.stack ?? error}`);
			}
		};

		return module.exports;
	},
});
