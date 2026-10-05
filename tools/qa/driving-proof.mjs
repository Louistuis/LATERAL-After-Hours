import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const out=process.env.LATERAL_EVIDENCE_DIR || 'evidence/G1/browser';
mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-gpu','--ignore-gpu-blocklist','--use-gl=angle','--use-angle=gl-egl']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const samples=[];
async function capture(label){const state=await page.evaluate(()=>window.__LATERAL_PROOF__);samples.push({label,state});return state;}
try {
 await page.goto(process.env.LATERAL_URL || 'http://127.0.0.1:5173');
 await page.waitForFunction(()=>!!window.__LATERAL_PROOF__);await page.waitForTimeout(750);
 const start=await capture('rest');
 await page.keyboard.down('KeyW');await page.waitForTimeout(2500);await page.keyboard.down('KeyD');await page.waitForTimeout(800);await page.keyboard.up('KeyD');await page.keyboard.down('Space');await page.waitForTimeout(250);await page.keyboard.up('Space');await page.keyboard.up('KeyW');
 const drive=await capture('drive');await page.screenshot({path:`${out}/drive.png`});
 await page.keyboard.press('Escape');const pause=await capture('pause');await page.waitForTimeout(400);const pauseLater=await capture('pause-later');
 await page.keyboard.press('Escape');await page.keyboard.press('KeyR');await page.waitForTimeout(400);const reset=await capture('reset');
 const position=v=>Math.hypot(v.x,v.z);
 const checks={noPageErrors:errors.length===0,carMoves:position(drive.vehicle.position)>10,rightSteering:drive.vehicle.position.x>0.2,fourContactsAtRest:start.vehicle.wheels.filter(w=>w.contact).length===4,pauseStopsSimulation:pause.tick===pauseLater.tick,resetRestoresSpawn:position(reset.vehicle.position)<1};
 const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,timestamp:new Date().toISOString(),browser:browser.version(),graphics:await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);}),scope:'Development driving proof, not final release regression or reference-device benchmark',checks,errors,samples};
 writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));console.log(checks);if(Object.values(checks).some(v=>!v))process.exitCode=1;
} finally {await browser.close();}
