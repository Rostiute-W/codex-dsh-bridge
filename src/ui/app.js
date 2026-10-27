const $ = id => document.getElementById(id);

// One table drives labels, colors, the progress stepper and which tasks count as in flight.
// step: index of the current stage in STEPS (5 = all done); active: work is still running.
const STATUS = {
  queued:              {label:'排队中',     tone:'info',   step:0, active:true},
  preparing:           {label:'准备工作区', tone:'info',   step:0, active:true},
  running:             {label:'DSH 执行中', tone:'info',   step:1, active:true},
  awaiting_permission: {label:'等待权限',   tone:'warn',   step:1, active:true},
  validating:          {label:'验证中',     tone:'info',   step:2, active:true},
  awaiting_review:     {label:'等待审查',   tone:'review', step:3},
  review_running:      {label:'API 审查中', tone:'info',   step:3, active:true},
  needs_changes:       {label:'需要修改',   tone:'warn',   step:3},
  committing:          {label:'提交中',     tone:'info',   step:4, active:true},
  completed:           {label:'已完成',     tone:'ok',     step:5},
  failed:              {label:'失败',       tone:'bad'},
  cancelled:           {label:'已取消',     tone:'muted'},
  needs_attention:     {label:'待处理',     tone:'warn'},
};
const STEPS = ['交接', '执行', '验证', '审查', '提交'];
const PAGES = {
  tasks: ['任务协作', 'Codex 规划 · DSH 执行 · Bridge 验收与本地提交'],
  integration: ['Codex 接入', '按顺序完成一次接入，之后直接在 Codex 中委派任务'],
  settings: ['运行设置', 'DSH 程序位置、新任务模型与运行时限'],
};
const ICONS = {
  copy: ['M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M4 15V5a1 1 0 0 1 1-1h10'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36L21 8', 'M21 3v5h-5'],
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z'],
  play: ['M7 4l13 8-13 8z'],
  stop: ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z', 'M9 9h6v6H9z'],
  check: ['M20 6 9 17l-5-5'],
  alert: ['M12 3 2 20h20z', 'M12 10v4', 'M12 17h.01'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  commit: ['M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z', 'M3 12h6', 'M15 12h6'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  box: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12 4 7.5'],
  review: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  layers: ['M12 3 2 8l10 5 10-5z', 'M2 13l10 5 10-5'],
};
const statusOf = status => STATUS[status] ?? {label:status, tone:'muted'};
const isActive = task => !!statusOf(task.status).active;

let current, selectedId, page = 'tasks', settingsLoaded = false, refreshing = false;
let listKey, detailKey;
const detailViews = new Map();
const elapsedNodes = new Map();
let modelCatalog, nativeModelDraft = null;

/* ---------- DOM helpers ---------- */
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}
function toast(text, error = false) {
  const el = $('toast');
  el.replaceChildren(icon(error ? 'alert' : 'check'), node('span', String(text).replace(/^Error invoking remote method '[^']+': Error: /, '')));
  el.className = `toast ${error ? 'tone-bad' : 'tone-ok'}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), error ? 10000 : 6000);
}
async function invoke(method, params) {
  try { return await window.bridge.invoke(method, params); }
  catch (error) { toast(error.message, true); throw error; }
}

/* ---------- formatting ---------- */
const modelKey = selection => selection ? `${selection.provider} / ${selection.model}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''}` : '跟随 DSH 默认';
function date(text) { return new Date(text).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}); }
function elapsed(task) {
  const end = isActive(task) ? Date.now() : Date.parse(task.updatedAt);
  const seconds = Math.max(0, Math.floor((end - Date.parse(task.createdAt)) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds / 60) % 60} 分`;
}
function taskTitle(task) { return task.handoff.title.includes('\uFFFD') ? `旧版标题编码损坏 · ${task.id.slice(0, 8)}` : task.handoff.title; }
const baseName = text => String(text ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
function badge(status) {
  const meta = statusOf(status);
  return node('span', meta.label, `badge tone-${meta.tone}${meta.active ? ' live' : ''}`);
}

/* ---------- navigation ---------- */
function setPage(name) {
  page = name;
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('hidden', el.id !== `${name}-page`));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('selected', el.dataset.page === name));
  [$('page-title').textContent, $('page-subtitle').textContent] = PAGES[name];
}
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => setPage(el.dataset.page)));
$('empty-connect').addEventListener('click', () => setPage('integration'));

