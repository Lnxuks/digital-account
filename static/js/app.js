'use strict';
/* app.js · 表单校验、数据操作、令牌、启动与事件绑定 */
/* ================= 表单 ================= */
function fillCatSelect(type,sel){
  const el=$('#f-cat');
  let h='';
  for(const k in CATS[type]){h+='<option value="'+k+'">'+esc(CATS[type][k].name)+'</option>';}
  el.innerHTML=h;
  el.value=sel&&CATS[type][sel]?sel:Object.keys(CATS[type])[0];
}
function syncCycleFields(){
  const c=$('#f-cycle').value;
  $('#w-charge').style.display=(c==='monthly'||c==='quarterly')?'':'none';
  $('#w-charge').parentElement.classList.toggle('full',!(c==='monthly'||c==='quarterly'));
  $('#l-start').textContent=c==='onetime'?'发生日期':'开始日期';
  $('#f-hint').textContent=CYCLE_HINT[c];
}
function setFieldError(id,msg){
  const input=$('#f-'+id),err=$('#err-'+id);
  if(!input||!err)return;
  if(msg){input.classList.add('invalid');input.setAttribute('aria-invalid','true');err.textContent=msg;err.hidden=false;}
  else{input.classList.remove('invalid');input.removeAttribute('aria-invalid');err.hidden=true;}
}
function validateForm(){
  let ok=true;
  const name=$('#f-name').value.trim();
  if(!name){setFieldError('name','请填写项目名称');ok=false;}else setFieldError('name','');
  const amt=Number($('#f-amount').value);
  if(!$('#f-amount').value.trim()||!isFinite(amt)||amt<=0){setFieldError('amount','请填写大于 0 的金额');ok=false;}else setFieldError('amount','');
  const c=$('#f-cycle').value;
  if(c==='monthly'||c==='quarterly'){
    const cv=$('#f-charge').value.trim();
    if(cv!==''){const n=Number(cv);if(!Number.isInteger(n)||n<1||n>31){setFieldError('charge','扣费日需为 1-31 的整数');ok=false;}else setFieldError('charge','');}
    else setFieldError('charge','');
  }else setFieldError('charge','');
  if(RECUR.indexOf(c)>=0&&!$('#f-start').value){setFieldError('start','周期项目需要开始日期');ok=false;}
  else setFieldError('start','');
  return ok;
}
function openModal(it){
  modal.open=true;modal.editingId=it?it.id:null;modal.lastFocus=document.activeElement;
  $('#mTitle').textContent=it?'编辑项目':'新增项目';
  $('#f-name').value=it?it.name:'';
  fillCatSelect('expense',it?it.category:null);
  $('#f-amount').value=it?it.amount:'';
  $('#f-cycle').value=it?it.cycle:'monthly';
  $('#f-charge').value=it&&it.charge_day?it.charge_day:'';
  $('#f-start').value=it&&it.start_date?it.start_date:fmtD(today());
  $('#f-active').value=it?String(it.active):'1';
  $('#f-note').value=it?(it.note||''):'';
  $('#mDelZone').hidden=!it;
  ['name','amount','charge','start'].forEach(k=>setFieldError(k,''));
  syncCycleFields();
  $('#ovForm').hidden=false;
  setTimeout(()=>$('#f-name').focus(),30);
}
function closeModal(){
  modal.open=false;$('#ovForm').hidden=true;
  if(modal.lastFocus&&modal.lastFocus.focus)modal.lastFocus.focus();
}
async function saveModal(){
  if(!validateForm()){
    const firstBad=$('#ovForm .invalid');
    if(firstBad)firstBad.focus();
    return;
  }
  const payload={
    name:$('#f-name').value.trim(),
    type:'expense',
    category:$('#f-cat').value,
    amount:Math.round(Number($('#f-amount').value)*100)/100,
    cycle:$('#f-cycle').value,
    charge_day:($('#f-cycle').value==='monthly'||$('#f-cycle').value==='quarterly')&&$('#f-charge').value.trim()!==''?Number($('#f-charge').value):null,
    start_date:$('#f-start').value||null,
    active:Number($('#f-active').value),
    note:$('#f-note').value.trim()
  };
  const btn=$('#mSave');btn.disabled=true;
  try{
    if(demo){
      if(modal.editingId!=null){
        const i=ITEMS.findIndex(x=>x.id===modal.editingId);
        if(i>=0)ITEMS[i]=Object.assign({},ITEMS[i],payload);
        toastOk('已更新（离线预览，未持久化）');
      }else{
        payload.id=Math.max(0,...ITEMS.map(x=>x.id||0))+1;
        ITEMS.push(payload);
        toastOk('已新增（离线预览，未持久化）');
      }
      closeModal();renderAll();
    }else{
      if(modal.editingId!=null){
        await api(`/api/items/${modal.editingId}`,{method:'PUT',body:JSON.stringify(payload)});
        toastOk('已更新');
      }else{
        await api('/api/items',{method:'POST',body:JSON.stringify(payload)});
        toastOk('已新增');
      }
      closeModal();
      await load();
    }
  }catch(e){
    if(!e.auth)toastErr(e.message);
  }finally{btn.disabled=false;}
}

