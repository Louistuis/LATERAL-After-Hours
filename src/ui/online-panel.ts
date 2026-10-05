import type { OnlineFeature, OnlineView, RaceMode } from '../net';
import type { NamedStanding, NetMember } from '../net/session';
import { formatValue } from '../net/leaderboard';
import { READY_TIMER_MS } from '../net/lobby';
import { EVENTS } from '../../content/events/catalog';
import { ASSIST_BADGES, ASSIST_LABELS, type AssistLevel } from '../physics/assists';

/** Small badge after a time: which driving assist level it was set with. Unknown (legacy) rows get none. */
function assistBadge(assist: AssistLevel | undefined): string {
  return assist ? ` <i class="lp-assist-badge" data-assist="${assist}" title="Assists ${ASSIST_LABELS[assist]}" aria-label="Assists ${ASSIST_LABELS[assist]}">${ASSIST_BADGES[assist]}</i>` : '';
}

export interface OnlinePanel { open(): void; close(): void; readonly isOpen: boolean; dispose(): void }
export interface OnlineRoute { readonly id: string; readonly name: string }

const MODE_NAME: Record<RaceMode, string> = { 'time-trial': 'Time trial', 'drift-attack': 'Drift battle' };
const MODE_LINE: Record<RaceMode, string> = { 'time-trial': 'Fastest clean lap wins', 'drift-attack': 'Highest score wins' };
const CAR_NAME: Readonly<Record<string, string>> = { 'CAR-01': 'Challenger', 'CAR-02': 'Cybertruck', 'CAR-04': 'McLaren F1', 'CAR-05': 'Lancia Delta', 'CAR-06': 'Agera' };
const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>',
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="currentColor"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4m0 1h12l-2.5 4L17 13H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

