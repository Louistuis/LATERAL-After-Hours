/**
 * Build target flags. Written as constants so the bundler drops the code of the other targets: the self-hosted build
 * must not carry any of the code (or text) that only the other platforms use.
 */
export const SELFHOST: boolean = typeof __SELFHOST__ !== 'undefined' && __SELFHOST__;
