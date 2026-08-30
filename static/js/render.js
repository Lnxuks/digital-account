'use strict';
/* render.js · 全部渲染逻辑（KPI / 即将续费 / 分类趋势 / 剩余价值 / 项目表） */
/* ================= 渲染 ================= */
function renderAll(){
  renderKpis();
  renderUpcoming();
  renderTrend();
  renderValueRelation();
  renderItems();
}

function skeletonRows(n){
  let h='';
  const w=[46,30,58,38,52];
  for(let i=0;i<(n||4);i++){h+='<div class="skl-row"><div class="sk" style="width:'+w[i%w.length]+'%"></div><div class="sk" style="width:12%"></div><div class="sk" style="width:16%"></div></div>';}
  return h;
}
function errorBox(msg){
  return '<div class="errbox"><span class="em">'+ic('alert',15)+'加载失败<span class="ec">'+esc(msg)+'</span></span><button class="btn sm" onclick="boot()">'+ic('refresh',13)+'重试</button></div>';
}

function stats(){
  const T=today();
  let exp=0,recN=0,usageN=0,activeExp=0;
  const byCat={};
  for(const it of ITEMS){
    if(!it.active||it.type!=='expense')continue;
    const m=monthlyCost(it);
    exp+=m;activeExp++;
    if(it.cycle==='usage')usageN++;else if(RECUR.indexOf(it.cycle)>=0)recN++;
    byCat[it.category]=(byCat[it.category]||0)+m;
  }
  return{T:T,exp:exp,recN:recN,usageN:usageN,activeExp:activeExp,byCat:byCat};
}

function renderKpis(){
  const el=$('#sec-kpi');
  if(loadError){el.innerHTML='';return;}
  const s=stats();
  const total=ITEMS.filter(x=>x.type==='expense').length;
  let recM=0,usageM=0,sumRv=0;
  for(const it of ITEMS){
    if(!it.active||it.type!=='expense')continue;
    const m=monthlyCost(it);
    if(it.cycle==='usage')usageM+=m;else if(RECUR.indexOf(it.cycle)>=0)recM+=m;
    const p=periodOf(it,s.T);
    if(!p)continue;
    const periodDays=Math.max(1,daysBetween(p.s,p.e));
    const left=Math.max(0,daysBetween(s.T,p.e));
    sumRv+=Math.min(Number(it.amount)||0,(Number(it.amount)||0)*left/periodDays);
  }
  const mult=u=>u==='quarterly'?3:u==='half'?6:u==='yearly'?12:1;
  const expV=s.exp*mult(state.kpiExpUnit);
  const recV=recM*mult(state.kpiRecUnit);
  const usageV=usageM*mult(state.kpiUsageUnit);
  const expSub=state.kpiExpUnit==='monthly'?'含按量月均 · 在缴 '+s.activeExp+' 项':state.kpiExpUnit==='quarterly'?'一个季度的固定支出合计':state.kpiExpUnit==='half'?'半年的固定支出合计':'一年的固定支出合计';
  const recSub=state.kpiRecUnit==='monthly'?'月/季/年付折算合计':state.kpiRecUnit==='quarterly'?'季度口径（月均 × 3）':state.kpiRecUnit==='half'?'半年口径（月均 × 6）':'年度口径（月均 × 12）';
  const usageSub=state.kpiUsageUnit==='monthly'?'API 与水电煤等用量计费':state.kpiUsageUnit==='quarterly'?'季度口径（月均 × 3）':state.kpiUsageUnit==='half'?'半年口径（月均 × 6）':'年度口径（月均 × 12）';
  el.innerHTML=
   kpi('cal','固定支出',money0(expV),expSub,'',unitSel('exp',state.kpiExpUnit))+
   kpi('ledger','周期订阅',money0(recV),recSub,'',unitSel('rec',state.kpiRecUnit))+
   kpi('plug','按量预估',money0(usageV),usageSub,'',unitSel('usage',state.kpiUsageUnit))+
   kpiLink('box','在管项目',String(total),'周期 '+s.recN+' 项 · 按量 '+s.usageN+' 项','#sec-items')+
   kpi('shield','剩余价值',money0(sumRv),'周期订阅尚未消耗部分','')+
   kpiLove();
  el.querySelectorAll('.kpi-sel').forEach(s=>{
    s.onchange=()=>{
      if(s.dataset.unit==='exp')state.kpiExpUnit=s.value;
      else if(s.dataset.unit==='rec')state.kpiRecUnit=s.value;
      else state.kpiUsageUnit=s.value;
      renderKpis();
    };
  });
  const bl=document.getElementById('btnLove');
  if(bl)bl.onclick=()=>{const ov=document.getElementById('ovLove');if(ov){ov.hidden=false;const f=document.getElementById('loveOk');if(f)f.focus();}};
  function unitSel(key,cur){return '<select class="kpi-sel" data-unit="'+key+'" aria-label="切换统计口径"><option value="monthly"'+(cur==='monthly'?' selected':'')+'>月均</option><option value="quarterly"'+(cur==='quarterly'?' selected':'')+'>季均</option><option value="half"'+(cur==='half'?' selected':'')+'>半年</option><option value="yearly"'+(cur==='yearly'?' selected':'')+'>年均</option></select>';}
  function kpi(icon,l,v,sub,cls,selHtml){return '<div class="kpi"><div class="kpi-top"><span class="kic">'+ic(icon,18)+'</span><span class="label">'+l+'</span></div><div class="kpi-vrow">'+(selHtml||'')+'<div class="value num '+cls+'">'+v+'</div></div><div class="sub">'+sub+'</div></div>';}
  function kpiLink(icon,l,v,sub,href){return '<a class="kpi kpi-link" href="'+href+'"><div class="kpi-top"><span class="kic">'+ic(icon,18)+'</span><span class="label">'+l+'</span></div><div class="kpi-vrow"><div class="value num">'+v+'</div></div><div class="sub">'+sub+'</div><span class="klink">查看全部 →</span></a>';}
  function kpiLove(){return '<button class="kpi kpi-love" id="btnLove" type="button"><div class="kpi-top"><span class="kic kic-love">'+ic('heart',18)+'</span><span class="label">爱心捐赠</span></div><div class="kpi-vrow"><div class="value love-heart">'+ic('heart',22)+'</div></div><div class="sub">勿以善小而不为</div></button>';}
}

