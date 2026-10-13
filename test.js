'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), path = require('node:path'), fs = require('node:fs');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cia-')), 't.db');
process.env.ADMIN_EMAILS = 'admin@teste.com'; process.env.LEGAL_NAME = 'Empresa Teste <script>'; process.env.CONTACT_EMAIL = 'contato@teste.com'; process.env.BASE_URL = 'https://site.teste';
process.env.APP_SECRET = 'segredo-de-teste-com-mais-de-24-chars';
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
const fake = require('./fake-mp.js');
let start, outbox, base, srv, mpsrv, mpbase;
test.before(async () => {
  mpsrv = await fake.start(0); mpbase = 'http://127.0.0.1:' + mpsrv.address().port;
  process.env.MP_API = mpbase; process.env.MP_ACCESS_TOKEN = 'TEST-fake';
  ({ start, outbox } = require('./server.js')); srv = await start(0); base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => { srv.close(); mpsrv.close(); });
const call = async (m, u, b, ck, hdr = {}) => {
  const r = await fetch(base + u, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(ck ? { Cookie: ck } : {}), ...hdr }, body: b ? JSON.stringify(b) : undefined });
  const ct = r.headers.get('content-type') || '', raw = r.headers.get('set-cookie') || '';
  return { s: r.status, j: ct.includes('json') ? await r.json() : null, t: ct.includes('json') ? null : await r.text(), ck: raw.split(';')[0], raw, h: r.headers };
};
async function entrar(email, news = true) {
  outbox.length = 0;
  const a = await call('POST', '/api/auth/request', { email, consent: true, news }); assert.equal(a.s, 200);
  const code = outbox.at(-1).text.match(/\d{6}/)[0];
  return call('POST', '/api/auth/verify', { email, code });
}
test('saúde e cabeçalhos de segurança', async () => {
  const r = await call('GET', '/api/health'); assert.equal(r.s, 200); assert.equal(r.j.app, 'curriculo-ia');
  assert.equal(r.h.get('x-content-type-options'), 'nosniff'); assert.match(r.h.get('content-security-policy'), /default-src 'self'/);
});
test('exige e-mail válido e consentimento', async () => {
  assert.equal((await call('POST', '/api/auth/request', { email: 'nao-e-email', consent: true })).s, 400);
  assert.equal((await call('POST', '/api/auth/request', { email: 'a@b.com', consent: false })).s, 400);
});
test('código errado 5 vezes bloqueia até o código certo', async () => {
  outbox.length = 0; await call('POST', '/api/auth/request', { email: 'trava@teste.com', consent: true });
  const code = outbox.at(-1).text.match(/\d{6}/)[0], errado = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/verify', { email: 'trava@teste.com', code: errado })).s, 400);
  assert.equal((await call('POST', '/api/auth/verify', { email: 'trava@teste.com', code })).s, 400);
});
test('login, sessão, rascunho e saída', async () => {
  assert.equal((await call('GET', '/api/me')).s, 401);
  const v = await entrar('cliente@teste.com'); assert.equal(v.s, 200); assert.match(v.raw, /HttpOnly/); assert.match(v.raw, /SameSite=Lax/);
  assert.equal((await call('GET', '/api/me', null, v.ck)).j.email, 'cliente@teste.com');
  assert.equal((await call('PUT', '/api/resume', { t: 'moderno', d: { nome: 'Ana' } }, v.ck)).s, 200);
  assert.deepEqual((await call('GET', '/api/resume', null, v.ck)).j, { t: 'moderno', d: { nome: 'Ana' } });
  await call('POST', '/api/logout', {}, v.ck);
  assert.equal((await call('GET', '/api/me', null, v.ck)).s, 401);
});
test('código só vale uma vez', async () => {
  outbox.length = 0; await call('POST', '/api/auth/request', { email: 'uma@teste.com', consent: true });
  const code = outbox.at(-1).text.match(/\d{6}/)[0];
  assert.equal((await call('POST', '/api/auth/verify', { email: 'uma@teste.com', code })).s, 200);
  assert.equal((await call('POST', '/api/auth/verify', { email: 'uma@teste.com', code })).s, 400);
});
test('admin: só administradores, só quem aceitou novidades', async () => {
  const sem = await entrar('semnews@teste.com', false), com = await entrar('comnews@teste.com', true), adm = await entrar('admin@teste.com', false);
  assert.equal((await call('GET', '/api/admin/stats', null, com.ck)).s, 403);
  assert.equal((await call('GET', '/api/admin/contacts.csv', null)).s, 401);
  const c = await call('GET', '/api/admin/contacts.csv', null, adm.ck);
  assert.equal(c.s, 200); assert.match(c.t, /comnews@teste.com/); assert.doesNotMatch(c.t, /semnews@teste.com/);
  assert.match((await call('GET', '/api/admin/contacts.csv?all=1', null, adm.ck)).t, /semnews@teste.com/);
  assert.ok((await call('GET', '/api/admin/stats', null, adm.ck)).j.usuarios >= 3);
});
test('bloqueia pedido vindo de outro site', async () => {
  assert.equal((await call('POST', '/api/auth/request', { email: 'x@y.com', consent: true }, null, { Origin: 'https://site-malicioso.com' })).s, 403);
});
test('limita pedidos de código por e-mail', async () => {
  let ultimo; for (let i = 0; i < 6; i++) ultimo = await call('POST', '/api/auth/request', { email: 'limite@teste.com', consent: true });
  assert.equal(ultimo.s, 429);
});
test('rejeita corpo grande demais', async () => {
  const r = await call('PUT', '/api/resume', { d: { x: 'a'.repeat(1_200_000) } }, (await entrar('grande@teste.com')).ck); assert.equal(r.s, 413);
});
test('excluir conta apaga os dados', async () => {
  const v = await entrar('apagar@teste.com'); await call('PUT', '/api/resume', { t: 'x', d: { nome: 'Z' } }, v.ck);
  assert.equal((await call('DELETE', '/api/me', null, v.ck)).s, 200);
  assert.equal((await call('GET', '/api/me', null, v.ck)).s, 401);
  const v2 = await entrar('apagar@teste.com'); assert.deepEqual((await call('GET', '/api/resume', null, v2.ck)).j, {});
});

