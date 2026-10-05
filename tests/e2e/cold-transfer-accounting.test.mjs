import assert from 'node:assert/strict';
import test from 'node:test';
import { accountTransferToBoundary, classifyResource, p95NearestRank } from './cold-transfer-accounting.mjs';

const origin = 'http://127.0.0.1:4173';

test('completed CDP encoded bytes are distinct from Content-Length and preserve encoding metadata', () => {
  const result = accountTransferToBoundary([{
    requestId: '1', url: `${origin}/assets/world.glb`, type: 'Fetch', requestedAt: 1, responseAt: 2,
    finishedAt: 3, status: 200, encodedBytes: 412, contentLength: '1000', contentEncoding: 'br',
  }], 4, origin);
  assert.equal(result.coverageComplete, true);
  assert.equal(result.totalBytes, 412);
  assert.equal(result.requests[0].contentLength, '1000');
  assert.equal(result.requests[0].contentEncoding, 'br');
  assert.equal(result.requests[0].resourceClass, 'fetch-or-decoder');
});

test('post-boundary optional requests do not inflate first-playable transfer', () => {
  const result = accountTransferToBoundary([
    { requestId: '1', url: `${origin}/index.html`, requestedAt: 1, responseAt: 1.1, finishedAt: 1.2, status: 200, encodedBytes: 100 },
    { requestId: '2', url: `${origin}/later.webp`, requestedAt: 5, responseAt: 6, finishedAt: 7, status: 200, encodedBytes: 500 },
  ], 4, origin);
  assert.equal(result.totalBytes, 100);
  assert.equal(result.requestCount, 1);
});

test('in-flight and failed records return null total with only a known subtotal', () => {
  const result = accountTransferToBoundary([
    { requestId: '1', url: `${origin}/app.js`, requestedAt: 1, responseAt: 1.2, finishedAt: 1.5, status: 200, encodedBytes: 300 },
    { requestId: '2', url: `${origin}/world.bin`, requestedAt: 2, responseAt: 2.2, status: 200,
      dataReceived: [{ timestamp: 2.5, encodedDataLength: 40 }, { timestamp: 4.5, encodedDataLength: 90 }] },
    { requestId: '3', url: `${origin}/texture.ktx2`, requestedAt: 2.4, failure: 'net::ERR_ABORTED', status: null },
  ], 4, origin);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.totalBytes, null);
  assert.equal(result.knownSubtotalBytes, 340);
  assert.equal(result.unknownCount, 2);
  assert.equal(result.requests[1].knownBytes, 40);
});

test('cross-origin and cached responses invalidate cold-load coverage instead of becoming zero-byte passes', () => {
  const result = accountTransferToBoundary([
    { requestId: '1', url: `${origin}/index.html`, requestedAt: 1, responseAt: 1.1, finishedAt: 1.2, status: 200, encodedBytes: 100 },
    { requestId: '2', url: 'https://cdn.invalid/asset.js', requestedAt: 2, responseAt: 2.1, finishedAt: 2.2, status: 200, encodedBytes: 25 },
    { requestId: '3', url: `${origin}/cached.js`, requestedAt: 2.5, responseAt: 2.6, finishedAt: 2.7, status: 200, encodedBytes: 0, fromDiskCache: true },
  ], 3, origin);
  assert.equal(result.totalBytes, null);
  assert.equal(result.knownSubtotalBytes, 125);
  assert.equal(result.unknownCount, 2);
  assert.match(result.unknown[0].reason, /cross-origin/);
  assert.match(result.unknown[1].reason, /cache/);
});

test('missing status or invalid completed-byte records cannot produce a transfer total', () => {
  const result = accountTransferToBoundary([
    { requestId: '1', url: `${origin}/index.html`, requestedAt: 1, responseAt: 1.1, finishedAt: 1.2, status: 200, encodedBytes: -1 },
    { requestId: '2', url: `${origin}/app.js`, requestedAt: 1.3, finishedAt: 1.4, encodedBytes: 250 },
  ], 2, origin);
  assert.equal(result.totalBytes, null);
  assert.equal(result.knownSubtotalBytes, 250);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.unknownCount, 2);
});

test('resource classes identify decoders, geometry and textures separately', () => {
  assert.equal(classifyResource({ url: '/assets/decoder.wasm' }), 'wasm');
  assert.equal(classifyResource({ url: '/world/harbor.glb' }), 'model-or-geometry');
  assert.equal(classifyResource({ url: '/textures/road.ktx2' }), 'image-or-texture');
  assert.equal(classifyResource({ type: 'Document' }), 'document');
});

test('p95 uses nearest-rank and rejects incomplete samples', () => {
  assert.equal(p95NearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10);
  assert.throws(() => p95NearestRank([]), /p95/);
  assert.throws(() => p95NearestRank([1, NaN]), /p95/);
});
