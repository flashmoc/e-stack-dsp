(() => {
  'use strict';
  window.EStackGraphicEqEditor={create({snapshot,commit}) {
    const F=window.EStackGraphicEqFit,store=window.EStackSavedConfigClient,$=s=>document.querySelector(s);
    const builtin={id:'wiim-acoustic',name:'WiiM Acoustic',type:'graphic-eq',data:{format:'estack-geq-v1',enabled:true,bands:F.FREQUENCIES.map((freq,i)=>({freq,gain:F.ACOUSTIC[i]}))}};
    let selection=null,busy=false;
    $('#geqSliders').innerHTML=F.FREQUENCIES.map((freq,i)=>`<label class="geq-band"><strong>${freq>=1000?freq/1000+'k':freq}<small> Hz</small></strong><input type="range" min="-12" max="12" step="0.1" value="0" data-geq-range="${i}" aria-label="Graphic EQ ${freq} Hz target gain"><input type="number" min="-12" max="12" step="0.1" value="0" data-geq-number="${i}" aria-label="Graphic EQ ${freq} Hz gain in dB"></label>`).join('');
    const status=(message,error=false)=>{$('#geqPresetStatus').textContent=message;$('#geqPresetStatus').dataset.state=error?'error':'success';};
    const run=async(operation)=>{try{busy=true;render();await operation();}catch(error){status(error.message,true);}finally{busy=false;render();}};
    function render() {
      const state=snapshot()?.eq?.geq;
      if(!state)return;
      document.querySelectorAll('[data-geq-range],[data-geq-number]').forEach(el=>{const index=Number(el.dataset.geqRange??el.dataset.geqNumber);if(document.activeElement!==el)el.value=state.targets[index];el.disabled=busy;});
      for(const id of ['geqReset','geqSavePreset']) $('#'+id).disabled=busy;
      $('#geqLoadPreset').disabled=busy||!selection;
      for(const id of ['geqRenamePreset','geqDeletePreset']) $('#'+id).disabled=busy||!selection||selection.id===builtin.id;
    }
    function change(event) {
      if(busy)return;const el=event.target,index=Number(el.dataset.geqRange??el.dataset.geqNumber),state=snapshot()?.eq?.geq;
      if(!state)return;
      if(el.value===''||!Number.isFinite(el.valueAsNumber)){el.value=state.targets[index];return;}
      const values=[...state.targets];values[index]=Math.round(Math.max(-12,Math.min(12,el.valueAsNumber))*10)/10;
      run(()=>commit(values));
    }
    document.querySelectorAll('[data-geq-range],[data-geq-number]').forEach(el=>el.addEventListener('change',change));
    document.querySelectorAll('[data-geq-range]').forEach(el=>el.addEventListener('input',()=>{$(`[data-geq-number="${el.dataset.geqRange}"]`).value=el.value;}));
    $('#geqReset').addEventListener('click',()=>run(()=>commit(Array(10).fill(0))));
    async function list() {
      selection=null;const records=[builtin,...await store.listByType('graphic-eq')];$('#geqPresetList').replaceChildren();
      records.forEach(record=>{const button=document.createElement('button');button.className='preset-item';button.textContent=record.name;button.dataset.geqPreset=record.id;button.addEventListener('click',()=>{selection=record;$('#geqPresetName').value=record.name;$('#geqPresetList').querySelectorAll('button').forEach(el=>el.classList.toggle('is-selected',el===button));status(record.id===builtin.id?'E-Stack smooth interpretation of the WiiM slider settings.':'Select Load GEQ to apply.');render();});$('#geqPresetList').append(button);});render();
    }
    function openPresets() { $('#geqPresetDialog').showModal();run(list); }
    $('#geqLoadPreset').addEventListener('click',()=>run(async()=>{
      const data=selection?.data;
      if(data?.format!=='estack-geq-v1'||typeof data.enabled!=='boolean'||!Array.isArray(data.bands)||data.bands.length!==10||data.bands.some((b,i)=>b.freq!==F.FREQUENCIES[i]))throw new Error('Invalid Graphic EQ preset.');
      await commit(F.targets(data.bands.map(b=>b.gain)),data.enabled);status(`'${selection.name}' loaded.`);
    }));
    $('#geqSavePreset').addEventListener('click',()=>run(async()=>{
      const name=$('#geqPresetName').value.trim();if(!name||name.length>80)throw new Error('Use a preset name of 1–80 characters.');
      const exists=(await store.listByType('graphic-eq')).some(r=>r.name===name);if(exists&&!confirm(`Replace Graphic EQ preset '${name}'?`))return;
      const state=snapshot().eq.geq;
      await store.save({type:'graphic-eq',name,data:{format:'estack-geq-v1',enabled:state.enabled,bands:F.FREQUENCIES.map((freq,i)=>({freq,gain:state.targets[i]}))}},exists);await list();status(`'${name}' saved.`);
    }));
    $('#geqRenamePreset').addEventListener('click',()=>run(async()=>{const name=prompt('New preset name',selection.name)?.trim();if(name){await store.rename(selection.id,name);await list();status('Preset renamed.');}}));
    $('#geqDeletePreset').addEventListener('click',()=>run(async()=>{if(confirm(`Delete '${selection.name}'?`)){await store.delete(selection.id);await list();status('Preset deleted.');}}));
    return {render,openPresets};
  }};
})();
