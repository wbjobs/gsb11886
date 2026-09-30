import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { process } from 'node:process';

const root = process.cwd();
const port = Number(process.env.PORT || 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requested = decodeURIComponent(url.pathname);
  const relative = normalize(requested).replace(/^[/\\]+/, '');
  let path = join(root, relative || 'index.html');

  if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': types[extname(path)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(response);
});

server.listen(port, () => {
  console.log(`Screen-space effects running at http://localhost:${port}/`);
});
