import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const MESSAGE_ACCES_COUPE =
  "Merci pour votre message 🙏 Notre service de réponse automatique est temporairement indisponible. Veuillez nous contacter directement.";

const MAX_HISTORY = 10;

async function getHistoryFromSupabase(sessionId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(MAX_HISTORY);

  if (error) {
    console.error('Erreur récupération historique Supabase:', error.message);
    return []; 
  }
  return data || [];
}

async function saveMessageToSupabase(sessionId, role, content) {
  const { error } = await supabase
    .from('conversations')
    .insert([{ session_id: sessionId, role, content }]);

  if (error) {
    console.error('Erreur sauvegarde message Supabase:', error.message);
  }
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      model: 'claude-3-5-sonnet-20241022',
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
  return data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

async function askClaudeReporting(history) {
  const systemPrompt = "Tu es l'assistant de gestion d'un commerçant ivoirien. Analyse l'historique des messages de la journée et fais un bilan STRICTEMENT en 3 phrases très simples, sans termes techniques complexes : 1. Combien de clients ont écrit. 2. Qui veut acheter immédiatement et quoi. 3. Le produit le plus demandé.";
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 300,
      system: systemPrompt,
      messages: history,
    }),
  });

  if (!response.ok) throw new Error('Erreur API Reporting');
  const data = await response.json();
  return data.content[0].text;
}

async function estSuspendu(whatsappNumber) {
  const { data, error } = await supabase
    .from('clients')
    .select('suspended')
    .eq('whatsapp_number', whatsappNumber)
    .maybeSingle();

  if (error) {
    console.error('Erreur lecture statut Supabase:', error.message);
    return false; 
  }
  if (!data) return false; 
  return data.suspended === true;
}

const SYSTEM_WHATSAPP =
  "Tu es l'assistant WhatsApp de Boutique Adjoua Mode, une boutique de vêtements à Abidjan. Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. Garde le fil de la conversation en t'appuyant sur les échanges précédents.";

const SYSTEM_DEMO =
  "Tu es l'assistante virtuelle de la Boutique Adjoua Mode, une boutique de vêtements féminins tendance située à Cocody, Abidjan, Côte d'Ivoire...\n[Règles de vouvoiement, tarifs de 5000 à 85000 FCFA, livraisons 2-4h]";

app.get('/', (req, res) => { res.send('NTA Assistant backend en ligne ✅'); });

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;
  if (!incomingMsg || !from) { res.set('Content-Type', 'text/xml'); return res.send('<Response></Response>'); }

  try {
    const suspendu = await estSuspendu(from);
    if (suspendu) {
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response><Message>${escapeXml(MESSAGE_ACCES_COUPE)}</Message></Response>`);
    }

    await saveMessageToSupabase(from, 'user', incomingMsg);
    const history = await getHistoryFromSupabase(from);
    const reply = await askClaude(history, SYSTEM_WHATSAPP);
    await saveMessageToSupabase(from, 'assistant', reply);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
  } catch (err) {
    console.error('Erreur Claude API:', err.message);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>Désolé, une erreur est survenue.</Message></Response>');
  }
});

app.post('/demo', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: 'message et sessionId requis' });
  try {
    await saveMessageToSupabase(sessionId, 'user', message);
    const history = await getHistoryFromSupabase(sessionId);
    const reply = await askClaude(history, SYSTEM_DEMO);
    await saveMessageToSupabase(sessionId, 'assistant', reply);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/bilan/:numero', async (req, res) => {
  const { numero } = req.params;
  try {
    const history = await getHistoryFromSupabase(numero);
    if (history.length === 0) {
      return res.send('Aucun message enregistré pour ce commerçant aujourd\'hui.');
    }
    const resume = await askClaudeReporting(history);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(`--- BILAN EXPRESS NTA ---\n\n${resume}`);
  } catch (err) {
    console.error('Erreur Bilan:', err.message);
    res.status(500).send('Erreur lors de la génération du bilan.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
