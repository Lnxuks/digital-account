'use strict';
/* core.js · 基础常量、状态、工具函数、周期计算、API 封装、示例数据 */
/* ================= 基础数据 ================= */
const CATS = {
  expense:{
    streaming:{name:'影音娱乐',color:'#4d94ff',icon:'film'},
    game:{name:'游戏娱乐',color:'#a06ef5',icon:'game'},
    ai:{name:'AI 订阅',color:'#38a1f0',icon:'spark'},
    api:{name:'API 按量',color:'#ffb02e',icon:'plug'},
    software:{name:'软件工具',color:'#22c1a3',icon:'window'},
    cloud:{name:'云服务/存储',color:'#58b6ff',icon:'cloud'},
    telecom:{name:'通讯网络',color:'#20c5cc',icon:'phone'},
    utilities:{name:'水电燃气',color:'#ff8a3d',icon:'bulb'},
    housing:{name:'房租物业',color:'#8fb3ff',icon:'home'},
    member:{name:'生活会员',color:'#ff7eb0',icon:'bag'},
    transport:{name:'出行交通',color:'#45b3e8',icon:'train'},
    insurance:{name:'保险保障',color:'#4fc47f',icon:'shield'},
    education:{name:'教育学习',color:'#7d95c9',icon:'book'},
    health:{name:'健康健身',color:'#c9d24e',icon:'heart'},
    finance:{name:'金融费用',color:'#d49a6a',icon:'card'},
    other:{name:'其他支出',color:'#aab4c8',icon:'box'}
  }
};
const LEGACY_INCOME={salary:'工资收入',interest:'利息理财',cashback:'返现红包',side:'副业接单',refund:'退款退还',other:'其他收入'};
const CYCLES = {weekly:'周付',monthly:'月付',quarterly:'季付',yearly:'年付',usage:'按量',onetime:'一次性'};
const RECUR = ['weekly','monthly','quarterly','yearly'];
const CYCLE_HINT = {
  monthly:'每月固定扣费。扣费日留空时，按开始日期的"日"自动推算。',
  quarterly:'每 3 个月扣费一次，以开始日期所在月为锚点循环。',
  yearly:'每年扣费一次，扣费的月份和日期取自开始日期（周年续费）。',
  weekly:'每 7 天扣费一次，以开始日期为锚点循环。',
  usage:'按量付费：金额填"月均预估"，参与每月支出统计，但不参与剩余价值计算。',
  onetime:'一次性支出：只记录在项目清单里，不折算进每月固定支出。'
};

let ITEMS = [];
let demo = false;
let loadError = null;
let token = localStorage.getItem('ah_token') || '';
const state = {cat:'all', status:'active', q:'', sort:{key:null,dir:'asc'}, kpiExpUnit:'monthly', kpiRecUnit:'monthly', kpiUsageUnit:'monthly'};
const sel = new Set();
const modal = {open:false, editingId:null, lastFocus:null};

/* ================= 工具 ================= */
const $ = s => document.querySelector(s);
const DAY = 864e5;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function pd(s){if(!s)return null;const p=s.split('-').map(Number);if(!p[0]||!p[1]||!p[2])return null;return new Date(p[0],p[1]-1,p[2]);}
function fmtD(d){if(!d)return'';const m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');return d.getFullYear()+'-'+m+'-'+dd;}
function today(){const n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate());}
function addDays(d,n){return new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);}
function addMonths(base,n,day){const y=base.getFullYear(),m=base.getMonth();const dim=new Date(y,m+n+1,0).getDate();return new Date(y,m+n,Math.min(day,dim));}
function daysBetween(a,b){return Math.round((b-a)/DAY);}
function money(v){return '¥'+Number(v||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});}
function money0(v){return '¥'+Math.round(Number(v||0)).toLocaleString('zh-CN');}
function fmtK(v){v=Number(v)||0;return v>=1000?(v/1000).toFixed(v%1000?1:0)+'k':String(Math.round(v));}
function ic(name,size){size=size||15;return '<svg class="ic" width="'+size+'" height="'+size+'" aria-hidden="true"><use href="#i-'+name+'"/></svg>';}
function catOf(it){
  if(it.type==='income'){return{name:LEGACY_INCOME[it.category]||'收入（旧数据）',color:'#94a3b8',icon:'box'};}
  return CATS.expense[it.category]||{name:it.category||'未分类',color:'#999488',icon:'box'};
}
function tint(hex){return 'background:'+hex+'1f;color:'+hex;}
function cycleName(c){return CYCLES[c]||c;}

/* ================= 周期计算 ================= */
function cycleStep(it){return it.cycle==='monthly'?1:it.cycle==='quarterly'?3:12;}
function periodOf(it,T){
  const start=pd(it.start_date);
  if(!start||RECUR.indexOf(it.cycle)<0)return null;
  const cd=(it.charge_day&&it.charge_day>=1&&it.charge_day<=31)?it.charge_day:start.getDate();
  if(it.cycle==='weekly'){
    if(start>T){return{s:start,e:addDays(start,7),next:start};}
    let k=Math.floor(daysBetween(start,T)/7);
    let s=addDays(start,k*7);
    let guard=0;
    while(addDays(s,7)<=T&&guard++<400){s=addDays(s,7);}
    return{s:s,e:addDays(s,7),next:addDays(s,7)};
  }
  if(start>T){return{s:start,e:addMonths(start,cycleStep(it),cd),next:start};}
  const m0=(T.getFullYear()-start.getFullYear())*12+(T.getMonth()-start.getMonth());
  let k=Math.max(0,Math.floor(m0/cycleStep(it))*cycleStep(it));
  let s=addMonths(start,k,cd);
  let guard=0;
  while(s<=T&&guard++<700){k+=cycleStep(it);s=addMonths(start,k,cd);}
  const prev=addMonths(start,k-cycleStep(it),cd);
  return{s:prev,e:s,next:s};
}
function monthlyCost(it){
  const a=Number(it.amount)||0;
  switch(it.cycle){
    case 'weekly':return a*52/12;
    case 'monthly':return a;
    case 'quarterly':return a/3;
    case 'yearly':return a/12;
    case 'usage':return a;
    default:return 0;
  }
}
function nextChargeText(it,T){
  if(RECUR.indexOf(it.cycle)>=0){
    const p=periodOf(it,T);
    if(!p)return '—';
    return fmtD(p.next)+(daysBetween(T,p.next)===0?'（今天）':'');
  }
  if(it.cycle==='usage')return '按量';
  if(it.cycle==='onetime')return fmtD(pd(it.start_date))||'—';
  return '—';
}

