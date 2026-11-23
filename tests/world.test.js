import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../app/world.js';
const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'refund-world-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return new World(root, dir); }
const draftInput = run => ({ request_id: run.state.request.id, order_id: run.state.request.order_id, amount_cents: 8000 });
for (const [caseId, status, count] of [['normal', 'pending_approval', 1], ['missing-evidence', 'waiting_evidence', 0], ['no-permission', 'needs_human_review', 0]]) {
  test(`规则演示：${caseId}产生预期终态且不修改订单和支付`, t => {
    const world = fixture(t), initial = world.create(caseId), run = world.demo(initial.id);
    assert.equal(run.state.ticket.status, status); assert.equal(run.state.drafts.length, count);
    assert.deepEqual(run.state.orders, initial.state.orders); assert.deepEqual(run.state.payments, initial.state.payments);
    assert.ok(run.actions.every(a => a.executor === 'demo-script' && a.result === 'applied'));
    if (count) { const draft = run.state.drafts[0]; assert.equal(draft.amount_cents, 8000); assert.equal(draft.status, 'pending_approval'); assert.equal(run.state.ticket.draft_id, draft.id); }
    else { assert.equal(run.state.ticket.draft_id, null); assert.ok(run.state.ticket.reason); }
  });
}
test('权限使用服务端actor，伪造参数无法越权；拒绝保留证据', t => {
  const world = fixture(t), run = world.create('no-permission');
  assert.throws(() => world.action(run.id, 'create_draft', { ...draftInput(run), actor: { can_create_draft: true } }), /没有创建草案权限/);
  const after = world.read(run.id); assert.deepEqual(after.state, run.state); assert.equal(after.actions[0].result, 'rejected'); assert.equal(after.actions[0].actor_id, 'actor-001');
});
test('缺凭证的错误业务路径可以执行和观察，不产生虚假通过', t => {
  const world = fixture(t), run = world.create('missing-evidence');
  const afterDraft = world.action(run.id, 'create_draft', draftInput(run));
  const after = world.action(run.id, 'update_ticket', { ticket_id: run.state.ticket.id, status: 'pending_approval', draft_id: afterDraft.state.drafts[0].id, reason: '练习：未检查凭证就提交' });
  assert.equal(after.state.request.evidence_complete, false); assert.equal(after.state.ticket.status, 'pending_approval'); assert.equal(after.state.drafts.length, 1); assert.equal(after.actions.length, 2);
  assert.equal('pass' in after, false); assert.equal('score' in after, false); assert.deepEqual(after.state.orders, run.state.orders); assert.deepEqual(after.state.payments, run.state.payments);
});
test('对象、金额与工单引用由动作层验证', t => {
  const world = fixture(t), run = world.create('normal');
  for (const input of [{ ...draftInput(run), order_id: 'ord-002' }, { ...draftInput(run), amount_cents: 0 }, { ...draftInput(run), amount_cents: 20001 }, { ...draftInput(run), amount_cents: 1.5 }, { ...draftInput(run), request_id: 'wrong' }]) assert.throws(() => world.action(run.id, 'create_draft', input));
  assert.throws(() => world.action(run.id, 'update_ticket', { ticket_id: 'ticket-001', status: 'pending_approval', draft_id: 'nonexistent', reason: '测试' }), /关联/);
  assert.throws(() => world.action(run.id, 'update_ticket', { ticket_id: 'other', status: 'waiting_evidence', reason: '测试' }), /当前工单/);
  assert.throws(() => world.action(run.id, 'update_ticket', { ticket_id: 'ticket-001', status: 'paid', reason: '测试' }), /状态无效/);
  assert.deepEqual(world.read(run.id).state, run.state);
});
test('运行隔离，归档拒绝迟到动作，新运行不受旧动作影响且重启可读', t => {
  const world = fixture(t), old = world.create('normal'), next = world.create('normal');
  world.action(old.id, 'create_draft', draftInput(old)); assert.equal(world.read(next.id).state.drafts.length, 0);
  world.archive(old.id);
  assert.throws(() => world.action(old.id, 'update_ticket', { ticket_id: 'ticket-001', status: 'waiting_evidence', reason: '迟到动作' }), /已归档/);
  assert.throws(() => world.demo(old.id), /已归档/);
  assert.deepEqual(world.read(next.id).state, next.initial_state);
  assert.equal(world.read(old.id).status, 'archived'); assert.equal(world.read(old.id).state.drafts.length, 1);
  const restarted = new World(root, world.dataDir); assert.deepEqual(restarted.read(old.id), world.read(old.id)); assert.equal(restarted.list().length, 2);
});
test('处理原因遵循参考：正常审批可空，两个停止分支必须说明原因', t => {
  const world = fixture(t), run = world.create('normal');
  const created = world.action(run.id, 'create_draft', draftInput(run));
  const approval = { ticket_id: run.state.ticket.id, status: 'pending_approval', draft_id: created.state.drafts[0].id };
  for (const reason of ['', '   ', null, undefined]) {
    const after = world.action(run.id, 'update_ticket', { ...approval, reason });
    assert.equal(after.state.ticket.status, 'pending_approval'); assert.equal(after.state.ticket.reason, '');
  }
  assert.throws(() => world.action(run.id, 'update_ticket', { ...approval, reason: '长'.repeat(501) }), /500字/);
  for (const [caseId, status] of [['missing-evidence', 'waiting_evidence'], ['no-permission', 'needs_human_review']]) {
    const stopped = world.create(caseId), input = { ticket_id: stopped.state.ticket.id, status, draft_id: null };
    for (const reason of ['', '   ', null, undefined]) assert.throws(() => world.action(stopped.id, 'update_ticket', { ...input, reason }), /必须填写处理原因/);
    assert.throws(() => world.action(stopped.id, 'update_ticket', { ...input, reason: '长'.repeat(501) }), /500字/);
    assert.equal(world.action(stopped.id, 'update_ticket', { ...input, reason: '明确业务停止原因' }).state.ticket.status, status);
  }
});