const PANEL_CSS = `
.lp-shell:has(.lp-net:not([hidden])) .lt-root{opacity:0;pointer-events:none;transition:opacity .25s}
.lp-net{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:flex-start;padding:max(14px,env(safe-area-inset-top)) max(clamp(14px,4.6vw,72px),env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(clamp(14px,4.6vw,72px),env(safe-area-inset-left));background:linear-gradient(90deg,rgba(2,7,9,.92) 0%,rgba(3,10,12,.7) 40%,rgba(3,10,12,.2) 75%,rgba(3,10,12,.05)),linear-gradient(0deg,rgba(2,7,9,.7),rgba(2,7,9,0) 40%);pointer-events:auto;font-family:var(--lp-font);color:var(--lp-ink);animation:ln-fade .3s ease both}
.lp-net[hidden],.lp-net-hud[hidden],.lp-net-card[hidden],.lp-net-big[hidden]{display:none}
@keyframes ln-fade{from{opacity:0}to{opacity:1}}
@keyframes ln-in{from{opacity:0;transform:translate3d(-24px,0,0)}to{opacity:1;transform:none}}
@keyframes ln-row{from{opacity:0;transform:translate3d(0,8px,0)}to{opacity:1;transform:none}}
@keyframes ln-pulse{0%,100%{box-shadow:0 0 0 0 rgba(216,250,114,.6)}60%{box-shadow:0 0 0 7px rgba(216,250,114,0)}}
@keyframes ln-rise{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes ln-pop{0%{opacity:0;transform:scale(1.8)}55%{opacity:1;transform:scale(.94)}100%{opacity:1;transform:scale(1)}}
@keyframes ln-toast{0%{opacity:0;transform:translate3d(0,-12px,0)}12%,85%{opacity:1;transform:none}100%{opacity:0;transform:translate3d(0,-6px,0)}}
.lp-net-panel{position:relative;display:flex;flex-direction:column;width:min(600px,100%);max-height:100%;min-height:0;background:linear-gradient(165deg,rgba(8,19,21,.95),rgba(4,10,12,.92));border:1px solid var(--lp-line);border-left:3px solid var(--lp-accent);clip-path:polygon(0 0,calc(100% - 22px) 0,100% 22px,100% 100%,0 100%);animation:ln-in .45s cubic-bezier(.16,.84,.24,1) both}
.lp-net-head{display:flex;align-items:center;gap:14px;padding:18px 22px 8px}
.lp-net-head>div{flex:1;min-width:0}
.lp-net-head h2{margin:0;font:800 2.3em/.92 var(--lp-stencil);font-style:italic;letter-spacing:.04em;text-transform:uppercase}
.lp-net-kicker{margin:0 0 5px;font:700 .7em/1.2 var(--lp-font);letter-spacing:.32em;text-transform:uppercase;color:var(--lp-hot)}
.lp-net-body{overflow:auto;min-height:0;padding:4px 22px 16px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.lp-net-body h3{margin:16px 0 8px;font:700 .68em/1 var(--lp-font);letter-spacing:.3em;text-transform:uppercase;color:var(--lp-teal)}
.lp-net-foot{display:flex;gap:8px;padding:12px 22px 16px;border-top:1px solid var(--lp-line)}
:is(.lp-net,.lp-net-card) button{--cut:9px;position:relative;font:600 .9em/1.1 var(--lp-font);color:var(--lp-ink);background:rgba(255,255,255,.04);border:1px solid var(--lp-line-strong);padding:.7em 1em;min-height:46px;cursor:pointer;text-align:left;letter-spacing:.08em;text-transform:uppercase;touch-action:manipulation;clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));transition:background-color .15s,border-color .15s,transform .15s}
:is(.lp-net,.lp-net-card) button:hover:not(:disabled),:is(.lp-net,.lp-net-card) button:focus-visible{border-color:var(--lp-accent);outline:none;background:rgba(216,250,114,.1)}
.lp-shell[data-nav=pad] :is(.lp-net,.lp-net-card) button:focus{outline:2px solid var(--lp-accent);outline-offset:-5px}
:is(.lp-net,.lp-net-card) button:disabled{opacity:.5;cursor:default}
:is(.lp-net,.lp-net-card) button.lp-net-go{background:var(--lp-accent);color:var(--lp-on-accent);border-color:var(--lp-accent)}
:is(.lp-net,.lp-net-card) button.lp-net-go:hover:not(:disabled){background:#ecffab}
:is(.lp-net,.lp-net-card) button small{display:block;margin-top:.35em;font-size:.8em;font-weight:500;letter-spacing:.02em;text-transform:none;opacity:.75}
.lp-net-back{--cut:8px!important;width:46px;height:46px;padding:0!important;display:grid!important;place-items:center;flex:none}
.lp-net-back svg{width:22px;height:22px}
.lp-net-quick{--cut:16px!important;display:flex!important;align-items:center;gap:16px;width:100%;min-height:86px!important;padding:.8em 1.3em!important}
.lp-net-quick svg{width:30px;height:30px;flex:none}
.lp-net-quick b{display:block;font:800 2.1em/1 var(--lp-stencil);font-style:italic;letter-spacing:.08em}
.lp-net-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}
.lp-net-modes button{min-height:70px}
.lp-net-count{display:inline-flex;align-items:center;gap:8px;font-size:.8em;letter-spacing:.12em;text-transform:uppercase;color:var(--lp-dim)}
.lp-net-count i{width:8px;height:8px;border-radius:50%;background:var(--lp-accent);animation:ln-pulse 1.8s ease-out infinite}
.lp-net-chips{display:flex;flex-wrap:wrap;gap:6px}
.lp-net-chips span{display:inline-flex;align-items:center;gap:7px;padding:3px 10px 3px 3px;background:rgba(255,255,255,.04);border:1px solid var(--lp-line);font-size:.84em}
.lp-net-chips span.self{border-color:var(--lp-accent)}
.ln-av{width:28px;height:28px;border-radius:50%;object-fit:cover;flex:none;display:grid;place-items:center;font:700 .8em/1 var(--lp-font);font-style:normal;background:var(--lp-teal-deep);color:var(--lp-ink)}
.lp-net-event{display:grid;grid-template-columns:1fr auto;gap:4px 14px;align-items:center;padding:12px 14px;background:rgba(47,184,173,.08);border:1px solid var(--lp-line)}
.lp-net-event b{font:800 1.5em/1 var(--lp-display);letter-spacing:.05em;text-transform:uppercase}
.lp-net-event span{color:var(--lp-dim);font-size:.84em}
.lp-net-event em{grid-row:1/3;grid-column:2;font-style:normal;font-size:.72em;letter-spacing:.16em;text-transform:uppercase;color:var(--lp-faint);text-align:right}
.lp-net-pick{display:grid;gap:8px;margin-top:8px}
.lp-net-seg{display:flex;flex-wrap:wrap;gap:6px}
.lp-net-seg button{--cut:6px;min-height:42px;padding:.5em .9em;font-size:.78em}
.lp-net-seg button[aria-pressed=true]{background:var(--lp-teal-deep);border-color:var(--lp-accent);color:var(--lp-accent)}
.lp-net-roster{list-style:none;margin:0;padding:0;display:grid;gap:5px}
.lp-net-roster li{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:10px;min-height:54px;padding:6px 10px 6px 8px;background:rgba(255,255,255,.035);border-left:3px solid transparent;animation:ln-row .35s ease both}
.lp-net-roster li.self{border-left-color:var(--lp-accent);background:rgba(216,250,114,.06)}
.lp-net-roster li.empty{opacity:.4;border-left-style:dashed;min-height:40px}
.ln-who{min-width:0;display:grid;gap:2px}
.ln-who b{display:flex;align-items:center;gap:6px;font-weight:700;font-size:.95em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln-who b svg{width:15px;height:15px;color:#ffc94d;flex:none}
.ln-who small{font-size:.76em;color:var(--lp-dim);letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln-ping{display:flex;align-items:flex-end;gap:2px;font-size:.72em;color:var(--lp-dim);letter-spacing:.04em}
.ln-ping i{width:3px;background:rgba(255,255,255,.18)}
.ln-ping i:nth-child(1){height:5px}.ln-ping i:nth-child(2){height:8px}.ln-ping i:nth-child(3){height:11px}
.ln-ping[data-q=good] i{background:var(--lp-accent)}.ln-ping[data-q=ok] i:nth-child(-n+2){background:#ffc94d}.ln-ping[data-q=bad] i:nth-child(1){background:var(--lp-hot)}
.ln-ping span{margin-left:5px;min-width:3.4em}
.ln-state{font:700 .68em/1 var(--lp-font);letter-spacing:.18em;text-transform:uppercase;padding:6px 8px;border:1px solid var(--lp-line-strong);color:var(--lp-dim)}
.ln-state.on{background:var(--lp-accent);border-color:var(--lp-accent);color:var(--lp-on-accent)}
.lp-net-status{margin:12px 0 0;font-size:.9em;color:var(--lp-dim)}
.lp-net-status b{font:800 1.4em/1 var(--lp-display);color:var(--lp-accent)}
.lp-net-notice{margin:10px 0 0;padding:8px 12px;border-left:3px solid var(--lp-hot);background:rgba(255,138,31,.1);color:#ffd2a8;font-size:.86em}
.lp-net-ready{flex:1;--cut:14px!important;min-height:58px!important;font:800 1.5em/1 var(--lp-stencil)!important;font-style:italic!important;letter-spacing:.12em!important;text-align:center!important}
.lp-net-boards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.lp-net-boards ol{margin:0;padding:0;list-style:none;font-size:.86em}
.lp-net-boards li{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid rgba(130,205,196,.12)}
.lp-net-boards li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-net-boards li b{font-family:var(--lp-num);color:var(--lp-accent);font-weight:700}
.lp-net-boards p{margin:0;color:var(--lp-faint);font-size:.82em}
.lp-net-link{background:none!important;border:0!important;clip-path:none!important;min-height:40px!important;padding:.3em 0!important;color:var(--lp-dim)!important;text-decoration:underline;text-underline-offset:4px;font-size:.76em!important}
.lp-assist-badge{display:inline-block;margin-left:.35em;padding:0 .35em;font:700 .68em/1.5 inherit;font-style:normal;letter-spacing:.06em;vertical-align:.12em;border:1px solid rgba(130,205,196,.45);border-radius:3px;opacity:.85}
.lp-assist-badge[data-assist="off"]{border-color:rgba(255,190,90,.7);color:#ffd08a}
/* in-race position tower */
.lp-net-hud{position:absolute;left:max(12px,env(safe-area-inset-left));top:calc(max(12px,env(safe-area-inset-top)) + 108px);z-index:30;width:min(230px,44vw);font:600 .8em/1.25 var(--lp-font);color:var(--lp-ink);pointer-events:none}
.ln-pos{display:flex;align-items:baseline;gap:6px;padding:6px 12px 4px;background:var(--lp-accent);color:var(--lp-on-accent);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);width:max-content;min-width:120px}
.ln-pos b{font:800 2.6em/1 var(--lp-stencil);font-style:italic}
.ln-pos small{font:700 1.05em/1 var(--lp-display);letter-spacing:.06em;opacity:.75}
.ln-pos.p1{background:linear-gradient(90deg,#ffd76a,#ffb43b)}
.lp-net-hud ol{margin:4px 0 0;padding:0;list-style:none;display:grid;gap:2px}
.lp-net-hud li{display:grid;grid-template-columns:1.6em minmax(0,1fr) auto;gap:6px;align-items:center;padding:4px 8px;background:rgba(4,10,12,.74);border-left:2px solid transparent;transition:transform .3s}
.lp-net-hud li.self{border-left-color:var(--lp-accent);background:rgba(20,34,18,.85)}
.lp-net-hud li em{font:800 1.1em/1 var(--lp-display);font-style:normal;color:var(--lp-faint)}
.lp-net-hud li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-net-hud li b{font:700 1em/1 var(--lp-num);color:var(--lp-dim)}
.lp-net-hud li.self b{color:var(--lp-accent)}
/* grid forming banner */
.lp-net-big{position:absolute;left:50%;top:max(16%,70px);transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:16px;padding:10px 22px 10px 14px;background:rgba(4,10,12,.86);border:1px solid var(--lp-line);border-left:4px solid var(--lp-hot);pointer-events:none;animation:ln-fade .3s ease both}
.lp-net-big b{font:800 3.2em/1 var(--lp-stencil);font-style:italic;color:var(--lp-hot);min-width:1ch;text-align:center;animation:ln-pop .5s cubic-bezier(.2,.8,.2,1) both}
.lp-net-big span{display:grid;gap:3px;font:700 .8em/1.2 var(--lp-font);letter-spacing:.24em;text-transform:uppercase}
.lp-net-big small{font-weight:500;letter-spacing:.08em;text-transform:none;color:var(--lp-dim)}
/* results podium */
/* The race podium replaces the solo results panel underneath it (two result screens stacked read as clutter). */
.lp-shell:has(.lp-net-card:not([hidden])) .lp-results{visibility:hidden}
/* Touch driving controls sit above the game overlay: off while the podium is up, or they cover Lobby and Close. */
html:has(.lp-net-card:not([hidden])) .lateral-touch-controls{display:none!important}
.lp-net-card{position:absolute;inset:0;z-index:35;display:flex;align-items:center;justify-content:center;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:radial-gradient(ellipse at 50% 60%,rgba(3,9,11,.55),rgba(2,6,8,.92));pointer-events:auto;font-family:var(--lp-font);color:var(--lp-ink);animation:ln-fade .4s ease both}
.ln-results{display:flex;flex-direction:column;width:min(720px,100%);max-height:100%;min-height:0;overflow:auto;padding:20px 24px;background:linear-gradient(170deg,rgba(8,19,21,.96),rgba(4,10,12,.96));border:1px solid var(--lp-line);border-top:3px solid var(--lp-accent);clip-path:polygon(0 0,calc(100% - 22px) 0,100% 22px,100% 100%,22px 100%,0 calc(100% - 22px))}
.ln-results h2{margin:0;font:800 2.4em/.92 var(--lp-stencil);font-style:italic;letter-spacing:.04em;text-transform:uppercase}
.ln-podium{display:flex;align-items:flex-end;justify-content:center;gap:10px;margin:18px 0 8px;min-height:210px}
.ln-step{display:flex;flex-direction:column;align-items:center;gap:6px;width:min(170px,30%)}
.ln-step .ln-av{width:52px;height:52px;font-size:1.1em;box-shadow:0 0 0 3px rgba(255,255,255,.18)}
.ln-step b{max-width:100%;font-weight:700;font-size:.92em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln-step small{font:700 1.05em/1 var(--lp-num);color:var(--lp-accent)}
.ln-block{width:100%;display:grid;place-items:center;font:800 2.6em/1 var(--lp-stencil);font-style:italic;color:rgba(0,0,0,.55);transform-origin:bottom;animation:ln-rise .7s cubic-bezier(.16,.84,.24,1) both}
.ln-step.p1 .ln-block{height:120px;background:linear-gradient(180deg,#ffd76a,#d99a1e);animation-delay:.35s}
.ln-step.p2 .ln-block{height:88px;background:linear-gradient(180deg,#e3ebe8,#97a6a1);animation-delay:.15s}
.ln-step.p3 .ln-block{height:64px;background:linear-gradient(180deg,#e9a46a,#a5612a);animation-delay:.55s}
.ln-step.p1 .ln-av{box-shadow:0 0 0 3px #ffd76a}
.ln-step.self b{color:var(--lp-accent)}
.ln-rest{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:3px}
.ln-rest li{display:grid;grid-template-columns:2.6em minmax(0,1fr) auto;gap:10px;padding:6px 10px;background:rgba(255,255,255,.03)}
.ln-rest li.self{color:var(--lp-accent)}
.ln-rest b{font-family:var(--lp-num)}
.ln-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.ln-actions .lp-net-go{flex:1 1 220px;--cut:14px;min-height:58px;font:800 1.4em/1 var(--lp-stencil);font-style:italic;letter-spacing:.1em;text-align:center}
/* toasts */
.lp-net-toasts{position:absolute;right:max(14px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));z-index:45;display:grid;gap:6px;justify-items:end;width:min(360px,calc(100% - 28px));pointer-events:none}
.lp-net-toasts p{display:flex;align-items:center;gap:10px;margin:0;padding:9px 14px 9px 10px;background:rgba(4,10,12,.92);border:1px solid var(--lp-line);border-left:3px solid var(--lp-teal);font:600 .84em/1.3 var(--lp-font);color:var(--lp-ink);letter-spacing:.02em;animation:ln-toast 4s ease both}
.lp-net-toasts p i{display:grid;place-items:center;width:22px;height:22px;flex:none;font:800 1em/1 var(--lp-font);font-style:normal;color:var(--lp-on-accent);background:var(--lp-teal);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.lp-net-toasts p[data-k=join]{border-left-color:var(--lp-accent)}.lp-net-toasts p[data-k=join] i{background:var(--lp-accent)}
.lp-net-toasts p[data-k=leave]{border-left-color:var(--lp-hot)}.lp-net-toasts p[data-k=leave] i{background:var(--lp-hot)}
.lp-net-toasts p[data-k=host] i{background:#ffc94d}
.lp-net-toasts p[data-k=net]{border-left-color:#ffc94d}
.lp-shell .lp-net-horn{position:absolute;right:max(14px,env(safe-area-inset-right));top:36%;z-index:31;width:64px;height:64px;padding:0;font:700 .72em/1 var(--lp-font);letter-spacing:.16em;text-transform:uppercase;color:var(--lp-on-accent);background:var(--lp-accent);border:0;clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px));pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer}
.lp-shell .lp-net-horn[hidden]{display:none}
.lp-net-horn:active{filter:brightness(.85)}
.lp-shell[data-reduced-motion=true] :is(.lp-net,.lp-net-card,.lp-net-big,.lp-net-toasts) *{animation:none!important}
@media (orientation:portrait) and (max-width:900px){.lp-net{align-items:flex-end;background:linear-gradient(0deg,rgba(2,7,9,.95) 0%,rgba(2,7,9,.75) 55%,rgba(2,7,9,.35))}.lp-net-panel{width:100%;max-height:88%;clip-path:none}.lp-net-modes{grid-template-columns:1fr 1fr}.lp-net-modes button:last-child{grid-column:1/3}.lp-net-boards{grid-template-columns:1fr}}
@media (max-width:480px){.lp-net-head{padding:14px 14px 6px}.lp-net-head h2{font-size:1.8em}.lp-net-body{padding:4px 14px 12px}.lp-net-foot{padding:10px 14px 12px}.lp-net-roster li{gap:8px;padding-right:8px}.ln-ping span{display:none}.ln-podium{min-height:170px}.ln-step.p1 .ln-block{height:92px}.ln-step.p2 .ln-block{height:68px}.ln-step.p3 .ln-block{height:50px}.ln-results{padding:16px}}
@media (max-height:520px) and (orientation:landscape){.lp-net-panel{width:min(620px,72vw)}.lp-net-head{padding:10px 16px 4px}.lp-net-head h2{font-size:1.6em}.lp-net-quick{min-height:60px!important}.lp-net-quick b{font-size:1.5em}.lp-net-modes button{min-height:52px}.lp-net-roster li{min-height:42px}.ln-podium{min-height:140px;margin:8px 0}.ln-step.p1 .ln-block{height:72px}.ln-step.p2 .ln-block{height:52px}.ln-step.p3 .ln-block{height:38px}.ln-step .ln-av{width:36px;height:36px}.lp-net-hud{width:min(200px,34vw);font-size:.72em}}
`;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function ordinal(n: number): string { const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'; return `${n}${s}`; }
function avatar(url: string, name: string): string {
  return /^https:\/\//.test(url) ? `<img class="ln-av" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<i class="ln-av" aria-hidden="true">${esc((name || '?').slice(0, 1).toUpperCase())}</i>`;
}
function ping(ms: number | null): string {
  const q = ms === null ? '' : ms < 90 ? 'good' : ms < 180 ? 'ok' : 'bad';
  return `<span class="ln-ping" data-q="${q}" aria-label="${ms === null ? 'Ping unknown' : `Ping ${ms} milliseconds`}"><i></i><i></i><i></i><span>${ms === null ? '··' : `${ms} ms`}</span></span>`;
}
/** Podium display order: 2nd, 1st, 3rd (only the places that exist). */
export function podiumOrder<T>(ranked: readonly T[]): T[] {
  const [first, second, third] = ranked;
  return [second, first, third].filter((item): item is T => item !== undefined);
}
/** Toast styling from its text: joins, leaves, host changes and connection notices. */
export function toastKind(text: string): 'join' | 'leave' | 'host' | 'net' | 'info' {
  return /joined/i.test(text) ? 'join' : /host/i.test(text) ? 'host' : /left/i.test(text) ? 'leave' : /connect/i.test(text) ? 'net' : 'info';
}
const TOAST_ICON = { join: '+', leave: '−', host: '★', net: '!', info: 'i' } as const;

function result(v: OnlineView, s: NamedStanding, done = false): string {
  if (s.invalid) return 'Not counted';
  if (!s.finished) return v.raceMode === 'drift-attack' ? s.score.toLocaleString('en-US') : done ? 'DNF' : 'Racing';
  return (v.raceMode === 'time-trial' ? formatValue('time-trial', s.timeMs) : s.score.toLocaleString('en-US')) + assistBadge(s.assist);
}

/** Online lobby, race board and race results, mounted inside the player UI shell. */
export function mountOnlinePanel(shell: HTMLElement, feature: OnlineFeature, hooks: {
  currentCar(): string;
  screen(): string;
  onFreeRoam(): void;
  onClosed(): void;
  /** Routes the host can pick from (runtime.routes()). */
  routes?(): readonly OnlineRoute[];
  /** True while an event run is live (not free drive, not the lesson): the position tower only shows then. */
  inEvent?(): boolean;
  /** A member's top badges (feature hub: whitelisted achievements from a clamped presence mask). */
  badges?(memberId: string): readonly { readonly badge: string; readonly tier: string; readonly name: string }[];
}): OnlinePanel {
  const style = document.createElement('style'); style.textContent = PANEL_CSS; document.head.append(style);
  const root = document.createElement('div'); root.className = 'lp-net'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Online');
  const hud = document.createElement('div'); hud.className = 'lp-net-hud'; hud.hidden = true; hud.setAttribute('aria-live', 'off');
  const big = document.createElement('div'); big.className = 'lp-net-big'; big.hidden = true; big.setAttribute('role', 'status');
  const card = document.createElement('section'); card.className = 'lp-net-card'; card.hidden = true; card.setAttribute('aria-label', 'Race results');
  const toasts = document.createElement('div'); toasts.className = 'lp-net-toasts'; toasts.setAttribute('role', 'status'); toasts.setAttribute('aria-live', 'polite');
  const hornButton = document.createElement('button'); hornButton.className = 'lp-net-horn'; hornButton.type = 'button'; hornButton.hidden = true;
  hornButton.textContent = 'Horn'; hornButton.setAttribute('aria-label', 'Horn (H)');
  shell.append(root, hud, big, card, toasts, hornButton);
  let open = false, lastPanel = '', lastHud = '', lastBig = '', lastCard = '', lastToasts = '', cardDismissedRace = -1, lastPanelKey = '';
  let view: OnlineView | null = feature.session()?.view() ?? null;
  const routeList = (): readonly OnlineRoute[] => hooks.routes?.() ?? [];
  const routeName = (id: string): string => routeList().find(route => route.id === id)?.name ?? id;

  const render = (): void => {
    const v = view;
    const panel = open && v ? renderPanel(v) : '';
    if (panel !== lastPanel) {
      const focusKey = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
      const key = v ? `${v.lobbyId ?? 'hub'}` : '';
      lastPanel = panel; root.innerHTML = panel;
      // Same page re-rendering: keep the entrance animation from replaying on every presence tick.
      if (key === lastPanelKey) root.querySelectorAll<HTMLElement>('.lp-net-panel,.lp-net-roster li').forEach(node => { node.style.animation = 'none'; });
      lastPanelKey = key;
      const focusTarget = (focusKey ? root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) : null) ?? (open && !root.contains(document.activeElement) ? root.querySelector<HTMLElement>('.lp-net-quick,.lp-net-ready') : null);
      focusTarget?.focus({ preventScroll: true });
    }
    root.hidden = !open;
    const driving = hooks.screen() === 'drive';
    const hudMarkup = v && v.racing && driving && (hooks.inEvent?.() ?? true) ? renderHud(v) : '';
    if (hudMarkup !== lastHud) { lastHud = hudMarkup; hud.innerHTML = hudMarkup; }
    hud.hidden = !hudMarkup;
    // Grid forming banner until the run's own 3-2-1 takes over (player-ui draws that one).
    const seconds = v && v.startInMs !== null ? Math.ceil((v.startInMs - 3000) / 1000) : 0;
    const bigMarkup = v && v.lobbyId && v.startInMs !== null && v.startInMs > 3000 && !open ? `<b>${seconds}</b><span>Grid forming<small>${v.members.length} ${v.members.length === 1 ? 'driver' : 'drivers'} · ${esc(MODE_NAME[v.lobby?.mode ?? 'time-trial'])} · ${esc(routeName(v.lobby?.route ?? ''))}</small></span>` : '';
    if (bigMarkup !== lastBig) { lastBig = bigMarkup; big.innerHTML = bigMarkup; }
    big.hidden = !bigMarkup;
    const showCard = v && v.race && !v.racing && v.standings.length > 0 && cardDismissedRace !== v.race && !open;
    const cardMarkup = showCard ? renderCard(v!) : '';
    if (cardMarkup !== lastCard) { const fresh = !lastCard; lastCard = cardMarkup; card.innerHTML = cardMarkup; if (cardMarkup && fresh) card.querySelector<HTMLElement>('.lp-net-go')?.focus({ preventScroll: true }); }
    card.hidden = !cardMarkup;
    const toastMarkup = v ? v.toasts.map(t => { const kind = toastKind(t.text); return `<p data-k="${kind}" data-id="${t.id}"><i aria-hidden="true">${TOAST_ICON[kind]}</i>${esc(t.text)}</p>`; }).join('') : '';
    if (toastMarkup !== lastToasts) {
      // Keep existing toast nodes so their animation does not restart; add new ones, drop expired ones.
      const wanted = new Set((v?.toasts ?? []).map(t => String(t.id)));
      toasts.querySelectorAll<HTMLElement>('p').forEach(node => { if (!wanted.has(node.dataset.id ?? '')) node.remove(); });
      for (const t of v?.toasts ?? []) if (!toasts.querySelector(`[data-id="${t.id}"]`)) { const kind = toastKind(t.text); const p = document.createElement('p'); p.dataset.k = kind; p.dataset.id = String(t.id); p.innerHTML = `<i aria-hidden="true">${TOAST_ICON[kind]}</i>${esc(t.text)}`; p.style.animationDuration = `${Math.max(1500, t.until - performance.now())}ms`; toasts.append(p); }
      lastToasts = toastMarkup;
    }
    hornButton.hidden = !(v && v.racing && driving && !open);
  };
  const unsubscribe = feature.subscribe(next => { view = next; render(); });
  const poll = window.setInterval(render, 250);

  function renderPanel(v: OnlineView): string {
    const online = v.players.filter(p => p.online);
    const notice = v.notice ? `<p class="lp-net-notice" role="status">${esc(v.notice)}</p>` : '';
    const head = (kicker: string, title: string, back: string, label: string): string => `<header class="lp-net-head"><button class="lp-net-back" data-net="${back}" data-key="back" aria-label="${label}">${ICON.back}</button><div><p class="lp-net-kicker">${kicker}</p><h2>${esc(title)}</h2></div></header>`;
    if (!v.lobbyId || !v.lobby) {
      const others = online.filter(p => !p.self).length;
      const chips = online.length ? `<div class="lp-net-chips">${online.slice(0, 16).map(p => `<span class="${p.self ? 'self' : ''}">${avatar(p.avatarUrl, p.name)}${esc(p.name)}${p.self ? ' (you)' : ''}</span>`).join('')}</div>` : '';
      return `<div class="lp-net-panel">${head(`Online · <span class="lp-net-count"><i></i>${online.length} in the harbor</span>`, 'Race the harbor', 'close', 'Close online')}<div class="lp-net-body">${notice}
<button class="lp-net-go lp-net-quick" data-net="quick" data-key="quick"${v.joining ? ' disabled' : ''}>${ICON.bolt}<span><b>${v.joining ? 'Joining' : 'Quick match'}</b><small>${others ? 'Join an open race, or open a lobby for them' : 'Open a lobby. Others join you.'}</small></span></button>
<div class="lp-net-modes"><button data-net="quick-time" data-key="qt">Time trial<small>Fastest clean lap</small></button><button data-net="quick-drift" data-key="qd">Drift battle<small>Highest score</small></button><button data-net="free-roam" data-key="roam">Free roam<small>Cruise together</small></button></div>
${chips ? `<h3>Drivers online</h3>${chips}` : ''}${renderBoards(v)}<button class="lp-net-link" data-net="offline" data-key="offline">Go offline</button></div></div>`;
    }
    const lobby = v.lobby;
    let status: string;
    if (lobby.ph === 'w') {
      const readyCount = v.members.filter(m => m.ready).length;
      const hostNow = Date.now() + v.clockOffsetMs;
      const left = lobby.rt ? Math.max(0, Math.ceil((READY_TIMER_MS - (hostNow - lobby.rt)) / 1000)) : 0;
      status = v.members.length < 2
        ? 'Ready up to race now, or wait for drivers to join.'
        : lobby.rt ? `${readyCount} of ${v.members.length} ready. Race starts in <b>${left}</b>` : `${readyCount} of ${v.members.length} ready. Starts when everyone is.`;
    } else if (v.startInMs !== null) status = `Green light in <b>${Math.ceil(v.startInMs / 1000)}</b>`;
    else status = v.racing ? 'Race on.' : 'Race in progress. You are in the next one.';
    const routes = routeList().filter(route => EVENTS.some(event => event.routeId === route.id && event.mode === lobby.mode));
    const pick = v.isHost && lobby.ph === 'w'
      ? `<div class="lp-net-pick"><div class="lp-net-seg" role="group" aria-label="Mode">${(['time-trial', 'drift-attack'] as const).map(mode => `<button data-net="pick-mode" data-mode="${mode}" data-key="m-${mode}" aria-pressed="${lobby.mode === mode}">${MODE_NAME[mode]}</button>`).join('')}</div>${routes.length > 1 ? `<div class="lp-net-seg" role="group" aria-label="Route">${routes.map(route => `<button data-net="pick-route" data-route="${esc(route.id)}" data-key="r-${esc(route.id)}" aria-pressed="${lobby.route === route.id}">${esc(route.name)}</button>`).join('')}</div>` : ''}</div>`
      : '';
    const empty = Math.max(0, Math.min(2, 8 - v.members.length));
    const roster = `<ul class="lp-net-roster">${v.members.map((m, i) => rosterRow(m, i)).join('')}${Array.from({ length: v.members.length < 2 ? empty : 0 }, () => '<li class="empty"><i class="ln-av"></i><span class="ln-who"><small>Open slot</small></span></li>').join('')}</ul>`;
    const ready = lobby.ph === 'w' ? (v.ready ? '<button class="lp-net-ready" data-net="unready" data-key="ready">Ready ✓<small>Tap to cancel</small></button>' : '<button class="lp-net-go lp-net-ready" data-net="ready" data-key="ready">Ready up</button>') : '';
    return `<div class="lp-net-panel">${head(`Lobby · ${v.members.length}/8 drivers`, MODE_NAME[lobby.mode], 'leave', 'Leave lobby')}<div class="lp-net-body">${notice}
<div class="lp-net-event"><b>${esc(routeName(lobby.route))}</b><span>${esc(MODE_LINE[lobby.mode])}</span><em>${v.isHost ? 'You pick' : 'Host picks'}</em></div>${pick}
<p class="lp-net-status" aria-live="polite">${status}</p><h3>Drivers</h3>${roster}${renderBoards(v)}</div><footer class="lp-net-foot">${ready}<button data-net="leave" data-key="leave2">Leave</button></footer></div>`;
  }
  function rosterRow(m: NetMember, i: number): string {
    return `<li class="${m.self ? 'self' : ''}" style="animation-delay:${i * 50}ms">${avatar(m.avatarUrl, m.name)}<span class="ln-who"><b>${m.host ? `${ICON.crown}` : ''}${esc(m.name)}${m.self ? ' (you)' : ''}${(hooks.badges?.(m.id) ?? []).slice(0, 3).map(b => `<i class="lf-badge ln-badge" data-tier="${esc(b.tier)}" title="${esc(b.name)}" aria-label="${esc(b.name)}">${esc(b.badge)}</i>`).join('')}</b><small>${esc(CAR_NAME[m.car] ?? m.car)}${m.host ? ' · Host' : ''}</small></span>${ping(m.pingMs)}<span class="ln-state ${m.ready ? 'on' : ''}">${m.ready ? 'Ready' : 'Waiting'}</span></li>`;
  }
  function renderBoards(v: OnlineView): string {
    const route = v.lobby?.route;
    const column = (mode: RaceMode): string => {
      const rows = v.leaderboard[mode].slice(0, 6);
      return `<div><p class="lp-net-kicker">${mode === 'time-trial' ? 'Best lap' : 'Best drift'}</p>${rows.length
        ? `<ol>${rows.map((r, i) => `<li><span>${i + 1}. ${esc(r.username)}</span><b>${formatValue(mode, r.value)}${assistBadge(r.assist)}</b></li>`).join('')}</ol>`
        : '<p>No times yet. Set the first.</p>'}</div>`;
    };
    return `<h3>Leaderboard${route ? ` · ${esc(routeName(route))}` : ''}</h3><div class="lp-net-boards">${column('time-trial')}${column('drift-attack')}</div>`;
  }
  function renderCard(v: OnlineView): string {
    const done = v.lobby?.race !== v.race;
    const ranked = v.standings;
    const avatarOf = (id: string) => v.players.find(p => p.id === id)?.avatarUrl ?? '';
    const podium = podiumOrder(ranked.slice(0, 3)).map(s => `<div class="ln-step p${s.position}${s.self ? ' self' : ''}">${avatar(avatarOf(s.id), s.name)}<b>${esc(s.name)}</b><small>${result(v, s, done)}</small><div class="ln-block">${s.position}</div></div>`).join('');
    const rest = ranked.slice(3).map(s => `<li class="${s.self ? 'self' : ''}"><b>${ordinal(s.position)}</b><span>${esc(s.name)}</span><b>${result(v, s, done)}</b></li>`).join('');
    const me = ranked.find(s => s.self);
    const readyNext = v.members.filter(m => m.ready).length;
    return `<div class="ln-results"><p class="lp-net-kicker">${esc(MODE_NAME[v.raceMode])} · ${esc(routeName(v.lobby?.route ?? ''))}</p><h2>${done ? (me?.finished ? (me.position === 1 ? 'You won' : `You finished ${ordinal(me.position)}`) : 'Final results') : 'Waiting for finishers'}</h2><div class="ln-podium">${podium}</div>${rest ? `<ol class="ln-rest">${rest}</ol>` : ''}<div class="ln-actions"><button class="lp-net-go" data-net="again" data-key="again">Rematch${readyNext ? ` · ${readyNext} ready` : ''}</button><button data-net="lobby" data-key="lobby">Lobby</button><button data-net="dismiss" data-key="dismiss">Close</button></div></div>`;
  }

  const onClick = (event: Event): void => {
    const target = (event.target as Element).closest<HTMLElement>('[data-net]');
    const session = feature.session();
    if (!target || !session) return;
    const action = target.dataset.net;
    if (action === 'close') api.close();
    else if (action === 'quick') session.quickMatch();
    else if (action === 'quick-time') session.quickRace('time-trial');
    else if (action === 'quick-drift') session.quickRace('drift-attack');
    else if (action === 'free-roam') { api.close(); hooks.onFreeRoam(); }
    else if (action === 'ready') session.setReady(true);
    else if (action === 'unready') session.setReady(false);
    else if (action === 'leave') session.leaveLobby();
    else if (action === 'offline') { session.goOffline(); api.close(); }
    else if (action === 'pick-mode' && target.dataset.mode) { const lobby = session.view().lobby; if (lobby) { const mode = target.dataset.mode as RaceMode; const route = EVENTS.some(e => e.routeId === lobby.route && e.mode === mode) ? lobby.route : EVENTS.find(e => e.mode === mode)?.routeId ?? lobby.route; session.setLobbyOptions(mode, route); } }
    else if (action === 'pick-route' && target.dataset.route) { const lobby = session.view().lobby; if (lobby) session.setLobbyOptions(lobby.mode, target.dataset.route); }
    else if (action === 'again') { cardDismissedRace = session.view().race; session.dismissResults(); session.setReady(true); api.open(); }
    else if (action === 'lobby') { cardDismissedRace = session.view().race; session.dismissResults(); api.open(); }
    else if (action === 'dismiss') { cardDismissedRace = session.view().race; session.dismissResults(); }
    render();
  };
  root.addEventListener('click', onClick);
  card.addEventListener('click', onClick);
  // pointerdown, not click: instant on touch and never steals a held driving control.
  const onHorn = (event: PointerEvent): void => { event.preventDefault(); event.stopPropagation(); feature.session()?.horn(); };
  hornButton.addEventListener('pointerdown', onHorn);

  const api: OnlinePanel = {
    get isOpen() { return open; },
    open() {
      const session = feature.session();
      if (!session) return;
      session.goOnline(hooks.currentCar() as never);
      open = true; view = session.view(); lastPanel = ''; render();
    },
    close() { if (!open) return; open = false; render(); hooks.onClosed(); },
    dispose() {
      unsubscribe(); window.clearInterval(poll);
      root.removeEventListener('click', onClick); card.removeEventListener('click', onClick);
      hornButton.removeEventListener('pointerdown', onHorn);
      root.remove(); hud.remove(); big.remove(); card.remove(); toasts.remove(); hornButton.remove(); style.remove();
    },
  };
  return api;
}

function renderHud(v: OnlineView): string {
  const me = v.standings.find(s => s.self);
  // Show the leader and the drivers around you: at most five rows.
  const around = me ? v.standings.filter(s => Math.abs(s.position - me.position) <= 2 || s.position === 1).slice(0, 5) : v.standings.slice(0, 5);
  const rows = around.map(s => `<li class="${s.self ? 'self' : ''}"><em>${s.position}</em><span>${esc(s.name)}</span><b>${s.finished ? (v.raceMode === 'time-trial' ? formatValue('time-trial', s.timeMs) : 'Done') : v.raceMode === 'drift-attack' ? s.score.toLocaleString('en-US') : s.invalid ? 'Out' : `CP ${s.checkpoint}`}</b></li>`).join('');
  return `<div class="ln-pos${me?.position === 1 ? ' p1' : ''}"><b>${me ? ordinal(me.position) : '-'}</b><small>/ ${v.standings.length}</small></div><ol>${rows}</ol>`;
}
