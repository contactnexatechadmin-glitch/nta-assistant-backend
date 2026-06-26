import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import twilio from 'twilio';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const NUMERO_PATRON = process.env.NUMERO_PATRON;
const CRON_SECRET = process.env.CRON_SECRET; // NOUVEAU : clé secrète pour protéger la route de déclenchement

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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

async function getTodayMessages() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('conversations')
    .select('session_id, role, content')
    .gte('created_at', today.toISOString())
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Erreur récupération messages du jour:', error.message);
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
      model: 'claude-sonnet-4-6', // CORRIGÉ : ancien modèle (claude-3-5-sonnet-20241022) retiré depuis le 19 février 2026
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

async function askClaudeReporting(transcript) {
  const systemPrompt = "Tu es l'assistant de gestion d'un commerçant ivoirien. Analyse ces conversations de la journée et fais un bilan STRICTEMENT en 3 phrases très simples, sans termes techniques : 1. Combien de clients ont écrit. 2. Qui veut acheter immédiatement et quoi (donne le numéro du client). 3. Le produit le plus demandé.";

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', // CORRIGÉ : même remplacement
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Voici les échanges du jour :\n${transcript}` }],
    }),
  });

  if (!response.ok) throw new Error('Erreur API Reporting');
  const data = await response.json();
  return data.content[0].text;
}

// NOUVEAU : la logique du bilan est extraite dans une fonction réutilisable,
// appelée à la fois par le cron interne ET par la route /trigger-report
async function envoyerBilanQuotidien() {
  console.log('--- Déclenchement du bilan ---');
  if (!NUMERO_PATRON || !TWILIO_WHATSAPP_NUMBER) {
    console.log('Annulé : NUMERO_PATRON ou TWILIO_WHATSAPP_NUMBER manquant.');
    return { envoye: false, raison: 'Configuration manquante' };
  }
  try {
    const messagesJour = await getTodayMessages();
    if (messagesJour.length === 0) {
      console.log("Aucun message aujourd'hui. Pas de bilan envoyé.");
      return { envoye: false, raison: 'Aucun message aujourd\'hui' };
    }

    const transcript = messagesJour
      .map((m) => `${m.role === 'user' ? 'Client ' + m.session_id : 'Bot'} : ${m.content}`)
      .join('\n');
    const bilan = await askClaudeReporting(transcript);

    await twilioClient.messages.create({
      from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${NUMERO_PATRON}`,
      body: `📊 *BILAN DE LA JOURNÉE*\n\n${bilan}`,
    });
    console.log('Bilan envoyé avec succès sur WhatsApp !');
    return { envoye: true };
  } catch (err) {
    console.error("Erreur lors de l'envoi du bilan :", err.message);
    return { envoye: false, raison: err.message };
  }
}

// Garde-fou interne : reste actif comme filet de sécurité, mais le déclenchement
// fiable se fait désormais via la route /trigger-report appelée par cron-job.org
cron.schedule('0 18 * * *', () => {
  envoyerBilanQuotidien();
});

const SYSTEM_WHATSAPP =
  "Tu es l'assistant WhatsApp de Boutique Adjoua Mode, une boutique de vêtements à Abidjan. Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. Garde le fil de la conversation en t'appuyant sur les échanges précédents.";

const SYSTEM_DEMO =
  "Tu es l'assistante virtuelle de la Boutique Adjoua Mode, une boutique de vêtements féminins tendance située à Cocody, Abidjan, Côte d'Ivoire...\n[Règles de vouvoiement, tarifs de 5000 à 85000 FCFA, livraisons 2-4h]";

app.get('/', (req, res) => {
  res.send('NTA Assistant backend en ligne ✅');
});

// NOUVEAU : route protégée, appelée par cron-job.org à 18h00 chaque jour
app.get('/trigger-report', async (req, res) => {
  const secretFourni = req.query.secret || req.headers['x-cron-secret'];
  if (!CRON_SECRET || secretFourni !== CRON_SECRET) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const resultat = await envoyerBilanQuotidien();
  res.json(resultat);
});

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;
  if (!incomingMsg || !from) {
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
