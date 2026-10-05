/**
 * Showroom styling. Lives inside .lp-shell, so it inherits the palette, fonts and cut-corner buttons from
 * src/ui/player-ui-css.ts. Desktop: tabs left, detail card right, rail at the bottom. Phone portrait: tabs
 * under the header, card and rail stacked at the bottom. Short landscape: everything compacts to the edges.
 */
export const SHOWROOM_CSS = `
.lp-shell.lp-showroom-open>:not(.lp-sr):not(.lp-error):not(.lp-live):not(.lp-gf){visibility:hidden!important}
.lp-sr{position:absolute;inset:0;z-index:40;pointer-events:auto;overflow:hidden;color:var(--lp-ink);font-family:var(--lp-font);-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.lp-sr::before{content:"";position:absolute;inset:0;z-index:20;background:#020405;opacity:0;pointer-events:none;transition:opacity .8s ease}
.lp-sr.is-entering::before{animation:lp-sr-curtain 1s ease forwards}
@keyframes lp-sr-curtain{0%{opacity:1}35%{opacity:1}100%{opacity:0}}
.lp-sr-drag{position:absolute;inset:0;touch-action:none;cursor:grab}
.lp-sr.is-orbiting .lp-sr-drag{cursor:grabbing}
.lp-sr-shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(2,5,6,.78) 0,rgba(2,5,6,0) 22%,rgba(2,5,6,0) 62%,rgba(2,5,6,.86) 100%)}
.lp-sr-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:flex-start;gap:16px;padding:max(16px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) 0 max(24px,env(safe-area-inset-left));pointer-events:none}
.lp-sr-top>*{pointer-events:auto}
.lp-sr-brand{flex:1;min-width:0}
.lp-sr-kicker{display:block;font-size:.72em;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--lp-teal)}
.lp-sr-kicker i{font-style:normal;color:var(--lp-accent);margin:0 .4em}
.lp-sr-brand h2{margin:.05em 0 0;font:700 clamp(40px,6.4vw,84px)/.86 var(--lp-stencil);letter-spacing:.02em;text-transform:uppercase;color:var(--lp-ink);text-shadow:0 0 28px rgba(216,250,114,.18)}
.lp-sr-wallet{position:relative;display:flex;align-items:center}
.lp-shell .lp-sr-bal{display:flex;align-items:center;gap:.5em;min-height:48px;padding:.4em 1em .4em .6em;background-color:rgba(5,12,14,.8);border-color:var(--lp-line-strong);letter-spacing:0}
.lp-sr-bal i{display:grid;place-items:center;width:28px;height:28px;font:800 15px/1 var(--lp-display);font-style:normal;color:var(--lp-on-accent);background:var(--lp-accent);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.lp-sr-bal b{font:700 30px/1 var(--lp-num);letter-spacing:.02em;font-variant-numeric:tabular-nums;min-width:3ch;text-align:right}
.lp-sr-plus{font:700 20px/1 var(--lp-display);color:var(--lp-accent);margin-left:.15em}
.lp-sr-delta{position:absolute;right:8px;top:100%;margin-top:6px;font:700 22px/1 var(--lp-num);color:var(--lp-accent);opacity:0;text-shadow:0 0 12px rgba(216,250,114,.6)}
.lp-sr-delta.pop{animation:lp-sr-pop 1.8s ease forwards}
@keyframes lp-sr-pop{0%{opacity:0;transform:translateY(8px)}15%{opacity:1;transform:none}75%{opacity:1}100%{opacity:0;transform:translateY(-10px)}}
.lp-shell .lp-sr-close{width:48px;min-height:48px;padding:0;font-size:26px;line-height:1;background-color:rgba(5,12,14,.8)}

.lp-sr-modes{display:flex;align-self:center;gap:0;margin-right:8px}
.lp-shell .lp-sr-modes button{--cut:8px;min-height:44px;padding:.6em 1.2em;background-color:rgba(5,12,14,.75);font-size:.84em;letter-spacing:.18em}
.lp-shell .lp-sr-modes button[aria-selected=true]{--lp-edge:var(--lp-hot);background-color:var(--lp-hot);border-color:var(--lp-hot);color:#1a0d00;transform:none}
.lp-sr[data-mode=garage] .lp-sr-kicker{color:var(--lp-hot)}
.lp-sr-sw.k-v{display:grid;place-items:center;font:800 16px/1 var(--lp-display);color:#050b0d}
.lp-sr-sw.k-livery{background:repeating-linear-gradient(115deg,var(--b) 0 7px,var(--a) 7px 10px,var(--b) 10px 16px)}
.lp-sr-sw.k-tune{width:30px;height:30px;background:var(--a);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);border:0}
.lp-sr-sw.k-route{background:linear-gradient(90deg,transparent 46%,var(--a) 46% 54%,transparent 54%),repeating-linear-gradient(0deg,#1a2224 0 4px,#11181a 4px 8px)}
.lp-sr-sw.k-lighting{background:radial-gradient(circle at 30% 70%,var(--a) 0 22%,transparent 24%),linear-gradient(180deg,var(--b),#0b1214)}
.lp-sr-bar s{position:absolute;inset:0 auto 0 0;background:rgba(244,247,241,.22);text-decoration:none}
.lp-sr-bar em{opacity:.95}
.lp-sr-bar b small{display:block;font-size:11px;line-height:1}
.lp-sr-bar b small.up{color:var(--lp-accent)}.lp-sr-bar b small.down{color:var(--lp-hot)}

.lp-sr-tabs{position:absolute;left:max(24px,env(safe-area-inset-left));top:calc(50% - 20px);transform:translateY(-50%);display:flex;flex-direction:column;gap:5px;width:176px;max-height:calc(100% - 290px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;padding-right:8px}
.lp-shell .lp-sr-tabs button{flex:0 0 auto;display:flex;justify-content:space-between;align-items:baseline;gap:8px;min-height:40px;padding:.65em 1.1em;text-align:left;background-color:rgba(5,12,14,.62);font-size:.86em}
.lp-sr-tabs small{font:600 14px/1 var(--lp-num);letter-spacing:.06em;color:var(--lp-faint)}
.lp-shell .lp-sr-tabs button[aria-selected=true]{--lp-edge:var(--lp-accent);background-color:var(--lp-accent);border-color:var(--lp-accent);color:var(--lp-on-accent);transform:translateX(6px)}
.lp-sr-tabs button[aria-selected=true] small{color:var(--lp-on-accent)}
/* Short desktop windows (720p): ten Garage tabs must fit without scrolling. Phone layouts below override this. */
@media (min-height:521px) and (max-height:860px){.lp-sr-tabs{gap:4px;max-height:calc(100% - 262px)}.lp-shell .lp-sr-tabs button{min-height:35px;padding:.5em 1.1em}}

.lp-sr-card{position:absolute;right:max(24px,env(safe-area-inset-right));top:50%;transform:translateY(-54%);width:min(360px,34vw);max-height:calc(100% - 250px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none}
/* With the Custom Plate field open the card is tall: the turntable already shows the plate up close, so the flat preview goes on short screens. */
@media (max-height:860px){.lp-sr .lp-pf canvas{display:none}}
.lp-sr-card-in{--cut:18px;position:relative;padding:20px 20px 18px;background:linear-gradient(160deg,rgba(9,19,21,.9),rgba(4,9,10,.82));border:1px solid var(--lp-line);border-top:3px solid var(--rar);clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:lp-sr-card .35s cubic-bezier(.2,.8,.2,1)}
@keyframes lp-sr-card{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
.lp-sr-rar{display:flex;gap:10px;align-items:center;margin:0 0 6px;font-size:.72em;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--lp-faint)}
.lp-sr-rar span{padding:2px 8px;color:#050b0d;background:var(--rar);letter-spacing:.14em}
.lp-sr-card h3,.lp-sr-confirm h3{margin:0;font:700 clamp(30px,3.2vw,46px)/.92 var(--lp-display);text-transform:uppercase;letter-spacing:.01em}
.lp-sr-price{display:inline-flex;align-items:baseline;gap:4px;margin-top:10px;padding:4px 12px 4px 10px;font:800 30px/1 var(--lp-num);color:var(--lp-on-accent);background:var(--lp-accent);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.lp-sr-price i{font-style:normal;font-size:.6em}
.lp-sr-blurb{margin:12px 0 0;color:var(--lp-dim);font-size:.94em;line-height:1.45}
.lp-sr-spec{margin-top:14px}
.lp-sr-figs{display:grid;grid-template-columns:auto auto 1fr;gap:18px;margin-bottom:10px}
.lp-sr-figs span{display:flex;flex-direction:column}
.lp-sr-figs b{font:800 30px/1 var(--lp-num);letter-spacing:.01em}
.lp-sr-figs span:last-child b{font-size:22px;line-height:1.36;color:var(--rar);text-transform:uppercase}
.lp-sr-figs small{font-size:.66em;letter-spacing:.2em;text-transform:uppercase;color:var(--lp-faint)}
.lp-sr-bar{display:grid;grid-template-columns:62px 1fr 28px;align-items:center;gap:8px;margin:5px 0;font-size:.72em;letter-spacing:.14em;text-transform:uppercase;color:var(--lp-dim)}
.lp-sr-bar i{position:relative;height:6px;background:rgba(170,230,222,.12);clip-path:polygon(0 0,100% 0,calc(100% - 4px) 100%,0 100%)}
.lp-sr-bar em{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--lp-teal),var(--rar));animation:lp-sr-fill .7s cubic-bezier(.2,.8,.2,1)}
@keyframes lp-sr-fill{from{width:0}}
.lp-sr-bar b{font:700 15px/1 var(--lp-num);color:var(--lp-ink);text-align:right}
.lp-sr-spec p{margin:8px 0 0;font-size:.82em;color:var(--lp-dim)}
.lp-sr-card-in.is-car .lp-sr-blurb{font-size:.86em}
.lp-sr-note{margin:10px 0 0;padding:8px 10px;font-size:.84em;color:#ffd1a8;background:rgba(255,138,31,.1);border-left:2px solid var(--lp-hot)}
.lp-sr-note.calm{color:var(--lp-dim);background:rgba(47,184,173,.08);border-left-color:var(--lp-teal)}
.lp-sr-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.lp-sr-actions button{flex:1 1 auto}
.lp-shell .lp-sr button.go{--lp-edge:var(--lp-accent);background-color:var(--lp-accent);border-color:var(--lp-accent);color:var(--lp-on-accent)}
.lp-shell .lp-sr button.go:hover:not(:disabled){background-color:#e8ff9a;color:var(--lp-on-accent)}
.lp-shell .lp-sr button.go.buy{box-shadow:0 0 0 0 rgba(216,250,114,.6);animation:lp-sr-throb 2.2s ease-in-out infinite}
@keyframes lp-sr-throb{0%,100%{filter:brightness(1)}50%{filter:brightness(1.18)}}
.lp-shell .lp-sr button.hot{--lp-edge:var(--lp-hot);background-color:rgba(255,138,31,.16);border-color:var(--lp-hot);color:#ffc189}
.lp-shell .lp-sr button.ghost{background-color:transparent;flex:0 0 auto}
.lp-shell .lp-sr button:disabled{opacity:.7;cursor:default;transform:none}
.lp-sr button svg{width:12px;height:12px;vertical-align:-1px;margin-right:4px}

.lp-sr-rail{position:absolute;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:stretch;gap:8px;max-width:calc(100% - 48px);padding:4px 4px 8px;overflow-x:auto;overscroll-behavior:contain;scrollbar-width:thin;scroll-snap-type:x proximity;touch-action:pan-x}
.lp-sr-group{flex:0 0 auto;align-self:center;writing-mode:vertical-rl;transform:rotate(180deg);font-size:.66em;letter-spacing:.24em;text-transform:uppercase;color:var(--lp-teal)}
.lp-shell .lp-sr-item{--cut:10px;flex:0 0 132px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-height:0;padding:10px 10px 9px;text-align:left;text-transform:none;letter-spacing:0;background-color:rgba(5,12,14,.78);border-color:var(--lp-line);border-bottom:2px solid var(--rar);scroll-snap-align:center}
.lp-shell .lp-sr-item:hover:not(:disabled){transform:translateY(-3px);color:var(--lp-ink)}
.lp-shell .lp-sr-item[aria-selected=true]{--lp-edge:var(--lp-accent);border-color:var(--lp-accent);background-color:rgba(216,250,114,.1);transform:translateY(-6px);box-shadow:0 10px 24px rgba(0,0,0,.4)}
.lp-sr-name{font-weight:600;font-size:.86em;line-height:1.15;min-height:2.3em}
.lp-sr-item b{display:inline-flex;align-items:center;gap:4px;font:700 16px/1 var(--lp-num);letter-spacing:.04em}
.lp-sr-item b svg{width:10px;height:11px;margin:0}
.t-buy{color:var(--lp-accent)}
.t-lock{color:var(--lp-faint)}
.t-own{color:var(--lp-teal)}
.t-eq{color:var(--lp-on-accent);background:var(--lp-accent);padding:2px 6px}
.lp-sr-item.s-short .lp-sr-sw,.lp-sr-item.s-locked .lp-sr-sw{filter:saturate(.75) brightness(.85)}
.lp-sr-on{position:absolute;top:8px;right:8px;width:8px;height:8px;background:var(--lp-accent);box-shadow:0 0 10px var(--lp-accent);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.lp-sr-sw{position:relative;display:block;width:46px;height:30px;background:linear-gradient(135deg,var(--a),var(--b) 55%,var(--c));border:1px solid rgba(255,255,255,.14)}
.lp-sr-sw.f-chrome,.lp-sr-sw.f-pearl,.lp-sr-sw.f-chameleon,.lp-sr-sw.f-candy{background:linear-gradient(115deg,var(--a) 0,var(--b) 38%,#fff8 46%,var(--b) 54%,var(--c) 100%)}
.lp-sr-sw.f-metallic{background:radial-gradient(circle at 30% 30%,#fff5,transparent 40%),linear-gradient(135deg,var(--a),var(--b))}
.lp-sr-sw.f-matte{filter:saturate(.8)}
.lp-sr-sw.k-rim{width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,#050b0d 0 26%,var(--b) 28% 44%,var(--a) 46% 70%,#111 72%)}
.lp-sr-sw.k-underglow{height:12px;margin:9px 0;background:var(--a);box-shadow:0 0 14px 3px var(--a);border:0}
.lp-sr-sw.k-smoke{border:0;background:radial-gradient(circle at 30% 60%,var(--a),transparent 55%),radial-gradient(circle at 65% 40%,var(--a),transparent 55%);opacity:.9}
.lp-sr-sw.k-plate{display:grid;place-items:center;width:64px;height:22px;margin:4px 0;background:var(--a);border:1px solid var(--b);box-shadow:0 0 8px var(--b);font:700 11px/1 var(--lp-display);letter-spacing:.08em;color:var(--b)}
.lp-sr-sw.k-horn{display:flex;align-items:center;gap:3px;border:0;background:none}
.lp-sr-sw.k-horn i{width:4px;height:12px;background:var(--a)}.lp-sr-sw.k-horn i:nth-child(2){height:22px}.lp-sr-sw.k-horn i:nth-child(3){height:16px}
.lp-sr-sw.k-style{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#111a1c;font:700 16px/1 var(--lp-display);color:var(--lp-dim)}
.lp-sr-sw.k-none{width:30px;height:30px;border:1px dashed var(--lp-faint);background:none}
.lp-sr-sw.k-car{width:58px;height:30px;border:0;background:none;color:var(--a)}
.lp-sr-sw.k-car svg{width:100%;height:100%}

.lp-sr-hint{position:absolute;left:50%;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 132px);transform:translateX(-50%);margin:0;font-size:.7em;letter-spacing:.22em;text-transform:uppercase;color:var(--lp-faint);pointer-events:none;opacity:.8;transition:opacity .4s ease;white-space:nowrap}
.lp-sr-hint i{font-style:normal;color:var(--lp-accent);margin:0 .5em}
.lp-sr.is-orbiting .lp-sr-hint{opacity:0}
.lp-sr-loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;flex-direction:column;align-items:center;gap:10px;font:700 22px/1 var(--lp-display);letter-spacing:.2em;text-transform:uppercase;color:var(--lp-dim);pointer-events:none}
.lp-sr-loading span{width:140px;height:6px;background:var(--lp-hazard);background-size:20px 20px;animation:lp-sr-haz 0.6s linear infinite}
@keyframes lp-sr-haz{to{background-position:20px 0}}
.lp-sr.is-loading .lp-sr-loading{display:flex}

.lp-sr-modal{position:absolute;inset:0;z-index:10;display:grid;place-items:center;padding:16px;background:rgba(1,3,4,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:lp-sr-fade .25s ease}
@keyframes lp-sr-fade{from{opacity:0}}
.lp-sr-confirm,.lp-sr-sheet{--cut:20px;position:relative;width:min(440px,100%);max-height:calc(100% - 24px);overflow:auto;padding:24px;background:linear-gradient(160deg,rgba(10,21,23,.97),rgba(4,9,10,.97));border:1px solid var(--lp-line-strong);clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));animation:lp-sr-rise .35s cubic-bezier(.2,.8,.2,1)}
.lp-sr-confirm{border-top:3px solid var(--rar)}
@keyframes lp-sr-rise{from{opacity:0;transform:translateY(20px) scale(.97)}}
.lp-sr-confirm dl{display:grid;grid-template-columns:1fr auto;gap:6px 16px;margin:18px 0 8px;font-size:.9em;color:var(--lp-dim)}
.lp-sr-confirm dd{margin:0;font:700 22px/1 var(--lp-num);color:var(--lp-ink);text-align:right}
.lp-sr-confirm p{margin:0;font-size:.82em;color:var(--lp-faint)}
.lp-sr-sheet{width:min(720px,100%)}
.lp-sr-sheet header{display:flex;justify-content:space-between;align-items:center}
.lp-sr-sheet h3{margin:0;font:700 40px/.9 var(--lp-stencil);text-transform:uppercase}
.lp-shell .lp-sr-x{width:44px;padding:0;font-size:22px}
.lp-sr-gap{margin:10px 0 4px;font-size:1.02em;color:var(--lp-dim)}
.lp-sr-gap strong{font:700 26px/1 var(--lp-num);color:var(--lp-hot);margin-left:.15em}
.lp-sr-gap.ok strong,.lp-sr-gap.ok b{color:var(--lp-accent)}
.lp-sr-earn h4{margin:18px 0 8px;font-size:.74em;letter-spacing:.22em;text-transform:uppercase;color:var(--lp-teal)}
.lp-sr-offers{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.lp-shell .lp-sr-offer{--cut:12px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:14px 12px 12px;text-align:left;text-transform:none;letter-spacing:0;background-color:rgba(47,184,173,.07)}
.lp-shell .lp-sr-offer.best{--lp-edge:var(--lp-accent);border-color:var(--lp-accent);background-color:rgba(216,250,114,.1);box-shadow:inset 0 0 24px rgba(216,250,114,.12)}
.lp-sr-saleh{display:flex;align-items:center;gap:10px;margin:18px 0 8px;font:700 .74em var(--lp-font);letter-spacing:.22em;text-transform:uppercase;color:var(--lp-hot)}
.lp-sr-saleh::before,.lp-sr-saleh::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(255,138,31,.6))}
.lp-sr-saleh::after{background:linear-gradient(270deg,transparent,rgba(255,138,31,.6))}
.lp-sr-offers.sale{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.lp-shell .lp-sr-offer.sale{--lp-edge:var(--lp-hot);border-color:var(--lp-hot);padding-top:26px;background-color:rgba(255,138,31,.1);background-image:linear-gradient(160deg,rgba(255,138,31,.22),rgba(216,250,114,.06) 70%);box-shadow:0 0 0 1px rgba(255,138,31,.55),0 0 20px rgba(255,138,31,.38),inset 0 0 26px rgba(255,138,31,.16);animation:lp-sr-sale 2.6s ease-in-out infinite}
.lp-shell .lp-sr-offer.sale.best{--lp-edge:var(--lp-accent);border-color:var(--lp-accent);box-shadow:0 0 0 1px rgba(216,250,114,.6),0 0 24px rgba(216,250,114,.4),inset 0 0 26px rgba(255,138,31,.14)}
@keyframes lp-sr-sale{50%{box-shadow:0 0 0 1px rgba(255,138,31,.8),0 0 32px rgba(255,138,31,.6),inset 0 0 30px rgba(255,138,31,.24)}}
.lp-sr-offer .lp-sr-sale-tag{position:absolute;top:0;left:0;right:0;padding:3px 10px;font-size:.66em;font-weight:800;letter-spacing:.16em;text-transform:uppercase;text-align:center;color:#1a0d00;background:linear-gradient(90deg,var(--lp-hot),#ffc15a)}
.lp-sr-offer .lp-sr-save{display:block;font-size:.8em;letter-spacing:.14em;text-transform:uppercase;color:var(--lp-hot)}
.lp-sr-offer .lp-sr-save b{font:800 2.4em/1 var(--lp-display);letter-spacing:0;margin-right:.1em;text-shadow:0 0 18px rgba(255,138,31,.7)}
.lp-sr-offer .lp-sr-worth{color:var(--lp-dim);font-size:.82em}
.lp-sr-offer .lp-sr-worth s{color:var(--lp-faint);text-decoration-color:var(--lp-hot);text-decoration-thickness:2px}
.lp-sr-offer .lp-sr-worth b{color:var(--lp-hot)}
@media (prefers-reduced-motion:reduce){.lp-shell .lp-sr-offer.sale{animation:none}}
.lp-sr-offer i{position:absolute;top:0;right:12px;padding:3px 7px;font-style:normal;font-size:.68em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--lp-on-accent);background:var(--lp-accent)}
.lp-sr-offer span{font-size:.8em;color:var(--lp-dim)}
.lp-sr-offer strong{font:800 34px/1 var(--lp-num)}
.lp-sr-offer strong small{font-size:.5em;margin-left:3px;color:var(--lp-accent)}
.lp-sr-offer em{font-style:normal;font-size:.74em;color:var(--lp-faint)}
.lp-sr-offer u{margin-top:6px;text-decoration:none;font-weight:700;font-size:.78em;letter-spacing:.14em;text-transform:uppercase;color:var(--lp-accent)}
.lp-sr-disclosure{margin:8px 0 0;font-size:.74em;color:var(--lp-faint)}

.lp-sr-fx{position:absolute;inset:0;z-index:12;pointer-events:none}
.lp-sr-fx-in{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.lp-sr-sweep{position:absolute;top:-20%;bottom:-20%;left:-40%;width:30%;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--rar),transparent 70%),rgba(255,255,255,.55),color-mix(in srgb,var(--rar),transparent 70%),transparent);transform:skewX(-18deg);opacity:0;mix-blend-mode:screen}
.lp-sr-flare{position:absolute;inset:0;background:radial-gradient(circle at 50% 55%,color-mix(in srgb,var(--rar),transparent 40%),transparent 55%);opacity:0;mix-blend-mode:screen}
.lp-sr-stamp{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;opacity:0;transform:scale(1.6);text-shadow:0 4px 30px rgba(0,0,0,.7)}
.lp-sr-stamp small{font:700 18px/1 var(--lp-display);letter-spacing:.5em;text-transform:uppercase;color:var(--rar)}
.lp-sr-stamp strong{font:800 clamp(44px,9vw,120px)/.86 var(--lp-stencil);text-transform:uppercase;color:#fff;max-width:92vw}
.lp-sr-stamp em{font:800 clamp(28px,4vw,48px)/1 var(--lp-num);font-style:normal;color:var(--lp-hot)}
.lp-sr-stamp span{font-size:.86em;letter-spacing:.16em;text-transform:uppercase;color:var(--lp-dim)}
.lp-sr-stamp span b{font:700 22px/1 var(--lp-num);color:var(--lp-ink);font-variant-numeric:tabular-nums}
.lp-sr-fx-actions{position:absolute;bottom:max(28px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;gap:10px;pointer-events:auto;opacity:0}
.lp-sr-fx-actions button{min-width:160px}
.lp-sr.is-charging .lp-sr-shade{animation:lp-sr-charge .85s ease-in forwards}
@keyframes lp-sr-charge{to{box-shadow:inset 0 0 160px 40px rgba(216,250,114,.25)}}
.lp-sr.is-charging .lp-sr-card,.lp-sr.is-charging .lp-sr-rail,.lp-sr.is-charging .lp-sr-tabs,.lp-sr.is-burst .lp-sr-card,.lp-sr.is-burst .lp-sr-rail,.lp-sr.is-burst .lp-sr-tabs{opacity:0;pointer-events:none;transition:opacity .3s ease}
.lp-sr.is-charging :is(.lp-sr-card,.lp-sr-rail,.lp-sr-tabs) *,.lp-sr.is-burst :is(.lp-sr-card,.lp-sr-rail,.lp-sr-tabs) *{pointer-events:none!important}
.lp-sr.is-burst .lp-sr-sweep{animation:lp-sr-sweep .9s cubic-bezier(.3,0,.2,1) forwards}
.lp-sr.is-burst .lp-sr-flare{animation:lp-sr-flare 1.4s ease-out forwards}
.lp-sr.is-burst .lp-sr-stamp{animation:lp-sr-stamp .55s cubic-bezier(.2,1.4,.3,1) .12s forwards}
.lp-sr.is-burst .lp-sr-fx-actions{animation:lp-sr-fade-in .4s ease 1.2s forwards}
.lp-sr.is-burst .lp-sr-bal{animation:lp-sr-hit .6s ease}
@keyframes lp-sr-sweep{0%{opacity:0;left:-40%}15%{opacity:1}100%{opacity:0;left:120%}}
@keyframes lp-sr-flare{0%{opacity:0}12%{opacity:1}100%{opacity:0}}
@keyframes lp-sr-stamp{to{opacity:1;transform:none}}
@keyframes lp-sr-fade-in{to{opacity:1}}
@keyframes lp-sr-hit{30%{transform:scale(1.12);box-shadow:0 0 30px rgba(255,138,31,.6)}}

@media (max-width:900px) and (min-height:521px){
.lp-sr-brand h2{font-size:clamp(30px,9vw,56px)}
.lp-sr-kicker{white-space:nowrap;font-size:.58em;letter-spacing:.16em}
.lp-sr-modes{position:absolute;right:12px;top:calc(max(16px,env(safe-area-inset-top)) + 58px);margin:0}
.lp-shell .lp-sr-modes button{min-height:34px;padding:.4em .8em;font-size:.7em}
.lp-sr:has(.lp-sr-modes:not([hidden])) .lp-sr-tabs{top:calc(max(16px,env(safe-area-inset-top)) + 100px)}
.lp-sr-tabs{left:0;right:0;top:calc(max(16px,env(safe-area-inset-top)) + 66px);transform:none;width:auto;max-height:none;flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:0 16px 6px;scrollbar-width:none;touch-action:pan-x}
.lp-shell .lp-sr-tabs button{flex:0 0 auto;min-height:40px;padding:.6em .9em}
.lp-shell .lp-sr-tabs button[aria-selected=true]{transform:none}
.lp-sr-card{left:12px;right:12px;top:auto;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 108px);transform:none;width:auto;max-height:calc(100% - 330px)}
.lp-sr-kicker{overflow:hidden;text-overflow:ellipsis}
.lp-sr-card-in{padding:12px 14px;display:grid;grid-template-columns:1fr auto;align-items:end;gap:0 10px}
.lp-sr-card-in .lp-sr-rar{grid-column:1/-1;margin-bottom:2px}
.lp-sr-card-in h3{font-size:30px}
.lp-sr-price{margin:0;font-size:22px;grid-row:2;grid-column:2}
.lp-sr-blurb{display:none}
.lp-sr-spec{grid-column:1/-1;margin-top:6px}.lp-sr-spec .lp-sr-bar,.lp-sr-spec p{display:none}.lp-sr-figs b{font-size:22px}.lp-sr-figs span:last-child b{font-size:16px}
.lp-sr-card-in .lp-sr-note{grid-column:1/-1;margin-top:6px;padding:5px 8px}
.lp-sr-actions{grid-column:1/-1;margin-top:10px}
.lp-sr-rail{left:0;right:0;transform:none;max-width:none;bottom:max(8px,env(safe-area-inset-bottom));padding:4px 12px 8px}
.lp-shell .lp-sr-item{flex-basis:112px;padding:8px}
.lp-sr-name{min-height:0}
.lp-sr-hint{display:none}
}
@media (max-height:520px){
.lp-sr-top{padding-top:max(8px,env(safe-area-inset-top))}
.lp-sr-brand h2{font-size:32px}
.lp-sr-kicker{font-size:.62em}
.lp-shell .lp-sr-bal{min-height:40px}.lp-sr-bal b{font-size:24px}
.lp-shell .lp-sr-close{width:40px;min-height:40px}
.lp-shell .lp-sr-modes button{min-height:36px;padding:.4em .8em;font-size:.72em}
.lp-sr-tabs{width:130px;top:calc(50% - 20px);gap:4px;max-height:calc(100% - 170px)}
.lp-shell .lp-sr-tabs button{min-height:34px;padding:.45em .7em;font-size:.76em}
.lp-sr-card{width:250px;top:max(56px,env(safe-area-inset-top));transform:none;max-height:calc(100% - max(56px,env(safe-area-inset-top)) - 104px)}
.lp-sr-card-in{padding:10px 12px}
.lp-sr-card-in h3{font-size:24px}
.lp-sr-price{font-size:20px;margin-top:6px}
.lp-sr-blurb{display:none}
.lp-sr-spec .lp-sr-bar,.lp-sr-spec p{display:none}.lp-sr-spec{margin-top:6px}.lp-sr-figs{gap:10px}.lp-sr-figs b{font-size:18px}.lp-sr-figs span:last-child b{font-size:13px}
.lp-sr-actions{margin-top:8px}
.lp-shell .lp-sr-actions button{min-height:38px;padding:.5em .8em}
.lp-sr-rail{bottom:max(6px,env(safe-area-inset-bottom));padding-bottom:4px}
.lp-shell .lp-sr-item{flex-basis:100px;padding:6px 8px;gap:4px}
.lp-sr-name{min-height:0;font-size:.76em}
.lp-sr-sw{height:20px;width:36px}
.lp-sr-hint{display:none}
}
@media (prefers-reduced-motion:reduce){.lp-sr *,.lp-sr::before{animation-duration:.01s!important;animation-delay:0s!important;transition:none!important}}
@media (max-width:560px){.lp-sr-offers{grid-template-columns:repeat(2,1fr)}.lp-sr-offers.sale{grid-template-columns:1fr}.lp-shell .lp-sr-offer{padding:12px 10px 10px}.lp-sr-offer strong{font-size:28px}}
.lp-sr-wallet{gap:10px}
.lp-sr-giftnote{position:absolute;left:0;top:100%;margin-top:4px;padding:2px 8px;font:700 11px/1.4 var(--lp-font);letter-spacing:.12em;text-transform:uppercase;color:#1a0d00;background:linear-gradient(90deg,var(--lp-hot),#ffc15a);white-space:nowrap;pointer-events:none;box-shadow:0 0 14px rgba(255,138,31,.5)}
.lp-shell .lp-sr-gift{position:relative;display:flex;align-items:center;gap:.55em;min-height:48px;padding:.4em 1em .4em .6em;color:var(--lp-ink);background-color:rgba(255,138,31,.16);border-color:var(--lp-hot);letter-spacing:.06em;animation:lp-sr-gift 1.8s ease-in-out infinite}
.lp-shell .lp-sr-gift:hover:not(:disabled){background-color:rgba(255,138,31,.3);border-color:#ffc15a;color:var(--lp-ink);transform:none}
.lp-sr-gift[hidden],.lp-sr-giftnote[hidden]{display:none}
.lp-sr-gi{position:relative;flex:none;width:26px;height:24px;background:linear-gradient(180deg,#ffc15a,var(--lp-hot));border:1px solid #fff3;box-shadow:inset 0 -9px 0 rgba(0,0,0,.14)}
.lp-sr-gi::before{content:"";position:absolute;left:50%;top:-1px;bottom:-1px;width:6px;margin-left:-3px;background:var(--lp-accent)}
.lp-sr-gi::after{content:"";position:absolute;left:-1px;right:-1px;top:8px;height:6px;background:var(--lp-accent)}
.lp-sr-gt{font:700 13px/1 var(--lp-font);text-transform:uppercase;letter-spacing:.12em;white-space:nowrap}
.lp-sr-gift em{position:absolute;right:-6px;top:-8px;display:grid;place-items:center;min-width:20px;height:20px;padding:0 5px;font:800 12px/1 var(--lp-display);font-style:normal;color:#fff;background:#e5362b;border-radius:10px;box-shadow:0 0 10px rgba(229,54,43,.7)}
@keyframes lp-sr-gift{0%,100%{box-shadow:0 0 0 0 rgba(255,138,31,.55)}50%{box-shadow:0 0 18px 4px rgba(255,138,31,.6)}}
.lp-sr-item .t-gift{color:#1a0d00;background:linear-gradient(90deg,var(--lp-hot),#ffc15a);padding:1px 6px;font-size:.62em;letter-spacing:.1em;white-space:nowrap}
.lp-sr-ingift{display:grid;gap:2px;margin:6px 0 0;padding:7px 10px;border-left:4px solid var(--lp-hot);background:rgba(255,138,31,.12)}
.lp-sr-ingift b{font:800 12px/1 var(--lp-font);letter-spacing:.16em;color:var(--lp-hot)}
.lp-sr-ingift span{font-size:.85em;color:var(--lp-dim)}
.lp-sr-from{margin:4px 0 0;font:600 11px/1.2 var(--lp-font);letter-spacing:.14em;text-transform:uppercase;color:var(--lp-teal)}
.lp-shell .lp-sr button.go.gift{--lp-edge:var(--lp-hot);background-color:var(--lp-hot);border-color:var(--lp-hot);color:#1a0d00}
.lp-shell .lp-sr button.go.gift:hover:not(:disabled){background-color:#ffc15a;color:#1a0d00}
@media (max-width:560px){.lp-sr-gt{display:none}.lp-shell .lp-sr-gift{min-height:40px;padding:.3em .7em .3em .5em}.lp-sr-giftnote{font-size:10px}}
@media (prefers-reduced-motion:reduce){.lp-shell .lp-sr-gift{animation:none}}
`;
