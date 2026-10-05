import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Public origin of the self-hosted build. The only absolute URL the shipped page may carry. */
export const SELFHOST_ORIGIN = 'https://lateral.lou15.com';
const TITLE = 'LATERAL · After Hours';
const DESCRIPTION = 'LATERAL: After Hours is a free browser drift game. Slide through the harbor, earn Marks from missions, collect gifts and race friends online.';

/** Page meta for the selfhost build: description, share card, favicon set. No analytics, no third party tags. */
export function selfhostPages() {
  return {
    name: 'selfhost-pages',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const head = [
          '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
          '<link rel="icon" href="/favicon.ico" sizes="any">',
          '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
          `<meta name="description" content="${DESCRIPTION}">`,
          `<link rel="canonical" href="${SELFHOST_ORIGIN}/">`,
          '<meta property="og:type" content="website">',
          '<meta property="og:site_name" content="LATERAL: After Hours">',
          `<meta property="og:title" content="${TITLE}">`,
          `<meta property="og:description" content="${DESCRIPTION}">`,
          `<meta property="og:url" content="${SELFHOST_ORIGIN}/">`,
          `<meta property="og:image" content="${SELFHOST_ORIGIN}/og.png">`,
          '<meta property="og:image:width" content="1080">',
          '<meta property="og:image:height" content="1080">',
          '<meta name="twitter:card" content="summary">',
          `<meta name="twitter:title" content="${TITLE}">`,
          `<meta name="twitter:description" content="${DESCRIPTION}">`,
          `<meta name="twitter:image" content="${SELFHOST_ORIGIN}/og.png">`,
        ].join('');
        // The shared page carries an inline data: favicon; the hosted build ships real icon files instead.
        const stripped = html.replace(/<link rel="icon" href="data:[^"]*">/, '');
        if (stripped === html) throw new Error('selfhost-pages: the inline favicon link was not found; update the plugin');
        return stripped.replace('</title>', `</title>${head}`);
      },
    },
  };
}

/** Emits og.png, robots.txt and the favicon files at the site root. */
export function selfhostStatic() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'static');
  return {
    name: 'selfhost-static',
    generateBundle() {
      for (const name of readdirSync(dir)) this.emitFile({ type: 'asset', fileName: name, source: readFileSync(join(dir, name)) });
    },
  };
}

/**
 * The three.js shader chunks carry reference links as GLSL comments inside template literals (a paper URL). They are
 * never fetched, but the hosted build ships no third party URL at all, so the comment lines are dropped from the chunks.
 */
export function selfhostScrub() {
  return {
    name: 'selfhost-scrub',
    renderChunk(code) {
      const next = code.replace(/\n[ \t]*\/\/ ?https?:\/\/[^\n]*/g, '');
      return next === code ? null : { code: next, map: null };
    },
  };
}
