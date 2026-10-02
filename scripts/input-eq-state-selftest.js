'use strict';
const assert=require('assert/strict');
const S=require('../public/prototypes/estack-ui/shared/domain/input-eq-state');
const F=require('../public/prototypes/estack-ui/shared/domain/graphic-eq-fit');
const M=require('../public/prototypes/estack-ui/shared/domain/input-processing-model');
const clone=M.clone;
const base={devices:{samplerate:48000,capture:{channels:8},playback:{channels:8}},mixers:{route:{channels:{in:8,out:8},mapping:[0,1,2,3,4,5].map(dest=>({dest,sources:[{channel:dest%2}]}))}},filters:{GLOBAL_EQ_01:M.filterForBand(M.normalizeBand(0,{gain:-3})),ESTACK_INPUT_DELAY:{type:'Delay',parameters:{delay:1,unit:'ms',subsample:false}},output:{type:'Gain',parameters:{gain:-5}}},processors:{},pipeline:[{type:'Filter',channels:[0,1],names:['GLOBAL_EQ_01'],description:M.GLOBAL_EQ_STEP_DESCRIPTION,bypassed:false},{type:'Filter',channels:[0,1],names:['ESTACK_INPUT_DELAY'],description:M.INPUT_DELAY_STEP_DESCRIPTION,bypassed:false},{type:'Mixer',name:'route'},{type:'Filter',channels:[0],names:['output']}]};
const initial=S.read(base);
for(const geq of [false,true]) for(const peq of [false,true]) {
  const next=clone(base),state=clone(initial);state.geq={enabled:geq,fitVersion:1,targets:[...F.ACOUSTIC]};state.peq.enabled=peq;
  S.rebuild(next,state,{fitGeq:true});
  assert.deepEqual(S.validate(next),state);
  const descriptions=next.pipeline.map(s=>s.description).filter(Boolean);
  assert.deepEqual(descriptions,[...(geq?[S.GEQ_STEP]:[]),...(peq?[M.GLOBAL_EQ_STEP_DESCRIPTION]:[]),M.INPUT_DELAY_STEP_DESCRIPTION]);
  assert.deepEqual(next.devices,base.devices);assert.deepEqual(next.mixers,base.mixers);assert.deepEqual(next.filters.GLOBAL_EQ_01,base.filters.GLOBAL_EQ_01);
  assert.deepEqual(S.read(JSON.parse(JSON.stringify(next))),state,'config restart lost semantic state');
  assert(!next.pipeline.some(s=>s.names?.includes(S.STATE)),'metadata entered audio pipeline');
}
const combined=clone(base), state=clone(initial);state.geq.targets=[...F.ACOUSTIC];state.geq.enabled=true;S.rebuild(combined,state,{fitGeq:true});S.assertMutation(base,combined,'geq');
const changed=clone(combined);changed.filters.GLOBAL_EQ_01=M.filterForBand(M.normalizeBand(0,{gain:2}));S.rebuild(changed,S.read(combined));S.assertMutation(combined,changed,'peq');
const disabled=clone(changed),off=S.read(changed);off.peq.disabled=['GLOBAL_EQ_01'];S.rebuild(disabled,off);S.assertMutation(changed,disabled,'peq');
assert.deepEqual(S.read(disabled).peq.disabled,['GLOBAL_EQ_01']);
const invalid=clone(combined);invalid.filters.GLOBAL_GEQ_01.parameters.gain+=1;assert.throws(()=>S.validate(invalid),/do not match/);
const illegal=clone(combined);illegal.devices.playback.channels=6;assert.throws(()=>S.assertMutation(base,illegal,'geq'),/Protected/);
const missing=clone(combined);delete missing.filters[S.STATE];assert.throws(()=>S.read(missing),/metadata is missing/);
console.log('OK: Independent GEQ/PEQ state, pipeline ordering, config reconstruction and protected hardware');
