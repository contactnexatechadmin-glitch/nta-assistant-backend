import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NUMERO_PATRON = process.env.NUMERO_PATRON;
const CRON_SECRET = process.env.CRON_SECRET;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const MESSAGE_ACCES_COUPE =
  "Merci pour votre message 🙏 Notre service de réponse automatique est temporairement indisponible. Veuillez nous contacter directement.";

const MAX_HISTORY = 20;

const REGLE_FORMATAGE_WHATSAPP =
  "\n\nIMPORTANT - Format du texte : WhatsApp utilise UN SEUL astérisque pour le gras (*comme ceci*), jamais deux. N'utilise JAMAIS le format **comme ceci** (style Markdown classique), cela affiche des étoiles parasites et gne la lecture. Pour l'italique, WhatsApp utilise un seul underscore (_comme ceci_).";

const REGLE_EMOTICONES =
  "\n\nIMPORTANT - Usage des émoticônes : N'utilise PAS d'émoticône de sourire/rire (ou similaire) à chaque phrase ou à chaque paragraphe. Tu n'es pas obligé d'en mettre une dans chaque message. Utilise au maximum UNE SEULE émoticône de ce type par message entier, et seulement quand elle apporte vraiment quelque chose. Privilégie les mots pour exprimer la sympathie plutôt que les émoticônes répétées. En revanche, les émoticônes qui illustrent un produit ou un objet concret (vêtements, accessoires, etc., comme 👗 👔 👠 🛍️) restent libres et ne sont pas concernées par cette limite.";

const PREFIXES_MOOV = ['01', '02', '03', '40', '41', '42', '43', '50', '51', '52', '53', '70', '71', '72', '73'];
const PREFIXES_MTN = ['04', '05', '06', '44', '45', '46', '54', '55', '56', '64', '65', '66', '74', '75', '76', '84', '85', '86', '94', '95', '96'];
const PREFIXES_ORANGE = ['07', '08', '09', '47', '48', '49', '57', '58', '59', '67', '68', '69', '77', '78', '79', '87', '88', '89', '97', '98'];

function normaliserNumeroIvoirien(numeroBrut) {
  if (!numeroBrut) return numeroBrut;
  let digits = numeroBrut.replace('whatsapp:', '').replace('+', '').trim();

  if (digits.startsWith('1555')) {
    return `+${digits}`;
  }

  if (digits.startsWith('225')) {
    digits = digits.slice(3);
  } else {
    return `+${digits}`;
  }

  let numeroLocalFinal = digits;

  if (digits.length === 8) {
    const prefixeAncien = digits.slice(0, 2);
    let prefixeNouveau = null;
    if (PREFIXES_MOOV.includes(prefixeAncien)) prefixeNouveau = '01';
    else if (PREFIXES_MTN.includes(prefixeAncien)) prefixeNouveau = '05';
    else if (PREFIXES_ORANGE.includes(prefixeAncien)) prefixeNouveau = '07';

    if (prefixeNouveau) {
      numeroLocalFinal = prefixeNouveau + digits;
    }
  }

  return `+225${numeroLocalFinal}`;
}

function versFormatMeta(numero) {
  // On extrait STRICTEMENT les chiffres pour Meta
  return numero.replace('whatsapp:', '').replace('+', '').trim();
}

async function getClientProfile(whatsappNumber) {
  const { data, error } = await supabase
    .from('client_profiles')
    .select('profile')
    .eq('whatsapp_number', whatsappNumber)
    .maybeSingle();
  if (error) return null;
  return data ? data.profile : null;
}

async function saveClientProfile(whatsappNumber, profileUpdate) {
  const existing = await getClientProfile(whatsappNumber);
  const merged = { ...(existing || {}), ...profileUpdate };
  await supabase
    .from('client_profiles')
    .upsert({ whatsapp_number: whatsappNumber, profile: merged, updated_at: new Date().toISOString() });
}

function formatProfileForPrompt(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';
  return '\n\n[Profil client connu] ' + Object.entries(profile).map(([k, v]) => `${k}: ${v}`).join(' | ');
}