/* ================= API ================= */
async function api(path,opts){
  opts=opts||{};
  const headers=Object.assign({'Content-Type':'application/json'},{},token?{'Authorization':'Bearer '+token}:{});
  opts.headers=Object.assign(headers,opts.headers||{});
  const res=await fetch(path,opts);
  if(res.status===401){openToken();const e=new Error('需要访问令牌');e.auth=true;throw e;}
  let data={};
  try{data=await res.json();}catch(e){}
  if(!res.ok)throw new Error(data.error||('服务返回 '+res.status));
  return data;
}

/* ================= 示例数据 ================= */
function dstr(n){return fmtD(addDays(today(),n));}
const DEMO=[
 {name:'腾讯视频 VIP',category:'streaming',type:'expense',amount:25,cycle:'monthly',charge_day:12,start_date:dstr(-70),active:1,note:'第三方渠道续费'},
 {name:'网易云音乐黑胶',category:'streaming',type:'expense',amount:15,cycle:'monthly',charge_day:3,start_date:dstr(-40),active:1,note:''},
 {name:'ChatGPT Plus',category:'ai',type:'expense',amount:145,cycle:'monthly',charge_day:5,start_date:dstr(-95),active:1,note:'美区订阅，折合人民币'},
 {name:'Claude Pro',category:'ai',type:'expense',amount:145,cycle:'monthly',charge_day:18,start_date:dstr(-30),active:1,note:''},
 {name:'OpenAI API',category:'api',type:'expense',amount:80,cycle:'usage',charge_day:null,start_date:dstr(-90),active:1,note:'月均用量预估'},
 {name:'阿里云短信 API',category:'api',type:'expense',amount:20,cycle:'usage',charge_day:null,start_date:dstr(-90),active:1,note:''},
 {name:'iCloud 200GB',category:'cloud',type:'expense',amount:21,cycle:'monthly',charge_day:8,start_date:dstr(-200),active:1,note:'家庭共享'},
 {name:'域名 example.com',category:'cloud',type:'expense',amount:78,cycle:'yearly',charge_day:null,start_date:dstr(-280),active:1,note:'注册商周年续费'},
 {name:'轻量云服务器',category:'cloud',type:'expense',amount:588,cycle:'yearly',charge_day:null,start_date:dstr(-120),active:1,note:''},
 {name:'手机话费',category:'telecom',type:'expense',amount:59,cycle:'monthly',charge_day:1,start_date:dstr(-300),active:1,note:''},
 {name:'家庭宽带',category:'telecom',type:'expense',amount:99,cycle:'monthly',charge_day:15,start_date:dstr(-150),active:1,note:''},
 {name:'电费',category:'utilities',type:'expense',amount:260,cycle:'usage',charge_day:null,start_date:dstr(-90),active:1,note:'月均预估'},
 {name:'水费',category:'utilities',type:'expense',amount:45,cycle:'usage',charge_day:null,start_date:dstr(-90),active:1,note:'两月一缴，按月摊'},
 {name:'燃气费',category:'utilities',type:'expense',amount:60,cycle:'usage',charge_day:null,start_date:dstr(-90),active:1,note:''},
 {name:'物业费',category:'housing',type:'expense',amount:450,cycle:'quarterly',charge_day:10,start_date:dstr(-65),active:1,note:''},
 {name:'房租',category:'housing',type:'expense',amount:2600,cycle:'monthly',charge_day:1,start_date:dstr(-300),active:1,note:''},
 {name:'京东 PLUS 会员',category:'member',type:'expense',amount:99,cycle:'yearly',charge_day:null,start_date:dstr(-310),active:1,note:''},
 {name:'健身房年卡',category:'health',type:'expense',amount:2380,cycle:'yearly',charge_day:null,start_date:dstr(-150),active:1,note:''},
 {name:'百万医疗险',category:'insurance',type:'expense',amount:358,cycle:'yearly',charge_day:null,start_date:dstr(-90),active:1,note:'保证续费 20 年'},
 {name:'Notion Plus',category:'software',type:'expense',amount:72,cycle:'monthly',charge_day:22,start_date:dstr(-52),active:1,note:''},
 {name:'《塞尔达传说》游戏',category:'game',type:'expense',amount:329,cycle:'onetime',charge_day:null,start_date:dstr(-20),active:1,note:'一次性买断'}
];

/* ================= toast ================= */
let toastTimer=null;
function toast(msg,isErr){
  const el=isErr?$('#toastErr'):$('#toastOk');
  const other=isErr?$('#toastOk'):$('#toastErr');
  other.hidden=true;
  el.textContent=msg;el.hidden=false;
  if(toastTimer)clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{el.hidden=true;},3200);
}
function toastOk(m){return toast(m,false);}
function toastErr(m){return toast(m,true);}
