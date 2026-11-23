import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app/server.js';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, dataDir, appRoot = root) {
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'refund-http-'));
  const { server } = createApp({ root: appRoot, dataDir: dir }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (!dataDir) rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, dir, url, post: (path, value) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) };
}
test('HTTP完整路径可初始化、执行、回读、导出并归档', async t => {
  const { url, post } = await fixture(t);
  assert.equal((await fetch(url)).status, 200);
  const response = await post('/api/runs', { case_id: 'normal' }); assert.equal(response.status, 201); const run = await response.json();
  const demo = await post(`/api/runs/${run.id}/demo`, {}); assert.equal(demo.status, 200); assert.equal((await demo.json()).state.ticket.status, 'pending_approval');
  const readback = await (await fetch(`${url}/api/runs/${run.id}`)).json(); assert.equal(readback.actions.length, 2);
  const exported = await fetch(`${url}/api/runs/${run.id}/export`); assert.match(exported.headers.get('content-disposition'), /attachment/); const evidence = await exported.json(); assert.equal(evidence.automated_verdict, null); assert.deepEqual(evidence.run, readback);
  assert.equal((await post(`/api/runs/${run.id}/archive`, {})).status, 200);
  assert.equal((await post(`/api/runs/${run.id}/actions`, { action: 'create_draft', input: {} })).status, 409);
});
test('HTTP不暴露答案、cases源码、目录或任意文件', async t => {
  const { url, server } = await fixture(t);
  for (const path of ['/reference/expected-outcomes.json', '/cases/normal.json', '/app/world.js', '/data/', '/web/', '/package.json', '/api/runs/not-an-id', '/unknown']) assert.equal((await fetch(url + path)).status, 404, path);
  const cases = await (await fetch(url + '/api/cases')).json(); assert.equal(cases.length, 3); assert.equal('initial_state' in cases[0], false);
  for (const path of ['/../reference/expected-outcomes.json', '/%2e%2e/reference/expected-outcomes.json', '/%5c..%5creference', '/%ZZ']) {
    const response = await new Promise((resolve, reject) => { http.get({ hostname: '127.0.0.1', port: server.address().port, path }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
    assert.ok([400, 404].includes(response), path);
  }
});
test('课程服务只开放指定目录和文件类型，支持章节内引用的媒体', async t => {
  const course = mkdtempSync(join(tmpdir(), 'learn-sde-course-'));
  t.after(() => rmSync(course, { recursive: true, force: true }));
  for (const directory of ['library', 'learning', 'library/01']) mkdirSync(join(course, directory), { recursive: true });
  const markdown = join(course, 'library', '第一章.md');
  writeFileSync(markdown, '# 第一章');
  writeFileSync(join(course, 'library', 'unlisted.json'), '仅作白名单测试');
  writeFileSync(join(course, 'library', 'unlisted.html'), '<h1>仅作白名单测试</h1>');
  writeFileSync(join(course, 'library', 'reader.html'), '<h1 id="chapter-1">第一章</h1>');
  writeFileSync(join(course, 'library', '01', 'clip.mp4'), 'mp4 fixture');
  symlinkSync(markdown, join(course, 'library', 'symlink.md'));
  symlinkSync(join(course, 'library'), join(course, 'learning', 'linked-dir'));
  writeFileSync(join(course, 'handbook.html'), `
    <a href="./library/reader.html#chapter-1">第一章</a>
    <a href="./library/symlink.md">符号链接</a>
    <a href="./learning/linked-dir/第一章.md">目录符号链接</a>
  `);
  const { url } = await fixture(t, undefined, course);
  const handbook = await fetch(url + '/handbook.html');
  assert.equal(handbook.status, 200);
  assert.match(handbook.headers.get('content-type'), /^text\/html/);
  const readerUrl = new URL('./library/reader.html#chapter-1', handbook.url);
  const reader = await fetch(readerUrl);
  assert.equal(reader.status, 200);
  assert.equal(reader.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await reader.text(), /id="chapter-1"/);
  const chapter = await fetch(url + '/library/' + encodeURIComponent('第一章.md'));
  assert.equal(chapter.status, 200);
  assert.equal(chapter.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await chapter.text(), '# 第一章');
  const clip = await fetch(url + '/library/01/clip.mp4');
  assert.equal(clip.headers.get('content-type'), 'video/mp4');
  assert.equal(await clip.text(), 'mp4 fixture');
  const partial = await fetch(url + '/library/01/clip.mp4', { headers: { Range: 'bytes=0-2' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 0-2/11');
  assert.equal(await partial.text(), 'mp4');
  for (const path of ['/library/', '/library/unlisted.json', '/library/unlisted.html', '/library/symlink.md', '/learning/linked-dir/' + encodeURIComponent('第一章.md'), '/library/%2e%2e%2fhandbook.html']) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
});
test('HTTP解析错误和跨站写入被明确拒绝，服务仍然可用', async t => {
  const { url, post } = await fixture(t);
  assert.equal((await fetch(url + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await post('/api/runs', [])).status, 400);
  assert.equal((await fetch(url + '/api/runs', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(url + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{"case_id":"normal"}' })).status, 403);
  assert.equal((await post('/api/runs', { case_id: '../reference' })).status, 404);
  assert.equal((await post('/api/runs', { case_id: 'normal' })).status, 201);
});
test('HTTP服务重建后读回运行和动作证据', async t => {
  const first = await fixture(t), response = await first.post('/api/runs', { case_id: 'missing-evidence' }), run = await response.json();
  await first.post(`/api/runs/${run.id}/demo`, {});
  const second = await fixture(t, first.dir);
  const restored = await (await fetch(`${second.url}/api/runs/${run.id}`)).json(); assert.equal(restored.state.ticket.status, 'waiting_evidence'); assert.equal(restored.actions.length, 1);
});
