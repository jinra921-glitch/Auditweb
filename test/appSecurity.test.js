import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

test('the deployed frontend has CSP, serves the local spreadsheet bundle, and accepts its own origin', async t => {
  process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough';
  process.env.NODE_ENV = 'test';
  const { default: app } = await import('../backend/app.js');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const homepage = await fetch(baseUrl + '/');
  assert.equal(homepage.status, 200);
  const contentSecurityPolicy = homepage.headers.get('content-security-policy') || '';
  assert.match(contentSecurityPolicy, /default-src 'self'/);
  assert.match(contentSecurityPolicy, /worker-src 'self' blob:/);

  const bundle = await fetch(baseUrl + '/vendor/xlsx.full.min.js');
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type') || '', /javascript/);

  const parserWorker = await fetch(baseUrl + '/xlsx-parser-worker.js');
  assert.equal(parserWorker.status, 200);

  const sameOrigin = await fetch(baseUrl + '/health', { headers: { Origin: baseUrl } });
  assert.equal(sameOrigin.headers.get('access-control-allow-origin'), baseUrl);

  const foreignOrigin = await fetch(baseUrl + '/health', { headers: { Origin: 'https://example.invalid' } });
  assert.equal(foreignOrigin.headers.get('access-control-allow-origin'), null);
});
