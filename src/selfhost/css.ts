/**
 * Styles for the account and gift screens of the self-hosted build. They reuse the feature layer plates (.lf-layer,
 * .lf-card) and the game variables; only what those do not cover is added here.
 */
export const SELFHOST_CSS = `
.lp-shell .sh-layer{z-index:82}
.sh-card{width:min(520px,100%)}
.sh-card .lf-title{font-size:clamp(1.7em,5vw,2.4em)}
.sh-form{display:grid;gap:10px;margin:6px 0 0}
.sh-field{display:grid;gap:5px}
.sh-field label{font-size:.7em;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:var(--lp-teal)}
.lp-shell .sh-input{width:100%;min-height:48px;padding:.5em .8em;font:600 1.1em/1.2 var(--lp-font);letter-spacing:.06em;color:var(--lp-ink);background:rgba(0,0,0,.45);border:1px solid var(--lp-line-strong);border-radius:0;pointer-events:auto;text-shadow:none}
.lp-shell .sh-input.code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase}
.lp-shell .sh-input[aria-invalid=true]{border-color:var(--lp-hot)}
.sh-rules{margin:0;font-size:.82em;line-height:1.4;color:var(--lp-dim)}
.sh-err{min-height:1.3em;margin:0;font-size:.86em;line-height:1.35;color:#ffb27a}
.sh-ok{margin:0;font-size:.86em;line-height:1.35;color:var(--lp-accent)}
.sh-gift{margin:8px 0 0;padding:.6em .9em;font-size:.92em;line-height:1.4;border-left:3px solid var(--lp-accent);background:rgba(216,250,114,.08)}
.sh-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}
.lp-shell .sh-actions .lf-go{flex:1 1 auto}
.lp-shell .sh-link{--cut:0px;clip-path:none;background:none;background-image:none;border:0;border-bottom:1px dashed var(--lp-line-strong);padding:.3em .1em;min-height:36px;text-transform:none;letter-spacing:.03em;font-weight:600;color:var(--lp-dim)}
.lp-shell .sh-link:hover:not(:disabled){transform:none;background:none;color:var(--lp-accent)}
.sh-or{display:grid;gap:4px;margin:12px 0 0;padding-top:10px;border-top:1px solid var(--lp-line)}
.sh-or small{font-size:.8em;line-height:1.4;color:var(--lp-faint)}
.sh-code{margin:8px 0 2px;padding:.8em .6em;text-align:center;font:700 clamp(1.15em,5.2vw,1.7em)/1.2 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.12em;color:var(--lp-accent);background:rgba(216,250,114,.07);border:1px solid var(--lp-accent);user-select:all;-webkit-user-select:all;overflow-wrap:anywhere}
.sh-warn{margin:8px 0 0;padding:.6em .9em;font-size:.9em;line-height:1.45;border-left:3px solid var(--lp-hot);background:rgba(255,138,31,.1)}
.sh-tick{display:flex;align-items:center;gap:10px;margin:12px 0 0;min-height:44px;font-size:.95em;cursor:pointer;pointer-events:auto}
.sh-tick input{width:22px;height:22px;accent-color:var(--lp-accent);pointer-events:auto}
.sh-block{display:grid;gap:8px;margin:2px 0 6px;padding:12px;border:1px solid var(--lp-line);background:rgba(255,255,255,.03)}
.sh-block h4{margin:0}
.sh-block p{margin:0;font-size:.88em;line-height:1.45;color:var(--lp-dim)}
.sh-block .sh-name{font:800 1.5em/1 var(--lp-display);letter-spacing:.05em;color:var(--lp-ink)}
.sh-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.lp-shell .sh-row button{min-height:40px;font-size:.74em;padding:.4em 1em}
.sh-redeem{display:flex;gap:8px;align-items:stretch}
.sh-redeem .sh-input{flex:1 1 auto;min-width:0}
.lp-shell .lt-root .lt-inbox{--cut:12px;display:flex;align-items:center;gap:8px;min-height:40px;padding:.35em .9em;background-color:rgba(216,250,114,.14);border:1px solid var(--lp-accent);color:var(--lp-accent);font-weight:700;letter-spacing:.1em;animation:lt-pulse 2.2s ease-in-out infinite}
.lt-inbox em{display:grid;place-items:center;min-width:20px;height:20px;padding:0 4px;font:800 .78em/1 var(--lp-display);font-style:normal;color:var(--lp-on-accent);background:var(--lp-accent);border-radius:10px}
@media (max-height:520px) and (orientation:landscape){.sh-card .lf-body{padding-bottom:6px}.sh-code{margin:4px 0}}
@media (prefers-reduced-motion:reduce){.lp-shell .lt-root .lt-inbox{animation:none}}
`;