// ---------- pagamento ----------
const mpSet = (id, st) => fetch(`${mpbase}/_status/${id}/${st}`, { method: 'POST' });
const mpPay = async id => (await fetch(`${mpbase}/v1/payments/${id}`)).json();
const pedido = async () => { const r = await call('POST', '/api/pay/create', { email: 'comprador@teste.com' }); assert.equal(r.s, 200); return r.j; };
const hdr = o => ({ 'X-Order-Token': o.token });
const webhook = (mpId, how = 'body') => how === 'body' ? call('POST', '/api/pay/webhook', { action: 'payment.updated', data: { id: String(mpId) } }) : call('POST', '/api/pay/webhook?data.id=' + mpId, {});
test('pagamento: cria Pix e começa pendente, sem liberar download', async () => {
  const o = await pedido(); assert.match(o.qr, /^00020126FAKE/); assert.ok(o.qr_b64.length > 10); assert.equal(o.amount, 1000);
  const st = await call('GET', '/api/pay/status?order=' + o.order, null, null, hdr(o)); assert.deepEqual(st.j, { status: 'pending', uses_left: 0 });
  assert.equal((await call('POST', '/api/pay/consume', { order: o.order }, null, hdr(o))).s, 409);
});
test('pagamento: exige o token do pedido e e-mail válido', async () => {
  const o = await pedido();
  assert.equal((await call('GET', '/api/pay/status?order=' + o.order)).s, 401);
  assert.equal((await call('GET', '/api/pay/status?order=' + o.order, null, null, { 'X-Order-Token': 'a'.repeat(64) })).s, 401);
  assert.equal((await call('POST', '/api/pay/create', { email: 'invalido' })).s, 400);
});
test('pagamento: aviso falso não libera (só vale a consulta ao Mercado Pago)', async () => {
  const o = await pedido(); const id = o.qr.replace('00020126FAKE', '');
  assert.equal((await webhook(id)).s, 200);
  assert.equal((await call('GET', '/api/pay/status?order=' + o.order, null, null, hdr(o))).j.status, 'pending');
});
test('pagamento: aprovado libera 3 downloads e o aviso repetido não soma', async () => {
  const o = await pedido(), id = o.qr.replace('00020126FAKE', '');
  await mpSet(id, 'approved'); assert.equal((await webhook(id)).s, 200); assert.equal((await webhook(id, 'query')).s, 200);
  assert.deepEqual((await call('GET', '/api/pay/status?order=' + o.order, null, null, hdr(o))).j, { status: 'paid', uses_left: 3 });
  for (let i = 2; i >= 0; i--) assert.equal((await call('POST', '/api/pay/consume', { order: o.order }, null, hdr(o))).j.uses_left, i);
  assert.equal((await call('POST', '/api/pay/consume', { order: o.order }, null, hdr(o))).s, 409);
});
test('pagamento: sem aviso, a consulta de status também confirma', async () => {
  const o = await pedido(), id = o.qr.replace('00020126FAKE', ''); await mpSet(id, 'approved');
  assert.equal((await call('GET', '/api/pay/status?order=' + o.order, null, null, hdr(o))).j.status, 'paid');
});
test('pagamento: valor divergente não libera', async () => {
  const o = await pedido(), id = o.qr.replace('00020126FAKE', ''); await fetch(`${mpbase}/_amount/${id}/100`, { method: 'POST' }); await mpSet(id, 'approved');
  await webhook(id); assert.equal((await call('GET', '/api/pay/status?order=' + o.order, null, null, hdr(o))).j.status, 'pending');
});
test('pagamento: recusado marca falha e estorno bloqueia', async () => {
  const a = await pedido(), ia = a.qr.replace('00020126FAKE', ''); await mpSet(ia, 'rejected'); await webhook(ia);
  assert.equal((await call('GET', '/api/pay/status?order=' + a.order, null, null, hdr(a))).j.status, 'failed');
  const b = await pedido(), ib = b.qr.replace('00020126FAKE', ''); await mpSet(ib, 'approved'); await webhook(ib); await mpSet(ib, 'refunded'); await webhook(ib);
  assert.deepEqual((await call('GET', '/api/pay/status?order=' + b.order, null, null, hdr(b))).j, { status: 'refunded', uses_left: 0 });
});
test('pagamento: administrador vê vendas e faturamento', async () => {
  const adm = await entrar('admin@teste.com', false), s = (await call('GET', '/api/admin/stats', null, adm.ck)).j;
  assert.ok(s.vendas >= 2); assert.equal(s.faturamento_centavos % 1000, 0);
  const l = await call('GET', '/api/admin/orders', null, adm.ck); assert.equal(l.s, 200); assert.ok(l.j.length >= 5);
});

test('páginas legais e prévia do link', async () => {
  const p = await call('GET', '/privacidade'); assert.equal(p.s, 200); assert.match(p.t, /LGPD/); assert.match(p.t, /contato@teste.com/); assert.doesNotMatch(p.t, /<script>/);
  assert.equal((await call('GET', '/termos')).s, 200);
  fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
  const i = await call('GET', '/'); assert.equal(i.s, 200); assert.doesNotMatch(i.t, /%%BASE%%/); assert.match(i.t, /https:\/\/site.teste\/og.png/);
});

test('backup: só administrador baixa e o arquivo é um banco SQLite válido', async () => {
  const com = await entrar('comum@teste.com', false), adm = await entrar('admin@teste.com', false);
  assert.equal((await call('GET', '/api/admin/backup', null, com.ck)).s, 403);
  assert.equal((await call('GET', '/api/admin/backup')).s, 401);
  const b = await call('GET', '/api/admin/backup', null, adm.ck); assert.equal(b.s, 200); assert.ok(b.t.startsWith('SQLite format 3'));
  assert.ok(fs.readdirSync(path.join(path.dirname(process.env.DB_PATH), 'backups')).some(n => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(n)));
});
