// Insights dashboard: GET /api/insights and render. Chinese for zh-CN, English otherwise.
(function () {
  const C = window.WaymarkCharts;
  const esc = C.esc;
  const zh = document.documentElement.lang === 'zh-CN';
  const D = zh ? {
    title: '数据面板', subtitle: 'AI 在 Waymark 里做了什么、Waymark 替它做了什么、哪里还能更好', loading: '读取中…', openManager: '打开管理中心 →', allAgents: '全部 agent',
    steps: 'AI 步骤', stepsNote: '{0} 个 agent · {1} 个会话 · {2} 个标签页', success: '动作成功率', successNote: '{0} 次动作，失败 {1}',
    tokens: '浏览器往返 token', tokensNote: '已上报真实用量 {0}', saved: 'Waymark 帮省的 token', savedNote: '另省人工时间约 {0}',
    automationTitle: 'Waymark 替 agent 做了什么', automationLead: '这些操作在本地完成，不经过模型，不花 token。',
    ocr: 'ddddocr 识别', ocrNote: '成功 {0} · 成功率 {1}%', pointer: '拟人鼠标轨迹', pointerNote: '其中点击 {0} 次', keys: '拟人键入字符', keysNote: '按键时长与间隔像人一样',
    idle: '空闲时随机游走', idleNote: '滚动 {0} · 浏览 {1} · 共 {2} 次行为', pacing: '反应时间补齐', pacingNote: 'AI 回得比人快时等的秒数', challenges: '人机验证 / 反爬拦截', challengesNote: '交给人处理 {0} · 阻止自动化 {1}',
    paste: '隔离剪贴板粘贴', pasteNote: '不碰系统剪贴板', screens: '溯源截图', screensNote: '快照 {0} · 读取 {1}',
    trendTitle: '每天的 AI 步骤', trendLead: '按 agent 堆叠；悬停查看当天明细。', heatTitle: '活跃时段', heatLead: '一周中各小时的 AI 步骤数（本机时间）。',
    agentsTitle: 'Agent 对比', agentsLead: '同样的浏览器，不同 agent 的效率。', savingsTitle: '节省与消耗', savingsLead: '带「估算」的数字依赖下方假设，可在配置 insights 中修改。',
    recsTitle: '改进建议', recsLead: '根据溯源记录自动发现的问题和机会。', noRecs: '暂时没有发现需要改进的地方。',
    repeatTitle: '重复度', repeatLead: '反复出现的网址和步骤序列，适合缓存、写成脚本或做成技能。', urls: '重复访问的页面', seqs: '重复的步骤序列', noRepeat: '没有明显重复。', redundant: '页面未变却重复快照：{0} 次',
    failTitle: '失败分析', failLead: '失败按原因归类，点开管理中心可看到每一步。', noFail: '没有失败。', recentFail: '最近失败',
    sitesTitle: '站点', sitesLead: '最常操作的站点、失败率和加载速度。', toolsTitle: '工具调用', timeTitle: '时间花在哪', estimate: '估算',
    assumptionsTitle: '估算假设', foot: '所有数据只保存在这台电脑上，Waymark 不上传任何记录。',
    col: { agent: 'Agent', sessions: '会话', steps: '动作', rate: '成功率', avgSteps: '平均步数/会话', avgMin: '平均时长(分)', tokens: 'token/会话（估）', identity: '身份来源', host: '站点', nav: '打开', fail: '失败', p50: '加载 p50', p90: '加载 p90', chall: '验证', tool: '工具', calls: '调用', avgMs: '平均耗时', tok: 'token（估）', url: '页面', count: '次数', seq: '步骤', when: '时间', what: '动作', err: '错误' },
    time: { browserSeconds: '浏览器执行', thinkSeconds: 'Agent 思考（调用间隔）', waitSeconds: '等待页面', pacingSeconds: '拟人节奏等待' },
    save: { tokensSavedCaptcha: '验证码本地识别', tokensSavedDiffs: '动作返回差异而非整页快照', tokensSavedTruncation: '长页面截断未发送', tokensSavedVsScreenshots: '文本快照代替截图', tokensWastedRedundantSnapshots: '重复快照浪费', tokensBrowserIo: '浏览器往返总量', tokensReported: 'Agent 上报的真实用量' },
    cat: { stale_ref: '元素引用过期', not_visible: '元素不可见', paused: '被用户暂停', timeout: '超时', network: '网络 / 导航错误', closed_page: '页面已关闭', bad_input: '参数错误', other: '其他' },
    sev: { high: '优先处理', medium: '建议', info: '提示' },
    formula: {
      tokensSavedCaptcha: '本地识别成功数 × AI 识别一次的 token × 无 OCR 时平均尝试次数', tokensSavedDiffs: '每次动作：(该标签页上次快照大小 − 动作返回大小) ÷ 每 token 字符数',
      tokensSavedVsScreenshots: '每次快照/读取：max(0, 一张截图的 token − 返回的 token)', tokensSavedTruncation: 'read 超出上限而没有发给 agent 的页面文字',
      tokensWastedRedundantSnapshots: '与本会话该标签页上一次快照完全相同的快照大小 ÷ 每 token 字符数', tokensBrowserIo: '每次工具调用的（请求 + 返回）字符数 ÷ 每 token 字符数（截图图片字节不计）'
    },
    ids: { declared: '自报', 'mcp-client': 'MCP 客户端', env: '环境变量', 'user-agent': 'UA 推断', tty: '终端', 'local-ui': '本地界面', system: '系统', unknown: '未知', legacy: '旧记录' },
    days: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'], sec: '{0} 秒', min: '{0} 分钟', hour: '{0} 小时',
    assume: { charsPerToken: '每 token 字符数', screenshotTokens: '一张截图的视觉 token', captchaTokensPerAttempt: 'AI 识别一次验证码的 token', captchaAttemptsWithoutOcr: '无本地 OCR 时平均尝试次数', humanSecondsPerCaptcha: '人工解一次验证码（秒）', sessionGapMinutes: '会话切分间隔（分钟）', thinkCapSeconds: '思考时间单次上限（秒）', slowNavigateMs: '慢页面阈值（毫秒）', repeatThreshold: '重复判定次数' },
    rec: {
      agent_failure_rate: ['{agent} 的动作成功率只有 {rate}%', '共失败 {failures} 次。看看失败分类：多数是引用过期或元素不可见时，让它在导航后先 snapshot，再按返回的 changes 操作。'],
      site_failure_rate: ['{host} 上的失败偏多', '{actions} 次动作失败 {failures} 次。这个站点可能有动态页面或拦截，可考虑加等待条件、或为它写专门的步骤。'],
      stale_refs: ['元素引用过期 {count} 次', '页面变化后还在用旧的 ref。动作结果里已经带了 changes 和新 ref，agent 应优先使用它们而不是旧快照。'],
      redundant_snapshots: ['页面没变却重复快照 {count} 次', '大约浪费 {tokens} token。动作返回的 changes 已经描述了变化，同一页面无需再次 snapshot。'],
      repeated_url: ['{url} 被打开了 {count} 次', '分布在 {sessions} 个会话里。如果内容变化不频繁，可以缓存结果，或把这段流程做成脚本 / 技能。'],
      repeated_sequence: ['同一串 {steps} 步操作重复了 {count} 次', '{sequence}。这是固定流程的信号，适合写成脚本或技能，省掉每次的推理 token。'],
      slow_site: ['{host} 加载较慢', '90% 的打开耗时在 {p90} 秒以内。可以在这个站点上减少整页跳转，或接受更长的等待。'],
      challenge_hotspot: ['{host} 经常需要人工验证', '已交给人 {count} 次。可以提前人工登录保持会话，或把它加入受保护站点。'],
      large_reads: ['有 {count} 次读取超过 2 万字符', '共约 {tokens} token。用 snapshot 或给 read 加 limit，只取需要的部分。'],
      long_sessions: ['{count} 个会话超过 40 步', '最长 {max} 步。可以拆分任务，或检查是否在原地反复尝试。'],
      think_bound: ['时间主要花在 agent 思考上', '思考约 {think} 分钟，浏览器执行约 {browser} 分钟。提速应从减少模型往返入手，而不是浏览器。'],
      unknown_agent: ['有 {count} 次调用无法识别是哪个 agent', '给 MCP 地址加上 ?agent=名字，或设置 X-Waymark-Agent 请求头、CLI 的 --agent / WAYMARK_AGENT，溯源就能分清。'],
      captcha_saved: ['本地识别了 {count} 个验证码', '估算为 agent 省下约 {tokens} token、人工约 {seconds} 秒。']
    }
  } : {
    title: 'Insights', subtitle: 'What agents did in Waymark, what Waymark did for them, and what could be better', loading: 'Loading…', openManager: 'Open agent manager →', allAgents: 'All agents',
    steps: 'AI steps', stepsNote: '{0} agents · {1} sessions · {2} tabs', success: 'Action success', successNote: '{0} actions, {1} failed',
    tokens: 'Browser I/O tokens', tokensNote: 'Reported by agents: {0}', saved: 'Tokens Waymark saved', savedNote: 'Plus about {0} of human time',
    automationTitle: 'What Waymark did for the agents', automationLead: 'Handled locally, without the model and without tokens.',
    ocr: 'ddddocr solves', ocrNote: '{0} solved · {1}% success', pointer: 'Human pointer paths', pointerNote: '{0} of them clicks', keys: 'Human-typed characters', keysNote: 'Key hold and gaps like a person',
    idle: 'Idle behaviour', idleNote: '{0} scrolls · {1} visits · {2} episodes', pacing: 'Reaction time added', pacingNote: 'Seconds waited when the agent was faster than a person', challenges: 'CAPTCHAs / bot walls', challengesNote: '{0} handed to you · {1} blocked',
    paste: 'Isolated pastes', pasteNote: 'System clipboard untouched', screens: 'Trace screenshots', screensNote: '{0} snapshots · {1} reads',
    trendTitle: 'AI steps per day', trendLead: 'Stacked by agent; hover a day for details.', heatTitle: 'When agents work', heatLead: 'AI steps per weekday and hour (local time).',
    agentsTitle: 'Agents compared', agentsLead: 'Same browser, different agents.', savingsTitle: 'Savings and spend', savingsLead: 'Numbers marked Estimate rest on the assumptions below (config: insights).',
    recsTitle: 'Suggestions', recsLead: 'Problems and opportunities found in the trace.', noRecs: 'Nothing to improve right now.',
    repeatTitle: 'Repetition', repeatLead: 'Recurring pages and step sequences: candidates for caching, scripts or skills.', urls: 'Pages opened repeatedly', seqs: 'Repeated step sequences', noRepeat: 'No notable repetition.', redundant: 'Snapshots of an unchanged page: {0}',
    failTitle: 'Failures', failLead: 'Grouped by cause; the agent manager shows every step.', noFail: 'No failures.', recentFail: 'Recent failures',
    sitesTitle: 'Sites', sitesLead: 'Where agents work most, failure rates and load times.', toolsTitle: 'Tool calls', timeTitle: 'Where the time goes', estimate: 'Estimate',
    assumptionsTitle: 'Assumptions', foot: 'All data stays on this computer. Waymark uploads nothing.',
    col: { agent: 'Agent', sessions: 'Sessions', steps: 'Actions', rate: 'Success', avgSteps: 'Steps / session', avgMin: 'Avg minutes', tokens: 'Tokens / session (est.)', identity: 'Identified by', host: 'Site', nav: 'Opens', fail: 'Failed', p50: 'Load p50', p90: 'Load p90', chall: 'Challenges', tool: 'Tool', calls: 'Calls', avgMs: 'Avg time', tok: 'Tokens (est.)', url: 'Page', count: 'Times', seq: 'Steps', when: 'When', what: 'Action', err: 'Error' },
    time: { browserSeconds: 'Browser execution', thinkSeconds: 'Agent thinking (gaps between calls)', waitSeconds: 'Waiting for pages', pacingSeconds: 'Human pacing' },
    save: { tokensSavedCaptcha: 'CAPTCHAs solved locally', tokensSavedDiffs: 'Actions return diffs, not full snapshots', tokensSavedTruncation: 'Long pages cut at the read limit', tokensSavedVsScreenshots: 'Text snapshots instead of screenshots', tokensWastedRedundantSnapshots: 'Wasted on repeated snapshots', tokensBrowserIo: 'Browser I/O in total', tokensReported: 'Reported by agents' },
    cat: { stale_ref: 'Stale element ref', not_visible: 'Element not visible', paused: 'Paused by user', timeout: 'Timeout', network: 'Network / navigation', closed_page: 'Page closed', bad_input: 'Bad arguments', other: 'Other' },
    sev: { high: 'Fix first', medium: 'Suggestion', info: 'Note' },
    ids: { declared: 'Declared', 'mcp-client': 'MCP client', env: 'Environment', 'user-agent': 'User-Agent', tty: 'Terminal', 'local-ui': 'Local UI', system: 'System', unknown: 'Unknown', legacy: 'Legacy' },
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], sec: '{0} s', min: '{0} min', hour: '{0} h',
    assume: { charsPerToken: 'Characters per token', screenshotTokens: 'Vision tokens per screenshot', captchaTokensPerAttempt: 'Tokens per AI CAPTCHA attempt', captchaAttemptsWithoutOcr: 'Attempts without local OCR', humanSecondsPerCaptcha: 'Seconds a person needs per CAPTCHA', sessionGapMinutes: 'Session split gap (min)', thinkCapSeconds: 'Max think time per gap (s)', slowNavigateMs: 'Slow page threshold (ms)', repeatThreshold: 'Repeat threshold' },
    rec: {
      agent_failure_rate: ['{agent} succeeds on only {rate}% of actions', '{failures} failures. If most are stale refs or hidden elements, have it snapshot after navigating and act on the returned changes.'],
      site_failure_rate: ['Many failures on {host}', '{failures} of {actions} actions failed. The site may be dynamic or guarded; add wait conditions or a dedicated routine.'],
      stale_refs: ['{count} stale element refs', 'Old refs were used after the page changed. Action results already carry changes and new refs; use them instead of an old snapshot.'],
      redundant_snapshots: ['{count} snapshots of an unchanged page', 'About {tokens} tokens wasted. Action results describe what changed, so the same page needs no second snapshot.'],
      repeated_url: ['{url} opened {count} times', 'Across {sessions} sessions. If it rarely changes, cache the result or turn the flow into a script or skill.'],
      repeated_sequence: ['The same {steps}-step sequence ran {count} times', '{sequence}. A fixed routine: script it or make it a skill and save the reasoning tokens.'],
      slow_site: ['{host} loads slowly', '90% of opens finish within {p90} s. Avoid full reloads there, or allow longer waits.'],
      challenge_hotspot: ['{host} often needs a person', 'Handed to you {count} times. Sign in ahead of time to keep the session, or add it to protected sites.'],
      large_reads: ['{count} reads over 20,000 characters', 'About {tokens} tokens. Use snapshot or a read limit to take only what is needed.'],
      long_sessions: ['{count} sessions longer than 40 steps', 'The longest has {max}. Split the task or check for retry loops.'],
      think_bound: ['Most time is agent thinking', 'About {think} min thinking vs {browser} min in the browser. Speed comes from fewer model round trips.'],
      unknown_agent: ['{count} calls could not be attributed to an agent', 'Add ?agent=NAME to the MCP URL, an X-Waymark-Agent header, or --agent / WAYMARK_AGENT for the CLI.'],
      captcha_saved: ['{count} CAPTCHAs solved locally', 'Estimated {tokens} agent tokens and {seconds} s of human time saved.']
    }
  };
  const f = (text, ...values) => String(text).replace(/\{(\d+)\}/g, (_, i) => values[i] ?? '');
  const named = (text, params) => esc(String(text).replace(/\{(\w+)\}/g, (_, key) => params[key] ?? ''));
  const nf = new Intl.NumberFormat(zh ? 'zh-CN' : 'en');
  const num = value => {
    const n = Number(value) || 0;
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return nf.format(Math.round(n * 10) / 10);
  };
  const dur = seconds => seconds >= 3600 ? f(D.hour, (seconds / 3600).toFixed(1)) : seconds >= 90 ? f(D.min, Math.round(seconds / 60)) : f(D.sec, Math.round(seconds));
  const SERIES = n => `var(--series-${(n % 8) + 1})`;
  const I = {
    ocr: '<svg viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="8" rx="2"/><path d="M5 8h1M8 8h3"/></svg>',
    pointer: '<svg viewBox="0 0 16 16"><path d="M4 2.5 12 8l-3.6.8L10.5 13l-1.6.8-2.1-4.2L4 12z"/></svg>',
    keys: '<svg viewBox="0 0 16 16"><rect x="1.5" y="4" width="13" height="8" rx="1.6"/><path d="M4 7h.1M6.5 7h.1M9 7h.1M11.5 7h.1M5 9.5h6"/></svg>',
    idle: '<svg viewBox="0 0 16 16"><path d="M2 10c2-4 4 2 6-2s4 2 6-2"/></svg>',
    pacing: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8.5" r="5"/><path d="M8 6v3l2 1M6.5 2h3"/></svg>',
    shield: '<svg viewBox="0 0 16 16"><path d="M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4z"/></svg>',
    clip: '<svg viewBox="0 0 16 16"><rect x="4" y="3" width="8" height="11" rx="1.5"/><path d="M6 3V2h4v1"/></svg>',
    camera: '<svg viewBox="0 0 16 16"><rect x="2" y="4.5" width="12" height="8.5" rx="2"/><circle cx="8" cy="8.7" r="2.3"/><path d="M6 4.5 7 3h2l1 1.5"/></svg>'
  };

  const params = new URLSearchParams(location.search);
  const state = { days: Number(params.get('days')) || 7, agent: params.get('agent') || '', agentsSeen: [] };
  document.querySelectorAll('[data-i]').forEach(node => { node.textContent = D[node.dataset.i] ?? node.textContent; });
  document.title = 'Waymark · ' + D.title;
  document.querySelectorAll('#range button').forEach(button => {
    button.classList.toggle('on', Number(button.dataset.days) === state.days);
    button.addEventListener('click', () => { state.days = Number(button.dataset.days); document.querySelectorAll('#range button').forEach(b => b.classList.toggle('on', b === button)); load(); });
  });
  $('#agent').addEventListener('change', event => { state.agent = event.target.value; load(); });
  function $(selector) { return document.querySelector(selector); }

  // Agent colors follow the agent, never its rank: the order agents were first seen fixes their slot.
  const colorSlots = new Map();
  const colorOf = agent => { if (!colorSlots.has(agent)) colorSlots.set(agent, SERIES(colorSlots.size)); return colorSlots.get(agent); };

  async function load() {
    const query = new URLSearchParams({ days: String(state.days) });
    if (state.agent) query.set('agent', state.agent);
    let report;
    try { report = await fetch('/api/insights?' + query).then(r => r.json()); }
    catch (error) { $('#main').innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
    if (!state.agent) {
      state.agentsSeen = report.agents.map(a => ({ agent: a.agent, label: a.label }));
      [...report.agents].sort((a, b) => a.agent.localeCompare(b.agent)).forEach(a => colorOf(a.agent));
    }
    $('#agent').innerHTML = `<option value="">${esc(D.allAgents)}</option>` + state.agentsSeen.map(a => `<option value="${esc(a.agent)}"${a.agent === state.agent ? ' selected' : ''}>${esc(a.label)}</option>`).join('');
    render(report);
  }

  function render(r) {
    const m = Object.fromEntries(r.metrics.map(x => [x.id, x.value]));
    const savedTokens = m.tokensSavedCaptcha + m.tokensSavedDiffs + m.tokensSavedTruncation + m.tokensSavedVsScreenshots;
    const html = [];
    html.push(`<section class="hero">
      <div class="card"><span class="k">${esc(D.steps)}</span><span class="v">${num(m.calls || m.actions)}</span><span class="n">${esc(f(D.stepsNote, m.agents, m.sessions, m.tabs))}</span></div>
      <div class="card with-ring">${C.ring(m.successRate, m.successRate >= 90 ? 'var(--ok)' : m.successRate >= 70 ? 'var(--warn)' : 'var(--bad)')}<div style="display:flex;flex-direction:column;gap:4px"><span class="k">${esc(D.success)}</span><span class="v">${m.actions ? m.successRate + '%' : '—'}</span><span class="n">${esc(f(D.successNote, num(m.actions), num(m.failures)))}</span></div></div>
      <div class="card"><span class="k">${esc(D.tokens)}<span class="est">${esc(D.estimate)}</span></span><span class="v">${num(m.tokensBrowserIo)}</span><span class="n">${esc(f(D.tokensNote, m.tokensReported ? num(m.tokensReported) : '—'))}</span></div>
      <div class="card"><span class="k">${esc(D.saved)}<span class="est">${esc(D.estimate)}</span></span><span class="v">${num(savedTokens)}</span><span class="n">${esc(f(D.savedNote, dur(m.secondsSavedCaptcha)))}</span></div>
    </section>`);

    const auto = (icon, value, key, note) => `<div class="auto"><div class="ic">${I[icon]}</div><div class="v">${esc(value)}</div><div class="k">${esc(key)}</div><div class="n">${esc(note)}</div></div>`;
    html.push(`<h2>${esc(D.automationTitle)}</h2><p class="lead">${esc(D.automationLead)}</p><section class="autos">
      ${auto('ocr', num(m.ocrRuns), D.ocr, f(D.ocrNote, num(m.ocrSolved), m.ocrSuccessRate))}
      ${auto('pointer', num(m.pointerPaths), D.pointer, f(D.pointerNote, num(m.pointerClicks)))}
      ${auto('keys', num(m.humanKeystrokes), D.keys, D.keysNote)}
      ${auto('idle', num(m.idleMoves), D.idle, f(D.idleNote, num(m.idleScrolls), num(m.idleVisits), num(m.idleBehaviours)))}
      ${auto('pacing', dur(m.pacingSeconds), D.pacing, D.pacingNote)}
      ${auto('shield', num(m.challengesDetected), D.challenges, f(D.challengesNote, num(m.humanHandoffs), num(m.blockedByChallenge)))}
      ${auto('clip', num(m.isolatedPastes), D.paste, D.pasteNote)}
      ${auto('camera', num(m.screenshots), D.screens, f(D.screensNote, num(m.snapshots), num(m.reads)))}
    </section>`);

    html.push(`<section class="grid2" style="margin-top:26px">
      <div class="card box"><h3>${esc(D.trendTitle)}</h3><p class="lead">${esc(D.trendLead)}</p><div class="legend" id="trend-legend"></div><div id="trend"></div></div>
      <div class="card box"><h3>${esc(D.heatTitle)}</h3><p class="lead">${esc(D.heatLead)}</p><div id="heat"></div></div>
    </section>`);

    html.push(`<h2>${esc(D.recsTitle)}</h2><p class="lead">${esc(D.recsLead)}</p>`);
    html.push(r.recommendations.length ? `<section class="recs">${r.recommendations.map(rec => {
      const text = D.rec[rec.id] || [rec.id, ''];
      const sessions = rec.evidence?.sessions?.length ? `<div class="ev"><a href="/agents?session=${encodeURIComponent(rec.evidence.sessions[0])}">${zh ? '查看相关会话 →' : 'Open related session →'}</a></div>` : '';
      return `<div class="card rec ${rec.severity}"><div class="sev">${esc(D.sev[rec.severity])}</div><h4>${named(text[0], rec.params)}</h4><p>${named(text[1], rec.params)}</p>${sessions}</div>`;
    }).join('')}</section>` : `<div class="card empty">${esc(D.noRecs)}</div>`);

    html.push(`<h2>${esc(D.agentsTitle)}</h2><p class="lead">${esc(D.agentsLead)}</p><div class="card box" style="overflow:auto">${r.agents.length ? `<table class="t"><thead><tr><th>${D.col.agent}</th><th class="num">${D.col.sessions}</th><th class="num">${D.col.steps}</th><th class="num">${D.col.rate}</th><th class="num">${D.col.avgSteps}</th><th class="num">${D.col.avgMin}</th><th class="num">${D.col.tokens}</th><th>${D.col.identity}</th></tr></thead><tbody>${r.agents.map(a => `<tr>
      <td><span style="display:inline-flex;align-items:center;gap:8px"><i class="swatch" style="background:${colorOf(a.agent)}"></i><a href="/agents?agent=${encodeURIComponent(a.agent)}">${esc(a.label)}</a></span></td><td class="num">${num(a.sessions)}</td><td class="num">${num(a.actions)}</td>
      <td class="num">${a.actions ? a.successRate + '%' : '—'}</td><td class="num">${a.avgStepsPerSession}</td><td class="num">${a.avgSessionMinutes}</td><td class="num">${num(a.tokensPerSession)}</td>
      <td>${Object.entries(a.identity).map(([k, v]) => `<span class="tag ${esc(k)}">${esc(D.ids[k] || k)} ${v}</span>`).join('')}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">—</div>`}</div>`);

    const saveRow = id => { const metric = r.metrics.find(x => x.id === id); return metric ? `<div class="save"><span>${esc(D.save[id])}${metric.estimate ? `<span class="est">${esc(D.estimate)}</span>` : ''}</span><b>${num(metric.value)}</b>${metric.formula ? `<small>${esc((D.formula && D.formula[id]) || metric.formula)}</small>` : ''}</div>` : ''; };
    html.push(`<section class="grid3" style="margin-top:26px">
      <div class="card box"><h3>${esc(D.savingsTitle)}</h3><p class="lead">${esc(D.savingsLead)}</p>${['tokensSavedCaptcha', 'tokensSavedDiffs', 'tokensSavedVsScreenshots', 'tokensSavedTruncation', 'tokensWastedRedundantSnapshots', 'tokensBrowserIo', 'tokensReported'].map(saveRow).join('')}</div>
      <div class="card box"><h3>${esc(D.timeTitle)}</h3><div id="time"></div><h3 style="margin-top:22px">${esc(D.toolsTitle)}</h3><div id="tools"></div></div>
      <div class="card box"><h3>${esc(D.failTitle)}</h3><p class="lead">${esc(D.failLead)}</p><div id="fails"></div>${r.failures.recent.length ? `<h3 style="margin-top:18px">${esc(D.recentFail)}</h3>${r.failures.recent.slice(0, 5).map(x => `<div style="font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line)"><a href="/agents?session=${encodeURIComponent(x.sessionKey)}&event=${encodeURIComponent(x.eventId)}">${esc(x.action)}</a> · <span class="muted">${esc(new Date(x.at).toLocaleString())}</span><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.error)}</div></div>`).join('')}` : ''}</div>
    </section>`);

    html.push(`<h2>${esc(D.repeatTitle)}</h2><p class="lead">${esc(D.repeatLead)}</p><section class="grid2">
      <div class="card box"><h3>${esc(D.urls)}</h3>${r.repetition.urls.length ? `<table class="t"><thead><tr><th>${D.col.url}</th><th class="num">${D.col.count}</th><th class="num">${D.col.sessions}</th></tr></thead><tbody>${r.repetition.urls.slice(0, 8).map(u => `<tr><td class="mono">${esc(u.url)}</td><td class="num">${u.count}</td><td class="num">${u.sessions}</td></tr>`).join('')}</tbody></table>` : `<div class="muted">${esc(D.noRepeat)}</div>`}
        <p class="muted" style="margin:12px 0 0;font-size:12.5px">${esc(f(D.redundant, r.repetition.redundantSnapshots))}</p></div>
      <div class="card box"><h3>${esc(D.seqs)}</h3>${r.repetition.sequences.length ? r.repetition.sequences.slice(0, 6).map(s => `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><b>${s.count}×</b> <span class="seq">${esc(s.steps)}</span></div>`).join('') : `<div class="muted">${esc(D.noRepeat)}</div>`}</div>
    </section>`);

    html.push(`<h2>${esc(D.sitesTitle)}</h2><p class="lead">${esc(D.sitesLead)}</p><div class="card box" style="overflow:auto">${r.sites.length ? `<table class="t"><thead><tr><th>${D.col.host}</th><th class="num">${D.col.nav}</th><th class="num">${D.col.steps}</th><th class="num">${D.col.fail}</th><th class="num">${D.col.p50}</th><th class="num">${D.col.p90}</th><th class="num">${D.col.chall}</th><th>${D.col.agent}</th></tr></thead><tbody>${r.sites.slice(0, 12).map(s => `<tr><td>${esc(s.host)}</td><td class="num">${s.navigations}</td><td class="num">${s.actions}</td><td class="num">${s.failures}</td><td class="num">${s.p50NavigateMs ? (s.p50NavigateMs / 1000).toFixed(1) + ' s' : '—'}</td><td class="num">${s.p90NavigateMs ? (s.p90NavigateMs / 1000).toFixed(1) + ' s' : '—'}</td><td class="num">${s.challenges}</td><td>${s.agents.map(a => `<i class="swatch" title="${esc(a)}" style="background:${colorOf(a)};margin-right:3px"></i>`).join('')}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">—</div>`}</div>`);

    html.push(`<h2>${esc(D.assumptionsTitle)}</h2><div class="card box assume">${Object.entries(r.assumptions).map(([k, v]) => `<span>${esc(D.assume[k] || k)}: <b>${esc(v)}</b></span>`).join('')}</div>`);
    html.push(`<p class="foot">${esc(D.foot)} · ${esc(new Date(r.generatedAt).toLocaleString())}</p>`);
    $('#main').innerHTML = html.join('');

    // Daily columns, one series per agent (top 7 by volume + Other), fixed color per agent.
    const agentIds = [...new Set(r.daily.flatMap(d => Object.keys(d.agents)))];
    const totals = Object.fromEntries(agentIds.map(a => [a, r.daily.reduce((s, d) => s + (d.agents[a] || 0), 0)]));
    agentIds.sort((a, b) => totals[b] - totals[a]);
    const shown = agentIds.slice(0, 7), rest = agentIds.slice(7);
    const label = id => (r.agents.find(a => a.agent === id)?.label) || (id === 'waymark' ? 'Waymark' : id);
    const series = shown.map(a => ({ name: label(a), color: colorOf(a), values: r.daily.map(d => d.agents[a] || 0) }));
    if (rest.length) series.push({ name: zh ? '其他' : 'Other', color: 'var(--text-3)', values: r.daily.map(d => rest.reduce((s, a) => s + (d.agents[a] || 0), 0)) });
    if (!series.length) series.push({ name: D.steps, color: 'var(--series-1)', values: r.daily.map(d => d.actions) });
    $('#trend-legend').innerHTML = series.length > 1 ? series.map(s => `<span><i class="swatch" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') : '';
    const dayLabel = day => { const [, mm, dd] = day.split('-'); return `${Number(mm)}/${Number(dd)}`; };
    C.columns($('#trend'), { labels: r.daily.map(d => dayLabel(d.day)), series, format: num, emptyText: '—' });
    // Monday first reads naturally in both languages.
    const order = [1, 2, 3, 4, 5, 6, 0];
    C.heatmap($('#heat'), { matrix: order.map(i => r.heatmap[i]), rows: order.map(i => D.days[i]), format: num, unit: D.steps });
    C.hbars($('#time'), { rows: ['thinkSeconds', 'browserSeconds', 'waitSeconds', 'pacingSeconds'].map((id, i) => ({ label: D.time[id], value: m[id] || 0, color: SERIES(i) })), format: dur });
    C.hbars($('#tools'), { rows: r.tools.slice(0, 8).map(t => ({ label: t.tool, value: t.calls, title: `${t.tool}: ${t.calls} · ${t.avgMs} ms · ${t.tokens} tok` })), format: num });
    if (r.failures.byCategory.length) C.hbars($('#fails'), { rows: r.failures.byCategory.map(c => ({ label: D.cat[c.category] || c.category, value: c.count, title: c.example })), format: num, color: 'var(--bad)' });
    else $('#fails').innerHTML = `<div class="muted">${esc(D.noFail)}</div>`;
  }

  addEventListener('resize', () => { clearTimeout(window.__wmResize); window.__wmResize = setTimeout(load, 250); });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 30000);
})();
