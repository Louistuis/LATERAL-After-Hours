import type { Plugin } from 'vite';
export const SELFHOST_ORIGIN: string;
export function selfhostPages(): Plugin;
export function selfhostStatic(): Plugin;

export function selfhostScrub(): import('vite').Plugin;
