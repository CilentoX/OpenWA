/**
 * OpenWA Webhook Register Helper
 * Automatically detects API Key and endpoint settings to register the webhook URL.
 */

const fs = require('fs');
const path = require('path');

// Target webhook URL from CLI arguments
const webhookUrl = process.argv[2];

if (!webhookUrl) {
  console.error('\x1b[31m%s\x1b[0m', '❌ Error: Webhook URL is required.');
  console.log('\nUsage:');
  console.log('  node register.js <YOUR_TUNNEL_URL>/webhook');
  console.log('\nExample:');
  console.log('  node register.js https://short-cats-jump.loca.lt/webhook\n');
  process.exit(1);
}

// Configuration paths
const ENV_PATH = path.join(__dirname, '..', '.env');
const API_KEY_PATH = path.join(__dirname, '..', 'data', '.api-key');

let openwaUrl = 'https://openwa.qwertyatlas.online/api';
let apiKey = '';
let sessionId = 'main';

// 1. Try to read .env file
if (fs.existsSync(ENV_PATH)) {
  try {
    const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    const envLines = envContent.split('\n');
    
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      
      if (key === 'BASE_URL') {
        openwaUrl = val;
      } else if (key === 'API_MASTER_KEY' && val) {
        apiKey = val;
      }
    }
    console.log(`📝 Detected BASE_URL from .env: ${openwaUrl}`);
  } catch (err) {
    console.warn('⚠️ Could not read .env file, using defaults.', err.message);
  }
}

// 2. Try to read .api-key file (priority for auth)
if (fs.existsSync(API_KEY_PATH)) {
  try {
    apiKey = fs.readFileSync(API_KEY_PATH, 'utf-8').trim();
    console.log('🔑 Detected admin API key from data/.api-key');
  } catch (err) {
    console.warn('⚠️ Could not read data/.api-key file.', err.message);
  }
}

// Helper to make the API request
async function registerWebhook() {
  const url = `${openwaUrl.replace(/\/$/, '')}/sessions/${sessionId}/webhooks`;
  
  const body = JSON.stringify({
    url: webhookUrl,
    events: ['message.received'],
    retryCount: 3
  });

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'OpenWA-Register-Script/1.0.0'
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  console.log(`🔗 Connecting to: ${url}...`);
  console.log(`📡 Registering URL: ${webhookUrl}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body
    });

    const resData = await response.json();

    if (!response.ok) {
      console.error('\x1b[31m%s\x1b[0m', `❌ Registration Failed: HTTP ${response.status}`, resData);
      return;
    }

    console.log('\n\x1b[32m%s\x1b[0m', '✅ SUCCESS: Webhook registered successfully!');
    console.log('Webhook Details:', {
      id: resData.id,
      url: resData.url,
      events: resData.events,
      active: resData.active
    });
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', '❌ Error connecting to OpenWA:', error.message);
  }
}

registerWebhook();