function renderUpcoming(){
  const el=$('#upcomingBody');
  if(loadError){el.innerHTML=errorBox(loadError);return;}
  if(!ITEMS.length){el.innerHTML=firstUseEmpty();return;}
  const T=today();
  const list=[];
  for(const it of ITEMS){
    if(!it.active||it.type!=='expense')continue;
    const p=periodOf(it,T);
    if(!p)continue;
    list.push({it:it,d:daysBetween(T,p.next),next:p.next});
  }
  list.sort((a,b)=>a.d-b.d);
  const show=list.filter(x=>x.d<=30).slice(0,8);
  if(!show.length){el.innerHTML='<div class="empty"><div class="eh">未来 30 天没有需要续费的项目</div><p>周期订阅续费时会自动出现在这里。</p></div>';return;}
  let h='';
  for(const x of show){
    const c=catOf(x.it);
    const b=x.d<=1?'today':x.d<=3?'soon':x.d<=7?'week':'';
    const bTxt=x.d===0?'今天':x.d===1?'明天':x.d+' 天后';
    h+='<div class="up-row">'+
      '<span class="up-ic" style="'+tint(c.color)+'">'+ic(c.icon,15)+'</span>'+
      '<span class="up-main"><span class="up-name">'+esc(x.it.name)+'</span><br><span class="up-sub">'+cycleName(x.it.cycle)+' · '+fmtD(x.next)+'</span></span>'+
      '<span class="up-right"><span class="up-amt num">'+money(x.it.amount)+'</span><br><span class="badge '+b+'">'+bTxt+'</span></span>'+
    '</div>';
  }
  el.innerHTML=h;
}

