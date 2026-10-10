'use strict';
// Currículo IA – servidor sem dependências (Node >= 22.9). Contas por código de e-mail, rascunhos, contatos.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const env = process.env, PROD = env.NODE_ENV === 'production' || !!env.RAILWAY_PROJECT_ID || !!env.RAILWAY_ENVIRONMENT_NAME; // na Railway sempre vale o modo de produção
const SECRET = env.APP_SECRET || (PROD ? '' : 'dev-secret-change-me-please-0123');
if (SECRET.length < 24) { console.error('Defina APP_SECRET com 24+ caracteres.'); process.exit(1); }
const MAIL_ON = !PROD || !!(env.RESEND_API_KEY && env.MAIL_FROM);
if (!MAIL_ON) console.warn('AVISO: RESEND_API_KEY/MAIL_FROM ausentes. O login por e-mail fica desligado até você configurá-los.');
const PRICE = +env.PRICE_CENTS || 1000, MP_API = env.MP_API || 'https://api.mercadopago.com', MP_TOKEN = env.MP_ACCESS_TOKEN || '', BASE = (env.BASE_URL || '').replace(/\/$/, '');
const ADMINS = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DB_PATH = env.DB_PATH || (env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'app.db') : path.join(__dirname, 'data', 'app.db'));
if (PROD && !env.DB_PATH && !env.RAILWAY_VOLUME_MOUNT_PATH) console.warn('ATENÇÃO: sem disco persistente configurado, o banco será apagado a cada publicação. Crie um volume e defina DB_PATH.');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`pragma journal_mode=wal; pragma foreign_keys=on;
create table if not exists users(id integer primary key, email text unique not null, created_at integer not null, consent_at integer not null, news integer not null default 0, news_at integer);
create table if not exists codes(email text primary key, hash text not null, exp integer not null, tries integer not null default 0, consent integer not null, news integer not null);
create table if not exists sessions(hash text primary key, user_id integer not null references users(id) on delete cascade, exp integer not null);
create table if not exists resumes(user_id integer primary key references users(id) on delete cascade, data text not null, updated_at integer not null);
create table if not exists orders(id text primary key, token_hash text not null, user_id integer, email text not null, amount_cents integer not null, status text not null, mp_id text, qr text, qr_b64 text, created_at integer not null, paid_at integer, uses_left integer not null default 0);
create table if not exists rate(k text primary key, n integer not null, reset integer not null);`);

const now = () => Date.now();
const H = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const outbox = []; // só para desenvolvimento e testes

function hit(k, max, win) { // limite simples por janela fixa
  const t = now(), r = db.prepare('select n,reset from rate where k=?').get(k);
  if (!r || r.reset < t) { db.prepare('insert or replace into rate(k,n,reset) values(?,?,?)').run(k, 1, t + win); return true; }
  if (r.n >= max) return false;
  db.prepare('update rate set n=n+1 where k=?').run(k); return true;
}
const ipOf = req => env.TRUST_PROXY === '1' ? (String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress) : req.socket.remoteAddress;
const normEmail = v => { const e = String(v || '').trim().toLowerCase(); return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null; };

async function sendMail(to, subject, text) {
  if (env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }) });
    if (!r.ok) throw new Error('falha no envio de e-mail: ' + r.status);
    return;
  }
  outbox.push({ to, subject, text }); console.log('[DEV e-mail para ' + to + ']', text.split('\n')[0]);
}

const HEAD = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
};
function send(res, code, obj, extra = {}) {
  const isStr = typeof obj === 'string';
  res.writeHead(code, { ...HEAD, 'Cache-Control': 'no-store', 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...extra });
  res.end(isStr ? obj : JSON.stringify(obj));
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));
const userOf = req => { const t = cookies(req).cia_s; if (!/^[a-f0-9]{64}$/.test(t || '')) return null; return db.prepare('select u.* from sessions s join users u on u.id=s.user_id where s.hash=? and s.exp>?').get(H(t), now()) || null; };
const cookie = (req, v, age) => `cia_s=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}` + ((PROD || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '');
const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; const h = req.headers.host; return o === 'http://' + h || o === 'https://' + h || (!!env.ORIGIN && o === env.ORIGIN); };
function readBody(req, max = 1_000_000) {
  return new Promise((ok, no) => {
    let n = 0, big = false; const c = [];
    req.on('data', x => { n += x.length; if (n > max) { big = true; if (n > max * 5) req.destroy(); } else c.push(x); });
    req.on('end', () => { if (big) return no({ code: 413 }); try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch { no({ code: 400 }); } });
    req.on('error', () => no({ code: 400 }));
  });
}
const csv = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

