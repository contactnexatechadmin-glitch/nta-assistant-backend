import express from 'express';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const conversations = new Map();
const MAX_HISTORY = 10;

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function askClaude(history) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'accept-encoding': 'identity',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system:
        "Tu es l'assistant WhatsApp de Boutique Adjoua Mode, une boutique de vêtements à Abidjan. " +
        "Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. " +
        "Garde le fil de la conversation en t'appuyant sur les échanges précédents.",
      messages: history,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API a répondu ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

app.get('/', (req, res) => {
  res.send('NTA Assistant backend en ligne ✅');
});

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;

  if (!incomingMsg || !from) {
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

  try {
    addToHistory(from, 'user', incomingMsg);
    const history = getHistory(from);

    const reply = await askClaude(history);

    addToHistory(from, 'assistant', reply);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
  } catch (err) {
    console.error('Erreur Claude API:', err.message);
    res.set('Content-Type', 'text/xml');
    res.send(
      '<Response><Message>Désolé, une erreur est survenue. Réessaie dans un instant.</Message></Response>'
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
