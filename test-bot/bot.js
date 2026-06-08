/**
 * OpenWA Mini Test Bot
 * Zero-dependency simple bot that listens to webhooks and replies to commands.
 */

const http = require('http');

// Configuration (can be overridden by environment variables)
const PORT = process.env.PORT || 3000;
const OPENWA_API_URL = process.env.OPENWA_API_URL || 'https://openwa.qwertyatlas.online/api';
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || 'owa_k1_77c8743ee86bce30cc120adda74ade9dc84ac66af407cd94316aafeac83790ae';
const SESSION_ID = process.env.SESSION_ID || 'main'; // Adjust this to your active session ID

if (!OPENWA_API_KEY) {
  console.warn('\x1b[33m%s\x1b[0m', '⚠️ WARNING: OPENWA_API_KEY environment variable is not set!');
  console.warn('\x1b[33m%s\x1b[0m', 'Commands reply will fail if your OpenWA instance requires authorization.');
}

// Predefined replies mapping
const COMMANDS = {
  '!ping': 'pong! 🏓',
  '!help': 'Olá! Sou o OpenWA Test Bot. Aqui estão os comandos disponíveis:\n\n' +
          '📌 *!menu* - Exibe o menu principal\n' +
          '📌 *!ping* - Teste de latência\n' +
          '📌 *!hora* - Exibe a hora do servidor\n' +
          '📌 *!docs* - Link para a documentação da API',
  '!docs': '📚 Acesse a documentação completa da API em:\nhttps://api-openwa.qwertyatlas.online/api/docs',
  '!menu': '📋 *MENU PRINCIPAL*\n\n' +
           '1️⃣ Informações da Conta\n' +
           '2️⃣ Testar Envio de Mídia\n' +
           '3️⃣ Status do Servidor\n\n' +
           'Envie *!help* para ver a lista de comandos de texto.',
  '1': '👤 *Informações da Conta*:\nEste bot está integrado usando a API Gateway do OpenWA.',
  '2': '📷 Para testar o envio de mídias, você pode usar os endpoints de imagem, áudio ou figurinhas na documentação!',
  '3': '⚡ *Status*: Servidor do bot online e ativo na porta ' + PORT + '.'
};

// Helper function to send a message via OpenWA API
async function sendTextMessage(chatId, text) {
  const url = `${OPENWA_API_URL.replace(/\/$/, '')}/sessions/${SESSION_ID}/messages/send-text`;
  
  const body = JSON.stringify({
    chatId,
    text
  });

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'OpenWA-Test-Bot/1.0.0'
  };

  if (OPENWA_API_KEY) {
    headers['X-API-Key'] = OPENWA_API_KEY;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body
    });

    const resData = await response.json();

    if (!response.ok) {
      console.error(`❌ Failed to send message to ${chatId}: HTTP ${response.status}`, resData);
      return false;
    }

    console.log(`📤 Reply sent successfully to ${chatId}: "${text.replace(/\n/g, ' ')}"`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending message to ${chatId}:`, error.message);
    return false;
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  // Only accept POST requests on /webhook
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        
        // Log event received
        console.log(`📥 Webhook Event received: "${payload.event}"`);

        // Handle message.received event
        if (payload.event === 'message.received' && payload.data) {
          const msg = payload.data;
          
          // Ignore messages sent by ourselves to prevent loop!
          if (msg.fromMe) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ignored_from_me' }));
            return;
          }

          const chatId = msg.from; // Sender JID (e.g. 5511999999999@c.us)
          const text = (msg.body || '').trim();

          console.log(`💬 Message from ${chatId}: "${text}"`);

          // Check if it matches a predefined command
          let replyText = null;

          if (COMMANDS[text]) {
            replyText = COMMANDS[text];
          } else if (text === '!hora') {
            replyText = `🕒 Server Time: ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (BRT)`;
          }

          // If we have a reply, send it!
          if (replyText) {
            await sendTextMessage(chatId, replyText);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success' }));
      } catch (err) {
        console.error('❌ Error parsing webhook payload:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    // Basic root page with instructions
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <head>
          <title>OpenWA Test Bot</title>
          <style>
            body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; line-height: 1.6; background: #fafafa; color: #333; }
            h1 { color: #25D366; }
            pre { background: #eee; padding: 10px; border-radius: 4px; overflow-x: auto; }
            .status { display: inline-block; padding: 4px 8px; border-radius: 4px; background: #25D366; color: white; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>🟢 OpenWA Test Bot</h1>
          <p>O servidor do bot está ativo e rodando! <span class="status">ONLINE</span></p>
          <hr>
          <h3>Como expor e testar:</h3>
          <p>Para o servidor do OpenWA conseguir enviar webhooks para este bot rodando localmente, você deve expor a porta <code>${PORT}</code> usando uma ferramenta como <strong>localtunnel</strong>:</p>
          <pre>npx localtunnel --port ${PORT}</pre>
          <p>Copie a URL gerada e registre-a no OpenWA como um webhook.</p>
        </body>
      </html>
    `);
  }
});

server.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🟢 OpenWA Test Bot is running at http://localhost:${PORT}`);
  console.log(`📡 OpenWA Endpoint: ${OPENWA_API_URL}`);
  console.log(`🤖 Target Session: ${SESSION_ID}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Instructions:');
  console.log(`1. Expose this port: 'npx localtunnel --port ${PORT}'`);
  console.log('2. Register the resulting URL as a webhook in OpenWA.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
