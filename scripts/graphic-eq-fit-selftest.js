'use strict';
const assert=require('assert');
const F=require('../public/prototypes/estack-ui/shared/domain/graphic-eq-fit');
const cases={flat:Array(10).fill(0),six:Array(10).fill(6),alternating:Array.from({length:10},(_,i)=>i%2?-12:12),acoustic:F.ACOUSTIC,boost:Array.from({length:10},(_,i)=>i===4?12:0),cut:Array.from({length:10},(_,i)=>i===4?-12:0)};
for(const rate of [44100,48000,96000]) for(const [name,values] of Object.entries(cases)) {
  const fitted=F.fit(values,rate);
  assert.deepStrictEqual(fitted,F.fit(values,rate),`${name}: nondeterministic fit`);
  assert(fitted.anchorError<=.25,`${name}: anchor error ${fitted.anchorError}`);
  assert(fitted.rmsError<(name==='alternating'?2:.4),`${name}: RMS error ${fitted.rmsError}`);
  for(const b of fitted.bands) assert([b.gain,b.q,b.frequency].every(Number.isFinite)&&b.q>0&&Math.abs(b.gain)<=36&&b.frequency<rate/2);
  const curve=F.targetCurve(values);
  for(let i=0;i<10;i++) assert(Math.abs(curve(F.FREQUENCIES[i])-values[i])<1e-9);
  for(let i=0;i<1001;i++) {
    const f=20*Math.pow(1000,i/1000), t=curve(f), actual=F.response(fitted.bands,f,rate);
    assert(Number.isFinite(actual));
    assert(t>=Math.min(...values)-1e-9&&t<=Math.max(...values)+1e-9,'target interpolation overshoots');
    assert(Math.abs(actual)<=15,'unbounded DSP response');
  }
  if(name==='flat') assert.strictEqual(fitted.bands.length,0);
  if(rate===48000) console.log(`GEQ ${name}: anchor ${fitted.anchorError.toFixed(6)} dB; RMS ${fitted.rmsError.toFixed(6)} dB`);
}
assert.throws(()=>F.fit(Array(10).fill(NaN)),/target gains/);
assert.throws(()=>F.fit(Array(10).fill(13)),/target gains/);
console.log('OK: GEQ target interpolation, deterministic IIR fitting, extreme settings and sample rates');
