const successfulStatus = status => Number.isInteger(status) && status >= 200 && status < 300;
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

export function classifyResource({ url = '', type = '' } = {}) {
  const normalizedType = String(type).toLowerCase();
  if (normalizedType === 'document') return 'document';
  if (normalizedType === 'script') return 'javascript';
  if (normalizedType === 'stylesheet') return 'stylesheet';
  if (normalizedType === 'font') return 'font';
  if (normalizedType === 'image') return 'image-or-texture';
  if (normalizedType === 'media') return 'audio-or-video';
  if (normalizedType === 'wasm') return 'wasm';
  if (normalizedType === 'xhr' || normalizedType === 'fetch') return 'fetch-or-decoder';
  const pathname = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return String(url).toLowerCase(); } })();
  if (/\.(wasm)(?:$|\?)/.test(pathname)) return 'wasm';
  if (/\.(glb|gltf|bin)(?:$|\?)/.test(pathname)) return 'model-or-geometry';
  if (/\.(ktx2|png|jpe?g|webp|avif)(?:$|\?)/.test(pathname)) return 'image-or-texture';
  if (/\.(mp3|ogg|wav|m4a)(?:$|\?)/.test(pathname)) return 'audio-or-video';
  if (/\.(m?js)(?:$|\?)/.test(pathname)) return 'javascript';
  if (/\.css(?:$|\?)/.test(pathname)) return 'stylesheet';
  return 'other';
}

/**
 * Totals only requests initiated by the marker boundary. CDP completed encoded bytes
 * are trusted only for complete, successful, uncached same-origin responses. Partial
 * observed bytes remain a lower-bound subtotal and force totalBytes=null.
 */
export function accountTransferToBoundary(requests, boundaryTimestamp, expectedOrigin) {
  if (!Array.isArray(requests) || !Number.isFinite(boundaryTimestamp) || typeof expectedOrigin !== 'string') {
    throw new TypeError('Transfer accounting requires request records, a finite boundary, and an origin');
  }
  let knownSubtotalBytes = 0;
  let coverageComplete = true;
  const included = [];
  const unknown = [];
  for (const request of requests) {
    if (!Number.isFinite(request.requestedAt) || request.requestedAt > boundaryTimestamp) continue;
    const path = (() => { try { return new URL(request.url).pathname; } catch { return null; } })();
    const sameOrigin = (() => { try { return new URL(request.url).origin === expectedOrigin; } catch { return false; } })();
    const completeByBoundary = Number.isFinite(request.finishedAt) && request.finishedAt <= boundaryTimestamp;
    const cacheUsed = request.fromDiskCache === true || request.fromServiceWorker === true ||
      request.fromPrefetchCache === true || request.servedFromCache === true;
    const base = {
      requestId: request.requestId ?? null,
      path,
      resourceClass: request.resourceClass ?? classifyResource({ url: request.url, type: request.type }),
      status: request.status ?? null,
      contentEncoding: request.contentEncoding ?? null,
      contentLength: request.contentLength ?? null,
      fromDiskCache: request.fromDiskCache === true,
      fromServiceWorker: request.fromServiceWorker === true,
      fromPrefetchCache: request.fromPrefetchCache === true,
      servedFromCache: request.servedFromCache === true,
      completeByBoundary,
      failure: request.failure ?? null,
    };
    let knownBytes = 0;
    let reason = null;
    if (!sameOrigin) reason = 'cross-origin request';
    else if (cacheUsed) reason = 'cache or service-worker response; cold transfer not proven';
    else if (request.failure) reason = 'request failed';
    else if (!successfulStatus(request.status)) reason = 'missing or unsuccessful HTTP response';
    else if (completeByBoundary && nonNegativeInteger(request.encodedBytes)) knownBytes = request.encodedBytes;
    else if (completeByBoundary) reason = 'completed response has no valid CDP encoded byte count';
    else {
      const partial = (request.dataReceived ?? [])
        .filter(chunk => Number.isFinite(chunk.timestamp) && chunk.timestamp <= boundaryTimestamp)
        .map(chunk => chunk.encodedDataLength)
        .filter(nonNegativeInteger);
      if (partial.length) knownBytes = partial.reduce((sum, value) => sum + value, 0);
      reason = Number.isFinite(request.responseAt) && request.responseAt <= boundaryTimestamp
        ? 'request was in flight at first-playable boundary'
        : 'request had not received a response by first-playable boundary';
    }
    if (!cacheUsed && completeByBoundary && nonNegativeInteger(request.encodedBytes)) knownBytes = request.encodedBytes;
    if (reason && !completeByBoundary) {
      const observed = (request.dataReceived ?? [])
        .filter(chunk => Number.isFinite(chunk.timestamp) && chunk.timestamp <= boundaryTimestamp)
        .map(chunk => chunk.encodedDataLength)
        .filter(nonNegativeInteger);
      if (observed.length) knownBytes = observed.reduce((sum, value) => sum + value, 0);
    }
    knownSubtotalBytes += knownBytes;
    const item = { ...base, knownBytes, coverageReason: reason };
    included.push(item);
    if (reason) { coverageComplete = false; unknown.push({ requestId: item.requestId, path, reason }); }
  }
  return {
    totalBytes: coverageComplete ? knownSubtotalBytes : null,
    knownSubtotalBytes,
    coverageComplete,
    requestCount: included.length,
    unknownCount: unknown.length,
    requests: included,
    unknown,
  };
}

export function p95NearestRank(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('p95 requires a non-empty array of finite non-negative values');
  }
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

export function validateFirstPlayableReadiness(readiness, markerAtMs, observerToleranceMs = 100) {
  const issues = [];
  if (!readiness || typeof readiness !== 'object' || !Number.isFinite(markerAtMs) || !Number.isFinite(observerToleranceMs) || observerToleranceMs < 0) {
    return { valid: false, issues: ['readiness sample, marker, or tolerance is invalid'] };
  }
  if (readiness.coverHidden !== true) issues.push('boot cover was not hidden at first-playable marker');
  if (readiness.driveMenuVisible !== true) issues.push('Drive menu was not present at first-playable marker');
  if (!Number.isFinite(readiness.canvasWidth) || readiness.canvasWidth <= 0 || !Number.isFinite(readiness.canvasHeight) || readiness.canvasHeight <= 0) {
    issues.push('canvas had no positive dimensions at first-playable marker');
  }
  if (readiness.webglContextReady !== true) issues.push('WebGL context was not ready at first-playable marker');
  for (const key of ['coverCreatedAtMs', 'coverHiddenAtMs', 'driveMenuAtMs']) {
    const value = readiness[key];
    if (!Number.isFinite(value)) issues.push(`DOM readiness mark ${key} was not observed`);
    else if (value > markerAtMs + observerToleranceMs) issues.push(`DOM readiness mark ${key} occurred after the marker tolerance`);
  }
  return { valid: issues.length === 0, issues };
}
