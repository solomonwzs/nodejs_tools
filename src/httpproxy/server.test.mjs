import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'httpproxy-test-'));
await build({ entryPoints: ['src/httpproxy/server.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'server.mjs') });
const { createProxyServer } = await import(pathToFileURL(path.join(temp, 'server.mjs')).href);
const servers = [];
const sockets = new Set();
async function listen(server) {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
function request(port, origin, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/echo?a=1&a=2', method,
      headers: { ...(origin ? { 'X-Ori-Host': origin } : {}), 'x-custom': 'kept', connection: 'close, x-hop', 'x-hop': 'removed' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function echo(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.writeHead(201, { 'x-upstream': 'kept', 'set-cookie': ['a=1', 'b=2'] });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('base64') }));
  });
}

test('header routing, HTTP proxy, HTTPS CONNECT, and errors', async () => {
  try {
    const upstreamPort = await listen(http.createServer(echo));
    const origin = `http://127.0.0.1:${upstreamPort}`;
    const directPort = await listen(createProxyServer({ listen: 4004 }));
    const body = Buffer.from([0, 255, 1, 2, 13, 10]);
    const result = await request(directPort, origin, 'PATCH', body);
    assert.equal(result.status, 201);
    assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
    const data = JSON.parse(result.body);
    assert.equal(data.method, 'PATCH');
    assert.equal(data.url, '/echo?a=1&a=2');
    assert.equal(data.body, body.toString('base64'));
    assert.equal(data.headers.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(data.headers['x-custom'], 'kept');
    assert.equal(data.headers['x-ori-host'], undefined);
    assert.equal(data.headers['x-hop'], undefined);
    for (const invalid of [undefined, 'ftp://example.org', 'https://example.org/base', 'bad-url']) {
      assert.equal((await request(directPort, invalid)).status, 400);
    }

    let absoluteUrl;
    let connectTarget;
    const proxy = http.createServer((req, res) => {
      absoluteUrl = req.url;
      const target = new URL(req.url);
      const outgoing = http.request(target, { method: req.method, headers: req.headers }, (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
      });
      outgoing.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(outgoing);
    });
    proxy.on('connect', (req, client, head) => {
      connectTarget = req.url;
      const [host, port] = req.url.split(':');
      const socket = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.write(head);
        socket.pipe(client);
        client.pipe(socket);
      });
      socket.on('error', () => client.destroy());
      client.on('error', () => socket.destroy());
      client.on('close', () => socket.destroy());
    });
    const proxyPort = await listen(proxy);
    const routedPort = await listen(createProxyServer({ listen: 4004, httpProxy: `http://127.0.0.1:${proxyPort}`, httpsProxy: `http://127.0.0.1:${proxyPort}` }));
    assert.equal((await request(routedPort, origin, 'POST', body)).status, 201);
    assert.equal(absoluteUrl, `${origin}/echo?a=1&a=2`);

    // Trust a local test certificate without disabling TLS verification.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(temp, 'key.pem'), '-out', path.join(temp, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(temp, 'cert.pem'));
    const tlsPort = await listen(https.createServer({ key: fs.readFileSync(path.join(temp, 'key.pem')), cert }, echo));
    const originalCa = https.globalAgent.options.ca;
    const tls = await import('node:tls');
    const originalConnect = tls.default.connect;
    tls.default.connect = (options) => originalConnect({ ...options, ca: cert });
    try {
      const secureResult = await request(routedPort, `https://127.0.0.1:${tlsPort}`, 'PUT', body);
      assert.equal(secureResult.status, 201);
      assert.equal(JSON.parse(secureResult.body).body, body.toString('base64'));
      assert.equal(connectTarget, `127.0.0.1:${tlsPort}`);
      https.globalAgent.options.ca = cert;
      assert.equal((await request(directPort, `https://127.0.0.1:${tlsPort}`)).status, 201);
    } finally {
      tls.default.connect = originalConnect;
      https.globalAgent.options.ca = originalCa;
    }

    const brokenProxyPort = await listen(http.createServer().on('connect', (_req, socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }));
    const failingPort = await listen(createProxyServer({ listen: 4004, httpsProxy: `http://127.0.0.1:${brokenProxyPort}` }));
    assert.equal((await request(failingPort, 'https://example.org')).status, 502);
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