async function extractAndUpdateProfile(whatsappNumber, history) {
  if (!history || history.length < 2) return;
  const transcript = history.map(m => `${m.role === 'user' ? 'Client' : 'Bot'}: ${m.content}`).join('\n');
  const extractionPrompt = `Analyse cet échange WhatsApp. Extrait en JSON compact les infos : prénom, produits préférés, prix. Échange :\n${transcript}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        messages: [{ role: 'user', content: extractionPrompt }],
      }),
    });
    if (!response.ok) return;
    const data = await response.json();
    const raw = data.content?.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!raw || raw === '{}') return;
    const profileUpdate = JSON.parse(raw);
    if (Object.keys(profileUpdate).length > 0) {
      await saveClientProfile(whatsappNumber, profileUpdate);
    }
  } catch (err) {}
}

async function getHistoryFromSupabase(sessionId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY);
  if (error) return [];
  return (data || []).reverse();
}

async function getTodayMessages() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('conversations')
    .select('session_id, role, content')
    .gte('created_at', today.toISOString())
    .order('created_at', { ascending: true });
  if (error) return [];
  return data || [];
}

async function saveMessageToSupabase(sessionId, role, content) {
  await supabase.from('conversations').insert([{ session_id: sessionId, role, content }]);
}

async function estSuspendu(whatsappNumber) {
  const { data, error } = await supabase
    .from('clients')
    .select('suspended')
    .eq('whatsapp_number', whatsappNumber)
    .maybeSingle();
  if (error || !data) return false;
  return data.suspended === true;
}

function verifierSignatureMeta(req, res, next) {
  if (!META_APP_SECRET) return next();
  const signatureRecue = req.headers['x-hub-signature-256'];
  if (!signatureRecue) return res.sendStatus(403);
  const signatureAttendue = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  if (signatureRecue !== signatureAttendue) return res.sendStatus(403);
  next();
}

// CORRECTION STRUCTURELLE DE L'ENVOI POUR LA SANDBOX
async function sendWhatsAppMessage(to, text) {
  let toMeta = versFormatMeta(to);
  
  // Si le numéro commence par 225 et échoue, la Sandbox attend peut-être le format local sans 225
  // Pour parer à toute éventualité en Semaine 1, on nettoie drastiquement
  if (toMeta.startsWith('2250758015720')) {
    toMeta = '2250758015720'; // Format international strict sans espace ni parasite
  }

  const response = await fetch(`https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toMeta,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Erreur envoi message Meta:', response.status, errText);
    throw new Error(`Meta API a répondu ${response.status}: ${errText}`);
  }

  return response.json();
}

async function askClaude(history, systemPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: history,
    }),
  });
  if (!response.ok) throw new Error('Erreur Claude API');
  const data = await response.json();
  return data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

async function askClaudeReporting(transcript) {
  const systemPrompt = "Tu es l'assistant de gestion d'un commerçant ivoirien..." + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Voici les échanges du jour :\n${transcript}` }],
    }),
  });
  if (!response.ok) throw new Error('Erreur API Reporting');
  const data = await response.json();
  return data.content[0].text;
}

async function envoyerBilanQuotidien() {
  if (!NUMERO_PATRON || !META_PHONE_NUMBER_ID) return { envoye: false };
  try {
    const messagesJour = await getTodayMessages();
    if (messagesJour.length === 0) return { envoye: false };
    const transcript = messagesJour.map((m) => `${m.role === 'user' ? 'Client ' + m.session_id : 'Bot'} : ${m.content}`).join('\n');
    const bilan = await askClaudeReporting(transcript);
    await sendWhatsAppMessage(NUMERO_PATRON, `📊 *BILAN DE LA JOURNÉE*\n\n${bilan}`);
    return { envoye: true };
  } catch (err) {
    return { envoye: false, raison: err.message };
  }
}

cron.schedule('0 18 * * *', () => { envoyerBilanQuotidien(); });

const SYSTEM_WHATSAPP_BASE = "Tu es l'assistant WhatsApp de Boutique Adjoua Mode..." + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;
const SYSTEM_DEMO = "Tu es l'assistante virtuelle de la Boutique Adjoua Mode..." + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;

app.get('/', (req, res) => { res.send('NTA Assistant backend en ligne ✅'); });

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.get('/trigger-report', async (req, res) => {
  const secretFourni = req.query.secret || req.headers['x-cron-secret'];
  if (!CRON_SECRET || secretFourni !== CRON_SECRET) return res.status(403).json({ error: 'Accès refusé' });
  const resultat = await envoyerBilanQuotidien();
  res.json(resultat);
});

app.post('/webhook', verifierSignatureMeta, async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const incomingMsg = message.text?.body;
    const from = normaliserNumeroIvoirien(message.from);

    if (!incomingMsg || !from) return;

    const suspendu = await estSuspendu(from);
    if (suspendu) {
      await sendWhatsAppMessage(from, MESSAGE_ACCES_COUPE);
      return;
    }

    await saveMessageToSupabase(from, 'user', incomingMsg);

    const [history, profile] = await Promise.all([
      getHistoryFromSupabase(from),
      getClientProfile(from),
    ]);

    const profileLine = formatProfileForPrompt(profile);
    const systemPrompt = SYSTEM_WHATSAPP_BASE + profileLine;

    const reply = await askClaude(history, systemPrompt);
    await saveMessageToSupabase(from, 'assistant', reply);

    const historyForExtraction = [...history, { role: 'assistant', content: reply }];
    extractAndUpdateProfile(from, historyForExtraction).catch(() => {});

    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error('Erreur traitement webhook Meta:', err.message);
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
