(function () {
  'use strict';
  const node=typeof module!=='undefined'&&module.exports;
  const M=node?require('./input-processing-model'):window.EStackInputProcessingModel;
  const F=node?require('./graphic-eq-fit'):window.EStackGraphicEqFit;
  const STATE='ESTACK_INPUT_EQ_STATE', PREFIX='E-Stack input EQ state v1: ';
  const GEQ_NAMES=F.FREQUENCIES.map((_,i)=>`GLOBAL_GEQ_${String(i+1).padStart(2,'0')}`);
  const GEQ_STEP='E-Stack graphic input EQ';
  const STEPS=[GEQ_STEP,M.GLOBAL_EQ_STEP_DESCRIPTION,M.INPUT_DELAY_STEP_DESCRIPTION];
  const clone=M.clone;
  const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
  function stable(v) { return Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v; }
  function normalize(value) {
    if(value?.version!==1 || value.geq?.fitVersion!==F.VERSION || typeof value.geq?.enabled!=='boolean' || typeof value.peq?.enabled!=='boolean' || !Array.isArray(value.peq?.disabled) || value.peq.disabled.some(n=>!M.GLOBAL_EQ_SLOT_NAMES.includes(n))) throw new Error('Invalid input EQ semantic state.');
    return {version:1,geq:{enabled:value.geq.enabled,fitVersion:F.VERSION,targets:F.targets(value.geq.targets)},peq:{enabled:value.peq.enabled,disabled:M.GLOBAL_EQ_SLOT_NAMES.filter(n=>value.peq.disabled.includes(n))}};
  }
  function read(config) {
    const record=config.filters?.[STATE];
    if(record) {
      if(record.type!=='Gain'||!record.description?.startsWith(PREFIX)) throw new Error('Reserved input EQ state filter is invalid.');
      try { return normalize(JSON.parse(record.description.slice(PREFIX.length))); }
      catch(error) { throw new Error(`Cannot read input EQ state: ${error.message}`); }
    }
    if(GEQ_NAMES.some(n=>config.filters?.[n])) throw new Error('Graphic EQ target metadata is missing; hidden gains cannot reconstruct slider targets.');
    const referenced=new Set((config.pipeline||[]).filter(s=>!s.bypassed).flatMap(s=>s.names||[]));
    const disabled=M.bandsFromConfig(config).filter(b=>b.present&&!M.isNeutral(b)&&!referenced.has(b.slot)).map(b=>b.slot);
    return {version:1,geq:{enabled:false,fitVersion:F.VERSION,targets:Array(10).fill(0)},peq:{enabled:true,disabled}};
  }
  function write(config, value) {
    const state=normalize(value);
    config.filters ||= {};
    // A valid, unreferenced CamillaDSP filter stores the application envelope.
    // Its description is round-tripped atomically with the actual filters and
    // captured by existing System Presets; it never runs in the audio pipeline.
    if(!state.geq.enabled&&state.geq.targets.every(v=>v===0)&&state.peq.enabled&&!state.peq.disabled.length) delete config.filters[STATE];
    else config.filters[STATE]={type:'Gain',description:PREFIX+JSON.stringify(state),parameters:{gain:0,inverted:false,mute:false,scale:'dB'}};
    return state;
  }
  function assertOwnership(config) {
    const pipeline=config.pipeline||[], mixer=pipeline.findIndex(s=>s.type==='Mixer');
    if(mixer<0||Number(config.devices?.capture?.channels)<2) throw new Error('Input EQ requires capture L/R and a mixer.');
    for(const [i,step] of pipeline.entries()) {
      if((step.names||[]).includes(STATE)) throw new Error('Input EQ metadata must never be processed.');
      if(STEPS.includes(step.description)) {
        if(i>=mixer||step.type!=='Filter'||!same(step.channels??[step.channel],[0,1])) throw new Error('Input EQ and delay must be shared L/R before the mixer.');
        const allowed=step.description===GEQ_STEP?GEQ_NAMES:step.description===M.GLOBAL_EQ_STEP_DESCRIPTION?M.GLOBAL_EQ_SLOT_NAMES:[M.INPUT_DELAY_FILTER];
        if((step.names||[]).some(n=>!allowed.includes(n))) throw new Error('Input stage contains an unrelated filter.');
      } else if((step.names||[]).some(n=>GEQ_NAMES.includes(n)||M.GLOBAL_EQ_SLOT_NAMES.includes(n))) throw new Error('EQ filters are used outside their dedicated input stage; resolve this ambiguous configuration first.');
    }
    if(STEPS.some(d=>pipeline.filter(s=>s.description===d).length>1)) throw new Error('Duplicate input EQ or delay stage.');
  }
  function fittedFilters(state,rate) {
    const fit=F.fit(state.geq.targets,rate);
    return Object.fromEntries(fit.bands.map((b,i)=>[GEQ_NAMES[i],{type:'Biquad',description:`E-Stack Graphic EQ ${i+1} (fitted)`,parameters:{type:b.type,freq:Number(b.frequency.toFixed(8)),gain:Number(b.gain.toFixed(8)),q:Number(b.q.toFixed(8))}}]));
  }
  function rebuild(config,value,{fitGeq=false}={}) {
    assertOwnership(config);
    const state=normalize(value);
    if(fitGeq) { GEQ_NAMES.forEach(n=>delete config.filters[n]); Object.assign(config.filters,fittedFilters(state,config.devices.samplerate)); }
    const geq=state.geq.enabled?GEQ_NAMES.filter(n=>config.filters?.[n]&&Math.abs(config.filters[n].parameters.gain)>1e-10):[];
    const peq=state.peq.enabled?M.bandsFromConfig(config).filter(b=>b.present&&!M.isNeutral(b)&&!state.peq.disabled.includes(b.slot)).map(b=>b.slot):[];
    const delay=(config.pipeline||[]).find(s=>s.description===M.INPUT_DELAY_STEP_DESCRIPTION);
    config.pipeline=config.pipeline.filter(s=>!STEPS.includes(s.description));
    const make=(description,names)=>({type:'Filter',channels:[0,1],names,description,bypassed:false});
    const stages=[...(geq.length?[make(GEQ_STEP,geq)]:[]),...(peq.length?[make(M.GLOBAL_EQ_STEP_DESCRIPTION,peq)]:[]),...(delay?[delay]:[])];
    config.pipeline.splice(config.pipeline.findIndex(s=>s.type==='Mixer'),0,...stages);
    write(config,state);
    validate(config);
    return config;
  }
  function validate(config) {
    assertOwnership(config);
    for(const name of M.GLOBAL_EQ_SLOT_NAMES) {
      const filter=config.filters?.[name],p=filter?.parameters;if(!filter)continue;
      if(filter.type!=='Biquad'||!M.EQ_TYPES.includes(p?.type)||![p.freq,p.gain,p.q].every(Number.isFinite)||p.freq<20||p.freq>20000||p.gain<-12||p.gain>12||p.q<.1||p.q>20) throw new Error(`Invalid Parametric EQ filter ${name}.`);
    }
    const delay=config.filters?.[M.INPUT_DELAY_FILTER];
    if(delay&&(delay.type!=='Delay'||!Number.isFinite(delay.parameters?.delay)||delay.parameters.delay<0||delay.parameters.delay>2000||delay.parameters.unit!=='ms')) throw new Error('Invalid shared Input Delay.');
    const state=read(config), positions=STEPS.map(d=>config.pipeline.findIndex(s=>s.description===d)).filter(i=>i>=0);
    if(positions.some((p,i)=>i&&p<positions[i-1])) throw new Error('Input processing order must be Graphic EQ, Parametric EQ, Input Delay, Mixer.');
    if(config.filters?.[STATE]) {
      const expected=fittedFilters(state,config.devices.samplerate);
      if(!same(Object.fromEntries(GEQ_NAMES.filter(n=>config.filters[n]).map(n=>[n,config.filters[n]])),expected)) throw new Error('Graphic EQ filters do not match their saved targets.');
      const geq=config.pipeline.find(s=>s.description===GEQ_STEP);
      const peq=config.pipeline.find(s=>s.description===M.GLOBAL_EQ_STEP_DESCRIPTION);
      const expectedGeq=state.geq.enabled?GEQ_NAMES.filter(n=>expected[n]&&Math.abs(expected[n].parameters.gain)>1e-10):[];
      const expectedPeq=state.peq.enabled?M.bandsFromConfig(config).filter(b=>b.present&&!M.isNeutral(b)&&!state.peq.disabled.includes(b.slot)).map(b=>b.slot):[];
      if(!same(geq?.names||[],expectedGeq)||geq?.bypassed||!same(peq?.names||[],expectedPeq)||peq?.bypassed) throw new Error('Input EQ pipeline does not match the saved ON/OFF states.');
    }
    return state;
  }
  function assertMutation(before,after,kind) {
    const allowed=[STATE,...(kind==='geq'?GEQ_NAMES:kind==='peq'?M.GLOBAL_EQ_SLOT_NAMES:[M.INPUT_DELAY_FILTER])];
    const protectedView=config=>{const c=clone(config);allowed.forEach(n=>delete c.filters?.[n]);c.pipeline=c.pipeline.filter(s=>!STEPS.includes(s.description));return c;};
    if(!same(protectedView(before),protectedView(after))) throw new Error('Protected DSP configuration changed unexpectedly.');
    const a=read(before),b=validate(after);
    if(kind!=='geq'&&!same(a.geq,b.geq)||kind!=='peq'&&!same(a.peq,b.peq)) throw new Error('Other input EQ processor state changed unexpectedly.');
    for(const d of STEPS.filter(d=>d!==(kind==='geq'?GEQ_STEP:kind==='peq'?M.GLOBAL_EQ_STEP_DESCRIPTION:M.INPUT_DELAY_STEP_DESCRIPTION))) {
      if(!same(before.pipeline.find(s=>s.description===d),after.pipeline.find(s=>s.description===d))) throw new Error('Other input processor pipeline changed unexpectedly.');
    }
  }
  const api=Object.freeze({STATE,GEQ_NAMES,GEQ_STEP,STEPS,read,write,normalize,rebuild,validate,assertMutation,fittedFilters});
  if(node) module.exports=api; else window.EStackInputEqState=api;
})();
