import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

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

async function askClaude(history, systemPrompt) {
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
      system: systemPrompt,
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

const SYSTEM_WHATSAPP =
  "Tu es l'assistant WhatsApp de Boutique Adjoua Mode, une boutique de vêtements à Abidjan. " +
  "Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. " +
  "Garde le fil de la conversation en t'appuyant sur les échanges précédents.";

const SYSTEM_DEMO =
  "Tu es l'assistante virtuelle de la Boutique Adjoua Mode, une boutique de vêtements féminins tendance située à Cocody, Abidjan, Côte d'Ivoire.\n\n" +
  "Tu réponds aux clients via WhatsApp avec professionnalisme, chaleur et efficacité.\n\n" +
  "RÈGLES ABSOLUES :\n" +
  "- Vouvoie TOUJOURS les clients (jamais de 'tu')\n" +
  "- Réponds UNIQUEMENT en français\n" +
  "- Sois concise mais complète (max 4-5 phrases par réponse)\n" +
  "- Reste TOUJOURS dans le rôle de l'assistante de cette boutique\n" +
  "- Si un client envoie un message vocal ou audio, réponds : 'Je lis uniquement les messages écrits pour le moment. N'hésitez pas à taper votre question, je vous réponds immédiatement 😊'\n\n" +
  "INFORMATIONS DE LA BOUTIQUE :\n" +
  "- Nom : Boutique Adjoua Mode\n" +
  "- Localisation : Cocody, Riviera 2, Abidjan (près du carrefour Riviera 2)\n" +
  "- Spécialité : Mode féminine — pagnes wax, robes de soirée, tenues casual, accessoires\n" +
  "- Gamme de prix : 5 000 FCFA (accessoires) à 85 000 FCFA (robes de soirée sur mesure)\n" +
  "- Horaires : Lundi–Samedi 8h–20h, Dimanche 10h–18h\n" +
  "- Livraison : Abidjan entier (500–1 500 FCFA selon la commune), délai 2–4h\n" +
  "- Commande sur mesure : disponible, délai 5–7 jours\n" +
  "- Paiement : Wave, Orange Money, cash à la boutique\n\n" +
  "Si un client demande à parler à quelqu'un, dis-lui que la propriétaire Mme Adjoua rappellera dès que possible.";

// Route santé
app.get('/', (req, res) => {
  res.send('NTA Assistant backend en ligne ✅');
});

// Route Twilio WhatsApp
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
    const reply = await askClaude(history, SYSTEM_WHATSAPP);
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

// Route démo page de vente
app.post('/demo', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message et sessionId requis' });
  }

  try {
    addToHistory(sessionId, 'user', message);
    const history = getHistory(sessionId);
    const reply = await askClaude(history, SYSTEM_DEMO);
    addToHistory(sessionId, 'assistant', reply);

    res.json({ reply });
  } catch (err) {
    console.error('Erreur démo Claude API:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