/* ================= 数据操作 ================= */
async function load(){
  loadError=null;
  if(demo){renderAll();return;}
  $('#upcomingBody').innerHTML=skeletonRows(4);
  $('#itemsBody').innerHTML=skeletonRows(5);
  try{
    const d=await api('/api/items');
    ITEMS=d.items||[];
    renderAll();
  }catch(e){
    if(e.auth)return;
    loadError=e.message;
    renderAll();
  }
}
async function toggleItem(id){
  const it=ITEMS.find(x=>x.id===id);
  if(!it)return;
  const nv=it.active?0:1;
  if(demo){it.active=nv;renderAll();toastOk(nv?'已启用（离线预览）':'已停用（离线预览）');return;}
  try{
    await api(`/api/items/${id}`,{method:'PUT',body:JSON.stringify({active:nv})});
    toastOk(nv?'已启用':'已停用');
    await load();
  }catch(e){if(!e.auth)toastErr(e.message);}
}
async function deleteItem(id){
  const it=ITEMS.find(x=>x.id===id);
  if(!it)return;
  if(!window.confirm('确定删除「'+it.name+'」？该操作不可恢复。'))return;
  if(demo){ITEMS=ITEMS.filter(x=>x.id!==id);renderAll();toastOk('已删除（离线预览）');return;}
  try{
    await api(`/api/items/${id}`,{method:'DELETE'});
    toastOk('已删除');
    await load();
  }catch(e){if(!e.auth)toastErr(e.message);}
}
function refreshSelUI(){
  const rows=[...document.querySelectorAll('#itemsBody .ck-row')];
  const ids=rows.map(r=>Number(r.dataset.id));
  const ckAll=document.getElementById('ckAll');
  if(ckAll){
    ckAll.checked=rows.length>0&&ids.every(id=>sel.has(id));
    ckAll.indeterminate=rows.some(id=>sel.has(id))&&!ckAll.checked;
  }
  rows.forEach(r=>{r.checked=sel.has(Number(r.dataset.id));});
  const btn=$('#btnBatchDel');
  if(btn){const n=sel.size;btn.hidden=n===0;btn.textContent='删除选中（'+n+'）';}
}
async function batchDelete(){
  if(sel.size===0){toastErr('请先勾选要删除的项目');return;}
  const ids=[...sel];
  if(!window.confirm('确定删除选中的 '+ids.length+' 个项目？该操作不可恢复。'))return;
  if(demo){ITEMS=ITEMS.filter(x=>ids.indexOf(x.id)<0);sel.clear();renderAll();toastOk('已删除 '+ids.length+' 项（离线预览）');return;}
  try{
    const d=await api('/api/batch-delete',{method:'POST',body:JSON.stringify({ids:ids})});
    sel.clear();
    toastOk('已删除 '+d.count+' 项');
    await load();
  }catch(e){if(!e.auth)toastErr(e.message);}
}
async function deleteFromModal(){
  if(modal.editingId==null)return;
  const it=ITEMS.find(x=>x.id===modal.editingId);
  if(!it)return;
  if(!window.confirm('确定删除「'+it.name+'」？该操作不可恢复。'))return;
  if(demo){ITEMS=ITEMS.filter(x=>x.id!==modal.editingId);closeModal();renderAll();toastOk('已删除（离线预览）');return;}
  try{
    await api(`/api/items/${modal.editingId}`,{method:'DELETE'});
    closeModal();
    toastOk('已删除');
    await load();
  }catch(e){if(!e.auth)toastErr(e.message);}
}
async function loadDemo(){
  if(!window.confirm('将载入 24 条示例数据'+(demo||!ITEMS.length?'':',并覆盖服务器上现有全部数据')+'，继续？'))return;
  if(demo){ITEMS=DEMO.map(x=>Object.assign({},x));renderAll();toastOk('示例数据已载入');return;}
  try{
    await api('/api/import',{method:'POST',body:JSON.stringify({items:DEMO})});
    toastOk('示例数据已载入');
    await load();
  }catch(e){if(!e.auth)toastErr(e.message);}
}
async function doExport(){
  try{
    let items;
    if(demo){items=ITEMS;}
    else{const d=await api('/api/export');items=d.items||[];}
    const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),items:items},null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='account-hub-export-'+fmtD(today()).replace(/-/g,'')+'.json';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),800);
    toastOk('已导出 '+items.length+' 条记录');
  }catch(e){if(!e.auth)toastErr(e.message);}
}
function doImportPick(){$('#importFile').click();}
async function handleImportFile(ev){
  const file=ev.target.files&&ev.target.files[0];
  ev.target.value='';
  if(!file)return;
  let obj;
  try{obj=JSON.parse(await file.text());}catch(e){toastErr('文件不是合法 JSON');return;}
  const items=Array.isArray(obj)?obj:obj.items;
  if(!Array.isArray(items)){toastErr('文件中未找到 items 数组');return;}
  if(!window.confirm('将导入 '+items.length+' 条记录'+(demo?'（替换本页数据）':'，并覆盖服务器上现有全部数据')+'，继续？'))return;
  if(demo){ITEMS=items.map((x,i)=>Object.assign({id:i+1},x));renderAll();toastOk('已导入 '+items.length+' 条（离线预览）');return;}
  try{
    const d=await api('/api/import',{method:'POST',body:JSON.stringify({items:items})});
    toastOk('已导入 '+d.count+' 条');
    await load();
  }catch(e){if(!e.auth)toastErr(e.message);}
}

