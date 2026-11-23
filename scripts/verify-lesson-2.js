import test from 'node:test';
import assert from 'node:assert/strict';
import { page } from './page-fixture.js';

function displayedDraft(element) {
  const html = element('state-view').innerHTML;
  const row = html.match(/<span>关联草案编号<\/span>\s*<strong>([^<]*)<\/strong>/);
  return row?.[1].trim() ?? '（终态区没有关联草案编号行）';
}

test('正常路径：先建草案，再关联，复位后还能查看归档', async t => {
  const { world, element, click, load } = await page(t);
  element('case-select').value = 'normal';
  await click('initialize');
  const runId = element('run-select').value;
  const initial = displayedDraft(element);

  await click('create-draft');
  const unlinkedState = world.read(runId).state;
  assert.equal(unlinkedState.drafts.length, 1);
  assert.equal(unlinkedState.ticket.draft_id, null);
  assert.equal(element('draft-select').value, unlinkedState.drafts[0].id);
  const created = displayedDraft(element);

  await click('update-ticket');
  const linkedState = world.read(runId).state;
  const draftId = linkedState.ticket.draft_id;
  assert.equal(linkedState.ticket.status, 'pending_approval');
  assert.equal(draftId, unlinkedState.drafts[0].id);
  const linked = displayedDraft(element);

  await click('reset');
  const newRunId = element('run-select').value;
  assert.notEqual(newRunId, runId);
  assert.equal(world.read(newRunId).state.ticket.draft_id, null);
  const reset = displayedDraft(element);

  const archive = world.read(runId);
  assert.equal(archive.status, 'archived');
  await load(archive);
  const archived = displayedDraft(element);

  assert.deepEqual({ initial, created, linked, reset, archived }, {
    initial: '未关联',
    created: '未关联',
    linked: draftId,
    reset: '未关联',
    archived: draftId,
  });
});

for (const [caseId, status, statusLabel] of [
  ['missing-evidence', 'waiting_evidence', '等待补充材料'],
  ['no-permission', 'needs_human_review', '转人工复核'],
]) {
  test(`${statusLabel}：终态不显示关联编号`, async t => {
    const { world, element, click } = await page(t);
    element('case-select').value = caseId;
    await click('initialize');
    await click('demo');
    const state = world.read(element('run-select').value).state;
    assert.equal(state.ticket.status, status);
    assert.equal(state.ticket.draft_id, null);
    assert.equal(state.drafts.length, 0);
    assert.ok(element('state-view').innerHTML.includes(statusLabel));
    assert.equal(displayedDraft(element), '未关联');
  });
}
