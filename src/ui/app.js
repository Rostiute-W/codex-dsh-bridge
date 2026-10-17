const $ = id => document.getElementById(id);
const labels = {queued:'排队中',preparing:'准备工作区',running:'DSH 执行中',awaiting_permission:'等待权限',validating:'验证中',awaiting_review:'等待审查',review_running:'API 审查中',needs_changes:'需要修改',committing:'提交中',completed:'已完成',failed:'失败',cancelled:'已取消',needs_attention:'待处理'};
let current, selectedId, page = 'tasks', settingsLoaded = false, refreshing = false;
const detailViews = new Map();
let modelCatalog, nativeModelDraft = null;
const modelKey = selection => selection ? `${selection.provider} / ${selection.model}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''}` : '跟随 DSH 默认';
function option(select, value, label) { const el = node('option', label); el.value = value; select.append(el); }
function renderModels() {
  const provider=$('nativeProvider'), model=$('nativeModelId'), effort=$('nativeEffort');
  provider.replaceChildren(); option(provider,'','跟随 DSH 默认');
  for(const group of modelCatalog?.groups ?? [])option(provider,group.id,`${group.name} (${group.id})`);
  const group=modelCatalog?.groups.find(group=>group.id===nativeModelDraft?.provider);
  if(nativeModelDraft&&!group)option(provider,nativeModelDraft.provider,`${nativeModelDraft.provider} · ${modelCatalog?'不可用':'尚未读取'}`);
  provider.value=nativeModelDraft?.provider ?? '';
  model.replaceChildren(); model.disabled=!nativeModelDraft;
  for(const item of group?.models ?? [])option(model,item.id,`${item.name} (${item.id})`);
  const selected=group?.models.find(item=>item.id===nativeModelDraft?.model);
  if(nativeModelDraft&&!selected)option(model,nativeModelDraft.model,`${nativeModelDraft.model} · ${modelCatalog?'不可用':'尚未读取'}`);
  if(nativeModelDraft)model.value=nativeModelDraft.model;
  effort.replaceChildren(); option(effort,'','使用模型默认');
  for(const item of selected?.reasoning?.efforts ?? [])option(effort,item.id,item.name);
  if(nativeModelDraft?.reasoningEffort&&!selected?.reasoning?.efforts.some(item=>item.id===nativeModelDraft.reasoningEffort))
    option(effort,nativeModelDraft.reasoningEffort,`${nativeModelDraft.reasoningEffort} · ${modelCatalog?'不支持':'尚未读取'}`);
  effort.value=nativeModelDraft?.reasoningEffort ?? '';
  effort.disabled=!nativeModelDraft || !selected;
  if(modelCatalog) {
    const invalid=nativeModelDraft&&(!selected || nativeModelDraft.reasoningEffort&&!selected.reasoning?.efforts.some(item=>item.id===nativeModelDraft.reasoningEffort));
    $('dsh-model-status').textContent=`DSH 默认：${modelKey(modelCatalog.default)}。${invalid?'已保存的选择当前不可用，请重新选择；不会自动替换。':!modelCatalog.groups.length?'没有可用模型，请在 DSH 配置供应商。':''}${modelCatalog.failures.map(item=>`${item.name}：${item.message}`).join(' ')}`;
  }
}
function selectNativeModel(provider, model) {
  const info=modelCatalog?.groups.find(group=>group.id===provider)?.models.find(item=>item.id===model);
  const preferred=info?.reasoning?.efforts.some(item=>item.id==='max')?'max':info?.reasoning?.defaultEffort;
  nativeModelDraft={provider,model,...preferred?{reasoningEffort:preferred}:{}};
  renderModels();
}
$('nativeProvider').addEventListener('change',()=>{
  const provider=$('nativeProvider').value, group=modelCatalog?.groups.find(group=>group.id===provider);
  if(!provider){nativeModelDraft=null;renderModels();}
  else if(group?.models.length)selectNativeModel(provider,group.models[0].id);
});
$('nativeModelId').addEventListener('change',()=>selectNativeModel($('nativeProvider').value,$('nativeModelId').value));
$('nativeEffort').addEventListener('change',()=>{
  if(!nativeModelDraft)return;
  const value=$('nativeEffort').value;
  if(value)nativeModelDraft.reasoningEffort=value;else delete nativeModelDraft.reasoningEffort;
});
function clearModelCatalog() { modelCatalog=undefined; renderModels(); $('dsh-model-status').textContent='DSH 路径已变更，请重新读取模型。'; }
for(const id of ['dshPath','dshHome'])$(id).addEventListener('input',clearModelCatalog);
$('read-dsh-models').addEventListener('click',async()=>{
  const button=$('read-dsh-models'), paths={dshPath:$('dshPath').value.trim(),dshHome:$('dshHome').value.trim()};
  button.disabled=true;$('dsh-model-status').textContent='正在读取 DSH 模型…';
  try {
    const catalog=await invoke('dshModels',paths);
    if(paths.dshPath!==$('dshPath').value.trim()||paths.dshHome!==$('dshHome').value.trim())return;
    modelCatalog=catalog;renderModels();
  } catch {$('dsh-model-status').textContent='读取失败，已保留模型选择。请检查 DSH 连接或升级对话连接插件后重试。';}
  finally {button.disabled=false;}
});
function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
function toast(text, error = false) { $('toast').textContent = String(text).replace(/^Error invoking remote method '[^']+': Error: /, ''); $('toast').className = `toast${error ? ' error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.add('hidden'), error ? 10000 : 6000); }
async function invoke(method, params) { try { return await window.bridge.invoke(method, params); } catch (error) { toast(error.message, true); throw error; } }
function setPage(name) { page = name; document.querySelectorAll('.page').forEach(el => el.classList.toggle('hidden', el.id !== `${name}-page`)); document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('selected', el.dataset.page === name)); $('page-title').textContent = {tasks:'任务协作',integration:'Codex 接入',settings:'运行设置'}[name]; }
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => setPage(el.dataset.page)));
$('empty-connect').addEventListener('click', () => setPage('integration'));
function color(status) { return ['completed','awaiting_review'].includes(status) ? 'green' : ['needs_attention','needs_changes','awaiting_permission'].includes(status) ? 'amber' : ['failed','cancelled'].includes(status) ? 'red' : ''; }
function badge(status) { return node('span', labels[status] ?? status, `badge ${color(status)}`); }
function date(text) { return new Date(text).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function elapsed(task) { const active = ['queued','preparing','running','awaiting_permission','validating','review_running','committing'].includes(task.status); const seconds = Math.max(0,Math.floor(((active ? Date.now() : Date.parse(task.updatedAt)) - Date.parse(task.createdAt))/1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`; }
function taskTitle(task) { return task.handoff.title.includes('\uFFFD') ? `旧版标题编码损坏 · ${task.id.slice(0,8)}` : task.handoff.title; }
function button(label, method, task, disabled = false, cls = 'secondary') { const el = node('button', label, cls); el.disabled = disabled; el.addEventListener('click', async () => { el.disabled = true; try { const result = await invoke(method, {taskId:task.id}); if (typeof result === 'string') toast(result); await refresh(); } catch {} finally { el.disabled = disabled; } }); return el; }
function section(parent, title) { parent.append(node('div', title, 'section-title')); }
function renderDetail(task) {
  const panel = $('detail'); const oldLog = panel.querySelector('.logs'); const scroll = oldLog?.scrollTop ?? 0; const follow = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40;
  if (panel.dataset.taskId) detailViews.set(panel.dataset.taskId, Object.fromEntries([...panel.querySelectorAll('details')].map(el => [el.dataset.section, {open:el.open,scroll:el.querySelector('pre')?.scrollTop ?? 0}])));
  const view = detailViews.get(task.id); panel.dataset.taskId = task.id;
  panel.replaceChildren();
  const head = node('div', undefined, 'detail-head'), left = node('div'); left.append(node('h2', taskTitle(task)), node('small', `创建于 ${date(task.createdAt)} · 返工 ${task.round}/2`)); head.append(left, badge(task.status)); panel.append(head);
  const timeline = node('div', undefined, 'timeline');
  const ranks = {queued:0,preparing:0,running:1,awaiting_permission:1,validating:2,awaiting_review:3,review_running:3,needs_changes:3,committing:4,completed:5};
  ['交接','执行','验证','审查','提交'].forEach((text, index) => timeline.append(node('span', text, index <= (ranks[task.status] ?? -1) ? 'done' : ''))); panel.append(timeline);
  const actions = node('div', undefined, 'actions');
  actions.append(button('复制任务 ID', 'copyTaskId', task), button('打开工作区', 'openWorktree', task, !task.worktree));
  if(task.executor==='desktop')actions.append(button('打开 DSH 对话','openDshChat',task,!task.sessionId));
  if (task.status === 'needs_changes' && task.review) actions.append(button('交给 DSH 修复', 'revise', task, task.round >= 2, 'primary'));
  if (['needs_attention','cancelled','needs_changes'].includes(task.status)) {
    const resume = node('button', '明确恢复', 'secondary'); resume.disabled = current.busy;
    resume.addEventListener('click', () => { $('resume-dialog').dataset.taskId = task.id; $('resume-instruction').value = ''; $('resume-dialog').showModal(); }); actions.append(resume);
  }
  if (['needs_attention','awaiting_review','needs_changes','cancelled'].includes(task.status) && task.worktree) actions.append(button('重新验证', 'revalidate', task, current.busy));
  if (['queued','preparing','running','validating','review_running','awaiting_permission'].includes(task.status)) actions.append(button('取消执行', 'cancel', task, false, 'danger'));
  panel.append(actions);
  if (task.error) panel.append(node('div', task.error, 'error-box'));
  if (task.permission) {
    const box = node('div', undefined, 'permission-box'); box.append(node('strong', task.permission.title), node('p', '此请求需要你判断额外权限。允许仅对本次请求生效。'), node('pre', task.permission.detail));
    for (const option of task.permission.options) { const el = node('button', option.name, option.kind === 'allow_once' ? 'primary' : 'secondary'); el.addEventListener('click', async () => { el.disabled = true; try { await invoke('permission', {taskId:task.id,permissionId:task.permission.id,optionId:option.id}); await refresh(); } catch {} }); box.append(el); }
    const reject = node('button','取消权限请求','secondary'); reject.addEventListener('click', async () => { try { await invoke('permission', {taskId:task.id,permissionId:task.permission.id,optionId:null}); await refresh(); } catch {} }); box.append(reject); panel.append(box);
  }
  section(panel, '工作现场'); panel.append(node('div', task.worktree ?? '将在任务启动后创建独立 Git worktree', 'path'));
  if (task.branch) panel.append(node('div', `分支 ${task.branch} · 基准 ${task.handoff.baseCommit.slice(0,12)}`, 'path'));
  if(task.executor==='desktop')panel.append(node('p',`执行与方向引导在 DSH 原生聊天中完成。权限请在 DSH 处理。${task.sessionId ? ' 会话：'+task.sessionId : ''}`,'muted'));
  if(task.executor==='desktop')panel.append(node('p',`任务初始模型：${modelKey(task.nativeModel)}。后续手动切换以 DSH 对话为准。`,'muted'));
  const spec = node('details'); spec.dataset.section='handoff'; spec.append(node('summary','查看交接方案'), node('pre', JSON.stringify(task.handoff, null, 2))); panel.append(spec);
  if (task.changedFiles.length) { section(panel,'代码变更'); panel.append(node('pre',task.changedFiles.join('\n'))); }
  if (task.checks.length) {
    section(panel,'验证记录'); for (const check of task.checks) { const box = node('div', undefined, 'check'); box.append(node('span',check.exitCode === 0 ? '通过' : `失败 · ${check.exitCode}`,`badge ${check.exitCode === 0 ? 'green' : 'red'}`),node('strong',check.command)); if (check.output) box.append(node('pre',check.output)); panel.append(box); }
  }
  if (task.review) { section(panel,`审查报告 · ${task.reviewSource === 'api' ? '付费 API' : 'Codex'}`); panel.append(node('div',task.review.summary,'review-summary')); const list = node('ul'); task.review.issues.forEach(issue => list.append(node('li',issue))); if (task.review.issues.length) panel.append(list); if (task.apiUsage) panel.append(node('pre',JSON.stringify(task.apiUsage,null,2))); }
  if (task.commit) { section(panel,'本地 Git 提交'); panel.append(node('div',task.commit,'commit'), node('div',task.handoff.commitMessage,'path'),node('div',task.commitStatus ? `剩余修改：${task.commitStatus}` : '工作区干净 · 未推送','path')); }
  if(task.executor!=='desktop') {
    if (task.summary) { const summary = node('details'); summary.dataset.section='summary'; summary.append(node('summary','查看旧版 ACP 执行总结'),node('pre',task.summary)); panel.append(summary); }
    const history=node('details');history.dataset.section='history';history.append(node('summary','旧版执行记录'));const logs=node('pre',task.log.map(line=>`[${new Date(line.at).toLocaleTimeString('zh-CN')}] ${line.kind}\n${line.text}`).join('\n\n'),'logs');history.append(logs);panel.append(history);logs.scrollTop=follow?logs.scrollHeight:scroll;
  }
  panel.querySelectorAll('details').forEach(el => { const saved=view?.[el.dataset.section]; if(saved){el.open=saved.open;const pre=el.querySelector('pre');if(pre&&!pre.classList.contains('logs'))pre.scrollTop=saved.scroll;} });
}
function renderState() {
  const tasks = current.tasks;
  $('task-count').textContent = tasks.length; $('total').textContent = tasks.length;
  $('running').textContent = tasks.filter(t => ['preparing','running','validating','review_running','committing'].includes(t.status)).length;
  $('review-count').textContent = tasks.filter(t => t.status === 'awaiting_review').length; $('complete-count').textContent = tasks.filter(t => t.status === 'completed').length;
  $('empty').classList.toggle('hidden', tasks.length > 0); $('task-workspace').classList.toggle('hidden', tasks.length === 0);
  $('version').textContent = `v${current.version} · Windows`; $('service-status').textContent = current.serviceError ? '服务需要检查' : '本地服务运行中';
  const connection = current.registration?.status === 'registered' && current.mcpLastCall ? `Codex 最近调用 · ${date(current.mcpLastCall)}` : current.registration?.message ?? '正在检查 Codex 配置';
  $('connection-state').textContent = connection; $('registration-state').textContent = connection;
  $('install-codex').textContent = current.registration?.status === 'registered' ? '检查接入 / 安装 Skill' : '安装到 Codex';
  if (!tasks.some(t => t.id === selectedId)) selectedId = tasks[0]?.id;
  $('task-list').replaceChildren();
  tasks.forEach(task => { const el = node('button',undefined,`task-item ${task.id === selectedId ? 'active' : ''}`); el.append(node('h4',taskTitle(task))); const meta = node('div',undefined,'task-meta'); meta.append(badge(task.status),node('small',elapsed(task))); el.append(meta); if (task.commit) el.append(node('small',`提交 ${task.commit.slice(0,10)}`)); el.addEventListener('click',() => { selectedId = task.id; renderState(); }); $('task-list').append(el); });
  const selected = tasks.find(t => t.id === selectedId); if (selected) renderDetail(selected);
  $('mcp-config').textContent = current.integration;
  $('data-root').textContent = `本地数据：${current.dataRoot}`;
  if (!settingsLoaded) { for (const [key,value] of Object.entries(current.settings)) if ($(key)) $(key).value = value; nativeModelDraft=structuredClone(current.settings.nativeModel ?? null);renderModels();settingsLoaded = true; }
}
async function refresh() { if (refreshing) return; refreshing = true; try { current = await window.bridge.invoke('state'); renderState(); } catch (error) { toast(error.message,true); } finally { refreshing = false; } }
document.querySelectorAll('.browse').forEach(el => el.addEventListener('click',async () => { try { const selected = await invoke('pick',el.dataset.kind); if (selected) {$(el.dataset.target).value = selected;if(['dshPath','dshHome'].includes(el.dataset.target))clearModelCatalog();} } catch {} }));
$('settings-form').addEventListener('submit',async event => { event.preventDefault(); const settings = {...structuredClone(current.settings),executionMode:$('executionMode').value,dshPath:$('dshPath').value.trim(),dshHome:$('dshHome').value.trim(),timeoutMinutes:Number($('timeoutMinutes').value),nativeModel:structuredClone(nativeModelDraft)}; try { current = await invoke('saveSettings',{settings}); renderState(); toast('设置已保存'); } catch {} });
$('install-codex').addEventListener('click',async () => { $('install-codex').disabled = true; try { toast(await invoke('installCodex')); await refresh(); } catch {} finally { $('install-codex').disabled = false; } });
$('install-dsh-observer').addEventListener('click',async () => { $('install-dsh-observer').disabled = true; try { toast(await invoke('installDshObserver')); } catch {} finally { $('install-dsh-observer').disabled = false; } });
$('copy-config').addEventListener('click',async () => { try { toast(await invoke('copyIntegration')); } catch {} });
$('resume-dialog').addEventListener('close',async () => { if ($('resume-dialog').returnValue !== 'confirm') return; const instruction = $('resume-instruction').value.trim(); if (instruction.length < 10) { toast('请填写至少十个字符的明确恢复要求。',true); return; } try { await invoke('resume',{taskId:$('resume-dialog').dataset.taskId,instruction}); await refresh(); } catch {} });
await refresh(); setInterval(refresh,1500);
