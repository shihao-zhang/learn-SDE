import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class BusinessError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const copy = value => structuredClone(value);
const caseIds = ['normal', 'missing-evidence', 'no-permission'];
export class World {
  constructor(root, dataDir = join(root, 'data', 'runs')) {
    this.root = root; this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }
  case(id) {
    if (!caseIds.includes(id)) throw new BusinessError('场景不存在', 404);
    return JSON.parse(readFileSync(join(this.root, 'cases', `${id}.json`), 'utf8'));
  }
  cases() { return caseIds.map(id => { const { initial_state, ...metadata } = this.case(id); return metadata; }); }
  policy() { return JSON.parse(readFileSync(join(this.root, 'cases', 'policy.json'), 'utf8')); }
  path(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new BusinessError('运行编号无效', 404);
    return join(this.dataDir, `${id}.json`);
  }
  read(id) {
    const file = this.path(id);
    if (!existsSync(file)) throw new BusinessError('运行不存在', 404);
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  save(run) {
    const file = this.path(run.id), temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(run, null, 2)); renameSync(temporary, file);
    return copy(run);
  }
  list() { return readdirSync(this.dataDir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => this.read(f.slice(0, -5))).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ id, case_id, title, status, created_at }) => ({ id, case_id, title, status, created_at })); }
  create(caseId) {
    const scenario = this.case(caseId);
    return this.save({ schema_version: 1, id: randomUUID(), case_id: caseId, title: scenario.title,
      task_instruction: scenario.task_instruction, policy_id: scenario.policy_id, status: 'active',
      created_at: new Date().toISOString(), initial_state: copy(scenario.initial_state),
      state: copy(scenario.initial_state), actions: [] });
  }
  log(run, action, input, executor, result, detail) {
    run.actions.push({ sequence: run.actions.length + 1, at: new Date().toISOString(),
      actor_id: run.state.actor.id, executor, action, input: copy(input), result, detail });
  }
  archive(id) {
    const run = this.read(id);
    if (run.status === 'archived') return run;
    run.status = 'archived'; run.archived_at = new Date().toISOString();
    this.log(run, 'archive_run', {}, 'human', 'applied', '本次运行已归档，后续业务动作将被拒绝');
    return this.save(run);
  }
  action(id, name, input = {}, executor = 'human') {
    const run = this.read(id);
    try {
      if (run.status !== 'active') throw new BusinessError('运行已归档，不能继续写入', 409);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BusinessError('动作参数必须为对象');
      const state = run.state;
      if (name === 'create_draft') {
        if (!state.actor.can_create_draft) throw new BusinessError('当前操作者没有创建草案权限', 403);
        const order = state.orders.find(item => item.id === input.order_id);
        if (input.request_id !== state.request.id || input.order_id !== state.request.order_id || !order || order.status !== 'paid') throw new BusinessError('只能处理当前申请对应的已付款订单');
        if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0 || input.amount_cents > order.paid_amount_cents - order.refunded_amount_cents) throw new BusinessError('金额须为整数分、大于零且不超过可退金额');
        if (state.drafts.length) throw new BusinessError('本练习已创建草案，请查看现有草案或重新初始化', 409);
        const draft = { id: `draft-${randomUUID()}`, request_id: input.request_id, order_id: input.order_id, amount_cents: input.amount_cents, status: 'pending_approval' };
        // 凭证是否充分属于业务判断，故意不在工具层替执行者裁决。
        state.drafts.push(draft);
        this.log(run, name, input, executor, 'applied', { draft_id: draft.id });
      } else if (name === 'update_ticket') {
        if (input.ticket_id !== state.ticket.id) throw new BusinessError('只能更新当前工单');
        if (!['pending_approval', 'waiting_evidence', 'needs_human_review'].includes(input.status)) throw new BusinessError('工单目标状态无效');
        const reason = input.reason ?? '';
        if (typeof reason !== 'string' || reason.length > 500) throw new BusinessError('处理原因须为不超过500字的文字');
        if (input.status !== 'pending_approval' && !reason.trim()) throw new BusinessError('等待补充材料或转人工复核时，必须填写处理原因');
        let draftId = null;
        if (input.status === 'pending_approval') {
          const draft = state.drafts.find(d => d.id === input.draft_id && d.request_id === state.request.id && d.order_id === state.request.order_id);
          if (!draft) throw new BusinessError('待审批工单必须关联本次运行中当前申请的草案');
          draftId = draft.id;
        } else if (input.draft_id != null && input.draft_id !== '') throw new BusinessError('非审批状态不能关联草案');
        Object.assign(state.ticket, { status: input.status, draft_id: draftId, reason: reason.trim() });
        this.log(run, name, input, executor, 'applied', { ticket_status: input.status });
      } else throw new BusinessError('不支持的业务动作');
      return this.save(run);
    } catch (error) {
      if (!(error instanceof BusinessError)) throw error;
      // 被拒绝的动作同样由服务端记证据；归档状态与业务数据保持不变。
      this.log(run, name, input, executor, 'rejected', error.message); this.save(run); throw error;
    }
  }
  demo(id) {
    let run = this.read(id);
    if (run.status !== 'active') throw new BusinessError('运行已归档，不能运行脚本', 409);
    const { request, actor, ticket } = run.state;
    const update = (status, reason, draft_id = null) => this.action(id, 'update_ticket', { ticket_id: ticket.id, status, reason, draft_id }, 'demo-script');
    if (!request.evidence_complete) return update('waiting_evidence', '申请凭证不齐，请补充材料后再核验');
    if (!actor.can_create_draft) return update('needs_human_review', '当前操作者没有创建草案权限，请有权限人员复核');
    run = this.action(id, 'create_draft', { request_id: request.id, order_id: request.order_id, amount_cents: request.requested_amount_cents }, 'demo-script');
    return update('pending_approval', '订单、金额、凭证和权限核验完成，仅提交审批草案', run.state.drafts[0].id);
  }
}
