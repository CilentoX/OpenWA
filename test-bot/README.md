# 🤖 OpenWA Test Bot

Este é um mini-bot simples para demonstrar e testar o funcionamento do **OpenWA Gateway API**. Ele foi construído em Node.js puro e **não possui nenhuma dependência** (zero dependencies).

Ele escuta eventos de novas mensagens recebidas (`message.received`) e responde automaticamente se a mensagem for algum comando configurado.

---

## 🚀 Como Executar

### 1. Iniciar o Servidor do Bot
Abra um terminal na pasta `test-bot` e execute o servidor:
```bash
node bot.js
```
O servidor iniciará localmente na porta `3000`.

### 2. Expor o Bot para a Internet (Tunnel)
Como o OpenWA está rodando no seu servidor Coolify, ele precisa de uma URL pública para enviar as notificações de mensagens. Você pode usar o **localtunnel** ou **ngrok** para expor a porta `3000` do seu computador local:
```bash
npx localtunnel --port 3000
```
Isso gerará uma URL semelhante a: `https://short-cats-jump.loca.lt`.

### 3. Registrar o Webhook no OpenWA
Com o túnel aberto, use o script de registro informando a sua URL pública seguida de `/webhook`:
```bash
node register.js https://sua-url-gerada.loca.lt/webhook
```
*(O script detecta automaticamente a chave de API e URL do OpenWA com base no seu arquivo `.env` e chaves geradas)*

---

## 💬 Comandos Disponíveis

Envie qualquer um destes comandos no WhatsApp da sessão conectada para testar:

*   `!help` - Exibe a ajuda com todos os comandos
*   `!menu` - Exibe um menu interativo simples
*   `!ping` - Responde com `pong! 🏓`
*   `!hora` - Informa a hora atual do servidor
*   `!docs` - Link da documentação Swagger
