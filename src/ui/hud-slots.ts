/**
 * HUD slot system. Fixed HUD pieces keep their own corners (plates top-left, slide gauge top-centre,
 * icons and route guide top-right, speed and gear bottom-right, touch controls bottom). Everything that
 * comes and goes is moved into one of two flow containers, so pieces stack instead of overlapping:
 *
 *   TL2  "side stack"  below the top-left plates: online position tower, lesson card.
 *   MSG  "message lane" below the slide gauge: grid banner, run invalid banner, assist hint, errors,
 *                      online toasts, mission toasts.
 *
 * The run invalid banner leaves .lp-hud when it moves, so its banner look is restated here.
 * Elements are re-parented on mount and whenever a late component (online panel, missions) appends
 * them to the shell. Owners keep their element references, so nothing else changes. Positions per layout
 * live in HUD_SLOTS_CSS: desktop, portrait phone (lane on the right under the route guide), short landscape.
 */
const SLOTTED: readonly (readonly [string, 'tl2' | 'msg'])[] = [
  ['.lp-net-hud', 'tl2'], ['.lp-tutorial', 'tl2'], ['.lf-ghost-chip', 'tl2'],
  ['.lp-net-big', 'msg'], ['.lp-invalid', 'msg'], ['.lp-assist-hint', 'msg'], ['.lp-error', 'msg'], ['.lp-net-toasts', 'msg'], ['.lp-mt', 'msg'], ['.lf-toasts', 'msg'],
];

export function mountHudSlots(shell: HTMLElement): () => void {
  const tl2 = document.createElement('div'); tl2.className = 'lp-slot lp-slot-tl2';
  const msg = document.createElement('div'); msg.className = 'lp-slot lp-slot-msg';
  shell.append(tl2, msg);
  const slots = { tl2, msg };
  const place = (): void => {
    for (const [selector, slot] of SLOTTED) {
      const target = slots[slot];
      shell.querySelectorAll<HTMLElement>(selector).forEach(node => {
        if (node.parentElement === target || target.contains(node)) return;
        // Keep the declared order inside a slot regardless of mount order.
        const order = SLOTTED.findIndex(([sel]) => sel === selector);
        const before = [...target.children].find(child => SLOTTED.findIndex(([sel]) => (child as HTMLElement).matches(sel)) > order);
        target.insertBefore(node, before ?? null);
      });
    }
  };
  place();
  const observer = new MutationObserver(records => { if (records.some(record => record.addedNodes.length)) place(); });
  observer.observe(shell, { childList: true });
  return () => { observer.disconnect(); tl2.remove(); msg.remove(); };
}

