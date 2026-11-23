// 规则演示通过页面手动操作使用的同一业务动作层执行。
import { World } from '../app/world.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const world = new World(root);
const run = world.create(process.argv[2] || 'normal');
const result = world.demo(run.id);
console.log(JSON.stringify({ run_id: result.id, case_id: result.case_id, ticket: result.state.ticket, drafts: result.state.drafts, evidence_file: `data/runs/${run.id}.json`, note: '仅输出业务终态，没有独立自动验收判定。' }, null, 2));
