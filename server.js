const fs = require('fs/promises');
const path = require('path');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3-32b';
const IS_GROQ_KEY = typeof API_KEY === 'string' && API_KEY.startsWith('gsk_');
const CHAT_ENDPOINT = IS_GROQ_KEY
  ? 'https://api.groq.com/openai/v1/chat/completions'
  : 'https://openrouter.ai/api/v1/chat/completions';
const CONTACT_STORE_PATH = path.join(__dirname, 'messages.json');

function sanitizeAssistantReply(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```[\s\S]*?```/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function saveContactMessage(payload) {
  let existing = [];
  try {
    const raw = await fs.readFile(CONTACT_STORE_PATH, 'utf8');
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  existing.push(payload);
  await fs.writeFile(CONTACT_STORE_PATH, JSON.stringify(existing, null, 2), 'utf8');
}

app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});
app.use(express.static(path.join(__dirname)));

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server is missing OPENROUTER_API_KEY (or GROQ_API_KEY).' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Request must include a non-empty messages array.' });
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    };
    if (!IS_GROQ_KEY) {
      headers['HTTP-Referer'] = process.env.PUBLIC_SITE_URL || `http://localhost:${PORT}`;
      headers['X-Title'] = 'Victor Portfolio';
    }

    const response = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Upstream provider request failed.'
      });
    }

    const rawReply = data?.choices?.[0]?.message?.content;
    const reply = sanitizeAssistantReply(rawReply);
    if (!reply) {
      return res.status(502).json({ error: 'Provider returned an empty response.' });
    }

    return res.json({ reply });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to reach chat provider.',
      detail: error.message
    });
  }
});

app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body || {};

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'Name, email, subject, and message are required.' });
  }

  const cleaned = {
    name: String(name).trim(),
    email: String(email).trim().toLowerCase(),
    subject: String(subject).trim(),
    message: String(message).trim()
  };

  if (!cleaned.name || !cleaned.email || !cleaned.subject || !cleaned.message) {
    return res.status(400).json({ error: 'All fields must be non-empty.' });
  }
  if (!isValidEmail(cleaned.email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (cleaned.message.length < 10) {
    return res.status(400).json({ error: 'Message should be at least 10 characters long.' });
  }

  try {
    await saveContactMessage({
      ...cleaned,
      createdAt: new Date().toISOString()
    });
    return res.status(201).json({ message: 'Message sent successfully. Victor will get back to you soon.' });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to save message.',
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