/* ---------- task detail ---------- */
function button(label, method, task, {disabled = false, cls = 'secondary', iconName} = {}) {
  const el = node('button', undefined, cls);
  if (iconName) el.append(icon(iconName));
  el.append(label);
  el.disabled = disabled;
  el.addEventListener('click', async () => {
    el.disabled = true;
    try { const result = await invoke(method, {taskId:task.id}); if (typeof result === 'string') toast(result); await refresh(); }
    catch {}
    finally { el.disabled = disabled; }
  });
  return el;
}
function block(title, iconName, aside) {
  const box = node('section', undefined, 'block'), head = node('h3', undefined, 'block-title');
  head.append(icon(iconName), title);
  if (aside) head.append(node('span', aside, 'aside'));
  box.append(head);
  return box;
}
function facts(rows) {
  const list = node('dl', undefined, 'facts');
  for (const [term, value, mono] of rows) if (value) list.append(node('dt', term), node('dd', value, mono ? 'mono' : undefined));
  return list;
}
function callout(tone, iconName, title, ...body) {
  const box = node('div', undefined, `callout tone-${tone}`), content = node('div', undefined, 'callout-body');
  content.append(node('strong', title), ...body);
  box.append(icon(iconName), content);
  return box;
}
/** Index of the stage the task is in. Interrupted tasks stop where their evidence ends. */
function stage(task) {
  const known = statusOf(task.status).step;
  if (known !== undefined) return known;
  return task.commit ? 4 : task.review ? 3 : task.checks.length ? 2 : task.worktree ? 1 : 0;
}
function stepper(task) {
  const meta = statusOf(task.status), at = stage(task), list = node('ol', undefined, 'stepper');
  STEPS.forEach((text, index) => {
    const item = node('li', undefined, 'step'), dot = node('span', undefined, 'step-dot');
    if (index < at) { item.classList.add('done'); dot.append(icon('check')); }
    else {
      dot.textContent = String(index + 1);
      if (index === at) item.classList.add('current', `tone-${meta.tone}`, ...meta.active ? ['live'] : []);
    }
    item.append(dot, node('span', text, 'step-label'));
    list.append(item);
  });
  return list;
}
function actionBar(task) {
  const bar = node('div', undefined, 'actions'), main = node('div', undefined, 'action-group'), tools = node('div', undefined, 'action-group');
  if (task.status === 'needs_changes' && task.review) main.append(button('交给 DSH 修复', 'revise', task, {disabled:task.round >= 2, cls:'primary', iconName:'wrench'}));
  if (['needs_attention', 'cancelled', 'needs_changes'].includes(task.status)) {
    const resume = node('button', undefined, 'secondary'); resume.append(icon('play'), '明确恢复'); resume.disabled = current.busy;
    resume.addEventListener('click', () => { $('resume-dialog').dataset.taskId = task.id; $('resume-instruction').value = ''; $('resume-dialog').showModal(); });
    main.append(resume);
  }
  if (['needs_attention', 'awaiting_review', 'needs_changes', 'cancelled'].includes(task.status) && task.worktree)
    main.append(button('重新验证', 'revalidate', task, {disabled:current.busy, iconName:'refresh'}));
  if (isActive(task) && task.status !== 'committing') main.append(button('取消执行', 'cancel', task, {cls:'danger', iconName:'stop'}));
  if (task.executor === 'desktop') tools.append(button('打开 DSH 对话', 'openDshChat', task, {disabled:!task.sessionId, iconName:'chat'}));
  tools.append(button('打开工作区', 'openWorktree', task, {disabled:!task.worktree, iconName:'folder'}), button('复制任务 ID', 'copyTaskId', task, {cls:'ghost', iconName:'copy'}));
  bar.append(main, tools);
  return bar;
}
function permissionBox(task) {
  const choices = node('div', undefined, 'callout-actions');
  // Locked while the request is in flight; unlocked on failure so the user can retry. The detail
  // panel is not rebuilt when a failed request leaves the task unchanged, so nothing else re-enables it.
  const answer = async (optionId, el) => {
    el.disabled = true;
    try { await invoke('permission', {taskId:task.id, permissionId:task.permission.id, optionId}); await refresh(); }
    catch { el.disabled = false; }
  };
  for (const option of task.permission.options) {
    const el = node('button', option.name, option.kind === 'allow_once' ? 'primary' : 'secondary');
    el.addEventListener('click', () => answer(option.id, el)); choices.append(el);
  }
  const reject = node('button', '取消权限请求', 'ghost'); reject.addEventListener('click', () => answer(null, reject)); choices.append(reject);
  const box = callout('warn', 'shield', task.permission.title, node('p', '此请求需要你判断额外权限。允许仅对本次请求生效。'), node('pre', task.permission.detail), choices);
  box.classList.add('permission-box');
  return box;
}
function overviewBlock(task) {
  const desktop = task.executor === 'desktop', box = block('工作现场', 'box', desktop ? 'DSH 原生聊天' : '旧版 ACP');
  box.append(facts([
    ['工作区', task.worktree ?? '将在任务启动后创建独立 Git worktree', !!task.worktree],
    ['分支', task.branch, true],
    ['基准提交', task.handoff.baseCommit.slice(0, 12), true],
    ['项目', task.handoff.repoPath, true],
    ...desktop ? [['DSH 会话', task.sessionId, true], ['初始模型', modelKey(task.nativeModel)]] : [],
  ]));
  box.append(node('div', task.handoff.goal, 'goal'));
  if (desktop) box.append(node('p', '执行与方向引导在 DSH 原生聊天中完成，权限请在 DSH 处理。初始模型之后的手动切换以 DSH 对话为准。', 'hint'));
  return box;
}
function reviewBlock(task) {
  const approved = task.review.verdict === 'approved';
  const box = block(`审查报告 · ${task.reviewSource === 'api' ? '付费 API' : 'Codex'}`, 'review');
  box.querySelector('.block-title').append(node('span', approved ? '通过' : '要求修改', `badge tone-${approved ? 'ok' : 'warn'}`));
  box.append(node('div', task.review.summary, 'review-summary'));
  if (task.review.issues.length) { const list = node('ol', undefined, 'issues'); task.review.issues.forEach(issue => list.append(node('li', issue))); box.append(list); }
  if (task.apiUsage) box.append(node('pre', JSON.stringify(task.apiUsage, null, 2)));
  return box;
}
function checksBlock(task) {
  const passed = task.checks.filter(check => check.exitCode === 0).length;
  const box = block('验证记录', 'list', `${passed} / ${task.checks.length} 通过`);
  for (const check of task.checks) {
    const row = node('div', undefined, 'check'), head = node('div', undefined, 'check-head'), ok = check.exitCode === 0;
    head.append(node('span', ok ? '通过' : `失败 · ${check.exitCode}`, `badge tone-${ok ? 'ok' : 'bad'}`), node('code', check.command));
    row.append(head);
    if (check.output) row.append(node('pre', check.output));
    box.append(row);
  }
  return box;
}
function filesBlock(task) {
  const box = block('代码变更', 'file', `${task.changedFiles.length} 个文件`), list = node('ul', undefined, 'file-list');
  for (const file of task.changedFiles) { const item = node('li'); item.append(icon('file'), file); list.append(item); }
  box.append(list);
  return box;
}
function commitBlock(task) {
  const box = block('本地 Git 提交', 'commit', task.commitStatus ? undefined : '工作区干净 · 未推送'), hash = node('span', undefined, 'commit');
  hash.append(icon('commit'), task.commit);
  box.append(hash, node('div', task.handoff.commitMessage, 'commit-message'));
  if (task.commitStatus) box.append(node('div', `剩余修改：${task.commitStatus}`, 'path'));
  return box;
}
function trellisDetail(task) {
  const declared = task.handoff?.trellis?.taskPath, pin = task.trellis, files = pin?.files ?? [];
  const box = node('details'); box.dataset.section = 'trellis';
  box.append(node('summary', pin ? `Trellis 上下文 · 已固定 ${files.length} 个文件` : declared ? 'Trellis 上下文 · 待固定' : 'Trellis 上下文 · 未关联'));
  if (!pin) {
    box.append(node('p', declared
      ? `交接引用了任务目录 ${declared}，但还没有固定上下文快照，尚未向 DSH 注入 Trellis 内容。固定失败时以上方错误为准。`
      : '本次交接没有引用 Trellis 任务，未读取任何 Trellis 文件。'));
    return box;
  }
  box.append(node('p', '执行开始时从基准 worktree 读取的只读资料，正文只保存在快照文件中；返工、重新验证与恢复沿用同一份快照。'));
  box.append(node('div', `任务目录 ${pin.taskPath}`, 'path'), node('div', `基准提交 ${pin.baseCommit}`, 'path'),
    node('div', `整体摘要 sha256 ${pin.sha256}`, 'path'), node('div', `快照文件 ${pin.snapshotPath}`, 'path'));
  box.append(node('pre', files.map(file => `${file.path} · ${file.roles.join(' + ')}\n${file.sha256}`).join('\n\n')));
  return box;
}
function handoffBlock(task) {
  const box = block('交接与上下文', 'layers');
  // The handoff stays the first <details> in the panel; the smoke test addresses it that way.
  const spec = node('details'); spec.dataset.section = 'handoff';
  spec.append(node('summary', '查看交接方案'), node('pre', JSON.stringify(task.handoff, null, 2)));
  box.append(spec, trellisDetail(task));
  return box;
}
function legacyBlock(task) {
  const box = block('旧版 ACP 记录', 'list');
  if (task.summary) { const summary = node('details'); summary.dataset.section = 'summary'; summary.append(node('summary', '查看旧版 ACP 执行总结'), node('pre', task.summary)); box.append(summary); }
  const history = node('details'); history.dataset.section = 'history'; history.append(node('summary', '旧版执行记录'));
  history.append(node('pre', task.log.map(line => `[${new Date(line.at).toLocaleTimeString('zh-CN')}] ${line.kind}\n${line.text}`).join('\n\n'), 'logs'));
  box.append(history);
  return box;
}
function renderDetail(task) {
  const panel = $('detail'), oldLog = panel.querySelector('.logs');
  const scroll = oldLog?.scrollTop ?? 0, follow = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40;
  const panelScroll = panel.dataset.taskId === task.id ? panel.scrollTop : 0;
  if (panel.dataset.taskId) detailViews.set(panel.dataset.taskId, Object.fromEntries([...panel.querySelectorAll('details')].map(el => [el.dataset.section, {open:el.open, scroll:el.querySelector('pre')?.scrollTop ?? 0}])));
  const view = detailViews.get(task.id); panel.dataset.taskId = task.id;

  const head = node('div', undefined, 'detail-head'), title = node('div'), meta = node('div', undefined, 'detail-meta');
  meta.append(node('span', `创建于 ${date(task.createdAt)}`), node('span', `返工 ${task.round}/2`), node('span', `ID ${task.id.slice(0, 8)}`));
  title.append(node('h2', taskTitle(task)), meta);
  head.append(title, badge(task.status));
  panel.replaceChildren(head, stepper(task), actionBar(task));
  if (task.error) { const error = callout('bad', 'alert', '需要处理', node('p', task.error)); error.classList.add('error-box'); panel.append(error); }
  if (task.permission) panel.append(permissionBox(task));
  panel.append(overviewBlock(task));
  if (task.review) panel.append(reviewBlock(task));
  if (task.checks.length) panel.append(checksBlock(task));
  if (task.changedFiles.length) panel.append(filesBlock(task));
  if (task.commit) panel.append(commitBlock(task));
  panel.append(handoffBlock(task));
  if (task.executor !== 'desktop') panel.append(legacyBlock(task));

  const logs = panel.querySelector('.logs'); if (logs) logs.scrollTop = follow ? logs.scrollHeight : scroll;
  panel.querySelectorAll('details').forEach(el => {
    const saved = view?.[el.dataset.section];
    if (saved) { el.open = saved.open; const pre = el.querySelector('pre'); if (pre && !pre.classList.contains('logs')) pre.scrollTop = saved.scroll; }
  });
  panel.scrollTop = panelScroll;
}

