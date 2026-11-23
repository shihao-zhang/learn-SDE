import test from 'node:test';
import assert from 'node:assert/strict';
import { page } from '../scripts/page-fixture.js';

test('恢复历史运行后金额、原因、状态和草案均来自该运行，不能串用旧表单', async t => {
  const { world, element: $, load } = await page(t);
  const normal = world.create('normal'), stopped = world.demo(world.create('missing-evidence').id);
  await load(stopped);
  assert.equal($('ticket-status').value, 'waiting_evidence', $('message').textContent); assert.equal($('reason').value, stopped.state.ticket.reason); assert.equal($('draft-select').value, '');
  $('amount').value = '123.45'; $('reason').value = '不能带到下一运行'; $('ticket-status').value = 'needs_human_review';
  await load(normal);
  assert.equal($('amount').value, '80.00', $('message').textContent); assert.equal($('reason').value, ''); assert.equal($('ticket-status').value, 'pending_approval'); assert.equal($('draft-select').value, '');
  const approved = world.demo(normal.id); await load(approved);
  assert.equal($('reason').value, approved.state.ticket.reason); assert.equal($('draft-select').value, approved.state.ticket.draft_id);
  await load(stopped); assert.equal($('draft-select').value, ''); assert.equal($('reason').value, stopped.state.ticket.reason);
});
test('初始化重置旧值；手动动作保留在写内容；演示完成同步实际工单', async t => {
  const { world, element: $, click, load } = await page(t);
  $('case-select').value = 'normal'; $('amount').value = '9'; $('reason').value = '旧场景'; $('ticket-status').value = 'waiting_evidence';
  await click('initialize'); assert.equal($('amount').value, '80.00'); assert.equal($('reason').value, ''); assert.equal($('ticket-status').value, 'pending_approval');
  $('amount').value = '70'; $('reason').value = '正在写的判断'; await click('create-draft');
  assert.equal($('amount').value, '70'); assert.equal($('reason').value, '正在写的判断'); assert.ok($('draft-select').value.startsWith('draft-'));
  const missing = world.create('missing-evidence'); await load(missing); $('reason').value = '未提交文字'; await click('demo');
  assert.equal($('ticket-status').value, 'waiting_evidence'); assert.equal($('reason').value, world.read(missing.id).state.ticket.reason); assert.equal($('draft-select').value, '');
});
