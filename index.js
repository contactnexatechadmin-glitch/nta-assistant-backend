import express from 'express';
import bodyParser from 'body-parser';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ----- Mémoire de conversation (en mémoire, par numéro de téléphone) -----
// Limite : cette mémoire est perdue si le serveur redémarre (tier gratuit Render
// s'endort après inactivité). Suffisant pour les tests, à améliorer avant
// l'arrivée d'un vrai client payant (stockage persistant).
const conversations = new Map();
const MAX_HISTORY = 10; // 5 derniers échanges (utilisateur + assistant)

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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system:
        "Tu es l'assistant WhatsApp de Boutique Adjoua Mode, une boutique de vêtements à Abidjan. " +
        "Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. " +
        "Garde le fil de la conversation en t'appuyant sur les échanges précédents.",
      messages: history,
    });

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    addToHistory(from, 'assistant', reply);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
  } catch (err) {
    console.error('Erreur Claude API:', err);
    res.set('Content-Type', 'text/xml');
    res.send(
      '<Response><Message>Désolé, une erreur est survenue. Réessaie dans un instant.</Message></Response>'
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