function monthAdd(d,n){return new Date(d.getFullYear(),d.getMonth()+n,1);}
function renderTrend(){
  const el=$('#catsBody');
  if(loadError){el.innerHTML=errorBox(loadError);return;}
  if(!ITEMS.length){el.innerHTML='<div class="empty"><div class="eh">暂无支出数据</div><p>添加项目后，这里会展示近 12 个月每月扣费走势。</p></div>';return;}
  const T=today();
  const thisM=new Date(T.getFullYear(),T.getMonth(),1);
  const buckets=[];
  for(let i=11;i>=0;i--){
    const d=monthAdd(thisM,-i);
    buckets.push({y:d.getFullYear(),m:d.getMonth()+1,label:String(d.getFullYear()%100).padStart(2,'0')+'-'+String(d.getMonth()+1).padStart(2,'0'),vals:{},total:0});
  }
  const winStart=new Date(buckets[0].y,buckets[0].m-1,1);
  const lim=new Date(T.getFullYear(),T.getMonth(),T.getDate()+1);
  function bump(b,cat,amt){b.vals[cat]=(b.vals[cat]||0)+amt;b.total+=amt;}
  for(const it of ITEMS){
    if(!it.active||it.type!=='expense')continue;
    const cat=it.category;
    if(it.cycle==='usage'){
      const st=pd(it.start_date);if(!st)continue;
      const stM=new Date(st.getFullYear(),st.getMonth(),1);
      for(const b of buckets){const bm=new Date(b.y,b.m-1,1);if(bm>=stM&&bm<=thisM)bump(b,cat,monthlyCost(it));}
      continue;
    }
    if(it.cycle==='onetime'){
      const st=pd(it.start_date);if(!st)continue;
      for(const b of buckets){if(b.y===st.getFullYear()&&b.m-1===st.getMonth())bump(b,cat,it.amount);}
      continue;
    }
    const st=pd(it.start_date);if(!st)continue;
    const cd=(it.charge_day&&it.charge_day>=1&&it.charge_day<=31)?it.charge_day:st.getDate();
    // 起始日距今很远时（比如 2005 年开的周付订阅），从 k=0 一路遍历会先撞上 guard 上限，
    // 结果窗口内一期都统计不到。先把 k 跳到接近窗口起点的期数，再小幅推进。
    let k=it.cycle==='weekly'
      ? Math.max(0,Math.floor(daysBetween(st,winStart)/7)-1)
      : Math.max(0,Math.floor(((winStart.getFullYear()-st.getFullYear())*12
          +(winStart.getMonth()-st.getMonth()))/cycleStep(it))-1);
    let guard=0;
    while(guard++<800){
      const R=it.cycle==='weekly'?addDays(st,k*7):addMonths(st,k*cycleStep(it),cd);
      if(R>=lim)break;
      if(R>=winStart){
        const bm=new Date(R.getFullYear(),R.getMonth(),1);
        for(const b of buckets){if(b.y===bm.getFullYear()&&b.m-1===bm.getMonth()){bump(b,cat,it.amount);break;}}
      }
      k++;
    }
  }
  const maxM=Math.max(1,...buckets.map(b=>b.total));
  let acc=0;
  const usedCats=[];
  for(const b of buckets){for(const k in b.vals){if(usedCats.indexOf(k)<0)usedCats.push(k);}}
  let h='<div class="hbar-chart">';
  h+='<div class="hb-row hb-head"><span class="hb-label">月份</span><span class="hb-scale"><span>0</span><span>'+fmtK(maxM/2)+'</span><span>'+fmtK(maxM)+'</span></span><span class="hb-amt hb-head-t">实付</span><span class="hb-cum hb-head-t">累计</span></div>';
  for(const b of buckets){
    acc+=b.total;
    let segs='';
    for(const k in b.vals){
      const c=CATS.expense[k]||{color:'#aab4c8'};
      segs+='<i style="width:'+(b.vals[k]/maxM*100).toFixed(2)+'%;background:'+c.color+'"></i>';
    }
    if(segs==='')segs='<i style="width:0%"></i>';
    h+='<div class="hb-row">'+
       '<span class="hb-label num">'+b.label+'</span>'+
       '<span class="hb-track">'+segs+'</span>'+
       '<span class="hb-amt num">'+fmtK(b.total)+'</span>'+
       '<span class="hb-cum num">'+fmtK(acc)+'</span>'+
     '</div>';
  }
  h+='</div>';
  let lg='<div class="chart-legend"><span><span class="lg-swatch" style="background:var(--chart-blue)"></span>实付（按分摊 · 横轴=金额 · 纵轴=月份）</span>';
  for(const k of usedCats){const c=CATS.expense[k]||{name:k,color:'#aab4c8'};lg+='<span><span class="lg-swatch" style="background:'+c.color+'"></span>'+esc(c.name)+'</span>';}
  lg+='</div>';
  el.innerHTML=h+lg+'<div class="foot-note">实付 = 当月实际扣费金额（年付/季付在扣费当月全额计入）；按量类项目（水电燃气、API 等）按月均分摊计入。</div>';
}

