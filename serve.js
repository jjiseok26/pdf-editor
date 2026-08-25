import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize, sep } from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));
const basePort = Number(process.env.PORT) || 5173;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    let filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mime[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
});

let port = basePort;
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE' && port < basePort + 50) {
    console.log(`포트 ${port} 사용 중 → ${port + 1}로 재시도`);
    port += 1;
    server.listen({ port, exclusive: true });
  } else {
    console.error('서버 시작 실패:', err);
    process.exit(1);
  }
});

server.listen({ port, exclusive: true }, () => {
  console.log(`\n  PDF 편집기 실행됨:  http://localhost:${port}\n`);
});
