'use strict';
const {test,expect}=require('@playwright/test');
const fs=require('node:fs');const vm=require('node:vm');
const routes=['control','output-processing','input-processing','loudness','advanced','signal-generator','measurement-batch','preferences'];
test('system status handles thresholds, missing protection and absent telemetry',()=>{
 const context={window:{}};vm.createContext(context);
 for(const file of ['pipeline','control-model','system-status'])vm.runInContext(fs.readFileSync(`public/prototypes/estack-ui/shared/domain/${file}.js`,'utf8'),context);
 const summarize=context.window.EStackSystemStatus.summarize;
 const config={devices:{playback:{channels:2}},filters:{limit:{type:'Limiter',parameters:{clip_limit:-10}},gain:{type:'Gain',parameters:{gain:0,mute:false}}},pipeline:[{type:'Filter',channels:[0,1],names:['gain','limit']}]};
 for(const [audio,state] of [[10,'ok'],[69,'ok'],[75,'warning'],[95,'critical'],[100,'critical']]) { const peak=-10+20*Math.log10(audio/100); const snapshot=summarize({config,load:.8,peaks:[peak,peak]});expect(snapshot.load).toBeCloseTo(audio,5);expect(snapshot.loadState).toBe(state);expect(snapshot.cpuLoad).toBe(.8); }
 expect(summarize({}).load).toBeNull(); for(const [peak,state] of [[-20,'armed'],[-13,'near'],[-10,'limit'],[-9,'limit']])expect(summarize({config,peaks:[peak,-30]}).limiter).toBe(state);
 expect(summarize({}).limiter).toBe('unknown');expect(summarize({}).master).toBeNull();
 expect(summarize({config,peaks:[-100,-100]}).margin).toBeNull();
 const missing=structuredClone(config);missing.pipeline[0].channels=[0];expect(summarize({config:missing}).limiter).toBe('missing');
 const bypassed=structuredClone(config);bypassed.pipeline[0].bypassed=true;expect(summarize({config:bypassed}).limiter).toBe('missing');
 const muted=structuredClone(config);muted.filters.gain.parameters.mute=true;expect(summarize({config:muted,peaks:[0,0]}).limiter).toBe('armed');
 const malformed=structuredClone(config);malformed.filters.limit.parameters.clip_limit=null;expect(summarize({config:malformed}).limiter).toBe('missing');
});
for(const width of [360,390,430,1440])test(`all workspaces retain live shell status and fit at ${width}px`,async({page,request})=>{
 test.setTimeout(60000);expect(process.platform).toBe('linux');expect((await (await request.get('/api/runtime')).json()).mode).toBe('demo');
 await page.setViewportSize({width,height:900});const writes=[];const errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>socket.on('framesent',({payload})=>{if(/SetConfig|SetVolume|SetMute/.test(String(payload)))writes.push(String(payload));}));
 await page.goto('/estack-dsp/?transport=camillanode#control');await expect(page.locator('[data-shell-load]')).toHaveText(/\d+\.\d %/);
 for(const route of routes){
  if(width<1181)await page.locator('#mobilePageSelect').selectOption(route);else await page.locator(`[data-page="${route}"]`).click();
  await expect.poll(()=>page.frames().some(f=>f.url().includes(`/pages/${route}/page.html`))).toBeTruthy();
  const frame=page.frames().find(f=>f.url().includes(`/pages/${route}/page.html`));await frame.waitForLoadState();
  await expect(page.locator('[data-shell-load]')).toHaveText(/\d+\.\d %/);await expect(page.locator('[data-shell-limiters]')).toBeVisible();
  expect(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  if(route==='control') expect(await frame.evaluate(()=>[...document.querySelectorAll('.channel-pair')].every(pair=>{
   const links=pair.querySelectorAll('.strip-pair-link');
   return links.length===2 && [...links].every(link=>link.getBoundingClientRect().height>=24);
  }))).toBeTruthy();
  expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight)).toBeTruthy();
  await frame.evaluate(()=>scrollTo(0,document.body.scrollHeight));await expect(page.locator('[data-shell-load]')).toBeInViewport();
 }
 expect(errors).toEqual([]);expect(writes).toEqual([]);
});
test('live shell colors load thresholds and clears readings when offline',async({page,request})=>{
 expect((await (await request.get('/api/runtime')).json()).mode).toBe('demo');let load=20,offline=false;
 await page.routeWebSocket('**/ws/dsp',ws=>{const server=ws.connectToServer();ws.onMessage(message=>{if(offline){ws.close();return;}if(String(message)==='"GetConfigJson"'){ws.send(JSON.stringify({GetConfigJson:{result:'Ok',value:JSON.stringify({devices:{playback:{channels:2}},filters:{limit:{type:'Limiter',parameters:{clip_limit:-13.5}}},pipeline:[{type:'Filter',channels:[0,1],names:['limit']}]})}}));}else if(String(message)==='"GetPlaybackSignalPeak"'){ws.send(JSON.stringify({GetPlaybackSignalPeak:{result:'Ok',value:[-13.5,-13.5].map(v=>v+20*Math.log10(load/100))}}));}else server.send(message);});server.onMessage(message=>ws.send(message));});
 await page.goto('/estack-dsp/?transport=camillanode#connections');
 for(const [value,state]of [[20,'ok'],[75,'warning'],[95,'critical']]){load=value;await expect(page.locator('[data-shell-load]')).toHaveText(`${value.toFixed(1)} %`);await expect(page.locator('[data-shell-load]').locator('..')).toHaveAttribute('data-state',state);}
 offline=true;await expect(page.locator('[data-shell-load]')).toHaveText('— %',{timeout:15000});await expect(page.locator('[data-shell-limiters]')).toHaveText('UNKNOWN');
});