/* ---------- task list & shell ---------- */
function renderList(tasks) {
  elapsedNodes.clear();
  $('task-list').replaceChildren(...tasks.map(task => {
    const el = node('button', undefined, `task-item${task.id === selectedId ? ' active' : ''}`), meta = node('div', undefined, 'task-meta'), time = node('small');
    elapsedNodes.set(task.id, time);
    meta.append(badge(task.status), time);
    const sub = node('div', undefined, 'task-sub'), repo = baseName(task.handoff.repoPath);
    if (repo) sub.append(node('span', repo));
    if (task.commit) sub.append(node('span', `· 提交 ${task.commit.slice(0, 10)}`, 'mono'));
    el.append(node('h4', taskTitle(task)), meta, sub);
    el.addEventListener('click', () => { selectedId = task.id; renderState(); });
    return el;
  }));
}
const connectionTone = () => {
  const status = current.registration?.status;
  return status === 'registered' ? (current.mcpLastCall ? 'ok' : 'info') : status === 'missing' ? 'warn' : status ? 'bad' : 'muted';
};
function renderState() {
  const tasks = current.tasks;
  $('task-count').textContent = tasks.length; $('total').textContent = tasks.length;
  $('running').textContent = tasks.filter(t => isActive(t) && t.status !== 'queued').length;
  $('review-count').textContent = tasks.filter(t => t.status === 'awaiting_review').length;
  $('complete-count').textContent = tasks.filter(t => t.status === 'completed').length;
  $('empty').classList.toggle('hidden', tasks.length > 0); $('task-workspace').classList.toggle('hidden', tasks.length === 0);
  $('version').textContent = `v${current.version} · Windows`;
  $('service-status').textContent = current.serviceError ? '服务需要检查' : '本地服务运行中';
  $('service').classList.toggle('bad', !!current.serviceError);
  const connection = current.registration?.status === 'registered' && current.mcpLastCall ? `Codex 最近调用 · ${date(current.mcpLastCall)}` : current.registration?.message ?? '正在检查 Codex 配置';
  const tone = connectionTone();
  $('connection-state').textContent = connection; $('registration-state').textContent = connection;
  $('connection-pill').className = `pill tone-${tone}`; $('registration-chip').className = `status-chip tone-${tone}`;
  $('connection-pill').title = connection;
  $('install-codex').textContent = current.registration?.status === 'registered' ? '检查接入 / 安装 Skill' : '安装到 Codex';
  if (!tasks.some(t => t.id === selectedId)) selectedId = tasks[0]?.id;

  // Rebuild only what changed: a rebuild every poll would drop text selection, focus and hover.
  const nextListKey = JSON.stringify([selectedId, tasks.map(t => [t.id, t.status, t.handoff.title, t.handoff.repoPath, t.commit])]);
  if (nextListKey !== listKey) { listKey = nextListKey; renderList(tasks); }
  for (const task of tasks) { const time = elapsedNodes.get(task.id); if (time) time.textContent = elapsed(task); }
  const selected = tasks.find(t => t.id === selectedId);
  const nextDetailKey = selected && JSON.stringify([selected, current.busy]);
  if (selected && nextDetailKey !== detailKey) { detailKey = nextDetailKey; renderDetail(selected); }

  $('mcp-config').textContent = current.integration;
  $('data-root').textContent = `本地数据：${current.dataRoot}`;
  if (!settingsLoaded) {
    for (const [key, value] of Object.entries(current.settings)) if ($(key)) $(key).value = value;
    nativeModelDraft = structuredClone(current.settings.nativeModel ?? null); renderModels(); settingsLoaded = true;
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { current = await window.bridge.invoke('state'); renderState(); }
  catch (error) { toast(error.message, true); }
  finally { refreshing = false; }
}

/* ---------- settings: native model selection ---------- */
function option(select, value, label) { const el = node('option', label); el.value = value; select.append(el); }
function renderModels() {
  const provider = $('nativeProvider'), model = $('nativeModelId'), effort = $('nativeEffort');
  const unavailable = modelCatalog ? '不可用' : '尚未读取';
  provider.replaceChildren(); option(provider, '', '跟随 DSH 默认');
  for (const group of modelCatalog?.groups ?? []) option(provider, group.id, `${group.name} (${group.id})`);
  const group = modelCatalog?.groups.find(group => group.id === nativeModelDraft?.provider);
  if (nativeModelDraft && !group) option(provider, nativeModelDraft.provider, `${nativeModelDraft.provider} · ${unavailable}`);
  provider.value = nativeModelDraft?.provider ?? '';

  model.replaceChildren(); model.disabled = !nativeModelDraft;
  for (const item of group?.models ?? []) option(model, item.id, `${item.name} (${item.id})`);
  const selected = group?.models.find(item => item.id === nativeModelDraft?.model);
  if (nativeModelDraft && !selected) option(model, nativeModelDraft.model, `${nativeModelDraft.model} · ${unavailable}`);
  if (nativeModelDraft) model.value = nativeModelDraft.model;

  const supportsEffort = id => selected?.reasoning?.efforts.some(item => item.id === id);
  effort.replaceChildren(); option(effort, '', '使用模型默认');
  for (const item of selected?.reasoning?.efforts ?? []) option(effort, item.id, item.name);
  if (nativeModelDraft?.reasoningEffort && !supportsEffort(nativeModelDraft.reasoningEffort))
    option(effort, nativeModelDraft.reasoningEffort, `${nativeModelDraft.reasoningEffort} · ${modelCatalog ? '不支持' : '尚未读取'}`);
  effort.value = nativeModelDraft?.reasoningEffort ?? '';
  effort.disabled = !nativeModelDraft || !selected;

  if (modelCatalog) {
    const invalid = nativeModelDraft && (!selected || nativeModelDraft.reasoningEffort && !supportsEffort(nativeModelDraft.reasoningEffort));
    const notice = invalid ? '已保存的选择当前不可用，请重新选择；不会自动替换。' : !modelCatalog.groups.length ? '没有可用模型，请在 DSH 配置供应商。' : '';
    $('dsh-model-status').textContent = `DSH 默认：${modelKey(modelCatalog.default)}。${notice}${modelCatalog.failures.map(item => `${item.name}：${item.message}`).join(' ')}`;
  }
}
function selectNativeModel(provider, model) {
  const info = modelCatalog?.groups.find(group => group.id === provider)?.models.find(item => item.id === model);
  const preferred = info?.reasoning?.efforts.some(item => item.id === 'max') ? 'max' : info?.reasoning?.defaultEffort;
  nativeModelDraft = {provider, model, ...preferred ? {reasoningEffort:preferred} : {}};
  renderModels();
}
function clearModelCatalog() { modelCatalog = undefined; renderModels(); $('dsh-model-status').textContent = 'DSH 路径已变更，请重新读取模型。'; }
$('nativeProvider').addEventListener('change', () => {
  const provider = $('nativeProvider').value, group = modelCatalog?.groups.find(group => group.id === provider);
  if (!provider) { nativeModelDraft = null; renderModels(); }
  else if (group?.models.length) selectNativeModel(provider, group.models[0].id);
});
$('nativeModelId').addEventListener('change', () => selectNativeModel($('nativeProvider').value, $('nativeModelId').value));
$('nativeEffort').addEventListener('change', () => {
  if (!nativeModelDraft) return;
  const value = $('nativeEffort').value;
  if (value) nativeModelDraft.reasoningEffort = value; else delete nativeModelDraft.reasoningEffort;
});
for (const id of ['dshPath', 'dshHome']) $(id).addEventListener('input', clearModelCatalog);
$('read-dsh-models').addEventListener('click', async () => {
  const button = $('read-dsh-models'), paths = {dshPath:$('dshPath').value.trim(), dshHome:$('dshHome').value.trim()};
  button.disabled = true; $('dsh-model-status').textContent = '正在读取 DSH 模型…';
  try {
    const catalog = await invoke('dshModels', paths);
    if (paths.dshPath !== $('dshPath').value.trim() || paths.dshHome !== $('dshHome').value.trim()) return;
    modelCatalog = catalog; renderModels();
  } catch { $('dsh-model-status').textContent = '读取失败，已保留模型选择。请检查 DSH 连接或升级对话连接插件后重试。'; }
  finally { button.disabled = false; }
});

/* ---------- forms & buttons ---------- */
document.querySelectorAll('.browse').forEach(el => el.addEventListener('click', async () => {
  try {
    const selected = await invoke('pick', el.dataset.kind);
    if (selected) { $(el.dataset.target).value = selected; if (['dshPath', 'dshHome'].includes(el.dataset.target)) clearModelCatalog(); }
  } catch {}
}));
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const settings = {...structuredClone(current.settings), executionMode:$('executionMode').value, dshPath:$('dshPath').value.trim(), dshHome:$('dshHome').value.trim(),
    timeoutMinutes:Number($('timeoutMinutes').value), nativeModel:structuredClone(nativeModelDraft)};
  try { current = await invoke('saveSettings', {settings}); renderState(); toast('设置已保存'); } catch {}
});
$('install-codex').addEventListener('click', async () => {
  $('install-codex').disabled = true;
  try { toast(await invoke('installCodex')); await refresh(); } catch {}
  finally { $('install-codex').disabled = false; }
});
$('install-dsh-observer').addEventListener('click', async () => {
  $('install-dsh-observer').disabled = true;
  try { toast(await invoke('installDshObserver')); } catch {}
  finally { $('install-dsh-observer').disabled = false; }
});
$('copy-config').addEventListener('click', async () => { try { toast(await invoke('copyIntegration')); } catch {} });
$('resume-dialog').addEventListener('close', async () => {
  if ($('resume-dialog').returnValue !== 'confirm') return;
  const instruction = $('resume-instruction').value.trim();
  if (instruction.length < 10) { toast('请填写至少十个字符的明确恢复要求。', true); return; }
  try { await invoke('resume', {taskId:$('resume-dialog').dataset.taskId, instruction}); await refresh(); } catch {}
});

setPage(page);
await refresh(); setInterval(refresh, 1500);