export const HUD_SLOTS_CSS = `
.lp-shell{--hud-t:max(12px,env(safe-area-inset-top));--hud-l:max(12px,env(safe-area-inset-left));--hud-r:max(12px,env(safe-area-inset-right))}
.lp-slot{position:absolute;display:flex;flex-direction:column;gap:8px;pointer-events:none;z-index:30}
.lp-shell .lp-slot>*{position:static!important;transform:none!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;margin:0!important;max-width:100%}
.lp-slot-tl2{left:var(--hud-l);top:calc(var(--hud-t) + 112px);width:min(316px,42vw);align-items:stretch}
.lp-shell .lp-slot-tl2 .lp-tutorial{width:100%;max-width:none}
.lp-shell .lp-slot-tl2 .lp-net-hud{width:min(240px,100%)}
/* Message lane: under the slide gauge (its height follows its width, 88/240), never wider than the space between the side stacks. */
.lp-slot-msg{left:50%;transform:translateX(-50%);top:calc(var(--hud-t) + 52px + min(19em,62vw) * .37);width:max(240px,min(520px,calc(100% - 2 * var(--hud-l) - 2 * min(316px,42vw) - 16px)));align-items:center;z-index:45}
.lp-shell .lp-slot-msg>.lp-net-toasts,.lp-shell .lp-slot-msg>.lp-mt{width:100%!important;justify-items:center}
.lp-shell .lp-slot-msg .lp-invalid{order:0;padding:.55em 1.3em;background:rgba(130,40,10,.94);border:1px solid rgba(255,160,100,.6);color:#fff;font-weight:700;font-size:.9em;letter-spacing:.1em;text-transform:uppercase;text-align:center;animation:lp-rise .3s ease both;clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.lp-shell:not([data-screen=drive]):not([data-screen=replay]) .lp-slot-msg .lp-invalid{display:none}
/* Menus, lobby and results: the lane steps out of the middle to the top-right corner (where toasts always lived), so it never covers a panel. Comes after the layout blocks below via higher specificity. */
html .lp-shell:not([data-screen=drive]):not([data-screen=replay]) .lp-slot-msg,html .lp-shell:has(.lp-net:not([hidden]),.lp-net-card:not([hidden])) .lp-slot-msg{left:auto;right:var(--hud-r);top:var(--hud-t);transform:none;width:min(360px,calc(100% - 2 * var(--hud-r)));max-height:none;align-items:flex-end;font-size:1em}
html .lp-shell:has(.lp-net:not([hidden]),.lp-net-card:not([hidden])) .lp-slot-msg .lp-assist-hint{display:none}
.lp-count{top:45%}
.lp-popups{top:40%}
/* Solo touch horn (shop-feature.ts). Same look as the online horn; prefixed with .lp-shell so the general button rule cannot reset it. */
.lp-shell .lp-shop-horn{position:absolute;right:max(14px,env(safe-area-inset-right));top:36%;z-index:31;width:64px;height:64px;padding:0;font:700 .72em/1 var(--lp-font);letter-spacing:.16em;text-transform:uppercase;color:var(--lp-on-accent);background:var(--lp-accent);border:0;clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px));pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer;opacity:.86}
.lp-shell .lp-shop-horn[hidden]{display:none}
.lp-shell .lp-shop-horn:active{filter:brightness(.85)}
@media (hover:hover) and (pointer:fine){.lp-shell .lp-net-horn,.lp-shell .lp-shop-horn{display:none}}
/* Portrait phones: the lane moves to the right half under the route guide; the side stack keeps the left half. Horns go mid-left. */
@media (orientation:portrait) and (max-width:600px){
.lp-slot-tl2{top:calc(var(--hud-t) + 160px);width:46vw}
.lp-slot-msg{left:auto;right:var(--hud-r);transform:none;top:calc(var(--hud-t) + 204px);width:calc(54vw - var(--hud-r) - 10px);align-items:flex-end}
.lp-shell .lp-slot-msg>.lp-net-toasts,.lp-shell .lp-slot-msg>.lp-mt{justify-items:end}
/* The lane stops above the speedo; in the rare case everything fires at once the oldest extras are clipped, not stacked on the tach. */
.lp-slot-msg{max-height:calc(100% - var(--hud-t) - 204px - max(14px,env(safe-area-inset-bottom)) - 168px - 11.5em * var(--lp-tach-k,.66));overflow:hidden;font-size:.92em}
html .lp-shell .lp-net-horn,html .lp-shell .lp-shop-horn{right:auto;left:var(--hud-l);top:auto;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 150px)}
/* Speed and gear sit above the pedal column and its Recover button. */
html[data-lateral-screen=drive] .lp-shell .lp-speed{bottom:calc(max(14px,env(safe-area-inset-bottom)) + 168px)}
html[data-lateral-screen=drive] .lp-shell .lp-gear{bottom:calc(max(14px,env(safe-area-inset-bottom)) + 168px + .15em * var(--lp-tach-k))}
}
/* Short landscape phones: side stack under the compact plates, lane centred under the small gauge, keyboard hint above the steer pads. */
@media (max-height:480px) and (orientation:landscape){
.lp-slot-tl2{top:calc(var(--hud-t) + 84px);width:min(230px,30vw);max-height:calc(100% - var(--hud-t) - 84px - 96px);overflow:hidden}
/* The tach sits bottom-centre here, so the lane is capped to end above it. */
.lp-slot-msg{top:calc(max(6px,env(safe-area-inset-top)) + 70px);width:min(36vw,340px);max-height:calc(100% - max(6px,env(safe-area-inset-top)) - 70px - 142px - max(8px,env(safe-area-inset-bottom)));overflow:hidden;font-size:.86em}
.lp-shell .lp-input-hint{left:var(--hud-l);right:auto;transform:none;top:auto;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 92px);max-width:34vw}
}
`;