// ---------- Pagamento (Mercado Pago, Pix) ----------
async function mp(method, p, body, idem) {
  const r = await fetch(MP_API + p, { method, headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json', ...(idem ? { 'X-Idempotency-Key': idem } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('mercadopago ' + r.status);
  return j;
}
// Nunca confiamos no conteúdo do aviso: só o que o Mercado Pago responde à nossa consulta vale.
function applyPayment(pay) {
  const o = db.prepare('select * from orders where id=?').get(String(pay.external_reference || ''));
  if (!o || (o.mp_id && String(o.mp_id) !== String(pay.id))) return 'ignorado';
  if (pay.currency_id !== 'BRL' || Math.round(Number(pay.transaction_amount) * 100) !== o.amount_cents) return 'valor divergente';
  if (!o.mp_id) db.prepare('update orders set mp_id=? where id=?').run(String(pay.id), o.id);
  if (o.status === 'paid' && ['refunded', 'charged_back'].includes(pay.status)) { db.prepare("update orders set status='refunded',uses_left=0 where id=?").run(o.id); return 'estornado'; }
  if (o.status !== 'pending') return 'já processado';
  if (pay.status === 'approved') { db.prepare("update orders set status='paid',paid_at=?,uses_left=3 where id=?").run(now(), o.id); return 'pago'; }
  if (['cancelled', 'rejected', 'expired'].includes(pay.status)) { db.prepare("update orders set status='failed' where id=?").run(o.id); return 'falhou'; }
  return 'pendente';
}
const getOrder = id => db.prepare('select * from orders where id=?').get(id);
function ordOf(req, id) {
  const o = getOrder(String(id || '')), t = req.headers['x-order-token'];
  return o && typeof t === 'string' && /^[a-f0-9]{64}$/.test(t) && same(o.token_hash, H(t)) ? o : null;
}
const isAdmin = u => !!u && ADMINS.includes(u.email);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    const f = path.join(__dirname, 'public', 'index.html');
    res.writeHead(200, { ...HEAD, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(f));
  }
  if (!p.startsWith('/api/')) return send(res, 404, { erro: 'Não encontrado.' });
  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, app: 'curriculo-ia', mail: MAIL_ON, pay: !!MP_TOKEN });
  if (m === 'POST' && p === '/api/pay/webhook') {
    let wb = {}; try { wb = await readBody(req, 100_000); } catch { /* ignora corpo ruim */ }
    const id = (wb.data && wb.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id');
    if (!MP_TOKEN || !/^\d{1,20}$/.test(String(id || ''))) return send(res, 200, { ok: true });
    if (!hit('wh:' + ipOf(req), 300, 3600e3)) return send(res, 429, { erro: 'Muitas requisições.' });
    try { applyPayment(await mp('GET', '/v1/payments/' + id)); } catch (e) { console.error('webhook:', e.message); return send(res, 500, { erro: 'Tente de novo.' }); }
    return send(res, 200, { ok: true });
  }
  if (m !== 'GET' && !sameOrigin(req)) return send(res, 403, { erro: 'Origem não permitida.' });
  let b = {};
  if (m === 'POST' || m === 'PUT') {
    if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { erro: 'Envie JSON.' });
    try { b = await readBody(req); } catch (e) { return send(res, e.code || 400, { erro: e.code === 413 ? 'Arquivo grande demais.' : 'Requisição inválida.' }); }
  }
  const ip = ipOf(req);

  if (m === 'POST' && p === '/api/auth/request') {
    const email = normEmail(b.email);
    if (!email) return send(res, 400, { erro: 'E-mail inválido.' });
    if (b.consent !== true) return send(res, 400, { erro: 'Aceite a política de privacidade para continuar.' });
    if (!MAIL_ON) return send(res, 503, { erro: 'O login por e-mail ainda não está disponível.' });
    if (!hit('ip:' + ip, 20, 3600e3) || !hit('em:' + email, 5, 3600e3)) return send(res, 429, { erro: 'Muitas tentativas. Tente novamente mais tarde.' });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    db.prepare('insert or replace into codes(email,hash,exp,tries,consent,news) values(?,?,?,0,1,?)').run(email, H(email + ':' + code), now() + 600e3, b.news === true ? 1 : 0);
    try { await sendMail(email, 'Seu código do Currículo IA', `Seu código do Currículo IA: ${code}\n\nEle vale por 10 minutos. Se você não pediu este código, ignore esta mensagem.`); }
    catch (e) { console.error(e.message); return send(res, 502, { erro: 'Não foi possível enviar o e-mail agora. Tente de novo.' }); }
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/auth/verify') {
    const email = normEmail(b.email), code = String(b.code || '');
    if (!email || !/^\d{6}$/.test(code)) return send(res, 400, { erro: 'Código inválido ou expirado.' });
    if (!hit('v:' + ip, 30, 3600e3)) return send(res, 429, { erro: 'Muitas tentativas. Tente novamente mais tarde.' });
    const row = db.prepare('select * from codes where email=?').get(email), bad = { erro: 'Código inválido ou expirado.' };
    if (!row || row.exp < now()) return send(res, 400, bad);
    if (row.tries >= 5) { db.prepare('delete from codes where email=?').run(email); return send(res, 400, { erro: 'Muitas tentativas. Peça um novo código.' }); }
    if (!same(row.hash, H(email + ':' + code))) { db.prepare('update codes set tries=tries+1 where email=?').run(email); return send(res, 400, bad); }
    db.prepare('delete from codes where email=?').run(email);
    const t = now(); let u = db.prepare('select * from users where email=?').get(email);
    if (!u) { db.prepare('insert into users(email,created_at,consent_at,news,news_at) values(?,?,?,?,?)').run(email, t, t, row.news, row.news ? t : null); u = db.prepare('select * from users where email=?').get(email); }
    else if (row.news && !u.news) { db.prepare('update users set news=1,news_at=? where id=?').run(t, u.id); u.news = 1; }
    const tok = crypto.randomBytes(32).toString('hex');
    db.prepare('insert into sessions(hash,user_id,exp) values(?,?,?)').run(H(tok), u.id, t + 30 * 864e5);
    return send(res, 200, { ok: true, email: u.email, news: !!u.news }, { 'Set-Cookie': cookie(req, tok, 30 * 86400) });
  }
  if (m === 'POST' && p === '/api/pay/create') {
    if (!MP_TOKEN) return send(res, 503, { erro: 'Pagamento ainda não configurado.' });
    const email = normEmail(b.email); if (!email) return send(res, 400, { erro: 'E-mail inválido.' });
    if (!hit('pay:' + ip, 10, 3600e3)) return send(res, 429, { erro: 'Muitas tentativas. Tente novamente mais tarde.' });
    const cu = userOf(req), id = crypto.randomBytes(8).toString('hex'), token = crypto.randomBytes(32).toString('hex');
    db.prepare("insert into orders(id,token_hash,user_id,email,amount_cents,status,created_at) values(?,?,?,?,?,'pending',?)").run(id, H(token), cu ? cu.id : null, email, PRICE, now());
    try {
      const pay = await mp('POST', '/v1/payments', { transaction_amount: PRICE / 100, description: 'Currículo IA', payment_method_id: 'pix', payer: { email }, external_reference: id, ...(BASE ? { notification_url: BASE + '/api/pay/webhook' } : {}) }, id);
      const td = (pay.point_of_interaction && pay.point_of_interaction.transaction_data) || {};
      if (!pay.id || !td.qr_code) throw new Error('resposta sem Pix');
      db.prepare('update orders set mp_id=?,qr=?,qr_b64=? where id=?').run(String(pay.id), td.qr_code, td.qr_code_base64 || '', id);
      return send(res, 200, { order: id, token, qr: td.qr_code, qr_b64: td.qr_code_base64 || '', amount: PRICE });
    } catch (e) { console.error('criar Pix:', e.message); db.prepare('delete from orders where id=?').run(id); return send(res, 502, { erro: 'Não foi possível gerar o Pix agora. Tente de novo.' }); }
  }
  if (m === 'GET' && p === '/api/pay/status') {
    let o = ordOf(req, url.searchParams.get('order')); if (!o) return send(res, 401, { erro: 'Pedido não encontrado.' });
    if (o.status === 'pending' && o.mp_id && hit('st:' + o.id, 40, 60e3)) { try { applyPayment(await mp('GET', '/v1/payments/' + o.mp_id)); o = getOrder(o.id); } catch (e) { console.error('status:', e.message); } }
    return send(res, 200, { status: o.status, uses_left: o.uses_left });
  }
  if (m === 'POST' && p === '/api/pay/consume') {
    const o = ordOf(req, b.order); if (!o) return send(res, 401, { erro: 'Pedido não encontrado.' });
    if (o.status !== 'paid' || o.uses_left < 1) return send(res, 409, { erro: 'Download não liberado.' });
    db.prepare('update orders set uses_left=uses_left-1 where id=?').run(o.id); return send(res, 200, { uses_left: o.uses_left - 1 });
  }
  const u = userOf(req);
  if (m === 'POST' && p === '/api/logout') { const t = cookies(req).cia_s; if (t) db.prepare('delete from sessions where hash=?').run(H(t)); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }); }
  if (!u) return send(res, 401, { erro: 'Entre na sua conta.' });
  if (m === 'GET' && p === '/api/me') return send(res, 200, { email: u.email, news: !!u.news, admin: isAdmin(u) });
  if (m === 'POST' && p === '/api/me/prefs') { const n = b.news === true ? 1 : 0; db.prepare('update users set news=?,news_at=? where id=?').run(n, n ? now() : null, u.id); return send(res, 200, { ok: true, news: !!n }); }
  if (m === 'DELETE' && p === '/api/me') { db.prepare('delete from users where id=?').run(u.id); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }); }
  if (m === 'GET' && p === '/api/resume') { const r = db.prepare('select data from resumes where user_id=?').get(u.id); return send(res, 200, r ? JSON.parse(r.data) : {}); }
  if (m === 'PUT' && p === '/api/resume') {
    if (!b.d || typeof b.d !== 'object' || Array.isArray(b.d)) return send(res, 400, { erro: 'Dados inválidos.' });
    if (!hit('r:' + u.id, 120, 3600e3)) return send(res, 429, { erro: 'Muitas gravações. Aguarde um pouco.' });
    const data = JSON.stringify({ t: String(b.t || '').slice(0, 30), d: b.d });
    if (data.length > 900_000) return send(res, 413, { erro: 'Arquivo grande demais.' });
    db.prepare('insert or replace into resumes(user_id,data,updated_at) values(?,?,?)').run(u.id, data, now()); return send(res, 200, { ok: true });
  }
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(u)) return send(res, 403, { erro: 'Sem permissão.' });
    if (m === 'GET' && p === '/api/admin/stats') return send(res, 200, db.prepare("select (select count(*) from users) usuarios, (select count(*) from users where news=1) aceitaram_novidades, (select count(*) from resumes) rascunhos, (select count(*) from orders where status='paid') vendas, (select coalesce(sum(amount_cents),0) from orders where status='paid') faturamento_centavos").get());
    if (m === 'GET' && p === '/api/admin/orders') return send(res, 200, db.prepare('select id,email,status,amount_cents,created_at,paid_at,uses_left from orders order by created_at desc limit 200').all());
    if (m === 'GET' && p === '/api/admin/contacts.csv') {
      const all = url.searchParams.get('all') === '1';
      const rows = db.prepare('select email,created_at,news from users ' + (all ? '' : 'where news=1 ') + 'order by created_at').all();
      return send(res, 200, 'email,criado_em,aceitou_novidades\n' + rows.map(r => [csv(r.email), new Date(r.created_at).toISOString(), r.news ? 'sim' : 'nao'].join(',')).join('\n') + '\n', { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contatos.csv"' });
    }
  }
  return send(res, 404, { erro: 'Não encontrado.' });
}

function start(port = +env.PORT || 3000) {
  const srv = http.createServer((req, res) => handle(req, res).catch(e => { console.error('erro:', e.message); if (!res.headersSent) send(res, 500, { erro: 'Erro interno.' }); }));
  const t = now();
  const clean = () => { const x = now(); db.prepare('delete from codes where exp<?').run(x); db.prepare('delete from sessions where exp<?').run(x); db.prepare('delete from rate where reset<?').run(x); };
  clean(); setInterval(clean, 3600e3).unref();
  return new Promise(ok => srv.listen(port, () => { if (require.main === module) console.log('Currículo IA em http://localhost:' + srv.address().port); ok(srv); }));
}
module.exports = { start, outbox };
if (require.main === module) start();
