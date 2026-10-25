const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const {DatabaseSync}=require('node:sqlite');
const PORT=+process.env.PORT||3000,DIR=process.env.DATA||path.join(__dirname,'data');
fs.mkdirSync(DIR,{recursive:true});
const db=new DatabaseSync(path.join(DIR,'motel.db'));
db.exec(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS stays(id INTEGER PRIMARY KEY,suite TEXT NOT NULL,open INTEGER NOT NULL,d TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_open ON stays(suite) WHERE open=1;
CREATE TABLE IF NOT EXISTS sessions(t TEXT PRIMARY KEY,uid INTEGER,ts INTEGER);`);
const get=(k,d)=>{const r=db.prepare('SELECT v FROM kv WHERE k=?').get(k);return r?JSON.parse(r.v):d};
const set=(k,v)=>db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,JSON.stringify(v));
const hp=(p,s=crypto.randomBytes(8).toString('hex'))=>s+':'+crypto.scryptSync(p,s,32).toString('hex');
const okp=(p,h)=>{const a=Buffer.from(hp(p,h.split(':')[0])),b=Buffer.from(h);return a.length==b.length&&crypto.timingSafeEqual(a,b)};
const num=v=>Math.max(0,+v||0);
const rp=()=>crypto.randomBytes(5).toString('hex'),AP=process.env.ADMIN_PASS||rp(),CP=process.env.CAIXA_PASS||rp();
if(!get('suites')){
 console.log('SENHAS INICIAIS -> admin: '+AP+'  |  caixa: '+CP);
 set('tol',10);set('uid',3);
 set('users',[{id:1,name:'Administrador',login:'admin',pass:hp(AP),role:'admin',on:1},{id:2,name:'Caixa',login:'caixa',pass:hp(CP),role:'func',on:1}]);
 set('suites',[1,2,3,4,5,6].map(n=>({n:String(n).padStart(2,'0'),base:80,hours:2,extra:30,rule:'hora',st:'livre'})));
 set('cats',['Bebidas','Comidas','Outros']);
 set('prods',[['Cerveja','Bebidas',8],['Refrigerante','Bebidas',6],['Água','Bebidas',3],['Energético','Bebidas',12],['Lanche','Comidas',15],['Porção','Comidas',25]].map((p,i)=>({id:i+1,name:p[0],cat:p[1],price:p[2],on:1})));
}
const VALS=[30,31,34,37,41,44,47,50,53,54,55,56,57,59,62,63,65,67,69,73,77,79,81,82,83,85,88,90,94,96,100,102,103,104,105,106,111,114,116,118,119,120,122,124,126,130,132,134,136,138,140,142,143,146,148,149,150,151,153,154,155,159,161,163,165,169,173,175,178,180,181,184,185,186,187,188,189,190,191,192,193,194,195,197,199,201,203,204,205,206,207,208,212,218,222,228,230,232,235,236,238,240,242,244,246,248,250,255,257];
if(!get('tabs'))set('tabs',[{id:'t1',name:'Tabela 1',rows:VALS.map((v,i)=>[60+5*i,v])}]);
const VIPV=[50,54,57,62,65,70,75,79,83,87,90,95,100,105,110,113,119,122,125,130,135,140,144,148,150,155,160,163,169,173,175,180,185,188,193,198,200,205,210,215,218,223,225,230,235,238,243,248,250,255,260,265,268,272,275,280,285,288,293,298,300,305,312,315,318,323,325,330,335,338,343,348,350,355,360,365,368,373,375,380,385,390,393,398,400,405,410,415,418,423,425,430,435,440,443,448,450,455,460,465,468,473,475,480,485,490,493,498,500];
{const ts=get('tabs',[]);if(!ts.some(t=>t.id=='vip')){ts.push({id:'vip',name:'Tabela VIP',rows:VIPV.map((v,i)=>[60+5*i,v])});set('tabs',ts)}}
const tabPrice=(s,m)=>{const t=s.tab||[];if(!t.length)return s.base;const last=t[t.length-1];if(m>last[0]){const p=t.filter(x=>x[0]<=last[0]-60).pop(),sl=p?last[1]-p[1]:0;return last[1]+sl*Math.ceil((m-last[0])/60)}const r=t.find(x=>x[0]>=m);return r?r[1]:last[1]};
const snap=x=>{if(x.rule!='tabela')return{base:x.base,hours:x.hours,extra:x.extra,rule:x.rule};const t=get('tabs',[]).find(y=>y.id==x.tab);if(!t||!t.rows.length)return null;return{base:t.rows[0][1],hours:t.rows[0][0]/60,extra:x.extra,rule:'tabela',tab:t.rows}};
const NOTAB='Esta suíte usa tabela de preços, mas nenhuma tabela foi escolhida (Admin > Suítes).';
const TTL=432e5,fails={};
const cookie=r=>(/(?:^|; )sid=([a-f0-9]+)/.exec(r.headers.cookie||'')||[])[1];
const who=r=>{const t=cookie(r);if(!t)return null;const s=db.prepare('SELECT uid,ts FROM sessions WHERE t=?').get(t);if(!s||Date.now()-s.ts>TTL)return null;const u=get('users').find(x=>x.id==s.uid);return u&&u.on?u:null};
const send=(res,c,o,h={})=>{res.writeHead(c,{'Content-Type':'application/json',...h});res.end(JSON.stringify(o))};
const body=req=>new Promise(r=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch(e){r({})}})});
const allStays=()=>db.prepare('SELECT d FROM stays ORDER BY id').all().map(r=>JSON.parse(r.d));
const saveStay=s=>db.prepare('UPDATE stays SET open=?,d=? WHERE id=?').run(s.end?0:1,JSON.stringify(s),s.id);
const getStay=id=>{const r=db.prepare('SELECT d FROM stays WHERE id=? AND open=1').get(+id);return r&&JSON.parse(r.d)};
const r2=n=>+n.toFixed(2);
const calcS=s=>{const m=Math.max(0,Math.round((s.end-s.start)/6e4)),ex=Math.max(0,m-s.hours*60-get('tol',10)),h=s.rule=='meia',u=ex?Math.ceil(ex/(h?30:60)):0,add=s.extra*u/(h?2:1),cons=Object.values(s.items).reduce((a,i)=>a+i.q*i.p,0);const host=s.rule=='tabela'?tabPrice(s,m):s.base+add;return{host,cons,total:host+cons}};
const shiftCalc=()=>{const c=get('closes',[]),since=c.length?c[c.length-1].at:0,now=Date.now(),l=allStays().filter(s=>s.end&&!s.cancel&&s.end>since&&s.end<=now).map(s=>({s,k:calcS(s)})),sum=f=>r2(l.reduce((a,x)=>a+f(x),0)),by=m=>sum(x=>x.s.pay==m?x.k.total:0);const agg={};l.forEach(x=>Object.entries(x.s.items).forEach(([id,i])=>{const a=agg[id]||(agg[id]={n:i.n,q:0,v:0});a.q+=i.q;a.v=r2(a.v+i.q*i.p)}));
const items=Object.values(agg).sort((a,b)=>b.q-a.q||a.n.localeCompare(b.n)),openQ=allStays().filter(s=>!s.end).reduce((a,s)=>a+Object.values(s.items).reduce((b,i)=>b+i.q,0),0);
return{since,now,items,openQ,cnt:l.length,pix:by('PIX'),cash:by('Dinheiro'),card:by('Cartão'),host:sum(x=>x.k.host),cons:sum(x=>x.k.cons),total:sum(x=>x.k.total),float:get('float',0)}};
function autoBackup(){try{const d=path.join(DIR,'backups');fs.mkdirSync(d,{recursive:true});const n=new Date().toISOString().slice(0,13).replace(/[-:T]/g,'');db.exec(`VACUUM INTO '${path.join(d,'motel-'+n+'.db').replace(/'/g,"''")}'`);fs.readdirSync(d).sort().slice(0,-28).forEach(f=>fs.rmSync(path.join(d,f)))}catch(e){}}
autoBackup();setInterval(autoBackup,216e5);
http.createServer(async(req,res)=>{try{
 const u=req.url.split('?')[0];
 if(!u.startsWith('/api/')){
  const f=u=='/'?'index.html':u.slice(1);
  if(!['index.html','api-layer.js'].includes(f)){res.writeHead(404);return res.end()}
  res.writeHead(200,{'Content-Type':f.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});
  return res.end(fs.readFileSync(path.join(__dirname,'public',f)));
 }
 const b=req.method=='POST'?await body(req):{};
 if(u=='/api/login'){
  const ip=(process.env.RAILWAY_ENVIRONMENT&&req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim(),f=fails[ip]||(fails[ip]={n:0,t:0});
  if(f.n>=8&&Date.now()-f.t<6e5)return send(res,429,{error:'Muitas tentativas. Aguarde alguns minutos.'});
  const us=get('users').find(x=>x.login==String(b.login||'').trim());
  if(!us||!okp(String(b.pass||''),us.pass)){f.n++;f.t=Date.now();return send(res,401,{error:'Usuário ou senha incorretos.'})}
  if(!us.on)return send(res,403,{error:'Usuário bloqueado. Fale com o administrador.'});
  f.n=0;const t=crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t,us.id,Date.now());
  db.prepare('DELETE FROM sessions WHERE ts<?').run(Date.now()-TTL);
  return send(res,200,{},{'Set-Cookie':`sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.headers['x-forwarded-proto']=='https'?'; Secure':''}`});
 }
 const me=who(req);
 if(!me)return send(res,401,{error:'Sessão expirada. Entre novamente.'});
 if(u=='/api/logout'){db.prepare('DELETE FROM sessions WHERE t=?').run(cookie(req));return send(res,200,{})}
 if(u=='/api/backup'){
  if(me.role!='admin')return send(res,403,{error:'Somente o administrador pode baixar o backup.'});
  const f=path.join(DIR,'export.db');fs.rmSync(f,{force:true});db.exec(`VACUUM INTO '${f.replace(/'/g,"''")}'`);const buf=fs.readFileSync(f);fs.rmSync(f);
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="motel-me-leve-backup.db"'});return res.end(buf);
 }
 if(u=='/api/shift')return send(res,200,shiftCalc());
 if(u=='/api/float'){if(me.role!='admin')return send(res,403,{error:'Somente o administrador pode alterar o fundo de troco.'});set('float',num(b.v));return send(res,200,{})}
 if(u=='/api/close'){
  const c=shiftCalc(),counted=Number(b.counted);
  if(!Number.isFinite(counted)||counted<0)return send(res,400,{error:'Informe o dinheiro contado na gaveta.'});
  if(!c.cnt)return send(res,409,{error:'Nenhuma venda desde o último fechamento.'});
  const list=get('closes',[]),expected=r2(c.float+c.cash),rec={id:list.length+1,by:me.name,at:c.now,from:c.since,cnt:c.cnt,pix:c.pix,cash:c.cash,card:c.card,host:c.host,cons:c.cons,total:c.total,float:c.float,items:c.items,expected,counted:r2(counted),diff:r2(counted-expected),note:String(b.note||'').slice(0,120)};
  list.push(rec);set('closes',list);return send(res,200,rec);
 }
 if(u=='/api/state')return send(res,200,{me:{id:me.id,name:me.name,role:me.role},tol:get('tol'),suites:get('suites'),cats:get('cats'),prods:get('prods'),tabs:get('tabs',[]),users:me.role=='admin'?get('users').map(({pass,...x})=>({...x,pass:''})):[],stays:allStays(),closes:me.role=='admin'?get('closes',[]).slice(-60).reverse():[]});
 if(u=='/api/start'){
  const su=get('suites'),x=su.find(y=>y.n==b.suite);
  if(!x||x.st!='livre')return send(res,409,{error:'Esta suíte não está livre.'});
  const sn=snap(x);if(!sn)return send(res,409,{error:NOTAB});
  const s={suite:x.n,start:Date.now(),end:0,...sn,items:{},user:me.name,pay:''};
  let id;try{id=Number(db.prepare('INSERT INTO stays(suite,open,d) VALUES(?,1,?)').run(x.n,'{}').lastInsertRowid)}catch(e){return send(res,409,{error:'Esta suíte já tem uma estadia aberta.'})}
  s.id=id;saveStay(s);x.st='ocupada';set('suites',su);return send(res,200,{id});
 }
 if(u=='/api/qty'){
  const d=b.d>0?1:-1,s=getStay(b.stay),p=get('prods').find(x=>x.id==b.prod);
  if(!s||!p||(d>0&&!p.on))return send(res,404,{error:'Comanda ou produto não encontrado.'});
  const i=s.items[p.id]||(s.items[p.id]={q:0,p:p.price,n:p.name});i.q=Math.max(0,i.q+d);if(!i.q)delete s.items[p.id];
  saveStay(s);return send(res,200,{});
 }
 if(u=='/api/pay'){
  const s=getStay(b.stay);
  if(!s||!['PIX','Dinheiro','Cartão'].includes(b.method))return send(res,409,{error:'Esta comanda já foi encerrada ou não existe.'});
  s.end=Date.now();s.pay=b.method;s.user=me.name;saveStay(s);
  const su=get('suites');su.find(x=>x.n==s.suite).st='limpeza';set('suites',su);return send(res,200,{});
 }
 if(u=='/api/cancel'){
  const r=db.prepare('SELECT d FROM stays WHERE id=?').get(+b.stay),s=r&&JSON.parse(r.d);
  if(!s||s.cancel)return send(res,404,{error:'Comanda não encontrada ou já cancelada.'});
  if(me.role!='admin'&&(s.end||Object.keys(s.items).length))return send(res,403,{error:'Somente o administrador pode cancelar esta comanda.'});
  const wasOpen=!s.end;s.cancel={by:me.name,at:Date.now(),why:String(b.why||'').slice(0,120)};if(wasOpen)s.end=Date.now();saveStay(s);
  if(wasOpen){const su=get('suites'),x=su.find(y=>y.n==s.suite);if(x&&x.st=='ocupada'){x.st='livre';set('suites',su)}}
  return send(res,200,{});
 }
 if(u=='/api/transfer'){
  const s=getStay(b.stay),su=get('suites'),to=su.find(x=>x.n==b.to),from=s&&su.find(x=>x.n==s.suite);
  if(!s||!to||!from)return send(res,404,{error:'Comanda ou suíte não encontrada.'});
  if(to.st!='livre'||to.n==s.suite)return send(res,409,{error:'A suíte de destino não está livre.'});
  const old=s.suite,nova=b.rate=='nova';s.suite=to.n;
  if(nova){const sn=snap(to);if(!sn)return send(res,409,{error:NOTAB});Object.assign(s,sn);if(!sn.tab)delete s.tab}
  (s.moves||(s.moves=[])).push({from:old,to:to.n,at:Date.now(),by:me.name,rate:nova?'nova':'manter'});
  try{db.prepare('UPDATE stays SET suite=?,d=? WHERE id=?').run(s.suite,JSON.stringify(s),s.id)}catch(e){return send(res,409,{error:'A suíte de destino já está ocupada.'})}
  from.st='limpeza';to.st='ocupada';set('suites',su);return send(res,200,{});
 }
 if(u=='/api/entry'){
  const s=getStay(b.stay),t=Number(b.t),now=Date.now();
  if(!s)return send(res,404,{error:'Comanda não encontrada ou já encerrada.'});
  if(!Number.isFinite(t)||t>now+6e4||t<now-864e5-6e4)return send(res,400,{error:'Horário inválido. Use um horário das últimas 24 horas.'});
  (s.edits||(s.edits=[])).push({from:s.start,to:Math.min(t,now),by:me.name,at:now,why:String(b.why||'').slice(0,120)});s.start=Math.min(t,now);saveStay(s);return send(res,200,{});
 }
 if(u=='/api/suite'){
  const su=get('suites'),x=su.find(y=>y.n==b.n);
  if(!x||x.st=='ocupada'||!['livre','limpeza','manut'].includes(b.st))return send(res,409,{error:'Não foi possível alterar esta suíte.'});
  if(me.role!='admin'&&!(x.st=='limpeza'&&b.st=='livre'))return send(res,403,{error:'Somente o administrador pode fazer isso.'});
  x.st=b.st;set('suites',su);return send(res,200,{});
 }
 if(u=='/api/config'){
  if(me.role!='admin')return send(res,403,{error:'Somente o administrador pode alterar configurações.'});
  const old=get('suites'),ns=(b.suites||[]).map(x=>{const o=old.find(y=>y.n==x.n);return{n:String(x.n),base:num(x.base),hours:num(x.hours),extra:num(x.extra),rule:['meia','tabela'].includes(x.rule)?x.rule:'hora',tab:String(x.tab||''),vip:x.vip?1:0,st:!o?'livre':(o.st=='ocupada'||x.st=='ocupada')?o.st:['livre','limpeza','manut'].includes(x.st)?x.st:o.st}});
  old.forEach(o=>{if(!ns.some(x=>x.n==o.n))ns.push(o)});set('suites',ns);
  set('cats',[...new Set((b.cats||[]).map(c=>String(c).trim()).filter(Boolean))]);
  set('prods',(b.prods||[]).map(p=>({id:+p.id,name:String(p.name).slice(0,60),cat:String(p.cat),price:num(p.price),on:p.on?1:0})));
  if(Array.isArray(b.tabs))set('tabs',b.tabs.map(t=>({id:String(t.id||'t'+Date.now()+Math.floor(Math.random()*1e3)),name:String(t.name||'Tabela').slice(0,40),rows:(t.rows||[]).map(r=>[Math.max(0,Math.round(+r[0]||0)),num(r[1])]).filter(r=>r[0]>0).sort((a,b)=>a[0]-b[0])})));
  const ou=get('users');let uid=get('uid');
  const nu=(b.users||[]).map(x=>{const o=ou.find(y=>y.id==x.id),id=o?o.id:uid++;return{id,name:String(x.name).slice(0,60),login:String(x.login).trim(),role:x.role=='admin'?'admin':'func',on:x.on?1:0,pass:x.pass?hp(String(x.pass)):o?o.pass:hp('1234')}});
  const self=nu.find(x=>x.id==me.id);if(self){self.on=1;self.role='admin'}else nu.push(ou.find(x=>x.id==me.id));
  set('users',nu);set('uid',uid);return send(res,200,{});
 }
 send(res,404,{error:'Não encontrado.'});
}catch(e){console.error(e);try{send(res,500,{error:'Erro interno.'})}catch(_){}}}).listen(PORT,'0.0.0.0',()=>{
 console.log('Motel Me Leve rodando. Deixe esta janela aberta.');
 console.log('Neste computador: http://localhost:'+PORT);
 Object.values(os.networkInterfaces()).flat().filter(i=>i.family=='IPv4'&&!i.internal).forEach(i=>console.log('Outros aparelhos na rede: http://'+i.address+':'+PORT));
});
