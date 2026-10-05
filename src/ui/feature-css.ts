/**
 * Styles for the feature layers (daily, leaderboards and ghosts, profile, photo mode, replay, toasts). Everything sits
 * inside .lp-shell, so it inherits the game's fonts and palette variables. No blur on low quality, safe areas respected,
 * phone portrait and short landscape layouts included.
 */
export const FEATURE_CSS = `
.lf-layer{position:absolute;inset:0;z-index:57;display:grid;place-items:center;padding:max(14px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));background:rgba(2,7,9,.8);pointer-events:auto;font-family:var(--lp-font);color:var(--lp-ink);animation:lf-fade .22s ease both}
.lp-shell:not([data-quality=low]) .lf-layer{backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
.lf-card{position:relative;display:flex;flex-direction:column;width:min(760px,100%);max-height:100%;min-height:0;background:rgba(6,13,15,.97);border:1px solid var(--lp-line-strong);border-left:3px solid var(--lp-accent);clip-path:polygon(0 0,calc(100% - 20px) 0,100% 20px,100% 100%,18px 100%,0 calc(100% - 18px));outline:none;animation:lf-rise .36s cubic-bezier(.16,.84,.24,1) both}
.lf-head{display:flex;align-items:flex-start;gap:14px;padding:18px 20px 8px}
.lf-head>div{flex:1;min-width:0}
.lf-kicker{margin:0 0 4px;font-size:.7em;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--lp-hot)}
.lf-title{margin:0;font:800 clamp(1.9em,5.4vw,2.8em)/.92 var(--lp-stencil);font-style:italic;letter-spacing:.03em;text-transform:uppercase;overflow-wrap:anywhere}
.lf-sub{margin:.45em 0 0;font-size:.95em;color:var(--lp-dim);letter-spacing:.03em}
.lp-shell .lf-close{--cut:8px;flex:none;width:44px;height:44px;min-height:44px;padding:0;display:grid;place-items:center;font:700 1.3em/1 var(--lp-font)}
.lf-body{overflow:auto;min-height:0;padding:4px 20px 16px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.lf-body h4{margin:16px 0 8px;font-size:.68em;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--lp-teal)}
.lf-foot{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding:12px 20px 16px;border-top:1px solid var(--lp-line)}
.lp-shell .lf-go{--cut:12px;background-color:var(--lp-accent);color:var(--lp-on-accent);border-color:transparent;font-weight:700;letter-spacing:.12em;min-height:48px;padding:.6em 1.6em}
.lp-shell .lf-go:hover:not(:disabled){background-color:#ecffab;color:var(--lp-on-accent)}
.lp-shell .lf-go:focus-visible{outline-color:var(--lp-night);outline-offset:-5px;background-color:#ecffab;border-color:transparent;color:var(--lp-on-accent)}
.lf-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.lf-chip{display:inline-flex;align-items:center;gap:6px;padding:.3em .7em;font-size:.74em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;border:1px solid var(--lp-line-strong);background:rgba(255,255,255,.04)}
.lf-chip.hot{border-color:var(--lp-hot);color:#ffc58a;background:rgba(255,138,31,.1)}
.lf-chip.ok{border-color:var(--lp-accent);color:var(--lp-accent);background:rgba(216,250,114,.08)}
.lf-clock{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:12px 0 0;padding:10px 12px;background:rgba(255,255,255,.04);border:1px solid var(--lp-line)}
.lf-clock span{font-size:.78em;letter-spacing:.16em;text-transform:uppercase;color:var(--lp-faint)}
.lf-clock b{font:800 1.7em/1 var(--lp-display);letter-spacing:.06em;color:var(--lp-accent);font-variant-numeric:tabular-nums}
.lf-tiers{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.lf-tier{display:grid;gap:3px;padding:9px 10px;border:1px solid var(--lp-line);background:rgba(255,255,255,.03)}
.lf-tier b{font:800 1.45em/1 var(--lp-display);color:var(--lp-accent);font-variant-numeric:tabular-nums}
.lf-tier small{font-size:.72em;color:var(--lp-dim);letter-spacing:.04em}
.lf-tier.done{border-color:var(--lp-accent);background:rgba(216,250,114,.09)}
.lf-tier.done b::after{content:" \\2713";font-size:.7em}
.lf-board{margin:0;padding:0;list-style:none;display:grid;gap:4px}
.lf-row{display:grid;grid-template-columns:2.2em minmax(0,1fr) auto auto;gap:10px;align-items:center;min-height:40px;padding:5px 10px;background:rgba(255,255,255,.035);border-left:3px solid transparent}
.lf-row.me{border-left-color:var(--lp-accent);background:rgba(216,250,114,.08)}
.lf-row.p1 .lf-rank{color:#ffd166}.lf-row.p2 .lf-rank{color:#d7e1e6}.lf-row.p3 .lf-rank{color:#e3a36d}
.lf-rank{font:800 1.2em/1 var(--lp-display);color:var(--lp-faint);text-align:right;font-variant-numeric:tabular-nums}
.lf-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;letter-spacing:.03em}
.lf-name small{margin-left:.5em;font-size:.72em;font-weight:700;letter-spacing:.1em;color:var(--lp-teal)}
.lf-val{font:700 1.15em/1 var(--lp-display);letter-spacing:.04em;font-variant-numeric:tabular-nums}
.lp-shell .lf-row button{--cut:6px;min-height:34px;padding:.3em .8em;font-size:.72em;letter-spacing:.1em}
.lf-empty{margin:10px 0;color:var(--lp-faint);font-size:.9em}
.lf-note{margin:10px 0 0;font-size:.82em;color:var(--lp-faint);line-height:1.4}
.lf-tabs{display:flex;gap:6px;margin:4px 0 6px;overflow-x:auto}
.lp-shell .lf-tabs button{--cut:0px;clip-path:none;min-height:40px;padding:.45em 1em;font-size:.78em;border:0;border-bottom:3px solid transparent;background:none;letter-spacing:.12em}
.lp-shell .lf-tabs button[aria-selected=true]{border-bottom-color:var(--lp-accent);color:var(--lp-ink)}
.lp-shell .lf-tabs button:hover:not(:disabled){transform:none}
.lf-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.lp-shell .lf-hero-ghost{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;width:100%;min-height:64px;margin:6px 0 0;padding:.6em 1em;text-align:left;text-transform:none;letter-spacing:.02em;border-color:var(--lp-accent);background-color:rgba(216,250,114,.08)}
.lf-hero-ghost i{display:grid;place-items:center;width:38px;height:38px;font:800 1.1em/1 var(--lp-display);font-style:normal;color:var(--lp-on-accent);background:var(--lp-accent);clip-path:polygon(50% 0,100% 30%,100% 100%,50% 82%,0 100%,0 30%)}
.lf-hero-ghost b{display:block;font:800 1.3em/1.05 var(--lp-display);letter-spacing:.05em;text-transform:uppercase}
.lf-hero-ghost small{display:block;font-size:.8em;color:var(--lp-dim)}
.lf-hero-ghost em{font:800 1.4em/1 var(--lp-display);font-style:normal;color:var(--lp-accent);font-variant-numeric:tabular-nums}
.lf-profile-head{display:flex;align-items:center;gap:14px}
.lf-avatar{flex:none;width:58px;height:58px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font:800 1.6em/1 var(--lp-display);background:var(--lp-teal-deep);box-shadow:0 0 0 2px rgba(216,250,114,.7)}
.lf-badges{display:flex;gap:6px;margin-top:6px}
.lf-badge{display:inline-grid;place-items:center;min-width:30px;height:30px;padding:0 4px;font:800 .78em/1 var(--lp-display);letter-spacing:.04em;color:#0d1505;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)}
.lf-badge[data-tier=bronze]{background:linear-gradient(160deg,#f1b27a,#a8602f)}
.lf-badge[data-tier=silver]{background:linear-gradient(160deg,#f4f8fa,#9aa8b0)}
.lf-badge[data-tier=gold]{background:linear-gradient(160deg,#fff0a6,#e0a21c);box-shadow:0 0 12px rgba(255,209,102,.5)}
.lf-badge.off{background:rgba(255,255,255,.08);color:var(--lp-faint)}
.lf-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.lf-stat{padding:9px 10px;border:1px solid var(--lp-line);background:rgba(255,255,255,.03)}
.lf-stat b{display:block;font:800 1.6em/1 var(--lp-display);font-variant-numeric:tabular-nums}
.lf-stat small{font-size:.7em;letter-spacing:.14em;text-transform:uppercase;color:var(--lp-faint)}
.lf-ach{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0;padding:0;list-style:none}
.lf-ach li{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:center;padding:9px 10px;border:1px solid var(--lp-line);background:rgba(255,255,255,.03)}
.lf-ach li.got{border-color:rgba(216,250,114,.5)}
.lf-ach .lf-badge{grid-row:1/3}
.lf-ach b{font-weight:700;letter-spacing:.03em}
.lf-ach small{font-size:.8em;color:var(--lp-dim)}
.lf-bar{grid-column:2;height:5px;background:rgba(255,255,255,.08);overflow:hidden}
.lf-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--lp-teal),var(--lp-accent))}
/* toasts and in-race chip */
.lf-toasts{display:grid;gap:6px;width:min(440px,calc(100vw - 24px));pointer-events:none;font-family:var(--lp-font)}
.lf-toast{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:9px 14px 9px 10px;color:var(--lp-ink);background:rgba(4,10,12,.94);border:1px solid rgba(216,250,114,.45);border-left:4px solid var(--lp-accent);animation:lf-toast .35s cubic-bezier(.2,1.2,.4,1) both}
.lf-toast.out{animation:lf-out .3s ease-in both}
.lf-toast .lf-badge{min-width:28px;height:28px}
.lf-toast p{margin:0;font-size:.66em;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--lp-teal)}
.lf-toast strong{display:block;font-size:.98em;letter-spacing:.03em}
.lf-toast em{font:800 1.3em/1 var(--lp-display);font-style:normal;color:var(--lp-accent);font-variant-numeric:tabular-nums}
.lf-ghost-chip{display:flex;align-items:center;gap:8px;padding:.35em .8em;font-size:.78em;letter-spacing:.08em;background:rgba(4,10,12,.82);border:1px solid rgba(216,250,114,.4);border-left:3px solid var(--lp-accent);pointer-events:none}
.lf-ghost-chip b{font:800 1.15em/1 var(--lp-display);color:var(--lp-accent);font-variant-numeric:tabular-nums}
.lf-ghost-chip[hidden]{display:none}
/* photo and replay hide the game panels underneath */
.lp-shell[data-lf-photo] .lp-overlay,.lp-shell[data-lf-photo] .lp-telemetry,.lp-shell[data-lf-photo] .lp-route-guide,.lp-shell[data-lf-photo] .lp-slot,
.lp-shell[data-lf-replay] .lp-overlay,.lp-shell[data-lf-replay] .lp-telemetry,.lp-shell[data-lf-replay] .lp-route-guide,.lp-shell[data-lf-replay] .lp-slot-tl2{display:none!important}
.lf-photo,.lf-replay{position:absolute;inset:0;z-index:56;pointer-events:none;font-family:var(--lp-font);color:var(--lp-ink)}
.lf-capture{position:absolute;inset:0;pointer-events:auto;touch-action:none;cursor:grab}
.lf-capture:active{cursor:grabbing}
.lf-dof{position:absolute;inset:0;pointer-events:none;backdrop-filter:blur(var(--lf-blur,0px));-webkit-backdrop-filter:blur(var(--lf-blur,0px))}
.lf-vig{position:absolute;inset:0;pointer-events:none}
.lf-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.lf-flash.on{animation:lf-flash .45s ease-out}
.lf-panel{position:absolute;right:max(14px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));bottom:max(14px,env(safe-area-inset-bottom));width:min(330px,calc(100% - 28px));display:flex;flex-direction:column;pointer-events:auto;background:rgba(6,13,15,.93);border:1px solid var(--lp-line-strong);border-left:3px solid var(--lp-accent);clip-path:polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,0 100%);animation:lf-slide .3s cubic-bezier(.16,.84,.24,1) both}
.lf-panel .lf-body{padding:4px 16px 12px}
.lf-panel .lf-head{padding:14px 16px 4px}
.lf-panel .lf-title{font-size:1.9em}
.lf-ctl{display:grid;grid-template-columns:5.2em minmax(0,1fr) 3.2em;gap:8px;align-items:center;margin:8px 0;font-size:.82em;letter-spacing:.08em;text-transform:uppercase;color:var(--lp-dim)}
.lf-ctl input{width:100%;accent-color:var(--lp-accent);min-height:28px}
.lf-ctl output{font:700 1.05em/1 var(--lp-display);color:var(--lp-ink);text-align:right;font-variant-numeric:tabular-nums}
.lf-seg{display:flex;flex-wrap:wrap;gap:4px}
.lp-shell .lf-seg button{--cut:0px;clip-path:none;min-height:36px;padding:.35em .8em;font-size:.74em;letter-spacing:.1em}
.lp-shell .lf-seg button[aria-pressed=true]{background-color:var(--lp-teal-deep);border-color:var(--lp-accent);color:var(--lp-accent)}
.lp-shell .lf-seg button:hover:not(:disabled){transform:none}
.lf-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 16px 14px;border-top:1px solid var(--lp-line)}
.lp-shell .lf-actions button{min-height:44px;font-size:.78em;letter-spacing:.1em}
.lf-actions .lf-go{grid-column:1/-1}
/* While the share sheet is open its own Cancel and Post are the actions: give it the room. */
.lf-panel:has(.lf-share:not([hidden])) .lf-actions{display:none}
.lf-hint{margin:6px 0 0;font-size:.74em;color:var(--lp-faint);line-height:1.4}
.lf-msg{min-height:1.2em;margin:6px 0 0;font-size:.8em;color:var(--lp-accent)}
.lf-msg.err{color:var(--lp-hot)}
.lf-share{display:grid;gap:8px;margin:8px 0 0;scroll-margin-bottom:12px;padding:10px;border:1px solid var(--lp-line);background:rgba(255,255,255,.04)}
.lf-share textarea{width:100%;min-height:64px;resize:vertical;padding:8px;font:500 .9em/1.35 var(--lp-font);color:var(--lp-ink);background:rgba(0,0,0,.4);border:1px solid var(--lp-line-strong);border-radius:0}
.lf-share div{display:flex;gap:6px;justify-content:flex-end}
.lp-shell .lf-show{position:absolute;right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));pointer-events:auto;min-height:44px;padding:.5em 1em;font-size:.74em;opacity:.7}
.lf-photo.bare .lf-panel,.lf-replay.bare .lf-rbar,.lf-replay.bare .lf-rtop{display:none}
.lf-photo:not(.bare) .lf-show{display:none}
.lf-replay:not(.bare) .lf-show{display:none}
/* replay */
.lf-bars::before,.lf-bars::after{content:"";position:absolute;left:0;right:0;height:7vh;background:#000;pointer-events:none;animation:lf-bars .5s ease both}
.lf-bars::before{top:0}.lf-bars::after{bottom:0}
.lf-rtop{position:absolute;left:max(16px,env(safe-area-inset-left));top:calc(max(14px,env(safe-area-inset-top)) + 7vh);display:flex;align-items:center;gap:10px;pointer-events:none}
.lf-rec{display:flex;align-items:center;gap:8px;padding:.35em .8em;font:800 .9em/1 var(--lp-display);letter-spacing:.2em;background:rgba(4,10,12,.8);border-left:3px solid var(--lp-hot)}
.lf-rec i{width:9px;height:9px;border-radius:50%;background:#e5362b;animation:lf-blink 1.2s steps(2) infinite}
.lf-shot{font-size:.74em;letter-spacing:.2em;text-transform:uppercase;color:var(--lp-dim)}
.lf-tele{display:flex;gap:16px;padding:.35em .8em;background:rgba(4,10,12,.7);font-size:.78em;letter-spacing:.1em;color:var(--lp-dim)}
.lf-tele b{font:800 1.4em/1 var(--lp-display);color:var(--lp-ink);font-variant-numeric:tabular-nums;margin-right:4px}
.lf-rbar{position:absolute;left:50%;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 7vh);transform:translateX(-50%);width:min(980px,calc(100% - 24px));display:grid;gap:8px;padding:10px 12px;pointer-events:auto;background:rgba(6,13,15,.9);border:1px solid var(--lp-line-strong);animation:lf-rise .3s cubic-bezier(.16,.84,.24,1) both}
.lf-scrub{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center}
.lf-scrub input{width:100%;accent-color:var(--lp-accent);min-height:30px}
.lf-scrub output{font:700 1em/1 var(--lp-display);font-variant-numeric:tabular-nums;color:var(--lp-dim);min-width:8.5em;text-align:right}
.lp-shell .lf-play{--cut:6px;width:46px;min-height:44px;padding:0;font:800 1.1em/1 var(--lp-display)}
.lf-rrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.lf-rrow .lf-seg{flex:1 1 auto}
.lf-rrow>div:last-child{display:flex;gap:6px}
.lp-shell .lf-rrow>div:last-child button{min-height:40px;font-size:.74em;padding:.4em .9em}
/* main menu: daily card, profile chip button, ghost link, lobby badges */
.lp-shell .lt-root .lt-daily{--cut:14px;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"k k" "b r" "s r";column-gap:12px;row-gap:3px;align-items:center;min-height:74px;padding:.6em 1.1em .7em;text-align:left;text-transform:none;letter-spacing:.02em;background-color:rgba(255,138,31,.1);border:1px solid rgba(255,138,31,.55);border-left:3px solid var(--lp-hot)}
.lp-shell .lt-root .lt-daily:hover:not(:disabled){background-color:rgba(255,138,31,.2);border-color:var(--lp-hot);color:var(--lp-ink);transform:translateX(4px)}
.lt-daily-k{grid-area:k;display:flex;align-items:center;gap:.6em;font-size:.66em;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:var(--lp-hot)}
.lt-daily-k i{width:8px;height:8px;background:var(--lp-hot);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);animation:lf-blink 1.6s steps(2) infinite}
.lt-daily-k em{margin-left:auto;font:700 1.05em/1 var(--lp-display);font-style:normal;letter-spacing:.08em;color:var(--lp-ink);font-variant-numeric:tabular-nums}
.lt-daily b{grid-area:b;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:800 1.5em/1 var(--lp-display);letter-spacing:.05em;text-transform:uppercase}
.lt-daily small{grid-area:s;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8em;color:var(--lp-dim)}
.lt-daily strong{grid-area:r;align-self:center;padding:.35em .6em;font:700 .72em/1.2 var(--lp-font);letter-spacing:.1em;text-transform:uppercase;color:#1a0d00;background:linear-gradient(90deg,var(--lp-hot),#ffc15a);white-space:nowrap}
.lt-daily.done strong{color:var(--lp-on-accent);background:var(--lp-accent)}
.lp-shell .lt-root .lt-profile-btn{--cut:0px;clip-path:none;min-height:40px;padding:4px 12px 4px 4px;text-transform:none;letter-spacing:.04em;background-color:rgba(5,12,14,.62);border:1px solid var(--lp-line);cursor:pointer}
.lp-shell .lt-root .lt-profile-btn:hover:not(:disabled){border-color:var(--lp-accent);background-color:rgba(216,250,114,.1);color:var(--lp-ink);transform:none}
.lp-shell .lt-root .lt-ghostlink{display:grid;gap:3px;width:100%;min-height:56px;padding:.6em 1em;text-align:left;text-transform:none;letter-spacing:.02em;background-color:rgba(255,255,255,.03)}
.lt-ghostlink b{font:800 1.15em/1 var(--lp-display);letter-spacing:.06em;text-transform:uppercase}
.lt-ghostlink small{font-size:.8em;color:var(--lp-dim)}
.lp-net-roster .ln-badge{display:inline-grid;min-width:20px;height:20px;margin-left:5px;font-size:.62em;font-style:normal;vertical-align:middle}
@media (max-height:520px) and (orientation:landscape){.lp-shell .lt-root .lt-daily{min-height:48px;padding:.4em .9em;grid-template-areas:"k r" "b r"}.lt-daily small{display:none}.lt-daily b{font-size:1.15em}}
@media (max-width:420px){.lt-daily b{font-size:1.25em}.lt-daily strong{font-size:.64em}}
/* Entrances never animate opacity: a stalled timeline (busy GPU, slow frames) must not leave a layer invisible. */
@keyframes lf-fade{from{background-color:rgba(2,7,9,0)}}
@keyframes lf-rise{from{transform:translate3d(0,14px,0)}to{transform:none}}
.lf-rbar{animation-name:lf-rise-c}
@keyframes lf-rise-c{from{transform:translate(-50%,14px)}to{transform:translate(-50%,0)}}
@keyframes lf-slide{from{transform:translate3d(24px,0,0)}to{transform:none}}
@keyframes lf-toast{0%{transform:translateY(-14px) scale(.95)}100%{transform:none}}
@keyframes lf-out{to{opacity:0;transform:translateY(-10px)}}
@keyframes lf-flash{0%{opacity:.85}100%{opacity:0}}
@keyframes lf-bars{from{transform:scaleY(0)}to{transform:none}}
@keyframes lf-blink{50%{opacity:.2}}
@media (max-width:640px){
.lf-cols{grid-template-columns:1fr}.lf-tiers{grid-template-columns:repeat(2,minmax(0,1fr))}.lf-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.lf-ach{grid-template-columns:1fr}
.lf-head{padding:14px 14px 6px}.lf-body{padding:4px 14px 12px}.lf-foot{padding:10px 14px 12px}
.lf-row{grid-template-columns:1.8em minmax(0,1fr) auto;row-gap:4px}.lf-row button{grid-column:2/-1;justify-self:end}
}
@media (orientation:portrait) and (max-width:900px){
.lf-panel{top:auto;left:max(10px,env(safe-area-inset-left));right:max(10px,env(safe-area-inset-right));width:auto;max-height:46vh;clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,0 100%)}
.lf-rbar{bottom:calc(max(10px,env(safe-area-inset-bottom)) + 4vh)}
.lf-bars::before,.lf-bars::after{height:4vh}
.lf-rtop{top:calc(max(12px,env(safe-area-inset-top)) + 4vh)}
}
@media (max-height:520px) and (orientation:landscape){
.lf-panel{width:min(300px,46vw)}.lf-panel .lf-title{font-size:1.4em}.lf-ctl{margin:4px 0}
.lf-actions{padding:8px 12px 10px;gap:4px}.lf-actions .lf-go{grid-column:auto;min-height:40px;padding:.4em .6em}.lp-shell .lf-actions button{min-height:40px}
.lf-bars::before,.lf-bars::after{height:0}
.lf-rtop{top:max(10px,env(safe-area-inset-top))}
.lf-rbar{bottom:max(8px,env(safe-area-inset-bottom));padding:6px 10px;gap:4px}
.lf-card{max-height:100%}.lf-title{font-size:1.6em}
}
@media (prefers-reduced-motion:reduce){.lf-layer,.lf-card,.lf-toast,.lf-toast.out,.lf-panel,.lf-rbar,.lf-flash.on,.lf-bars::before,.lf-bars::after,.lf-rec i{animation:none}}
`;

/** Small DOM builder: every string goes in through textContent. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
export function button(className: string, text: string, onClick: () => void, label?: string): HTMLButtonElement {
  const node = h('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return node;
}
export function ensureStyle(id: string, css: string): void {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id; style.textContent = css;
  document.head.append(style);
}
