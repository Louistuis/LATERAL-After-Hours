/**
 * Typed view of the websim runtime the platform injects as `window.websim`. Never imported or polyfilled:
 * off websim this resolves to null and every websim feature hides itself.
 *
 * Verified 2026-10-01 against the live object (Object.keys(window.websim) in the project iframe) and the
 * websim.com parent bundle that answers its RPCs:
 *  - getCurrentUser() -> { id, username, avatar_url }
 *  - getCurrentProject() -> { id, title, description }
 *  - postComment({ content, images?, parent_comment_id?, credits? }): with credits > 0 it opens the native
 *    comment composer prefilled with the tip and resolves {} at once; the player confirms there. It resolves
 *    { error } when the page has had no user gesture or the visitor is signed out.
 *  - addEventListener('comment:created', cb) -> unsubscribe; cb receives { comment, cursor }.
 */
export interface WebsimUser { readonly id: string; readonly username: string; readonly avatar_url?: string }
export interface WebsimProject { readonly id: string; readonly title?: string }
export interface WebsimHost {
  getCurrentUser(): Promise<WebsimUser | null>;
  getCurrentProject(): Promise<WebsimProject | null>;
  postComment(input: { content: string; credits?: number }): Promise<{ error?: string } | Record<string, unknown> | undefined>;
  addEventListener(type: 'comment:created', listener: (data: unknown) => void): (() => void) | void;
}

export function websimHost(): WebsimHost | null {
  try {
    const candidate = (globalThis as { websim?: Partial<WebsimHost> }).websim;
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof candidate.getCurrentUser !== 'function' || typeof candidate.postComment !== 'function') return null;
    return candidate as WebsimHost;
  } catch { return null; }
}

export { withTimeout } from './timeout';
