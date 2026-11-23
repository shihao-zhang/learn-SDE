import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { World } from '../app/world.js';
const root = fileURLToPath(new URL('../', import.meta.url));
// 执行实际页面事件代码；DOM替身只提供本测试需要的表单与事件行为。
export async function page(t) {
  const dir = mkdtempSync(join(tmpdir(), 'refund-form-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world = new World(root, dir), elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, dispatchEvent(event) { return this.listeners[event.type]?.(event); } });
    return elements.get(id);
  }
  const fetch = async (path, options) => {
    const isPost = options?.method === 'POST';
    const data = isPost ? JSON.parse(options.body) : undefined;
    let value;
    if (path === '/api/cases') value = world.cases();
    else if (path === '/api/policy') value = world.policy();
    else if (path === '/api/runs') value = isPost ? world.create(data.case_id) : world.list();
    else {
      const [, id, route] = path.match(/^\/api\/runs\/([^/]+)(?:\/(.+))?$/);
      value = route === 'actions' ? world.action(id, data.action, data.input) : route === 'demo' ? world.demo(id) : route === 'archive' ? world.archive(id) : world.read(id);
    }
    return { ok: true, json: async () => structuredClone(value) };
  };
  const context = { document: { getElementById: element, querySelectorAll: () => [...elements.values()] }, fetch, localStorage: { getItem: () => null }, Event: class { constructor(type) { this.type = type; } }, console };
  await vm.runInNewContext(`(async () => {${readFileSync(join(root, 'web/app.js'), 'utf8')}\n})()`, context);
  const click = id => element(id).listeners.click();
  const load = async run => { element('run-select').value = run.id; await click('load-run'); };
  return { world, element, click, load };
}
