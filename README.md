# Currículo IA – servidor

Servidor sem dependências (só Node.js) que faz três coisas:

1. **Contas por código de e-mail** (sem senha): a pessoa digita o e-mail, recebe um código de 6 dígitos e entra.
2. **Guarda o currículo na conta**: o rascunho é salvo sozinho e volta em qualquer aparelho.
3. **Lista de contatos**: guarda o e-mail, a data do consentimento e se a pessoa aceitou receber novidades. Você baixa em CSV.

Também entrega o próprio site (`public/index.html`), então é um único serviço para publicar.

## Rodar no seu computador

Precisa do Node.js 22.9 ou mais novo (https://nodejs.org).

```
node server.js
```
Abra http://localhost:3000. Em modo de desenvolvimento **os códigos de login aparecem no terminal** (nenhum e-mail é enviado de verdade). Para rodar os testes automáticos: `node --test test.js`.

## Publicar

1. Hospedagem que rode Node 22.9+ **e tenha disco persistente** (o banco é o arquivo `data/app.db`). Exemplos: Railway, Render, Fly.io ou uma VPS. Confira o preço e se o plano inclui disco persistente.
2. Copie `.env.example` para `.env` (ou cadastre as variáveis no painel da hospedagem) e preencha:
   - `APP_SECRET`: texto aleatório longo (veja o comando no próprio arquivo).
   - `RESEND_API_KEY` e `MAIL_FROM`: veja abaixo.
   - `ADMIN_EMAILS`: seu e-mail, para baixar os contatos.
   - `DB_PATH`: caminho do disco persistente.
   - `TRUST_PROXY=1` se a hospedagem usar proxy (quase todas).
3. Comando de início: `node server.js` (com `NODE_ENV=production`).
4. Aponte o domínio e use HTTPS (as hospedagens costumam dar HTTPS automático).

## Publicar na Railway (passo a passo)

**Dá para publicar em etapas:** primeiro só com `APP_SECRET`, para o site entrar no ar; depois você liga o e-mail (Resend) e, por último, o pagamento (Mercado Pago).

1. **Conta:** crie a conta em railway.com e assine o plano Hobby (o plano gratuito é pequeno demais para um serviço comercial). Confira o preço atual na página deles.
2. **Código no GitHub:** crie um repositório **privado** e envie esta pasta (o `.gitignore` já impede o envio de `.env` e do banco). Alternativa sem GitHub: instale a CLI da Railway e rode `railway up` dentro da pasta.
3. **Projeto:** na Railway, *New Project → Deploy from GitHub repo* e escolha o repositório.
4. **Volume (obrigatório):** crie um *Volume*, conecte ao serviço e use o ponto de montagem `/data`. O servidor detecta o volume sozinho e grava o banco em `/data/app.db`. Sem volume, **os dados somem a cada nova publicação**. Ative os backups do volume no painel.
5. **Variáveis** (aba *Variables*): `RAILPACK_NODE_VERSION=22`, `APP_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `ADMIN_EMAILS`, `MP_ACCESS_TOKEN`, `TRUST_PROXY=1`, `PRICE_CENTS` e `BASE_URL`. Como o endereço ainda não existe, publique primeiro, copie o endereço gerado e então preencha `BASE_URL`.
6. **Endereço:** em *Settings → Networking*, gere o domínio `.up.railway.app` para testar e, depois, adicione o seu domínio próprio (a Railway mostra o registro DNS a criar). Atualize `BASE_URL` e o webhook do Mercado Pago para o endereço final.
7. **Teste antes de divulgar:** abra o site, crie uma conta (o código deve chegar por e-mail), salve um currículo, saia e entre de novo; depois um Pix de R$ 1,00 (`PRICE_CENTS=100`) e só então volte para `1000`.

Observações: o servidor só funciona com **uma instância** (SQLite em volume não aceita réplicas); na Railway ele já inicia em modo de produção e se recusa a subir sem `APP_SECRET`; sem `RESEND_API_KEY`/`MAIL_FROM` o login por e-mail fica desligado, e sem `MP_ACCESS_TOKEN` o pagamento fica desligado (o site mostra "Pagamento em breve" com o WhatsApp, e **nenhum PDF é liberado**); o arquivo `railway.json` já define o comando de início e a verificação de saúde (`/api/health`).

### E-mail (Resend)
Crie uma conta em https://resend.com, **verifique o seu domínio** (ele pede registros DNS SPF/DKIM; sem isso os e-mails caem no spam ou nem saem) e gere uma chave de API. Em produção o servidor se recusa a iniciar sem `RESEND_API_KEY` e `MAIL_FROM`.

## Pagamento por Pix (Mercado Pago)

Como funciona: o site pede ao servidor um Pix; o servidor cria o pagamento no Mercado Pago e devolve o QR code e o "copia e cola". O cliente paga, e o servidor **consulta o Mercado Pago** (pelo aviso automático e, se ele atrasar, pela própria tela do cliente) e só então libera o download. O servidor nunca confia no conteúdo do aviso: só vale o que o Mercado Pago responde à consulta, e o valor (R$ 10,00), a moeda e o pedido precisam bater. Cada pedido pago libera até 3 downloads do PDF. Estornos bloqueiam o pedido.

Configuração:
1. No painel de desenvolvedores do Mercado Pago, crie uma aplicação de pagamentos e copie o **Access Token** para `MP_ACCESS_TOKEN`.
2. Defina `BASE_URL` com o endereço público do site e, no painel do Mercado Pago (Webhooks), cadastre `BASE_URL/api/pay/webhook` para o evento de **Pagamentos**. Mesmo sem o aviso, a tela do cliente confirma o pagamento sozinha a cada poucos segundos.
3. **Teste antes de abrir ao público:** use `PRICE_CENTS=100` e faça um pagamento real de R$ 1,00 com a sua própria conta. O ambiente de testes do Mercado Pago tem limitações para Pix; confira na documentação deles.
4. Para testar sem cobrar nada: `node fake-mp.js` (um "Mercado Pago de mentira" na porta 4000) e inicie o servidor com `MP_API=http://localhost:4000 MP_ACCESS_TOKEN=x`. Para "pagar", envie `POST http://localhost:4000/_status/<número no final do código Pix>/approved`.

Vendas: logado como administrador, `/api/admin/stats` mostra vendas e faturamento, e `/api/admin/orders` lista os pedidos.

**Limite importante:** o PDF ainda é gerado no navegador do cliente. O servidor controla quando o botão aparece, o que impede o uso normal sem pagar, mas alguém que saiba mexer no código da página ainda consegue gerar o PDF sem passar pelo pagamento. A trava completa exige gerar o PDF no servidor depois da confirmação (e esse PDF teria texto selecionável). É o próximo passo recomendado.

## Lista de contatos
Logado com um e-mail de `ADMIN_EMAILS`, abra no navegador:
- `/api/admin/contacts.csv` → só quem aceitou receber novidades (use esta para divulgação).
- `/api/admin/contacts.csv?all=1` → todos os cadastros (uso operacional, não para propaganda).
- `/api/admin/stats` → totais.

## Segurança já implementada
Código de 6 dígitos guardado só como hash, vale 10 min, uso único e bloqueia após 5 erros; limite de pedidos por e-mail e por IP; sessão em cookie HttpOnly/SameSite com validade de 30 dias (guardada como hash); checagem de origem contra CSRF; limite de tamanho de requisição; cabeçalhos de segurança (CSP, HSTS em produção); CSV protegido contra injeção de fórmulas; exclusão de conta que apaga rascunho e sessões.

## LGPD (o que falta é seu)
O código registra consentimento e permite excluir a conta. Ainda é preciso: **escrever e publicar a política de privacidade** (ela precisa dizer quais dados são guardados, para quê, por quanto tempo e como pedir exclusão), definir prazo de retenção e indicar um contato responsável. Isto aqui não é assessoria jurídica: vale revisar com um profissional.

## O que NÃO está pronto ou NÃO foi testado
- **Envio real de e-mail pelo Resend**: o código está escrito, mas não foi testado com uma chave de verdade.
- **Publicação na hospedagem**: nada foi publicado.
- **Backup do banco**: copie o arquivo `app.db` periodicamente (com o servidor parado ou usando o backup do SQLite).
- **Pagamento real com o Mercado Pago**: o código foi testado contra um Mercado Pago simulado (`fake-mp.js`), baseado na documentação deles, mas **nunca contra o serviço de verdade**. Os nomes de campos da API podem exigir ajuste no primeiro teste real (use R$ 1,00).
- **PDF gerado no servidor, painel visual de pedidos e envio do PDF por e-mail**: ainda não existem.
- O recurso de IA do site usa a conta do Claude de quem visita; para todos os clientes ele precisa ser movido para este servidor, com chave da API da Anthropic guardada aqui.