function renderValueRelation(){
  const el=$('#valueBody');
  if(loadError){el.innerHTML=errorBox(loadError);return;}
  const T=today();
  const monthEnd=new Date(T.getFullYear(),T.getMonth()+1,0);
  const nextMStart=new Date(T.getFullYear(),T.getMonth()+1,1);
  const yearEnd=new Date(T.getFullYear(),11,31);
  const nyS=new Date(T.getFullYear()+1,0,1), nyE=new Date(T.getFullYear()+1,11,31);
  const afS=new Date(T.getFullYear()+2,0,1);
  const GROUPS={
    monthly:{name:'月付',color:'var(--chart-blue)'},
    weekly:{name:'周付',color:'var(--chart-purple)'},
    quarterly:{name:'季付',color:'var(--chart-cyan)'},
    yearly:{name:'年付',color:'var(--chart-orange)'}
  };
  const seg={inMonth:0,inYear:0,nextYear:0,after:0};
  const byCycle={monthly:{inMonth:0,inYear:0,nextYear:0,after:0},weekly:{inMonth:0,inYear:0,nextYear:0,after:0},quarterly:{inMonth:0,inYear:0,nextYear:0,after:0},yearly:{inMonth:0,inYear:0,nextYear:0,after:0}};
  function ov(s1,e1,s2,e2){const s=s1>s2?s1:s2,e=e1<e2?e1:e2;return Math.max(0,Math.round((e-s)/864e5));}
  let sumAmt=0;
  for(const it of ITEMS){
    if(!it.active||it.type!=='expense')continue;
    if(RECUR.indexOf(it.cycle)<0)continue;
    const st=pd(it.start_date);if(!st)continue;
    const cd=(it.charge_day&&it.charge_day>=1&&it.charge_day<=31)?it.charge_day:st.getDate();
    const step=cycleStep(it);
    const g=byCycle[it.cycle];
    // 同上：老项目先把 k 跳到接近今天的期数，避免被 guard 截断
    let k=it.cycle==='weekly'
      ? Math.max(0,Math.floor(daysBetween(st,T)/7)-1)
      : Math.max(0,Math.floor(((T.getFullYear()-st.getFullYear())*12
          +(T.getMonth()-st.getMonth()))/step)-1);
    let guard=0;
    while(guard++<400){
      const ps=it.cycle==='weekly'?addDays(st,k*7):addMonths(st,k*step,cd);
      if(ps>T)break;
      const pe=it.cycle==='weekly'?addDays(ps,7):addMonths(ps,step,cd);
      const periodDays=Math.max(1,Math.round((pe-ps)/864e5));
      const daily=(Number(it.amount)||0)/periodDays;
      const dM=ov(ps,pe,T,monthEnd),dY=ov(ps,pe,nextMStart,yearEnd),dN=ov(ps,pe,nyS,nyE),dA=ov(ps,pe,afS,new Date(T.getFullYear()+15,11,31));
      seg.inMonth+=dM*daily;seg.inYear+=dY*daily;seg.nextYear+=dN*daily;seg.after+=dA*daily;
      g.inMonth+=dM*daily;g.inYear+=dY*daily;g.nextYear+=dN*daily;g.after+=dA*daily;
      sumAmt+=Number(it.amount)||0;
      k++;
    }
  }
  const s=stats();
  if(sumAmt<=0){
    el.innerHTML='<div class="empty"><div class="eh">暂无周期订阅</div><p>月付 / 季付 / 年付 / 周付的项目会在这里展示剩余价值的年度分布。</p></div>';
    return;
  }
  const totalRv=seg.inMonth+seg.inYear+seg.nextYear+seg.after;
  const nextOn=seg.nextYear+seg.after;   // 明年与更远年份合并为一段
  const maxV=Math.max(1,seg.inMonth,seg.inYear,nextOn,totalRv);
  const timeSegs=[
    {name:'本月内剩余',v:seg.inMonth,c:'var(--chart-blue)'},
    {name:'本年内后续',v:seg.inYear,c:'var(--chart-cyan)'},
    {name:'明年及以后',v:nextOn,c:'var(--chart-purple)'}
  ];
  let h='<div class="hbar-chart hb-vr">';
  h+='<div class="hb-row hb-head"><span class="hb-label">口径</span><span class="hb-scale"><span>0</span><span>'+fmtK(maxV/2)+'</span><span>'+fmtK(maxV)+'</span></span><span class="hb-amt hb-head-t">金额</span></div>';
  h+='<div class="hb-row">'+
     '<span class="hb-label hb-total">剩余价值总额</span>'+
     '<span class="hb-track">'+timeSegs.map(s2=>'<i style="width:'+(s2.v/maxV*100).toFixed(2)+'%;background:'+s2.c+'"></i>').join('')+'</span>'+
     '<span class="hb-amt num">'+money0(totalRv)+'</span>'+
   '</div>';
  for(const s2 of timeSegs){
    h+='<div class="hb-row hb-sub">'+
       '<span class="hb-label">'+s2.name+'</span>'+
       '<span class="hb-track"><i style="width:'+(s2.v/maxV*100).toFixed(2)+'%;background:'+s2.c+'"></i></span>'+
       '<span class="hb-amt num">'+money0(s2.v)+'</span>'+
     '</div>';
  }
  const cycRows=[
    {name:'月付摊销',g:byCycle.monthly,c:'var(--chart-blue)'},
    {name:'季付摊销',g:byCycle.quarterly,c:'var(--chart-cyan)'},
    {name:'年付摊销',g:byCycle.yearly,c:'var(--chart-orange)'},
    {name:'周付摊销',g:byCycle.weekly,c:'var(--chart-purple)'}
  ];
  h+='<div class="hb-sep">按计费周期拆分（未来未消耗部分）</div>';
  for(const cr of cycRows){
    const t=cr.g.inMonth+cr.g.inYear+cr.g.nextYear+cr.g.after;
    if(t<=0)continue;
    let segsHtml=
      '<i style="width:'+(cr.g.inMonth/maxV*100).toFixed(2)+'%;background:'+cr.c+'"></i>'+
      '<i style="width:'+(cr.g.inYear/maxV*100).toFixed(2)+'%;background:'+cr.c+';opacity:.72"></i>'+
      '<i style="width:'+((cr.g.nextYear+cr.g.after)/maxV*100).toFixed(2)+'%;background:'+cr.c+';opacity:.5"></i>';
    h+='<div class="hb-row hb-sub">'+
       '<span class="hb-label">'+cr.name+'</span>'+
       '<span class="hb-track">'+segsHtml+'</span>'+
       '<span class="hb-amt num">'+money0(t)+'</span>'+
     '</div>';
  }
  h+='</div>';
  const monthFullAmort=seg.inMonth+seg.inYear*0+0;
  let refText='';
  let monthFull=0,yearFull=0;
  for(const it of ITEMS){
    if(!it.active||it.type!=='expense')continue;
    if(RECUR.indexOf(it.cycle)<0)continue;
    const st=pd(it.start_date);if(!st)continue;
    const cd=(it.charge_day&&it.charge_day>=1&&it.charge_day<=31)?it.charge_day:st.getDate();
    const step=cycleStep(it);
    const yS=new Date(T.getFullYear(),0,1),yE=new Date(T.getFullYear(),11,31),mS=new Date(T.getFullYear(),T.getMonth(),1),mE=monthEnd;
    // 同样先跳到接近本年年初的期数
    let k=it.cycle==='weekly'
      ? Math.max(0,Math.floor(daysBetween(st,yS)/7)-1)
      : Math.max(0,Math.floor(((yS.getFullYear()-st.getFullYear())*12
          +(yS.getMonth()-st.getMonth()))/step)-1);
    let guard=0;
    while(guard++<400){
      const ps=it.cycle==='weekly'?addDays(st,k*7):addMonths(st,k*step,cd);
      if(ps>yE)break;
      const pe=it.cycle==='weekly'?addDays(ps,7):addMonths(ps,step,cd);
      const daily=(Number(it.amount)||0)/Math.max(1,Math.round((pe-ps)/864e5));
      monthFull+=ov(ps,pe,mS,mE)*daily;
      yearFull+=ov(ps,pe,yS,yE)*daily;
      k++;
    }
  }
  refText='<div class="foot-note">摊销口径参考：本月摊销 '+money0(monthFull)+'（月/季/年付按天分摊 + 按量月均）；本年度摊销 '+money0(yearFull)+'（1-12 月按天分摊，含已消耗部分）。剩余价值 = 今天起尚未消耗的订阅价值，按自然年切分为上图三段（本月内剩余 / 本年内后续 / 明年及以后）；金额与「剩余价值」指标卡一致。</div>';
  el.innerHTML='<div class="tscroll">'+h+'</div>'+refText;
}

