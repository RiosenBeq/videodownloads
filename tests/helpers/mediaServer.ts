/**
 * Minimal static media server for tests.
 *   /path                 static file with Range support
 *   /path?throttle=N      stream at ~N bytes/second
 *   /flaky/path           first request per path drops the socket mid-body
 *   /redirect?to=URL      302 redirect
 *   /html-instead.mp4     returns an HTML page with 200 (link expired case)
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.key': 'application/octet-stream',
};

export interface MediaServer {
  url: string;
  port: number;
  requests: string[];
  close(): Promise<void>;
}

export async function startMediaServer(root: string, host = '127.0.0.1'): Promise<MediaServer> {
  const flakyServed = new Set<string>();
  const requests: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    requests.push(`${req.method} ${url.pathname}${url.search}${req.headers.range ? ` [${req.headers.range}]` : ''}`);

    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end();
      return;
    }
    if (url.pathname === '/html-instead.mp4') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Link expired</body></html>');
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    let flaky = false;
    if (rel.startsWith('/flaky/')) {
      flaky = !flakyServed.has(rel);
      flakyServed.add(rel);
      rel = rel.slice('/flaky'.length);
    }
    const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    const size = fs.statSync(file).size;
    const headers: http.OutgoingHttpHeaders = {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      start = range[1] ? Number(range[1]) : size - Number(range[2]);
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return void res.end();

    const throttle = Number(url.searchParams.get('throttle')) || 0;
    if (!throttle && !flaky) {
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }

    // Throttled / flaky: push fixed-size chunks on a timer.
    const fd = fs.openSync(file, 'r');
    const chunk = 32 * 1024;
    const interval = throttle ? Math.max(5, Math.round((chunk / throttle) * 1000)) : 1;
    const dropAt = flaky ? start + Math.floor((end - start) * 0.3) : Infinity;
    let pos = start;
    const timer = setInterval(() => {
      if (res.destroyed) return stop();
      if (pos > end) {
        stop();
        return void res.end();
      }
      if (pos >= dropAt) {
        stop();
        return void res.socket?.destroy();
      }
      const len = Math.min(chunk, end - pos + 1);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      res.write(buf);
    }, interval);
    const stop = () => {
      clearInterval(timer);
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    };
    res.on('close', stop);
  });

  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
