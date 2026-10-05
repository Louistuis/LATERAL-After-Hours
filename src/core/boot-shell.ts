import type { GraphicsRecoveryState } from './canvas-recovery';
import { describeBootFailure } from './boot-failure';
import './boot-shell.css';

export interface BootSaveRecoveryActions {
  exportBackup(): Promise<Blob>;
  playForSession(): Promise<unknown>;
}

export function createBootShell(root: HTMLElement) {
  root.classList.add('lateral-app');
  const canvas = document.createElement('canvas');
  canvas.className = 'lateral-viewport'; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'LATERAL driving view');
  const controls = document.createElement('div'); controls.className = 'lateral-controls';
  const overlay = document.createElement('div'); overlay.className = 'lateral-overlay';
  const cover = document.createElement('section'); cover.className = 'lateral-boot';
  cover.setAttribute('aria-live', 'polite');
  cover.innerHTML = '<i class="boot-band" aria-hidden="true"></i><div class="boot-mark" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M6 5h31l6 6v32H11l-6-6z" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M19 11h8l-5 20h14l-2 7H12z" fill="currentColor"/><path d="M1 27h9M3 32h8M0 37h7" stroke="currentColor" stroke-width="2.2"/></svg></div><p class="boot-eyebrow">LATERAL · AFTER HOURS</p><h1>Find your line.</h1><p class="boot-message">Opening the coast…</p><button type="button" class="boot-retry" hidden>Try again</button>';
  const message = cover.querySelector<HTMLElement>('.boot-message')!;
  const title = cover.querySelector<HTMLElement>('h1')!;
  const button = cover.querySelector<HTMLButtonElement>('button')!;
  let cancelRecovery: (() => void) | undefined;
  const reload = () => window.location.reload(); button.addEventListener('click', reload);
  root.replaceChildren(canvas, controls, overlay, cover);
  return {
    canvas, controls, overlay,
    progress(text: string) { message.textContent = text; },
    ready() { cover.hidden = true; cover.removeAttribute('aria-label'); message.removeAttribute('role'); },
    /** Wait for an explicit non-destructive choice; never replace stored bytes here. */
    recoverSave(error: unknown, actions: BootSaveRecoveryActions, signal?: AbortSignal): Promise<void> {
      cancelRecovery?.();
      const failure = describeBootFailure(error);
      cover.hidden = false; cover.setAttribute('role', 'region'); cover.setAttribute('aria-label', 'Save recovery');
      message.setAttribute('role', 'alert');
      title.textContent = failure.title;
      message.textContent = `${failure.message} You can download the stored save or play for this session without changing it. Temporary progress will end when you close or reload the page.`;
      button.textContent = 'Reload'; button.hidden = false;
      const row = document.createElement('div'); row.className = 'boot-recovery-actions';
      const backup = document.createElement('button'); backup.type = 'button'; backup.textContent = 'Download stored save';
      const play = document.createElement('button'); play.type = 'button'; play.textContent = 'Play for this session';
      const feedback = document.createElement('p'); feedback.className = 'boot-recovery-feedback'; feedback.setAttribute('aria-live', 'polite');
      row.append(backup, play); button.before(row, feedback);
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const urls = new Set<string>();
        const releaseUrl = (url: string) => { URL.revokeObjectURL(url); urls.delete(url); };
        const cleanup = () => {
          settled = true; signal?.removeEventListener('abort', abort);
          backup.removeEventListener('click', download); play.removeEventListener('click', continueSession);
          for (const url of urls) releaseUrl(url);
          row.remove(); feedback.remove(); cancelRecovery = undefined;
        };
        const abort = () => { cleanup(); reject(new DOMException('Boot replaced', 'AbortError')); };
        const busy = (value: boolean) => { backup.disabled = value; play.disabled = value; };
        const download = () => {
          if (backup.disabled) return;
          busy(true); feedback.textContent = '';
          void actions.exportBackup().then(blob => {
            if (settled) return;
            const url = URL.createObjectURL(blob); urls.add(url);
            const link = document.createElement('a'); link.href = url; link.download = 'lateral-stored-save-backup.json';
            row.append(link); link.click(); link.remove();
            setTimeout(() => releaseUrl(url), 1000);
            feedback.textContent = 'The stored save is ready to download. It has not been changed.';
          }).catch(() => {
            if (!settled) feedback.textContent = 'The backup could not be downloaded. Your stored save has not been changed.';
          }).finally(() => { if (!settled) busy(false); });
        };
        const continueSession = () => {
          if (play.disabled) return;
          busy(true); feedback.textContent = 'Opening a temporary session…';
          void actions.playForSession().then(() => {
            if (settled) return;
            cleanup(); resolve();
          }).catch(() => {
            if (!settled) { feedback.textContent = 'The temporary session could not open. Your stored save has not been changed.'; busy(false); }
          });
        };
        cancelRecovery = abort;
        backup.addEventListener('click', download); play.addEventListener('click', continueSession);
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
    },
    fail(error: unknown) {
      const failure = describeBootFailure(error);
      cover.hidden = false; cover.setAttribute('role','alert'); cover.removeAttribute('aria-label'); message.removeAttribute('role');
      title.textContent = failure.title; message.textContent = failure.message;
      button.textContent = 'Reload'; button.hidden = false;
    },
    graphics(state: GraphicsRecoveryState) {
      if (state === 'ready') { cover.hidden = true; return; }
      cover.setAttribute('role', 'alert'); cover.removeAttribute('aria-label'); message.removeAttribute('role');
      cover.hidden = false; title.textContent = 'Taking a breather.'; button.hidden = false;
      message.textContent = state === 'failed' ? 'The graphics stopped. Reload to continue from your last save.'
        : state === 'restoring' ? 'Restoring your view…' : 'The graphics are paused. Your drive will resume when the view returns.';
    },
    dispose() { cancelRecovery?.(); button.removeEventListener('click', reload); canvas.remove(); controls.remove(); overlay.remove(); cover.remove(); },
  };
}