function renderItems(){
  const el=$('#itemsBody');
  const hint=$('#itemsHint');
  if(loadError){el.innerHTML=errorBox(loadError);hint.textContent='';return;}
  if(!ITEMS.length){el.innerHTML=firstUseEmpty();hint.textContent='';return;}
  // 分类下拉
  const selC=$('#fCat');
  const cur=selC.value;
  let opts='<option value="all">全部分类</option>';
  for(const k in CATS.expense){opts+='<option value="'+k+'">'+esc(CATS.expense[k].name)+'</option>';}
  selC.innerHTML=opts;
  selC.value=(cur&&CATS.expense[cur])?cur:'all';
  state.cat=selC.value;
  // 过滤（纯支出账本：列出全部项目，历史收入数据也会显示以便清理）
  let list=ITEMS.slice();
  if(state.sort.key){
    const dir=state.sort.dir==='asc'?1:-1;
    const nk=it=>{if(RECUR.indexOf(it.cycle)>=0){const p=periodOf(it,today());return p?p.next.getTime():9e15;}if(it.cycle==='usage')return 8e15;const st=pd(it.start_date);return st?st.getTime():9e15;};
    list.sort((a,b)=>{
      if(state.sort.key==='name')return dir*(a.name||'').localeCompare(b.name||'','zh-CN');
      if(state.sort.key==='category')return dir*catOf(a).name.localeCompare(catOf(b).name,'zh-CN');
      if(state.sort.key==='amount')return dir*(monthlyCost(a)-monthlyCost(b));
      if(state.sort.key==='next')return dir*(nk(a)-nk(b));
      if(state.sort.key==='status')return dir*((b.active?1:0)-(a.active?1:0));
      return 0;
    });
  }else{
    list.sort((a,b)=>(b.active-a.active)||(a.name||'').localeCompare(b.name||'','zh-CN'));
  }
  if(state.cat!=='all')list=list.filter(x=>x.category===state.cat);
  if(state.status==='active')list=list.filter(x=>x.active);
  if(state.status==='off')list=list.filter(x=>!x.active);
  const q=state.q.trim().toLowerCase();
  if(q)list=list.filter(x=>(x.name||'').toLowerCase().indexOf(q)>=0||(x.note||'').toLowerCase().indexOf(q)>=0);
  hint.textContent='共 '+list.length+' 项';
  if(!list.length){
    el.innerHTML='<div class="empty"><div class="eh">没有匹配的项目</div><p>试试更换分类、状态或搜索关键词。</p><div class="btns"><button class="btn sm" id="btnClearF" type="button">清除筛选</button></div></div>';
    const b=$('#btnClearF');if(b)b.onclick=()=>{state.q='';$('#fSearch').value='';$('#fStatus').value='active';state.status='active';renderItems();};
    refreshSelUI();
    return;
  }
  const T=today();
  const thDefs=[
    {k:null,html:'<input type="checkbox" id="ckAll" aria-label="全选当前列表">',w:' style="width:30px"'},
    {k:'name',t:'项目'},
    {k:'category',t:'分类'},
    {k:'amount',t:'金额 / 周期',num:true},
    {k:'next',t:'下次扣费',num:true},   // 数据是右对齐的，表头必须同步
    {k:'status',t:'状态'},
    {k:null,t:'操作',right:true}
  ];
  let h='<table><thead><tr>';
  for(const d of thDefs){
    if(!d.k){h+='<th'+(d.w||'')+(d.right?' style="text-align:right"':'')+'>'+d.html+'</th>';continue;}
    const ind=state.sort.key===d.k?(state.sort.dir==='asc'?' <span class="sort-ind">▲</span>':' <span class="sort-ind">▼</span>'):'';
    h+='<th class="sortable'+(d.num?' num':'')+'" data-sort="'+d.k+'"'+(state.sort.key===d.k?' aria-sort="'+(state.sort.dir==='asc'?'ascending':'descending')+'"':'')+' title="点击排序">'+d.t+ind+'</th>';
  }
  h+='</tr></thead><tbody>';
  for(const it of list){
    const c=catOf(it);
    let amt;
    if(it.cycle==='usage')amt='≈'+money(it.amount)+'<span style="color:var(--muted)"> /月均</span>';
    else if(it.cycle==='onetime')amt=money(it.amount)+'<span style="color:var(--muted)"> /次</span>';
    else amt=money(it.amount)+'<span style="color:var(--muted)"> /'+cycleName(it.cycle).replace('付','')+'</span>';
    h+='<tr>'+
      '<td><input type="checkbox" class="ck-row" data-id="'+it.id+'" aria-label="选择'+esc(it.name)+'"></td>'+
      '<td><span class="name-cell"><span class="n-ic" style="'+tint(c.color)+'">'+ic(c.icon,14)+'</span><span class="n-txt"><span class="n-name">'+esc(it.name)+'</span>'+(it.note?'<span class="n-note" title="'+esc(it.note)+'">'+esc(it.note)+'</span>':'')+'</span></span></td>'+
      '<td style="white-space:nowrap"><span class="cat-dot" style="background:'+c.color+'"></span>'+esc(c.name)+'</td>'+
      '<td class="num">'+amt+'</td>'+
      '<td class="num" style="color:var(--muted);white-space:nowrap">'+nextChargeText(it,T)+'</td>'+
      '<td>'+(it.active?'<span class="pill on">启用</span>':'<span class="pill off">停用</span>')+'</td>'+
      '<td><span class="td-actions">'+
        '<button class="ibtn" data-act="edit" data-id="'+it.id+'" title="编辑" aria-label="编辑 '+esc(it.name)+'">'+ic('edit',14)+'</button>'+
        '<button class="ibtn" data-act="toggle" data-id="'+it.id+'" title="'+(it.active?'停用':'启用')+'" aria-label="'+(it.active?'停用':'启用')+' '+esc(it.name)+'">'+ic(it.active?'pause':'play',14)+'</button>'+
        '<button class="ibtn danger" data-act="del" data-id="'+it.id+'" title="删除" aria-label="删除 '+esc(it.name)+'">'+ic('trash',14)+'</button>'+
      '</span></td>'+
    '</tr>';
  }
    const totalM=list.reduce((a,x)=>a+monthlyCost(x),0);
  h+='</tbody><tfoot><tr>'+
     '<td colspan="2" style="font-weight:650">总计（'+list.length+' 项）</td>'+
     '<td class="num" style="font-weight:650">≈ '+money0(totalM)+' /月均</td>'+
     '<td colspan="4"></td></tr></tfoot></table>';
  el.innerHTML=h;
  refreshSelUI();
}

function firstUseEmpty(){
  return '<div class="empty"><div class="eh">还没有任何项目</div><p>把视频会员、云存储、AI 订阅、水电燃气、API 按量、年费保险等都记进来，账本会帮你算清每月固定支出和每笔订阅的剩余价值。</p><div class="btns">'+
    '<button class="btn primary" id="btnAdd2" type="button">'+ic('plus',14)+'新增第一项</button>'+
    '<button class="btn" id="btnDemo" type="button">'+ic('spark',14)+'载入示例数据</button>'+
  '</div></div>';
}
