'use strict';
// "Mercado Pago de mentira" para testar sem cobrar nada. Uso: node fake-mp.js  (porta 4000)
// No servidor use MP_API=http://localhost:4000 e MP_ACCESS_TOKEN=qualquer-coisa.
// Para "pagar": POST http://localhost:4000/_status/<id-do-pagamento>/approved
const http = require('node:http');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function start(port = 4000) {
  let n = 1000; const pays = new Map();
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); let b = ''; for await (const c of req) b += c;
    const out = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && u.pathname === '/v1/payments') {
      const j = JSON.parse(b), id = ++n;
      const p = { id, status: 'pending', currency_id: 'BRL', transaction_amount: j.transaction_amount, external_reference: j.external_reference, point_of_interaction: { transaction_data: { qr_code: '00020126FAKE' + id, qr_code_base64: PNG } } };
      pays.set(String(id), p); return out(201, p);
    }
    let m = u.pathname.match(/^\/v1\/payments\/(\d+)$/);
    if (req.method === 'GET' && m) { const p = pays.get(m[1]); return p ? out(200, p) : out(404, { message: 'not found' }); }
    m = u.pathname.match(/^\/_status\/(\d+)\/(\w+)$/);
    if (req.method === 'POST' && m && pays.has(m[1])) { pays.get(m[1]).status = m[2]; return out(200, { ok: true }); }
    if (req.method === 'POST' && (m = u.pathname.match(/^\/_amount\/(\d+)\/(\d+)$/)) && pays.has(m[1])) { pays.get(m[1]).transaction_amount = +m[2] / 100; return out(200, { ok: true }); }
    out(404, {});
  });
  return new Promise(ok => srv.listen(port, () => ok(srv)));
}
module.exports = { start };
if (require.main === module) start(+process.env.PORT || 4000).then(s => console.log('Mercado Pago de mentira em http://localhost:' + s.address().port));
