const $ = id => document.getElementById(id);
let cases = [], policy, current, busy = false;
const money = cents => (cents / 100).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' });
const statusNames = { open: '尚未处理', pending_approval: '等待审批', waiting_evidence: '等待补充材料', needs_human_review: '转人工复核', active: '进行中', archived: '已归档' };
const actionNames = { create_draft: '创建退款草案', update_ticket: '更新工单', archive_run: '归档运行' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, data) {
  const res = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error || '请求失败'); return value;
}
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; }
function setBusy(value) { busy = value; document.querySelectorAll('button').forEach(button => button.disabled = value); if (!value && current?.status === 'archived') ['create-draft', 'update-ticket', 'demo'].forEach(id => $(id).disabled = true); }
async function task(fn) {
  if (busy) return; setBusy(true);
  try { await fn(); }
  catch (error) { message(error.message, true); if (current) { try { current = await api(`/api/runs/${current.id}`); render(); } catch {} } }
  finally { setBusy(false); }
}
async function history() {
  const runs = await api('/api/runs');
  $('run-select').innerHTML = '<option value="">选择历史运行</option>' + runs.map(run => `<option value="${run.id}">${escape(run.title)} · ${statusNames[run.status]} · ${escape(new Date(run.created_at).toLocaleString('zh-CN'))} · ${run.id.slice(0, 6)}</option>`).join('');
  if (current) $('run-select').value = current.id;
}
function expectation() {
  try { $('expectation').value = localStorage.getItem(`refund-expectation:${current.case_id}`) || ''; $('expectation-note').textContent = ''; }
  catch { $('expectation').value = ''; $('expectation-note').textContent = '浏览器未允许本地保存，当前文字仅保留在页面中。'; }
}
// 切换运行时用权威状态重置表单；新/未处理工单默认展示待审批的操作目标。
function syncOperationForm() {
  const { request, ticket, drafts } = current.state;
  $('amount').value = (request.requested_amount_cents / 100).toFixed(2);
  $('reason').value = ticket.reason ?? '';
  $('ticket-status').value = ticket.status === 'open' ? 'pending_approval' : ticket.status;
  $('draft-select').value = $('ticket-status').value === 'pending_approval' ? (ticket.draft_id || drafts[0]?.id || '') : '';
}
function render() {
  $('workspace').hidden = false;
  const state = current.state, order = state.orders.find(o => o.id === state.request.order_id);
  $('run-label').textContent = `${current.title} · ${statusNames[current.status]} · 运行 ${current.id.slice(0, 8)} · ${new Date(current.created_at).toLocaleString('zh-CN')}`;
  $('task').textContent = current.task_instruction;
  const facts = [['申请金额', money(state.request.requested_amount_cents)], ['当前可退', money(order.paid_amount_cents - order.refunded_amount_cents)], ['订单状态', order.status === 'paid' ? '已付款' : order.status], ['申请凭证', state.request.evidence_complete ? '齐全' : '缺少材料', !state.request.evidence_complete], ['操作者权限', state.actor.can_create_draft ? '可创建草案' : '没有创建权限', !state.actor.can_create_draft], ['业务边界', '不执行真实退款']];
  $('facts').innerHTML = facts.map(([title, value, alert]) => `<div class="fact ${alert ? 'alert' : ''}"><span>${title}</span><strong>${value}</strong></div>`).join('');
  $('rules').innerHTML = policy.rules.map(rule => `<li>${escape(rule.text)}</li>`).join('');
  $('raw-state').textContent = JSON.stringify(state, null, 2);
  const selectedDraft = $('draft-select').value;
  $('draft-select').innerHTML = '<option value="">不关联草案</option>' + state.drafts.map(draft => `<option value="${draft.id}">${money(draft.amount_cents)} · ${escape(draft.id.slice(0, 14))}</option>`).join('');
  $('draft-select').value = $('ticket-status').value === 'pending_approval' ? (state.drafts.some(draft => draft.id === selectedDraft) ? selectedDraft : state.drafts[0]?.id || '') : '';
  const rows = [['工单', statusNames[state.ticket.status]], ['草案数量', `${state.drafts.length} 份`], ['草案金额', state.drafts.map(draft => money(draft.amount_cents)).join('、') || '尚无草案'], ['订单已退款', money(order.refunded_amount_cents)], ['支付记录', `${state.payments.length} 笔（无支付写入工具）`]];
  const unchanged = JSON.stringify(state.orders) === JSON.stringify(current.initial_state.orders) && JSON.stringify(state.payments) === JSON.stringify(current.initial_state.payments);
  $('state-view').innerHTML = rows.map(([label, value]) => `<div class="state-row"><span>${label}</span><strong>${escape(value)}</strong></div>`).join('') + `<p class="state-note">处理原因：${escape(state.ticket.reason || '尚未填写')}<br>订单与支付记录：${unchanged ? '与初始化数据一致' : '存在变化，请检查原始数据'}。<br>该比较仅检查数据是否变化，未判定本次处理是否符合全部政策。</p>`;
  $('evidence').innerHTML = current.actions.length ? current.actions.map(action => `<article class="evidence-item ${action.result}"><h3>${action.sequence}. ${escape(actionNames[action.action] || action.action)} · ${action.result === 'applied' ? '已执行' : '被拒绝'}</h3><p>${escape(new Date(action.at).toLocaleTimeString('zh-CN'))} · ${action.executor === 'demo-script' ? '规则演示脚本' : '手动操作'} · 操作者 ${escape(action.actor_id)}</p><p>${escape(typeof action.detail === 'string' ? action.detail : JSON.stringify(action.detail))}</p><details><summary>展开动作参数与原始记录</summary><pre>${escape(JSON.stringify(action, null, 2))}</pre></details></article>`).join('') : '<p class="empty">还没有业务动作。先填写你的预期，再选择一条处理路径。</p>';
}
async function initialize(caseId) {
  current = await api('/api/runs', { case_id: caseId });
  render(); syncOperationForm(); expectation(); await history(); message('本场景已初始化。先写下你的预期，再选择手动处理或运行演示脚本。');
}
$('case-select').addEventListener('change', () => { $('case-description').textContent = cases.find(item => item.case_id === $('case-select').value)?.description || ''; });
$('initialize').addEventListener('click', () => task(() => initialize($('case-select').value)));
$('load-run').addEventListener('click', () => task(async () => {
  if (!$('run-select').value) throw new Error('请先选择一条历史运行');
  current = await api(`/api/runs/${$('run-select').value}`); $('case-select').value = current.case_id; $('case-select').dispatchEvent(new Event('change')); render(); syncOperationForm(); expectation(); message(current.status === 'archived' ? '已打开归档证据。可以导出或重新初始化，不能继续业务操作。' : '已恢复运行，可以继续观察或处理。');
}));
$('expectation').addEventListener('input', () => { try { localStorage.setItem(`refund-expectation:${current.case_id}`, $('expectation').value); $('expectation-note').textContent = '已保存到当前浏览器的当前访问地址；重要预期请同步到工作纸。'; } catch { $('expectation-note').textContent = '浏览器未允许本地保存，当前文字仅保留在页面中。'; } });
// 同一次手动操作后保留未提交的表单文字，方便继续处理或修改被拒绝的输入。
async function act(action, input) { current = await api(`/api/runs/${current.id}/actions`, { action, input }); render(); message('业务动作已执行。请检查终态与动作证据，它们不等于验收通过。'); }
$('create-draft').addEventListener('click', () => task(async () => {
  const text = $('amount').value;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('金额请填写大于零且最多两位小数的元数');
  await act('create_draft', { request_id: current.state.request.id, order_id: current.state.request.order_id, amount_cents: Math.round(Number(text) * 100) });
}));
$('ticket-status').addEventListener('change', () => { if ($('ticket-status').value !== 'pending_approval') $('draft-select').value = ''; else if (current?.state.drafts.length) $('draft-select').value = current.state.drafts[0].id; });
$('update-ticket').addEventListener('click', () => task(() => act('update_ticket', { ticket_id: current.state.ticket.id, status: $('ticket-status').value, reason: $('reason').value, draft_id: $('draft-select').value || null })));
$('demo').addEventListener('click', () => task(async () => { current = await api(`/api/runs/${current.id}/demo`, {}); render(); syncOperationForm(); message('规则演示脚本已完成。请对照你的预期检查工单、草案与保留不变的数据。'); }));
$('reset').addEventListener('click', () => task(async () => { const caseId = current.case_id; await api(`/api/runs/${current.id}/archive`, {}); await initialize(caseId); message('旧运行已归档并保留，新运行已创建。可从历史运行查看旧证据。'); }));
$('export').addEventListener('click', () => { const link = document.createElement('a'); link.href = `/api/runs/${current.id}/export`; link.download = `run-${current.id}.json`; link.click(); message('已请求下载当前运行证据。导出包含初始数据、当前状态和服务端动作日志，不含自动验收判定。'); });
await task(async () => {
  [cases, policy] = await Promise.all([api('/api/cases'), api('/api/policy')]);
  $('case-select').innerHTML = cases.map(item => `<option value="${item.case_id}">${escape(item.title)}</option>`).join('');
  $('case-select').dispatchEvent(new Event('change')); await history(); message('请选择一个场景，点击“初始化本场景”开始。已有练习可从历史运行恢复。');
});
