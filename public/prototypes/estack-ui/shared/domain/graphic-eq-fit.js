(function () {
  'use strict';
  const M = typeof module !== 'undefined' && module.exports ? require('./input-processing-model') : window.EStackInputProcessingModel;
  const FREQUENCIES = Object.freeze([31,63,125,250,500,1000,2000,4000,8000,16000]);
  const ACOUSTIC = Object.freeze([5,4.9,4,1,2.2,1.8,3.5,4.1,3.5,2.2]);
  const VERSION = 1;
  function targets(values) {
    if (!Array.isArray(values) || values.length !== 10 || values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < -12 || v > 12)) throw new Error('Graphic EQ requires ten target gains between -12 and +12 dB.');
    return values.map(v => Math.round(v * 10) / 10);
  }
  // Shape-preserving Hermite interpolation with constant, bounded end extensions.
  function targetCurve(values) {
    const y = targets(values), x = FREQUENCIES.map(Math.log), h = x.slice(1).map((v,i) => v-x[i]);
    const d = h.map((v,i) => (y[i+1]-y[i])/v), slopes = [0];
    for (let i=1;i<9;i++) slopes[i] = d[i-1]*d[i] <= 0 ? 0 : (3*(h[i-1]+h[i])) / ((2*h[i]+h[i-1])/d[i-1]+(h[i]+2*h[i-1])/d[i]);
    slopes[9] = 0;
    return frequency => {
      if (frequency <= FREQUENCIES[0]) return y[0];
      if (frequency >= FREQUENCIES[9]) return y[9];
      const t = Math.log(frequency); let i=0; while (i<8 && t>x[i+1]) i++;
      const u=(t-x[i])/h[i], u2=u*u, u3=u2*u;
      return (2*u3-3*u2+1)*y[i]+(u3-2*u2+u)*h[i]*slopes[i]+(-2*u3+3*u2)*y[i+1]+(u3-u2)*h[i]*slopes[i+1];
    };
  }
  function solve(matrix, vector) {
    const a=matrix.map((row,i)=>[...row,vector[i]]), n=vector.length;
    for(let i=0;i<n;i++) {
      let pivot=i; for(let k=i+1;k<n;k++) if(Math.abs(a[k][i])>Math.abs(a[pivot][i])) pivot=k;
      [a[i],a[pivot]]=[a[pivot],a[i]];
      if(Math.abs(a[i][i])<1e-10) return null;
      const scale=a[i][i]; for(let j=i;j<=n;j++) a[i][j]/=scale;
      for(let k=0;k<n;k++) if(k!==i) { const f=a[k][i]; for(let j=i;j<=n;j++) a[k][j]-=f*a[i][j]; }
    }
    return a.map(row=>row[n]);
  }
  const response = (bands,f,rate) => bands.reduce((sum,b)=>sum+M.rawResponseAt(b,f,rate),0);
  function fit(values, rate=48000) {
    const desired=targets(values);
    if (!Number.isFinite(rate) || rate < 44100 || rate > 384000) throw new Error('Graphic EQ requires a sample rate of at least 44.1 kHz.');
    const target=targetCurve(desired), grid=Array.from({length:161},(_,i)=>20*Math.pow(1000,i/160));
    if(desired.every(v=>v===0)) return {version:VERSION,targets:desired,bands:[],anchorError:0,rmsError:0};
    let best=null;
    for(const edge of [1,1.4,2,2.8]) for(const q of [.45,.6,.8,1,1.3,1.6,2]) {
      // The two edge shelves keep the uncontrolled ends bounded; eight bells
      // provide the interior tonal controls. Gains are hidden solver variables.
      let bands=FREQUENCIES.map((frequency,i)=>({frequency:i===0?frequency*edge:i===9?frequency/edge:frequency,type:i===0?'Lowshelf':i===9?'Highshelf':'Peaking',gain:desired[i],q}));
      for(let iteration=0;iteration<24;iteration++) {
        const current=FREQUENCIES.map(f=>response(bands,f,rate));
        const errors=desired.map((v,i)=>v-current[i]);
        if(Math.max(...errors.map(Math.abs))<.0005) break;
        const jacobian=FREQUENCIES.map(f=>bands.map(b=>(M.rawResponseAt({...b,gain:b.gain+.01},f,rate)-M.rawResponseAt({...b,gain:b.gain-.01},f,rate))/.02));
        const delta=solve(jacobian,errors); if(!delta) break;
        let improved=false;
        for(const step of [1,.5,.25,.125,.0625]) {
          const candidate=bands.map((b,i)=>({...b,gain:Math.max(-36,Math.min(36,b.gain+delta[i]*step))}));
          if(FREQUENCIES.reduce((s,f,i)=>s+(desired[i]-response(candidate,f,rate))**2,0)<errors.reduce((s,v)=>s+v*v,0)) {bands=candidate;improved=true;break;}
        }
        if(!improved) break;
      }
      const anchorError=Math.max(...FREQUENCIES.map((f,i)=>Math.abs(response(bands,f,rate)-desired[i])));
      const rmsError=Math.sqrt(grid.reduce((s,f)=>s+(response(bands,f,rate)-target(f))**2,0)/grid.length);
      const score=rmsError+anchorError*20;
      if(!best||score<best.score) best={version:VERSION,targets:desired,bands,anchorError,rmsError,score};
    }
    if(!best || !Number.isFinite(best.score) || best.anchorError>.25) throw new Error('Graphic EQ could not fit these targets safely. Nothing changed.');
    return best;
  }
  const api=Object.freeze({VERSION,FREQUENCIES,ACOUSTIC,targets,targetCurve,fit,response});
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else window.EStackGraphicEqFit=api;
})();
