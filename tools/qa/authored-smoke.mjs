import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const url=process.env.LATERAL_URL||'http://127.0.0.1:4173';
const output=process.env.LATERAL_EVIDENCE_DIR||'evidence/integration/static-authored-01';
mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-gpu','--ignore-gpu-blocklist','--use-gl=angle','--use-angle=gl-egl']});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const consoleLog=[],errors=[],navigations=[],samples=[],checks={};
page.on('console',message=>consoleLog.push({type:message.type(),text:message.text()}));
page.on('pageerror',error=>errors.push(error.stack));
page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations.push({time:new Date().toISOString(),url:frame.url()});});
async function sample(label){
  const state=await page.evaluate(()=>window.__LATERAL_QA__);
  assert.ok(state?.view?.frame?.current,`Runtime observation missing at ${label}`);
  samples.push({label,state});return state.view;
}
const travel=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
let failure=null;
try{
  await page.goto(url);await page.waitForSelector('.lp-menu',{timeout:20000});
  const initial=await sample('menu');
  assert.equal(initial.paused,true);checks.freshBoot=true;
  await page.screenshot({path:`${output}/menu.png`});
  await page.getByRole('button',{name:'Drive',exact:true}).click();
  await page.keyboard.down('KeyW');await page.waitForTimeout(2200);
  await page.keyboard.down('KeyD');await page.waitForTimeout(500);
  await page.keyboard.up('KeyD');await page.keyboard.up('KeyW');
  const driven=await sample('drive');
  assert.ok(travel(initial.frame.current.position,driven.frame.current.position)>3,'Real keyboard drive did not move the car');
  assert.equal(driven.paused,false);checks.keyboardDrive=true;
  await page.screenshot({path:`${output}/drive.png`});
  await page.keyboard.press('Escape');await page.waitForSelector('.lp-menu');
  const paused=await sample('pause');await page.waitForTimeout(300);const pausedLater=await sample('pause-later');
  assert.equal(paused.paused,true);assert.equal(paused.frame.current.simulationTick,pausedLater.frame.current.simulationTick);checks.pause=true;
  await page.locator('.lp-menu [data-action="garage"]').click();await page.waitForSelector('.lp-garage');
  await page.locator('.lp-garage [data-select="tune"]').selectOption('Drift');
  await page.waitForFunction(()=>window.__LATERAL_QA__?.view.tune==='Drift');
  checks.garageTune=true;await page.screenshot({path:`${output}/garage.png`});
  await page.locator('.lp-garage [data-action="drive"]').click();
  await page.keyboard.press('KeyR');await page.waitForTimeout(400);
  const reset=await sample('reset');assert.ok(travel(initial.route.spawn.position,reset.frame.current.position)<2);checks.reset=true;
  await page.keyboard.press('Escape');await page.waitForSelector('.lp-menu');
  await page.reload();await page.waitForSelector('.lp-menu');
  const restored=await sample('reload');assert.equal(restored.tune,'Drift');checks.saveReload=true;
  assert.deepEqual(errors,[]);checks.noPageErrors=true;
}catch(error){failure=String(error);process.exitCode=1;await page.screenshot({path:`${output}/failure.png`}).catch(()=>{});}
finally{
  const report={timestamp:new Date().toISOString(),url,scope:'Actual-input static authored integration smoke, not final release/device QA',browser:browser.version(),checks,failure,errors,navigations,consoleLog,samples};
  writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({checks,failure,errors,navigations},null,2));await browser.close();
}