/* ================= 令牌 ================= */
function openToken(){
  $('#t-input').value=token;
  $('#ovToken').hidden=false;
  setTimeout(()=>$('#t-input').focus(),30);
}
function closeToken(){$('#ovToken').hidden=true;}

/* ================= 启动 ================= */
function enterDemo(){
  demo=true;ITEMS=DEMO.map(x=>Object.assign({},x));
  $('#demoBanner').hidden=false;
  renderAll();
}
async function boot(){
  loadError=null;
  try{
    const headers=token?{'Authorization':'Bearer '+token}:{};
    const res=await fetch('/api/health',{headers:headers,signal:AbortSignal.timeout(2500)});
    if(res.status===401){openToken();return;}
    if(res.status===429){loadError='访问过于频繁，请稍后再试';renderAll();return;}
    if(!res.ok)throw new Error('HTTP '+res.status);
    await load();
  }catch(e){enterDemo();}
}

/* ================= 事件绑定 ================= */
document.addEventListener('DOMContentLoaded',()=>{
  const n=new Date();
  const wd='日一二三四五六'[n.getDay()];
  $('#todayTxt').textContent=n.getFullYear()+' 年 '+(n.getMonth()+1)+' 月 '+n.getDate()+' 日 · 周'+wd;

  $('#btnAdd').onclick=()=>openModal(null);
  $('#btnBatchDel').onclick=batchDelete;
  $('#btnExport').onclick=doExport;
  $('#btnImport').onclick=doImportPick;
  $('#importFile').onchange=handleImportFile;
  $('#btnToken').onclick=openToken;
  $('#footToken').onclick=openToken;
  const loveClose=document.getElementById('loveClose');
  if(loveClose)loveClose.onclick=()=>{document.getElementById('ovLove').hidden=true;};
  const loveOk=document.getElementById('loveOk');
  if(loveOk)loveOk.onclick=()=>{document.getElementById('ovLove').hidden=true;};
  const ovLoveEl=document.getElementById('ovLove');
  if(ovLoveEl)ovLoveEl.addEventListener('mousedown',e=>{if(e.target===ovLoveEl)document.getElementById('ovLove').hidden=true;});
  $('#mClose').onclick=closeModal;
  $('#mCancel').onclick=closeModal;
  $('#mSave').onclick=saveModal;
  $('#mDelete').onclick=deleteFromModal;
  $('#ovForm').addEventListener('mousedown',e=>{if(e.target===$('#ovForm'))closeModal();});
  $('#tClose').onclick=closeToken;
  $('#tSave').onclick=()=>{token=$('#t-input').value.trim();localStorage.setItem('ah_token',token);closeToken();location.reload();};
  $('#tClear').onclick=()=>{token='';localStorage.removeItem('ah_token');closeToken();location.reload();};
  $('#ovToken').addEventListener('mousedown',e=>{if(e.target===$('#ovToken'))closeToken();});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      if(!$('#ovForm').hidden)closeModal();
      if(!$('#ovToken').hidden)closeToken();
      const lv=document.getElementById('ovLove');if(lv&&!lv.hidden)lv.hidden=true;
    }
  });
  $('#f-cycle').onchange=syncCycleFields;
  ['f-name','f-amount','f-charge','f-start'].forEach(id=>{
    const el=document.getElementById(id);
    el.addEventListener('blur',()=>{
      if(id==='f-name'&&el.value.trim())setFieldError('name','');
      if(id==='f-amount'&&Number(el.value)>0)setFieldError('amount','');
      if(id==='f-charge'&&el.value.trim()==='')setFieldError('charge','');
      if(id==='f-start'&&el.value)setFieldError('start','');
    });
    el.addEventListener('input',()=>{
      if(el.classList.contains('invalid'))validateForm();
    });
  });
  $('#fCat').onchange=e=>{state.cat=e.target.value;renderItems();};
  $('#fStatus').onchange=e=>{state.status=e.target.value;renderItems();};
  let qTimer=null;
  $('#fSearch').oninput=e=>{
    clearTimeout(qTimer);
    qTimer=setTimeout(()=>{state.q=e.target.value;renderItems();},160);
  };
  $('#itemsBody').addEventListener('click',e=>{
    const th=e.target.closest('th.sortable');
    if(th){const k=th.dataset.sort;if(state.sort.key===k){state.sort.dir=state.sort.dir==='asc'?'desc':'asc';}else{state.sort={key:k,dir:'asc'};}renderItems();return;}
    const b=e.target.closest('button[data-act]');
    if(!b)return;
    const id=Number(b.dataset.id);
    if(b.dataset.act==='edit'){const it=ITEMS.find(x=>x.id===id);if(it)openModal(it);}
    else if(b.dataset.act==='toggle')toggleItem(id);
    else if(b.dataset.act==='del')deleteItem(id);
  });
  $('#itemsBody').addEventListener('change',e=>{
    if(e.target.classList&&e.target.classList.contains('ck-row')){
      const id=Number(e.target.dataset.id);
      if(e.target.checked)sel.add(id);else sel.delete(id);
      refreshSelUI();
    }else if(e.target.id==='ckAll'){
      const rows=[...document.querySelectorAll('#itemsBody .ck-row')];
      if(e.target.checked){rows.forEach(r=>sel.add(Number(r.dataset.id)));}
      else{rows.forEach(r=>sel.delete(Number(r.dataset.id)));}
      refreshSelUI();
    }
  });
  $('#upcomingBody').addEventListener('click',e=>{
    if(e.target.closest('#btnAdd2'))openModal(null);
    if(e.target.closest('#btnDemo'))loadDemo();
  });
  $('#itemsBody').addEventListener('click',e=>{
    if(e.target.closest('#btnAdd2'))openModal(null);
    if(e.target.closest('#btnDemo'))loadDemo();
  });
  // 侧栏滚动高亮
  const NAV_IDS=['sec-kpi','sec-upcoming','sec-cats','sec-value','sec-items'];
  function showSection(id){
    if(NAV_IDS.indexOf(id)<0)return;   // 防御：锚点指向未知区块时不要把整页都隐藏掉
    NAV_IDS.forEach(s=>{const n=document.getElementById(s);if(n)n.style.display=(s===id?'':'none');});
    document.querySelectorAll('.nav a, .m-nav a').forEach(x=>x.classList.toggle('active',x.getAttribute('href')==='#'+id));
  }
  document.querySelectorAll('.nav a, .m-nav a').forEach(a=>{
    a.addEventListener('click',e=>{e.preventDefault();showSection(a.getAttribute('href').slice(1));});
  });
  // KPI 卡片里的锚点（如「在管项目」→ 项目清单）：
  // 1) 目标区块平时是 display:none，浏览器原生锚点跳转滚不过去，必须走 showSection
  // 2) renderKpis() 每次都会重建卡片 DOM，绑在卡片上的事件会丢失，
  //    所以要委托到不会被替换的 #sec-kpi 容器上
  $('#sec-kpi').addEventListener('click',e=>{
    const a=e.target.closest('a.kpi-link');
    if(!a)return;
    e.preventDefault();
    showSection(a.getAttribute('href').slice(1));
  });
  showSection('sec-kpi');

  boot();
});
