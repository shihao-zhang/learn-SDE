import http from 'node:http';
import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, BusinessError } from './world.js';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticFiles = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['web/styles.css', 'text/css; charset=utf-8']],
  ['/handbook.html', ['handbook.html', 'text/html; charset=utf-8']],
  ['/library/reader.html', ['library/reader.html', 'text/html; charset=utf-8']],
]);
const courseTypes = new Map([
  ['.md', 'text/plain; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.srt', 'application/x-subrip; charset=utf-8'],
  ['.webm', 'video/webm'],
  ['.vtt', 'text/vtt; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);
function regularFile(root, relativePath) {
  let fullPath = root;
  const parts = relativePath.split('/');
  for (const [i, part] of parts.entries()) {
    fullPath = join(fullPath, part);
    const stat = lstatSync(fullPath, { throwIfNoEntry: false });
    if (!(i === parts.length - 1 ? stat?.isFile() : stat?.isDirectory())) return;
  }
  return fullPath;
}
function allowedFiles(root) {
  const files = new Map(staticFiles);
  // 只扫描随课发布的资料目录，并在启动时固定允许访问的路径。
  function scan(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (!/^[\p{L}\p{N}_-][\p{L}\p{N}._ -]*$/u.test(entry.name) || entry.name.includes('..')) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) scan(file);
      const type = courseTypes.get(extname(entry.name).toLowerCase());
      if (entry.isFile() && type) files.set('/' + file, [file, type]);
    }
  }
  for (const directory of ['library', 'learning']) {
    if (lstatSync(join(root, directory), { throwIfNoEntry: false })?.isDirectory()) scan(directory);
  }
  return files;
}
function serveVideo(req, res, fullPath, headers) {
  const size = lstatSync(fullPath).size;
  headers['Accept-Ranges'] = 'bytes';
  let options;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const start = range?.[1] ? Number(range[1]) : Math.max(0, size - Number(range?.[2]));
    const end = range?.[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if ((!range?.[1] && !range?.[2]) || !(start <= end)) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    options = { start, end };
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = end - start + 1;
  } else {
    headers['Content-Length'] = size;
  }
  res.writeHead(options ? 206 : 200, headers);
  const stream = createReadStream(fullPath, options);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
function send(res, status, value, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BusinessError('请求需使用JSON格式', 415);
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new BusinessError('请求内容过大', 413); }
  try { const data = JSON.parse(text || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new BusinessError('JSON解析失败，请检查输入'); }
}
export function createApp({ root = projectRoot, dataDir } = {}) {
  const world = new World(root, dataDir);
  const files = allowedFiles(root);
  const server = http.createServer(async (req, res) => {
    try {
      const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rawPath.includes('..') || rawPath.includes('\\') || rawPath.includes('\0')) throw new BusinessError('路径无效', 404);
      const path = rawPath;
      if (req.method === 'POST') {
        const ownOrigin = `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== ownOrigin) throw new BusinessError('不接受其他网站发起的写入', 403);
      }
      if (req.method === 'GET' && files.has(path)) {
        const [file, type] = files.get(path);
        const fullPath = regularFile(root, file);
        if (!fullPath) throw new BusinessError('资源不存在', 404);
        const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
        if (type === 'image/svg+xml') headers['Content-Security-Policy'] = 'sandbox';
        if (type.startsWith('video/')) {
          serveVideo(req, res, fullPath, headers);
        } else {
          const content = readFileSync(fullPath);
          res.writeHead(200, headers).end(content);
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/cases') return send(res, 200, world.cases());
      if (req.method === 'GET' && path === '/api/policy') return send(res, 200, world.policy());
      if (req.method === 'GET' && path === '/api/runs') return send(res, 200, world.list());
      if (req.method === 'POST' && path === '/api/runs') return send(res, 201, world.create((await body(req)).case_id));
      const match = path.match(/^\/api\/runs\/([a-f0-9-]{36})(?:\/(actions|demo|archive|export))?$/);
      if (match) {
        const [, id, route] = match;
        if (req.method === 'GET' && !route) return send(res, 200, world.read(id));
        if (req.method === 'GET' && route === 'export') return send(res, 200, { evidence_type: 'phase-1-observation', automated_verdict: null, note: '业务状态与动作证据，未执行独立自动验收。', run: world.read(id) }, { 'Content-Disposition': `attachment; filename="run-${id}.json"` });
        if (req.method === 'POST' && route) {
          const data = await body(req);
          if (route === 'actions') return send(res, 200, world.action(id, data.action, data.input));
          if (route === 'demo') return send(res, 200, world.demo(id));
          if (route === 'archive') return send(res, 200, world.archive(id));
        }
      }
      throw new BusinessError('资源不存在', 404);
    } catch (error) { send(res, error instanceof URIError ? 400 : error.status || 500, { error: error.status || error instanceof URIError ? error.message : '服务内部错误' }); }
  });
  return { server, world };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  const port = Number(process.env.PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT无效');
  server.listen(port, '127.0.0.1', () => console.log(`Learn SDE · 客服工单台\nhttp://127.0.0.1:${server.address().port}\n进程 PID ${process.pid}；按 Ctrl+C 停止。`));
}
