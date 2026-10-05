/**
 * LATERAL interface styling, "Night Shift at the Port".
 * Identity: harbor signage. Stencil container lettering (Big Shoulders Stencil) for titles, condensed signal
 * numerals (Big Shoulders Display) for every live number, Chakra Petch for labels and body. Panels are cut-corner
 * plates with hairline teal borders and lime corner ticks. Palette is lifted from the scene: deep harbor teal
 * ground, sodium-lamp orange for heat and warnings, signal lime for go and focus. Hazard stripes are rare and
 * only ever mean "live" (chain running, loading). Menus use blur; the live HUD uses flat plates so driving
 * never pays for a per-frame backdrop blur.
 */
export const PLAYER_CSS = `
.lp-shell{--lp-scale:1;--lp-tach-k:1;--lp-accent:#d8fa72;--lp-accent-deep:#b5e23f;--lp-on-accent:#0d1505;--lp-hot:#ff8a1f;--lp-hot-deep:#e06a00;--lp-teal:#2fb8ad;--lp-teal-deep:#0f4a4d;--lp-night:#050b0d;--lp-ink:#f4f7f1;--lp-dim:#b7c5bf;--lp-faint:#8fa19a;--lp-plate:rgba(5,12,14,.74);--lp-glass-solid:rgba(7,15,17,.94);--lp-line:rgba(130,205,196,.26);--lp-line-strong:rgba(170,230,222,.55);--lp-edge:rgba(130,205,196,.5);
--lp-font:"Chakra Petch",ui-monospace,"SF Mono","Avenir Next Condensed",-apple-system,BlinkMacSystemFont,"Helvetica Neue",system-ui,sans-serif;
--lp-display:"Big Shoulders Display","Avenir Next Condensed","Arial Narrow","Helvetica Neue",system-ui,sans-serif;
--lp-stencil:"Big Shoulders Stencil Display","Big Shoulders Display","Avenir Next Condensed","Arial Narrow","Helvetica Neue",system-ui,sans-serif;
--lp-num:var(--lp-display);
--lp-hazard:repeating-linear-gradient(-45deg,var(--lp-hot) 0 7px,#0a0f10 7px 14px);
position:absolute;inset:0;z-index:5;pointer-events:none;color:var(--lp-ink);font:500 calc(14px * var(--lp-scale))/1.45 var(--lp-font);text-shadow:0 1px 3px rgba(0,0,0,.55);-webkit-font-smoothing:antialiased;color-scheme:dark}
.lp-shell *{box-sizing:border-box}
.lp-shell [hidden]{display:none!important}
.lp-shell button,.lp-shell select,.lp-shell input{font:inherit}

/* Buttons: cut-corner keys. The diagonal hairlines are drawn as background layers so the clipped corners still have an edge. */
.lp-shell button{--cut:9px;--lp-edge:rgba(130,205,196,.5);pointer-events:auto;appearance:none;-webkit-appearance:none;position:relative;color:var(--lp-ink);
background-color:rgba(47,184,173,.09);
background-image:linear-gradient(to bottom left,transparent calc(50% - .75px),var(--lp-edge) calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px)),linear-gradient(to bottom left,transparent calc(50% - .75px),var(--lp-edge) calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px));
background-position:100% 0,0 100%;background-size:var(--cut) var(--cut),var(--cut) var(--cut);background-repeat:no-repeat;
border:1px solid var(--lp-line);border-radius:0;padding:.8em 1.25em;min-height:44px;font-weight:600;font-size:.92em;line-height:1.1;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;text-shadow:none;
clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));
transition:background-color .16s ease,border-color .16s ease,transform .16s cubic-bezier(.2,.8,.2,1),color .16s ease}
.lp-shell button:hover:not(:disabled){--lp-edge:var(--lp-accent);background-color:rgba(216,250,114,.12);border-color:var(--lp-accent);color:var(--lp-accent);transform:translateX(3px)}
.lp-shell button:active:not(:disabled){transform:translateX(0) scale(.975);background-color:rgba(216,250,114,.22)}
.lp-shell button:disabled{opacity:.45;cursor:not-allowed;background-image:none;border-style:dashed}
.lp-shell button:focus-visible{outline:2px solid var(--lp-accent);outline-offset:-5px;background-color:rgba(216,250,114,.14);border-color:var(--lp-accent)}
.lp-shell select:focus-visible,.lp-shell input:focus-visible,.lp-shell summary:focus-visible{outline:3px solid var(--lp-accent);outline-offset:2px}
.lp-shell select:focus-visible{outline-offset:-4px}
.lp-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.lp-shell .lp-primary{--cut:12px;--lp-edge:transparent;background-color:var(--lp-accent);background-image:none;color:var(--lp-on-accent);border-color:transparent;font-weight:700;letter-spacing:.14em}
.lp-shell .lp-primary:hover:not(:disabled){background-color:#ecffab;color:var(--lp-on-accent);border-color:transparent}
.lp-shell .lp-primary:active:not(:disabled){background-color:var(--lp-accent-deep)}
.lp-shell .lp-primary:focus-visible{outline-color:var(--lp-night);outline-offset:-5px;background-color:#ecffab;border-color:transparent}
.lp-secondary{margin-top:12px}
.lp-shell .lp-secondary{--cut:7px;min-height:38px;padding:.5em 1em;font-size:.82em;background-color:transparent;color:var(--lp-dim)}
.lp-shell .lp-ghost{background-color:transparent;background-image:none;border-color:transparent;color:var(--lp-dim)}

/* Panels: cut-corner plate in a frame, inner wrapper scrolls so the chamfer and hairline stay intact */
.lp-panel{--cut:22px;pointer-events:auto;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(660px,calc(100% - 24px));max-height:calc(100% - 32px);display:flex;flex-direction:column;color:var(--lp-ink);
background:linear-gradient(158deg,rgba(12,44,48,.84),rgba(4,10,12,.9) 62%),repeating-linear-gradient(0deg,rgba(255,255,255,.02) 0 1px,transparent 1px 4px);
-webkit-backdrop-filter:blur(22px) saturate(1.3);backdrop-filter:blur(22px) saturate(1.3);
clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));text-shadow:none;animation:lp-rise .55s cubic-bezier(.2,.8,.2,1) both}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.lp-panel{background:var(--lp-glass-solid)}}
.lp-panel::before{content:"";position:absolute;inset:0;border:1px solid var(--lp-line);pointer-events:none;z-index:2}
.lp-panel::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:2;
background:
linear-gradient(to bottom left,transparent calc(50% - .75px),var(--lp-line-strong) calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px)) 100% 0/var(--cut) var(--cut) no-repeat,
linear-gradient(to bottom left,transparent calc(50% - .75px),var(--lp-line-strong) calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px)) 0 100%/var(--cut) var(--cut) no-repeat,
linear-gradient(var(--lp-accent),var(--lp-accent)) 0 0/18px 3px no-repeat,linear-gradient(var(--lp-accent),var(--lp-accent)) 0 0/3px 18px no-repeat,
linear-gradient(var(--lp-hot),var(--lp-hot)) 100% 100%/18px 3px no-repeat,linear-gradient(var(--lp-hot),var(--lp-hot)) 100% 100%/3px 18px no-repeat}
.lp-scroll{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:clamp(22px,3.4vw,34px);scrollbar-width:thin;scrollbar-color:rgba(130,205,196,.4) transparent}
.lp-scroll>*{animation:lp-rise .5s cubic-bezier(.2,.8,.2,1) both}
.lp-scroll>:nth-child(2){animation-delay:.05s}.lp-scroll>:nth-child(3){animation-delay:.1s}.lp-scroll>:nth-child(4){animation-delay:.15s}.lp-scroll>:nth-child(5){animation-delay:.2s}.lp-scroll>:nth-child(n+6){animation-delay:.25s}
.lp-panel h1,.lp-panel h2,.lp-panel h3{margin:0;font-family:var(--lp-display)}
.lp-panel h2{font-family:var(--lp-stencil);font-size:3em;font-weight:800;letter-spacing:.03em;line-height:.95;text-transform:uppercase}
.lp-panel h3{display:flex;align-items:center;gap:.8em;margin:1.7em 0 .8em;font:700 .74em/1 var(--lp-font);letter-spacing:.24em;text-transform:uppercase;color:var(--lp-teal)}
.lp-panel h3::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--lp-line-strong),transparent)}
.lp-panel p{margin:.5em 0;color:var(--lp-dim)}
.lp-panel header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--lp-line)}
.lp-panel header p{margin:.45em 0 0;font-size:.9em;letter-spacing:.04em}
.lp-panel header h2+p{margin-top:.5em}
.lp-local-only{font-size:.84em;color:var(--lp-faint)!important}
.lp-kicker{margin:0!important;letter-spacing:.26em;font-weight:700;font-size:.74em;text-transform:uppercase;color:var(--lp-accent)!important}
.lp-hazard{display:block;height:6px;background:var(--lp-hazard);clip-path:polygon(0 0,100% 0,calc(100% - 6px) 100%,0 100%)}

/* Title lockup and main menu */
.lp-lockup{display:flex;align-items:center;gap:16px}
.lp-mark{display:block;flex:none;width:3.6em;height:3.6em;color:var(--lp-accent);filter:drop-shadow(0 0 14px rgba(216,250,114,.35))}
.lp-mark svg{display:block;width:100%;height:100%}
.lp-brand{display:flex;flex-direction:column;gap:7px}
.lp-brand strong{font-family:var(--lp-stencil);font-size:2.9em;font-weight:800;font-style:italic;letter-spacing:.09em;line-height:.8;text-transform:uppercase}
.lp-brand small{display:flex;align-items:center;gap:.8em;font-size:.72em;font-weight:700;letter-spacing:.42em;color:var(--lp-hot);text-transform:uppercase}
.lp-brand small::before{content:"";width:2.4em;height:6px;background:var(--lp-hazard)}
.lp-menu{--cut:28px;left:clamp(16px,5vw,84px);top:50%;width:min(560px,calc(100% - 32px));transform:translateY(-50%)}
.lp-menu h1{margin:1.05em 0 .25em;font-family:var(--lp-stencil);font-size:clamp(3rem,6.2vw + .4rem,5.4rem);font-weight:800;font-style:italic;letter-spacing:.015em;line-height:.88;text-transform:uppercase;text-wrap:balance}
.lp-menu h1 span{display:block;color:var(--lp-accent);text-shadow:0 0 38px rgba(216,250,114,.3)}
.lp-lede{max-width:30em;font-size:1.02em}
.lp-nav{margin-top:22px}
.lp-nav .lp-primary{flex:1 1 100%;display:flex;align-items:center;justify-content:space-between;min-height:62px;padding:.8em 1.4em;font-family:var(--lp-stencil);font-size:1.7em;font-weight:800;letter-spacing:.14em}
.lp-nav .lp-primary svg{width:1.3em;height:1.3em;transition:transform .2s ease}
.lp-nav .lp-primary:hover svg{transform:translateX(6px)}
.lp-nav button:not(.lp-primary){flex:1}
.lp-events{counter-reset:ev;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:0}
.lp-events button{--cut:12px;counter-increment:ev;overflow:hidden;font-weight:700;font-size:.9em;display:flex;flex-direction:column;align-items:flex-start;gap:5px;min-height:84px;padding:.9em .9em;text-align:left}
.lp-events button::before{content:counter(ev,decimal-leading-zero);position:absolute;right:.45em;top:.05em;font:800 2.6em/1 var(--lp-stencil);color:rgba(130,205,196,.22);letter-spacing:0;transition:color .16s}
.lp-events button:hover:not(:disabled)::before{color:rgba(216,250,114,.4)}
.lp-events .lp-sub{font-size:.78em;font-weight:500;letter-spacing:.03em;text-transform:none;color:var(--lp-dim);line-height:1.3}
.lp-menu .lp-secondary{margin-right:8px}
.lp-shell[data-screen=pause]::before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(3,9,11,.78) 0%,rgba(3,12,14,.45) 42%,rgba(3,8,10,0) 76%),linear-gradient(0deg,rgba(3,9,11,.65),rgba(3,9,11,0) 34%);animation:lp-fade .6s ease both}
.lp-shell[data-screen=pause]::after{content:"";position:absolute;left:0;right:0;top:0;height:6px;background:var(--lp-hazard);opacity:.9;clip-path:polygon(0 0,100% 0,100% 100%,0 100%)}

/* Harbor signage (title screen decoration, never interactive) */
.lp-signage{position:absolute;right:clamp(18px,4vw,64px);top:0;bottom:0;pointer-events:none;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:.6em;animation:lp-fade 1.2s .3s ease both}
.lp-signage b{font:800 clamp(6rem,22vh,15rem)/.8 var(--lp-stencil);letter-spacing:.02em;color:transparent;-webkit-text-stroke:2px rgba(216,250,114,.55);text-shadow:none;font-style:italic}
.lp-signage span{font:600 .74em/1.2 var(--lp-font);letter-spacing:.34em;text-transform:uppercase;color:var(--lp-dim);text-shadow:0 1px 6px rgba(0,0,0,.9);text-align:right}
.lp-signage span i{font-style:normal;color:var(--lp-hot)}
.lp-signage em{display:block;width:clamp(120px,18vw,260px);height:10px;background:var(--lp-hazard);clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%)}
@media(max-width:1100px){.lp-signage{display:none}}

/* Forms: one column of aligned rows */
.lp-side{left:clamp(16px,5vw,84px);top:50%;width:min(540px,calc(100% - 32px));transform:translateY(-50%)}
.lp-grid,.lp-settings{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}.lp-route-blurb{margin:-2px 0 4px calc(5.6em + 12px);color:var(--lp-faint);font-size:.78em;line-height:1.35}
.lp-grid label{display:grid;grid-template-columns:5.6em minmax(0,1fr);align-items:center;gap:12px;color:var(--lp-faint);font-size:.76em;font-weight:700;letter-spacing:.18em;text-transform:uppercase}
.lp-settings{counter-reset:sec}
.lp-settings label{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) 3.4em;align-items:center;gap:12px;min-height:42px;padding:.15em 0;color:var(--lp-ink);font-size:.94em;font-weight:500;border-bottom:1px solid rgba(130,205,196,.12)}
.lp-settings label:last-of-type{border-bottom:0}
.lp-shell select{appearance:none;-webkit-appearance:none;width:100%;min-height:42px;padding:.5em 2.4em .5em 1em;color:var(--lp-ink);font-size:.92em;font-weight:600;letter-spacing:.04em;text-transform:none;background:rgba(47,184,173,.09) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23d8fa72' stroke-width='2' stroke-linecap='square'/%3E%3C/svg%3E") no-repeat right .95em center/.8em;border:1px solid var(--lp-line);border-radius:0;clip-path:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,9px 100%,0 calc(100% - 9px));text-shadow:none;cursor:pointer;transition:border-color .16s,background-color .16s}
.lp-shell select:hover{border-color:var(--lp-accent);background-color:rgba(216,250,114,.09)}
.lp-shell select:disabled{opacity:.45;cursor:not-allowed}
.lp-shell select option{background:#0a1a1c;color:#f4f7f1}
/* Sliders: ten-notch rail, lime fill via --v, blocky thumb */
.lp-shell input[type=range]{--v:50;-webkit-appearance:none;appearance:none;width:100%;height:30px;min-height:0;padding:0;margin:0;background:transparent;border:0;cursor:pointer}
.lp-shell input[type=range]::-webkit-slider-runnable-track{height:10px;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 2px),rgba(5,11,13,.95) calc(10% - 2px) 10%),linear-gradient(90deg,var(--lp-accent) calc(var(--v) * 1%),rgba(130,205,196,.22) calc(var(--v) * 1%));clip-path:polygon(0 0,100% 0,calc(100% - 4px) 100%,4px 100%)}
.lp-shell input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:26px;margin-top:-8px;border-radius:0;background:var(--lp-ink);border:0;box-shadow:0 0 0 2px var(--lp-night),0 0 14px rgba(216,250,114,.5);clip-path:polygon(0 4px,100% 0,100% calc(100% - 4px),0 100%);transition:background .14s ease,transform .14s ease}
.lp-shell input[type=range]:hover::-webkit-slider-thumb{background:var(--lp-accent);transform:scaleY(1.1)}
.lp-shell input[type=range]:active::-webkit-slider-thumb{background:var(--lp-accent);transform:scale(1.15)}
.lp-shell input[type=range]::-moz-range-track{height:10px;background:linear-gradient(90deg,var(--lp-accent) calc(var(--v) * 1%),rgba(130,205,196,.22) calc(var(--v) * 1%))}
.lp-shell input[type=range]::-moz-range-thumb{width:12px;height:24px;border-radius:0;background:var(--lp-ink);border:2px solid var(--lp-night)}
/* Toggle: a switch plate that reads OFF / ON */
.lp-shell input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:4.2em;height:1.9em;margin:0;border-radius:0;background:rgba(5,11,13,.8);border:1px solid var(--lp-line-strong);clip-path:polygon(0 0,calc(100% - 7px) 0,100% 7px,100% 100%,7px 100%,0 calc(100% - 7px));cursor:pointer;transition:background .18s ease,border-color .18s ease}
.lp-shell input[type=checkbox]::before{content:"OFF";position:absolute;right:.55em;top:50%;translate:0 -50%;font:700 .64em/1 var(--lp-font);letter-spacing:.16em;color:var(--lp-faint)}
.lp-shell input[type=checkbox]::after{content:"";position:absolute;top:3px;left:3px;width:calc(50% - 2px);height:calc(100% - 8px);background:var(--lp-dim);clip-path:polygon(0 0,calc(100% - 4px) 0,100% 4px,100% 100%,4px 100%,0 calc(100% - 4px));transition:transform .22s cubic-bezier(.3,1.3,.5,1),background .18s ease}
.lp-shell input[type=checkbox]:checked{background:rgba(216,250,114,.16);border-color:var(--lp-accent)}
.lp-shell input[type=checkbox]:checked::before{content:"ON";right:auto;left:.7em;color:var(--lp-accent)}
.lp-shell input[type=checkbox]:checked::after{transform:translateX(calc(100% + 2px));background:var(--lp-accent)}
.lp-shell input[type=checkbox]:hover::after{background:var(--lp-ink)}
.lp-shell input[type=checkbox]:focus-visible{outline-offset:3px}
.lp-check{display:flex!important;flex-direction:row-reverse;justify-content:space-between;align-items:center;cursor:pointer}
.lp-settings h3{counter-increment:sec;grid-column:1/-1;margin:1.6em 0 .4em}
.lp-settings h3::before{content:counter(sec,decimal-leading-zero);font:800 1.9em/.7 var(--lp-stencil);letter-spacing:0;color:var(--lp-hot)}
.lp-settings h3:first-child{margin-top:0}
.lp-settings p{grid-column:1/-1;margin:.2em 0 .5em;font-size:.84em;line-height:1.5;color:var(--lp-faint)}
.lp-settings output{color:var(--lp-accent);font:800 1.25em/1 var(--lp-display);font-variant-numeric:tabular-nums;text-align:right}
.lp-settings .lp-secondary{margin:0 0 10px}
.lp-cosmetic-group+.lp-cosmetic-group{margin-top:12px}
.lp-cosmetic-group>span{display:block;margin-bottom:7px;font-size:.72em;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--lp-faint)}
.lp-cosmetics{display:flex;gap:6px;flex-wrap:wrap}
.lp-cosmetics button{--cut:6px;min-height:34px;padding:.35em .9em;font-size:.78em}
.lp-cosmetics button[aria-pressed=true]{background-color:rgba(216,250,114,.2);border-color:var(--lp-accent);color:var(--lp-accent);--lp-edge:var(--lp-accent)}
.lp-cosmetics button[aria-pressed=true]::before{content:"";display:inline-block;width:.55em;height:.55em;margin-right:.6em;background:var(--lp-accent);clip-path:polygon(0 50%,40% 100%,100% 0,85% 0,40% 70%,15% 40%)}
.lp-remaps{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.lp-remaps h3{grid-column:1/-1;margin:.9em 0 0}
.lp-remaps>span{grid-column:1/-1;color:var(--lp-dim)}
.lp-remaps button{--cut:7px;min-height:40px;font-size:.74em;font-weight:600;padding:.5em .8em;text-align:left;letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lp-remaps button[data-action=reset-bindings]{grid-column:1/-1;text-align:center;color:var(--lp-dim)}
.lp-tuning{margin-top:14px;color:var(--lp-dim)}
.lp-tuning summary{cursor:pointer;padding:.7em 1em;background:rgba(47,184,173,.09);border:1px solid var(--lp-line);font-size:.8em;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--lp-ink);list-style-position:inside;transition:background .16s ease,border-color .16s}
.lp-tuning summary:hover{background:rgba(216,250,114,.09);border-color:var(--lp-accent)}
.lp-tuning summary span{float:right;color:var(--lp-accent);font-weight:700;letter-spacing:.1em}
.lp-tuning label{display:grid;grid-template-columns:1fr 1.4fr 3em;align-items:center;gap:10px;margin:8px 4px;font-size:.88em}
.lp-tuning input{min-width:0}
.lp-tuning output{text-align:right;font:800 1.2em/1 var(--lp-display);font-variant-numeric:tabular-nums;color:var(--lp-accent)}
.lp-tuning p{font-size:.82em;color:var(--lp-faint);margin:.6em 4px 0}
.lp-tuning>button{margin:6px 4px 0}
.lp-garage .lp-actions{margin-top:18px}
/* Garage stat bars: ten cells, real values from the active tune */
.lp-plate{display:inline-block;margin-top:.7em;padding:.25em .8em;font:800 1.15em/1 var(--lp-stencil);letter-spacing:.2em;color:var(--lp-night);background:var(--lp-ink);border:2px solid var(--lp-night);box-shadow:0 0 0 1px var(--lp-line-strong);clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))}
.lp-stats{display:grid;gap:9px;margin:2px 0 0}
.lp-stat{display:grid;grid-template-columns:5.6em minmax(0,1fr) 3em;align-items:center;gap:12px}
.lp-stat span{font-size:.72em;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--lp-dim)}
.lp-stat i{display:block;height:12px;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 3px),rgba(5,11,13,.95) calc(10% - 3px) 10%),linear-gradient(90deg,var(--lp-teal) calc(var(--v) * 1%),rgba(130,205,196,.16) calc(var(--v) * 1%));transition:background .3s}
.lp-stat:nth-child(odd) i{background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 3px),rgba(5,11,13,.95) calc(10% - 3px) 10%),linear-gradient(90deg,var(--lp-accent) calc(var(--v) * 1%),rgba(130,205,196,.16) calc(var(--v) * 1%))}
.lp-stat b{font:800 1.2em/1 var(--lp-display);text-align:right;font-variant-numeric:tabular-nums;color:var(--lp-ink)}

/* Results: scoreboard */
.lp-results{text-align:left}
.lp-results .lp-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:22px}
.lp-results .lp-primary{grid-column:1/-1;min-height:56px;font-size:1.05em}
.lp-board{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:stretch;margin-top:4px}
.lp-result-score{align-self:center;font-family:var(--lp-num);font-size:6.6em;font-weight:900;font-style:italic;letter-spacing:-.01em;line-height:.85;color:var(--lp-accent);font-variant-numeric:tabular-nums;text-shadow:0 0 44px rgba(216,250,114,.32)}
.lp-result-score small{display:block;margin:.6em 0 0;font:700 .15em/1 var(--lp-font);font-style:normal;letter-spacing:.42em;text-transform:uppercase;color:var(--lp-dim);text-shadow:none}
.lp-grade{position:relative;display:grid;place-items:center;align-content:center;gap:.25em;width:6.2em;padding:.55em .4em .5em;background:rgba(216,250,114,.08);border:2px solid var(--lp-accent);clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,14px 100%,0 calc(100% - 14px));animation:lp-stamp .7s .55s cubic-bezier(.2,1.4,.4,1) both}
.lp-grade span{font:900 5.4em/.8 var(--lp-stencil);font-style:italic;color:var(--lp-accent)}
.lp-grade small{font:700 .66em/1 var(--lp-font);letter-spacing:.3em;text-transform:uppercase;color:var(--lp-dim);margin-right:-.3em}
.lp-grade[data-grade="-"]{border-color:var(--lp-line-strong);background:rgba(130,205,196,.06)}
.lp-grade[data-grade="-"] span{color:var(--lp-dim)}
.lp-grade[data-grade=S]{border-color:var(--lp-hot);background:rgba(255,138,31,.1)}
.lp-grade[data-grade=S] span{color:var(--lp-hot)}
.lp-board-rows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin:18px 0 0;background:var(--lp-line)}
.lp-board-rows>div{padding:.75em 1em;background:rgba(4,10,12,.92)}
.lp-board-rows dt{font-size:.66em;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:var(--lp-teal)}
.lp-board-rows dd{margin:.25em 0 0;font:800 1.9em/1 var(--lp-display);letter-spacing:.02em;text-transform:uppercase;font-variant-numeric:tabular-nums;color:var(--lp-ink)}
.lp-board-rows dd small{margin-left:.3em;font:700 .5em/1 var(--lp-font);letter-spacing:.2em;color:var(--lp-dim)}
.lp-invalid{color:#ffb487}
.lp-presentation{--cut:16px;top:auto;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(540px,calc(100% - 24px))}
.lp-presentation .lp-scroll{padding:16px 20px 18px}
.lp-presentation h2{font-size:2em}
.lp-presentation progress{display:block;width:100%;margin-top:6px}
.lp-presentation .lp-actions{margin-top:14px}

/* Live HUD: flat plates, no backdrop blur. Score + timer top-left, drift arc top-centre (sky), tach + speed + gear bottom-right. */
.lp-hud{position:absolute;top:max(12px,env(safe-area-inset-top));left:max(12px,env(safe-area-inset-left));display:flex;gap:10px;align-items:flex-start;pointer-events:none;font-variant-numeric:tabular-nums}
.lp-hud strong,.lp-hud small{display:block}
.lp-hud small{font:700 .66em/1 var(--lp-font);letter-spacing:.24em;text-transform:uppercase;color:var(--lp-dim)}
.lp-score{--cut:14px;position:relative;order:1;display:flex;flex-direction:column;min-width:11em;padding:.6em 1.2em .85em 1.1em;background:linear-gradient(100deg,rgba(4,10,12,.82),rgba(4,10,12,.52));clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,0 100%)}
.lp-score::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--lp-live,var(--lp-accent))}
.lp-score::after{content:"";position:absolute;left:4px;bottom:0;height:5px;width:calc(14% + var(--lp-heat,0) * 86%);background:var(--lp-hazard);background-size:20px 20px;opacity:0;transition:opacity .2s}
.lp-score[data-live=true]::after{opacity:1;animation:lp-hazard 1s linear infinite}
.lp-score small{order:-1;color:var(--lp-teal)}
.lp-score .lp-banked{font-family:var(--lp-num);font-size:3.6em;font-weight:900;font-style:italic;letter-spacing:.005em;line-height:.9;transform-origin:left center}
.lp-banked.pop{animation:lp-pop .5s cubic-bezier(.2,1.5,.4,1)}
.lp-chain{display:flex;align-items:center;gap:.6em;margin-top:.5em;font:700 .74em/1 var(--lp-font);letter-spacing:.2em;text-transform:uppercase;color:var(--lp-faint);transition:color .2s ease}
.lp-chain b{font-family:var(--lp-num);font-size:1.9em;font-weight:800;letter-spacing:0;line-height:.8;min-width:2ch}
.lp-chain i{font-style:normal;font-weight:800;letter-spacing:.06em;padding:.25em .6em;background:rgba(255,255,255,.12);color:var(--lp-dim);clip-path:polygon(0 0,calc(100% - 5px) 0,100% 5px,100% 100%,5px 100%,0 calc(100% - 5px));transition:background .2s ease,color .2s ease}
.lp-score[data-live=true]{--lp-live:var(--lp-hot);--lp-live:color-mix(in srgb,var(--lp-accent),var(--lp-hot) calc(var(--lp-heat,0) * 100%))}
.lp-score[data-live=true] .lp-chain{color:var(--lp-live)}
.lp-score[data-live=true] .lp-chain b{font-size:2.3em;text-shadow:0 0 18px var(--lp-live);animation:lp-breathe .9s ease-in-out infinite;transform-origin:left center}
.lp-score[data-live=true] .lp-chain i{background:var(--lp-live);color:#10130a}
.lp-event{--cut:12px;position:relative;order:2;padding:.6em 1.1em .75em;background:rgba(4,10,12,.74);border-bottom:3px solid var(--lp-hot);clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,0 100%)}
.lp-event strong{font-family:var(--lp-num);font-size:2.9em;font-weight:800;line-height:.9;letter-spacing:.01em}
.lp-event small{order:-1;color:var(--lp-hot)}
.lp-event[data-medal="gold"] small,.lp-medal-targets [data-medal="gold"],dd[data-medal="gold"]{color:#f3c64f}
.lp-event[data-medal="silver"] small,.lp-medal-targets [data-medal="silver"],dd[data-medal="silver"]{color:#cfd8dc}
.lp-event[data-medal="bronze"] small,.lp-medal-targets [data-medal="bronze"],dd[data-medal="bronze"]{color:#d99a62}
.lp-medal-targets{display:flex;flex-wrap:wrap;gap:.2em .8em;font-size:.86em}
.lp-speed,.lp-gear,.lp-angle{position:fixed;pointer-events:none}
.lp-speed,.lp-gear{font-size:calc(1em * var(--lp-tach-k))}
.lp-speed{--k:0;right:max(18px,env(safe-area-inset-right));bottom:max(10px,env(safe-area-inset-bottom));width:15em;height:15em;text-align:center}
.lp-tach{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.lp-tach .tr{fill:none;stroke:rgba(4,10,12,.66);stroke-width:14;stroke-linecap:butt}
.lp-tach .tt{fill:none;stroke:rgba(130,205,196,.3);stroke-width:2}
.lp-tach .tz{fill:none;stroke:var(--lp-hot);stroke-width:5;opacity:.85}
.lp-tach .tf{fill:none;stroke:var(--lp-accent);stroke-width:9;stroke-dasharray:0 101;filter:drop-shadow(0 0 6px rgba(216,250,114,.55))}
.lp-tach .tk{stroke:rgba(200,240,232,.5);stroke-width:1.5}
.lp-tach .tk.m{stroke:rgba(244,247,241,.9);stroke-width:2.5}
.lp-speed[data-redline=true] .tf{stroke:var(--lp-hot);filter:drop-shadow(0 0 8px rgba(255,138,31,.8))}
.lp-speed strong{position:absolute;left:0;right:0;top:19%;font-family:var(--lp-num);font-size:6.6em;font-weight:900;font-style:italic;line-height:.85;letter-spacing:0;color:var(--lp-ink);color:color-mix(in srgb,var(--lp-ink),var(--lp-accent) calc(var(--lp-speed-k,0) * 100%));text-shadow:0 3px 18px rgba(0,0,0,.75),0 0 calc(var(--lp-speed-k,0) * 28px) rgba(216,250,114,.4);padding-right:.06em}
.lp-speed small{position:absolute;left:0;right:0;top:61%;letter-spacing:.42em;color:var(--lp-dim);text-shadow:0 1px 6px rgba(0,0,0,.9)}
.lp-gear{--cut:9px;right:calc(max(18px,env(safe-area-inset-right)) + 5.05em * var(--lp-tach-k));bottom:calc(max(10px,env(safe-area-inset-bottom)) + .15em * var(--lp-tach-k));width:5em;display:flex;flex-direction:column;align-items:center;padding:.3em .4em .4em;background:rgba(4,10,12,.82);border-top:3px solid var(--lp-accent);clip-path:polygon(0 0,100% 0,100% calc(100% - var(--cut)),calc(100% - var(--cut)) 100%,var(--cut) 100%,0 calc(100% - var(--cut)))}
.lp-gear strong{font-family:var(--lp-stencil);font-size:2.6em;font-weight:800;line-height:.9;color:var(--lp-accent);text-shadow:none}
.lp-gear small{font-size:.58em;letter-spacing:.3em;margin-right:-.3em}
/* Drift angle: an arch gauge with a live arc that grows both ways from the centre line */
.lp-angle{left:50%;top:calc(max(10px,env(safe-area-inset-top)) + 38px);width:min(19em,62vw);transform:translateX(-50%);text-align:center}
.lp-arc{display:block;width:100%;height:auto;overflow:visible}
.lp-arc .ar-t{fill:none;stroke:rgba(4,10,12,.7);stroke-width:14}
.lp-arc .ar-h{fill:none;stroke:rgba(130,205,196,.28);stroke-width:2}
.lp-arc .ar-k{stroke:rgba(200,240,232,.5);stroke-width:1.4}
.lp-arc .ar-k.w{stroke:#ffc94d;stroke-width:2.2}
.lp-arc .ar-k.h{stroke:var(--lp-hot);stroke-width:2.6}
.lp-arc .ar-k.c{stroke:var(--lp-ink);stroke-width:3}
.lp-arc .ar-f{fill:none;stroke:var(--lp-accent);stroke-width:9;stroke-dasharray:0 2;transition:stroke .15s ease}
.lp-angle-read{position:absolute;left:0;right:0;top:41%;display:flex;flex-direction:column;align-items:center;gap:.45em}
.lp-angle strong{display:block;font-family:var(--lp-num);font-size:2.9em;font-weight:900;font-style:italic;line-height:.9;letter-spacing:0;color:var(--lp-ink);text-shadow:0 2px 12px rgba(0,0,0,.8);transition:color .15s ease}
.lp-angle small{display:block;line-height:1;text-shadow:0 1px 6px rgba(0,0,0,.9);transition:color .15s ease}
.lp-angle[data-level=mid] .ar-f{stroke:#ffc94d}
.lp-angle[data-level=high] .ar-f{stroke:var(--lp-hot)}
.lp-angle[data-level=mid] strong{color:#ffc94d}
.lp-angle[data-level=high] strong{color:var(--lp-hot)}
.lp-angle[data-drift=true] small{color:var(--lp-accent)}
.lp-angle[data-drift=true] .ar-f{filter:drop-shadow(0 0 7px rgba(216,250,114,.8))}
.lp-angle[data-level=high][data-drift=true] .ar-f{filter:drop-shadow(0 0 8px rgba(255,138,31,.9))}
.lp-hud .lp-invalid{position:fixed;top:calc(max(12px,env(safe-area-inset-top)) + 122px);left:50%;transform:translateX(-50%);order:3;padding:.55em 1.3em;background:rgba(130,40,10,.94);border:1px solid rgba(255,160,100,.6);color:#fff;font-weight:700;font-size:.9em;letter-spacing:.1em;text-transform:uppercase;animation:lp-rise .3s ease both;clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.lp-shell .lp-icon{position:absolute;right:max(12px,env(safe-area-inset-right));top:max(12px,env(safe-area-inset-top));min-width:46px;padding:.55em .9em;background-color:rgba(4,10,12,.72)!important;display:inline-flex;align-items:center;justify-content:center;gap:.5em}
.lp-icon svg{width:1.25em;height:1.25em;flex:none}
.lp-icon+[data-action=camera]{top:64px}
.lp-route-guide{pointer-events:none;position:absolute;right:max(12px,env(safe-area-inset-right));top:118px;width:clamp(92px,13vw,168px);aspect-ratio:1;background:rgba(4,10,12,.66);padding:8px;clip-path:polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,16px 100%,0 calc(100% - 16px));background-image:linear-gradient(rgba(130,205,196,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(130,205,196,.12) 1px,transparent 1px);background-size:25% 25%;box-shadow:inset 0 0 0 1px var(--lp-line)}
.lp-route-guide svg{display:block;width:100%;height:100%}
.lp-route-label{position:absolute;right:13px;bottom:8px;font:700 .62em/1 var(--lp-font);letter-spacing:.2em;color:var(--lp-teal)}
.lp-driving-tools{pointer-events:auto;position:absolute;left:max(12px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));display:flex;gap:8px}
.lp-driving-tools button{--cut:7px;min-height:36px;padding:.4em .95em;font-size:.78em;background-color:rgba(4,10,12,.66);opacity:.72}
.lp-driving-tools button:hover,.lp-driving-tools button:focus-visible{opacity:1}
.lp-input-hint{pointer-events:auto;position:absolute;left:max(12px,env(safe-area-inset-left));bottom:calc(max(14px,env(safe-area-inset-bottom)) + 52px);display:flex;align-items:center;gap:10px;max-width:min(46vw,560px);padding:.55em .6em .55em 1em;background:rgba(4,10,12,.76);border-left:3px solid var(--lp-teal);font-size:.84em;line-height:1.6;letter-spacing:.03em;transition:opacity 1s ease;clip-path:polygon(0 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%)}
.lp-input-hint kbd{display:inline-block;min-width:1.9em;padding:.12em .5em .08em;margin:0 .15em;font:700 .92em/1.3 var(--lp-font);letter-spacing:.04em;text-align:center;text-transform:uppercase;color:var(--lp-ink);background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.34);border-bottom-width:3px;border-radius:4px}
.lp-input-hint em{font-style:normal;color:var(--lp-accent);font-weight:600}
.lp-assist-hint{position:absolute;left:50%;top:calc(max(14px,env(safe-area-inset-top)) + 64px);transform:translateX(-50%);margin:0;max-width:min(88vw,560px);padding:.5em 1em;background:rgba(4,10,12,.8);border-left:3px solid var(--lp-teal);font-size:.86em;line-height:1.5;letter-spacing:.03em;text-align:center;pointer-events:none;transition:opacity 1s ease}
.lp-assist-note{margin:.1em 0 .6em;font-size:.84em;opacity:.78;line-height:1.45}
.lp-input-hint button{--cut:5px;min-height:30px;min-width:30px;padding:2px 8px}
.lp-tutorial{position:absolute;left:max(12px,env(safe-area-inset-left));top:118px;width:min(316px,50vw);pointer-events:auto}
.lp-tutorial-card{position:relative;padding:1em 1.1em .95em 1.2em;background:rgba(4,10,12,.82);border-top:1px solid var(--lp-line);clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,0 100%);animation:lp-rise .35s cubic-bezier(.2,.8,.2,1) both}
.lp-tutorial-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--lp-accent)}
.lp-tutorial-card strong{display:block;font-family:var(--lp-stencil);font-size:1.45em;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--lp-accent)}
.lp-tutorial-card p{margin:.35em 0;color:#e8efec;font-size:.92em}
.lp-tutorial-card progress,.lp-presentation progress{appearance:none;-webkit-appearance:none;display:block;width:100%;height:8px;margin:9px 0;border:0;border-radius:0;overflow:hidden;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 2px),rgba(4,10,12,.95) calc(10% - 2px) 10%),rgba(130,205,196,.22)}
.lp-tutorial-card progress::-webkit-progress-bar,.lp-presentation progress::-webkit-progress-bar{background:transparent}
.lp-tutorial-card progress::-webkit-progress-value,.lp-presentation progress::-webkit-progress-value{background:var(--lp-accent);transition:width .25s ease}
.lp-tutorial-card progress::-moz-progress-bar,.lp-presentation progress::-moz-progress-bar{background:var(--lp-accent)}
.lp-tutorial-card small{display:block;color:var(--lp-dim);letter-spacing:.04em;text-transform:none;font-size:.82em;font-weight:500}
.lp-tutorial-card button{--cut:6px;min-height:34px;margin:4px 6px 0 0;padding:.3em .9em;font-size:.74em}
.lp-error{pointer-events:auto;position:absolute;top:110px;left:50%;transform:translateX(-50%);padding:.6em 1.3em;background:rgba(130,40,14,.94);border:1px solid rgba(255,170,120,.5);clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.lp-error:empty{display:none}
.lp-storage-warning:empty{display:none}
.lp-storage-warning:not(:empty){pointer-events:auto;position:absolute;z-index:7;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100% - 24px);padding:.55em 1.3em;background:rgba(124,62,12,.95);border-left:4px solid var(--lp-hot);color:#fff;font-size:.84em;letter-spacing:.03em}
.lp-live{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}

/* Speed and input feel: cheap opacity-only layers (no per-frame gradient repaints) */
.lp-fx{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1}
.lp-fx>*{position:absolute;inset:0;will-change:opacity}
.lp-fx-vignette{background:radial-gradient(ellipse 78% 72% at 50% 52%,transparent 52%,rgba(2,8,10,.76) 100%);opacity:calc(.22 + var(--lp-speed-k,0) * .78)}
.lp-fx-lines{inset:-12%;background:repeating-conic-gradient(from 0deg at 50% 54%,rgba(255,255,255,.34) 0 .22deg,transparent .22deg 4.4deg);-webkit-mask-image:radial-gradient(ellipse 66% 62% at 50% 54%,transparent 66%,#000 100%);mask-image:radial-gradient(ellipse 66% 62% at 50% 54%,transparent 66%,#000 100%);opacity:max(0,calc((var(--lp-speed-k,0) - .4) * 1.1 + var(--lp-hyper-k,0) * .45));transform:scale(calc(1 - var(--lp-hyper-k,0) * .09));animation:lp-streak .16s steps(1,end) infinite}
.lp-fx-brake{background:linear-gradient(0deg,rgba(255,74,52,.55),rgba(255,74,52,0) 26%);opacity:var(--lp-brake,0);transition:opacity .09s linear}
.lp-fx-hb{background:linear-gradient(90deg,rgba(255,201,77,.42),rgba(255,201,77,0) 11%,rgba(255,201,77,0) 89%,rgba(255,201,77,.42));opacity:var(--lp-hb,0);transition:opacity .09s linear}
.lp-fx-hit{background:radial-gradient(ellipse at 50% 50%,transparent 38%,rgba(255,60,40,.65) 100%);opacity:0}
.lp-fx-hit.go{animation:lp-hit .5s ease-out}
.lp-popups{position:absolute;left:50%;top:30%;width:0;height:0}
.lp-popup{position:absolute;left:0;top:0;transform:translateX(-50%);white-space:nowrap;font-family:var(--lp-num);font-weight:900;font-style:italic;font-size:4em;letter-spacing:.01em;line-height:.9;color:var(--lp-accent);text-shadow:0 3px 16px rgba(0,0,0,.8),0 0 30px rgba(216,250,114,.45);animation:lp-popup 1.25s cubic-bezier(.2,.8,.2,1) both}
.lp-popup i{font:700 .22em/1 var(--lp-font);font-style:normal;letter-spacing:.2em;text-transform:uppercase;margin-left:.8em;padding:.45em .9em;background:var(--lp-accent);color:#10130a;text-shadow:none;vertical-align:1.2em;clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))}
.lp-popup.lost{font-size:2.4em;color:#ff9f7a;text-shadow:0 2px 12px rgba(0,0,0,.8);animation-duration:1s}
.lp-popup.mult{font-size:3em;color:var(--lp-hot);text-shadow:0 2px 14px rgba(0,0,0,.8),0 0 28px rgba(255,138,31,.45)}

@keyframes lp-rise{from{opacity:0;translate:0 16px}to{opacity:1;translate:0 0}}
@keyframes lp-fade{from{opacity:0}to{opacity:1}}
@keyframes lp-pop{0%{transform:scale(1)}35%{transform:scale(1.2);color:var(--lp-accent)}100%{transform:scale(1)}}
@keyframes lp-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
@keyframes lp-streak{0%{transform:rotate(0)}50%{transform:rotate(1.4deg)}}
@keyframes lp-hit{0%{opacity:.95}100%{opacity:0}}
@keyframes lp-hazard{from{background-position:0 0}to{background-position:20px 0}}
@keyframes lp-stamp{0%{opacity:0;scale:2.4;rotate:-12deg}60%{opacity:1;scale:.94;rotate:2deg}100%{opacity:1;scale:1;rotate:0deg}}
@keyframes lp-popup{0%{opacity:0;translate:0 14px;scale:.6}12%{opacity:1;translate:0 0;scale:1.18}26%{scale:1}75%{opacity:1}100%{opacity:0;translate:0 -52px}}
.lp-overlay.lp-still .lp-panel,.lp-overlay.lp-still .lp-panel *{animation:none!important}
[data-reduced-motion=true] *,[data-reduced-motion=true] *::before,[data-reduced-motion=true] *::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}
[data-reduced-motion=true] .lp-fx-lines,[data-reduced-motion=true] .lp-fx-hit{display:none}
@media(prefers-reduced-motion:reduce){.lp-shell *,.lp-shell *::before,.lp-shell *::after{animation:none!important;transition:none!important}.lp-fx-lines,.lp-fx-hit{display:none}}

@media(max-width:900px){.lp-input-hint{max-width:min(52vw,400px)}.lp-shell{--lp-tach-k:.86}}
@media(max-width:720px){.lp-menu,.lp-side{left:50%;top:calc(50% + 28px);max-height:calc(100% - 76px);transform:translate(-50%,-50%)}.lp-shell[data-screen=pause]::before{background:linear-gradient(0deg,rgba(3,9,11,.82),rgba(3,9,11,.5))}}
@media(max-width:640px){.lp-shell{--lp-tach-k:.66}.lp-panel{--cut:16px}.lp-scroll{padding:18px}.lp-panel h2{font-size:2.4em}.lp-events{grid-template-columns:1fr}.lp-events button{min-height:54px;flex-direction:row;align-items:center;justify-content:space-between}.lp-events button::before{font-size:1.8em}.lp-events .lp-sub{text-align:right}.lp-hud{gap:6px}.lp-score{min-width:8.4em;padding:.4em .9em .7em .9em}.lp-score .lp-banked{font-size:2.8em}.lp-event{position:fixed;top:max(12px,env(safe-area-inset-top));right:calc(max(12px,env(safe-area-inset-right)) + 56px);padding:.35em .8em .5em}.lp-event strong{font-size:2em}.lp-input-hint{font-size:.74em;max-width:66vw;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 46px)}.lp-angle{width:min(13em,42vw);top:calc(max(12px,env(safe-area-inset-top)) + 52px)}.lp-angle strong{font-size:2.2em}.lp-grid label{grid-template-columns:4.6em minmax(0,1fr);gap:8px}.lp-settings label{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr) 3.2em;gap:8px;font-size:.9em}.lp-remaps{grid-template-columns:1fr}.lp-results .lp-actions{grid-template-columns:1fr 1fr}.lp-result-score{font-size:4.6em}.lp-grade{width:5em}.lp-grade span{font-size:4.2em}.lp-popup{font-size:2.7em}.lp-hud .lp-invalid{top:calc(max(12px,env(safe-area-inset-top)) + 122px)}.lp-lockup .lp-brand strong{font-size:2.3em}.lp-stat{grid-template-columns:5em minmax(0,1fr) 2.6em;gap:8px}}
@media(hover:none),(pointer:coarse){.lp-speed{bottom:calc(max(10px,env(safe-area-inset-bottom)) + 88px)}.lp-gear{bottom:calc(max(10px,env(safe-area-inset-bottom)) + 88px + .15em * var(--lp-tach-k))}.lp-driving-tools{bottom:calc(max(12px,env(safe-area-inset-bottom)) + 88px)}.lp-input-hint{bottom:calc(max(12px,env(safe-area-inset-bottom)) + 88px + 46px)}}
@media(max-height:480px){.lp-panel{max-height:calc(100% - 12px)}.lp-scroll{padding:14px 18px}.lp-menu h1{font-size:2.6em;margin:.5em 0 .2em}.lp-menu p{margin:.25em 0}.lp-menu h3{margin:1em 0 .5em}.lp-nav,.lp-actions{margin-top:12px}.lp-grid,.lp-settings{gap:6px}.lp-shell{--lp-tach-k:.62}.lp-mark{width:2.8em;height:2.8em}.lp-brand strong{font-size:2.2em}.lp-nav .lp-primary{min-height:48px;font-size:1.4em}.lp-events button{min-height:56px}.lp-result-score{font-size:4.2em}.lp-grade span{font-size:3.6em}}
/* Touch and small-screen layout. Touch keys only exist while driving (input hides them in menus too). */
html:not([data-lateral-screen=drive]) .lateral-touch-controls{display:none!important}
html[data-lateral-screen=drive],html[data-lateral-screen=drive] body{touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
html .lateral-touch-controls{inset:auto max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));z-index:4;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
html .lateral-steer,html .lateral-pedals{gap:10px}
html .lateral-touch-controls button{min-width:64px;min-height:64px;padding:0 10px;border:1px solid rgba(130,205,196,.42);border-radius:0;background:rgba(5,11,13,.52);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#f4f7f1;font:700 15px/1 'Chakra Petch',ui-monospace,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px));-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;touch-action:none;transition:transform .08s,background .08s}
html .lateral-touch-controls [data-control=left],html .lateral-touch-controls [data-control=right]{min-width:72px;min-height:72px;font-size:22px}
html .lateral-touch-controls [data-control=brake]{order:1;border-color:rgba(255,138,31,.5)}
html .lateral-touch-controls [data-control=handbrake]{order:2;border-color:rgba(255,201,77,.55);color:#ffc94d}
html .lateral-touch-controls [data-control=throttle]{order:3;min-width:84px;min-height:92px;background:rgba(216,250,114,.82);border-color:transparent;color:#0d1505}
html .lateral-touch-controls .is-pressed{transform:scale(.95);background:rgba(47,184,173,.55);filter:none}
html .lateral-touch-controls [data-control=throttle].is-pressed{background:#d8fa72}html .lateral-touch-controls [data-recover]{position:absolute;right:0;bottom:calc(100% + 12px);min-width:0;min-height:44px;padding:0 14px;font-size:11px;letter-spacing:.16em;color:#cfe9e4}
html .lateral-touch-controls[data-steer-mode=drag] .lateral-steer{gap:0;border:1px dashed rgba(130,205,196,.5);background:rgba(5,11,13,.3);clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px))}
html .lateral-touch-controls[data-steer-mode=drag] .lateral-steer button{background:transparent;border-color:transparent;clip-path:none;-webkit-backdrop-filter:none;backdrop-filter:none;color:rgba(244,247,241,.6)}
@media(pointer:coarse){html[data-lateral-screen=drive] .owner-tools{display:none}.lp-speed{bottom:calc(max(10px,env(safe-area-inset-bottom)) + 112px)}.lp-gear{bottom:calc(max(10px,env(safe-area-inset-bottom)) + 112px + .15em * var(--lp-tach-k))}}

/* Portrait (phones and tablets): menus become a bottom sheet so the car stays in view */
@media(orientation:portrait) and (max-width:1100px){
.lp-menu,.lp-side,.lp-results{left:50%;right:auto;top:auto;bottom:max(10px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(620px,calc(100% - 20px));max-height:min(62%,calc(100% - 120px))}
.lp-shell[data-screen=pause]::before{background:linear-gradient(0deg,rgba(3,9,11,.85) 0%,rgba(3,9,11,.5) 45%,rgba(3,9,11,0) 75%)}
}

/* Narrow and tablet widths: the drift arc and the lesson card share the top band, so the card drops below it */
@media(max-width:1100px) and (min-height:481px){.lp-shell .lp-tutorial{top:calc(max(12px,env(safe-area-inset-top)) + 152px)}}

/* Portrait phone while driving */
@media(orientation:portrait) and (max-width:600px){
.lp-shell .lp-icon[data-action=camera]{top:calc(max(12px,env(safe-area-inset-top)) + 52px);right:max(12px,env(safe-area-inset-right));font-size:0;gap:0;min-width:46px;padding:0 12px}
.lp-shell .lp-icon[data-action=camera] svg{width:18px;height:18px}
.lp-shell .lp-route-guide{top:calc(max(12px,env(safe-area-inset-top)) + 104px);right:max(12px,env(safe-area-inset-right));width:76px}
.lp-angle{top:calc(max(12px,env(safe-area-inset-top)) + 92px);width:min(13em,40vw)}
.lp-shell .lp-tutorial{top:calc(max(12px,env(safe-area-inset-top)) + 160px);left:max(8px,env(safe-area-inset-left))}
.lp-hud .lp-invalid{top:calc(max(12px,env(safe-area-inset-top)) + 160px)}
.lp-input-hint{max-width:calc(100% - 24px - 160px * var(--lp-tach-k) / .66)}
}
@media(max-width:480px) and (orientation:portrait){html .lateral-touch-controls button{min-width:56px;min-height:60px;padding:0 6px;font-size:13px;letter-spacing:.06em}html .lateral-touch-controls [data-control=left],html .lateral-touch-controls [data-control=right]{min-width:60px;min-height:64px}html .lateral-touch-controls [data-control=throttle]{min-width:66px;min-height:80px}html .lateral-steer,html .lateral-pedals{gap:8px}html[data-lateral-screen=drive] .lp-speed{bottom:calc(max(14px,env(safe-area-inset-bottom)) + 96px)}html[data-lateral-screen=drive] .lp-gear{bottom:calc(max(14px,env(safe-area-inset-bottom)) + 96px + .15em * var(--lp-tach-k))}}
@media(pointer:coarse) and (orientation:portrait) and (max-width:600px){html[data-lateral-screen=drive] body::after{content:'Turn your phone sideways for a wider view';position:fixed;z-index:5;left:50%;top:44%;transform:translateX(-50%);padding:7px 14px;background:rgba(5,11,13,.72);border:1px solid rgba(130,205,196,.35);border-left:3px solid #2fb8ad;color:#b7c5bf;font:600 11px/1.2 'Chakra Petch',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;pointer-events:none;animation:lp-rot-hint 7s forwards}}
@keyframes lp-rot-hint{0%{opacity:0}8%,72%{opacity:1}100%{opacity:0}}

/* Short landscape (phones on their side): compact HUD in the corners, tach between the thumbs */
@media(max-height:480px) and (orientation:landscape){
.lp-menu,.lp-side,.lp-results{left:max(12px,env(safe-area-inset-left));top:50%;transform:translateY(-50%);width:min(470px,64%);max-height:calc(100% - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom))}
.lp-score{min-width:8.4em;padding:.4em .9em .6em}.lp-score .lp-banked{font-size:2.5em}.lp-chain{margin-top:.35em}
.lp-angle{top:max(6px,env(safe-area-inset-top));width:min(11em,30vw)}.lp-angle strong{font-size:2em}
.lp-shell .lp-icon[data-action=camera]{top:max(12px,env(safe-area-inset-top));right:calc(max(12px,env(safe-area-inset-right)) + 54px);font-size:0;gap:0;min-width:46px;padding:0 12px}
.lp-shell .lp-icon[data-action=camera] svg{width:18px;height:18px}
.lp-shell .lp-route-guide{top:calc(max(12px,env(safe-area-inset-top)) + 54px);right:max(12px,env(safe-area-inset-right));width:76px}
.lp-event{position:fixed;top:max(12px,env(safe-area-inset-top));right:calc(max(12px,env(safe-area-inset-right)) + 108px);padding:.35em .8em .5em}.lp-event strong{font-size:2em}
.lp-shell .lp-tutorial{top:calc(max(12px,env(safe-area-inset-top)) + 84px);left:max(12px,env(safe-area-inset-left));width:min(230px,30vw);font-size:.76em}
.lp-input-hint{left:50%;transform:translateX(-50%);top:calc(max(6px,env(safe-area-inset-top)) + 66px);bottom:auto;max-width:min(36vw,320px);font-size:.74em}
.lp-hud .lp-invalid{top:calc(max(6px,env(safe-area-inset-top)) + 66px)}
.lp-speed{right:auto;left:50%;transform:translateX(-50%);bottom:max(6px,env(safe-area-inset-bottom))}
.lp-gear{right:auto;left:50%;transform:translateX(-50%);bottom:max(6px,env(safe-area-inset-bottom))}
html .lateral-touch-controls button{min-width:60px;min-height:60px}html .lateral-touch-controls [data-control=left],html .lateral-touch-controls [data-control=right]{min-width:64px;min-height:64px}html .lateral-touch-controls [data-control=throttle]{min-height:76px;min-width:72px}html .lateral-steer,html .lateral-pedals{gap:8px}
}
@media(max-height:480px) and (orientation:landscape) and (pointer:coarse){.lp-driving-tools{display:none}}
`;
