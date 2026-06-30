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
const CRON_SECRET = process.env.CRON_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const MESSAGE_ACCES_COUPE =
  "Merci pour votre message 🙏 Notre service de réponse automatique est temporairement indisponible. Veuillez nous contacter directement.";

// Augmenté à 20 messages (suffisant pour tout échange en cours, économique en tokens)
const MAX_HISTORY = 20;

const URL_BACKEND = 'https://nta-assistant-backend.onrender.com';

const REGLE_FORMATAGE_WHATSAPP =
  "\n\nIMPORTANT - Format du texte : WhatsApp utilise UN SEUL astérisque pour le gras (*comme ceci*), jamais deux. N'utilise JAMAIS le format **comme ceci** (style Markdown classique), cela affiche des étoiles parasites et gêne la lecture. Pour l'italique, WhatsApp utilise un seul underscore (_comme ceci_).";

const REGLE_EMOTICONES =
  "\n\nIMPORTANT - Usage des émoticônes : N'utilise PAS d'émoticône de sourire/rire (😁😅😂🤣😄😃😀☺️😊😆ou similaire) à chaque phrase ou à chaque paragraphe. Tu n'es PAS obligé d'en mettre une dans chaque message — la plupart de tes messages n'en ont besoin d'aucune. Utilise au maximum UNE SEULE émoticône de ce type par message entier, et seulement quand elle apporte vraiment quelque chose. Privilégie les mots pour exprimer la sympathie plutôt que les émoticônes répétées. " +
  "Concernant les émoticônes représentant un produit ou objet concret (ex: 🚗 pour une voiture, 👠 pour des talons) : utilise-en UNIQUEMENT s'il existe un emoji qui représente FIDÈLEMENT et PRÉCISÉMENT l'objet exact dont tu parles. Ne JAMAIS utiliser un emoji approximatif ou 'proche' comme substitut (par exemple, ne mets PAS 👗 (robe) pour parler d'un pagne, d'un boubou ou d'un tissu — ces objets n'ont pas d'emoji dédié, donc dans ce cas n'utilise AUCUNE émoticône). En cas de doute sur l'exactitude d'un emoji, abstiens-toi plutôt que d'approximer. Comme pour les émoticônes d'émotion, tu n'es jamais obligé d'en mettre une — uniquement si elle est exacte ET utile.";

// ─── NORMALISATION DES NUMÉROS IVOIRIENS ──────────────────────────────────────
//
// Depuis le 31 janvier 2021, la Côte d'Ivoire est passée de 8 à 10 chiffres.
// Selon l'opérateur d'origine, il faut ajouter un préfixe fixe devant l'ancien
// numéro à 8 chiffres pour obtenir le nouveau numéro à 10 chiffres :
//   - Moov  → préfixe "01"
//   - MTN   → préfixe "05"
//   - Orange→ préfixe "07"
// Certains téléphones/opérateurs transmettent encore l'ancien format à Twilio.
// Cette fonction ramène TOUJOURS un numéro vers le même format canonique (10
// chiffres), pour qu'un même client ne soit jamais compté comme deux clients
// différents selon le format reçu ce jour-là.

const PREFIXES_MOOV = ['01', '02', '03', '40', '41', '42', '43', '50', '51', '52', '53', '70', '71', '72', '73'];
const PREFIXES_MTN = ['04', '05', '06', '44', '45', '46', '54', '55', '56', '64', '65', '66', '74', '75', '76', '84', '85', '86', '94', '95', '96'];
const PREFIXES_ORANGE = ['07', '08', '09', '47', '48', '49', '57', '58', '59', '67', '68', '69', '77', '78', '79', '87', '88', '89', '97', '98'];

function normaliserNumeroIvoirien(numeroBrut) {
  if (!numeroBrut) return numeroBrut;

  const aPrefixeWhatsapp = numeroBrut.startsWith('whatsapp:');
  let digits = numeroBrut.replace('whatsapp:', '').replace('+', '');

  // Retire le code pays 225 s'il est présent, pour travailler sur le numéro local
  if (digits.startsWith('225')) {
    digits = digits.slice(3);
  } else {
    // Numéro non-ivoirien (ex: numéro sandbox US +1...) : on ne touche à rien
    return numeroBrut;
  }

  let numeroLocalFinal = digits;

  if (digits.length === 8) {
    // Ancien format : on retrouve l'opérateur via les 2 premiers chiffres
    const prefixeAncien = digits.slice(0, 2);
    let prefixeNouveau = null;
    if (PREFIXES_MOOV.includes(prefixeAncien)) prefixeNouveau = '01';
    else if (PREFIXES_MTN.includes(prefixeAncien)) prefixeNouveau = '05';
    else if (PREFIXES_ORANGE.includes(prefixeAncien)) prefixeNouveau = '07';

    if (prefixeNouveau) {
      numeroLocalFinal = prefixeNouveau + digits;
    } else {
      console.warn(`Numéro ivoirien à 8 chiffres non reconnu (préfixe ${prefixeAncien}) : ${numeroBrut}`);
    }
  }
  // Si digits.length === 10, c'est déjà le nouveau format : rien à faire.
  // Tout autre cas (longueur inattendue) : on laisse tel quel, par sécurité.

  const resultat = `+225${numeroLocalFinal}`;
  return aPrefixeWhatsapp ? `whatsapp:${resultat}` : resultat;
}

// ─── PROFIL CLIENT ────────────────────────────────────────────────────────────

/**
 * Récupère le profil d'un client depuis Supabase.
 * La table `client_profiles` doit exister avec les colonnes :
 *   - whatsapp_number (text, primary key)
 *   - profile (jsonb)
 *   - updated_at (timestamptz)
 */
async function getClientProfile(whatsappNumber) {
  const { data, error } = await supabase
    .from('client_profiles')
    .select('profile')
    .eq('whatsapp_number', whatsappNumber)
    .maybeSingle();

  if (error) {
    console.error('Erreur lecture profil client:', error.message);
    return null;
  }
  return data ? data.profile : null;
}

/**
 * Sauvegarde ou met à jour le profil d'un client.
 * On fusionne avec l'existant pour ne jamais écraser des données déjà présentes.
 */
async function saveClientProfile(whatsappNumber, profileUpdate) {
  const existing = await getClientProfile(whatsappNumber);
  const merged = { ...(existing || {}), ...profileUpdate };

  const { error } = await supabase
    .from('client_profiles')
    .upsert({ whatsapp_number: whatsappNumber, profile: merged, updated_at: new Date().toISOString() });

  if (error) {
    console.error('Erreur sauvegarde profil client:', error.message);
  }
}

/**
 * Formate le profil en une ligne compacte pour injection dans le system prompt.
 * Ex : "Profil client — Nom: Aya | Prix Robe Bleue: 5000F | VIP: oui"
 * Coût : ~15-20 tokens. Négligeable.
 */
function formatProfileForPrompt(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';

  const parts = Object.entries(profile)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');

  return `\n\n[Profil client connu] ${parts}`;
}

/**
 * Demande à Claude d'extraire les infos importantes de la conversation
 * pour mettre à jour le profil client. Appel léger (max_tokens: 150).
 * Ne s'exécute que si la conversation contient des infos potentiellement utiles.
 */
async function extractAndUpdateProfile(whatsappNumber, history) {
  // On ne tente l'extraction que si l'historique est suffisant
  if (!history || history.length < 2) return;

  const transcript = history
    .map(m => `${m.role === 'user' ? 'Client' : 'Bot'}: ${m.content}`)
    .join('\n');

  const extractionPrompt = `Analyse cet échange WhatsApp entre un client et un bot de boutique.
Extrait UNIQUEMENT les informations factuelles importantes sur ce client spécifique : prénom, produits préférés, prix négociés, statut VIP, préférences de livraison, ou tout accord commercial.
Réponds UNIQUEMENT avec un objet JSON compact. Si aucune info utile, réponds avec {}.
Exemples valides :
{"nom":"Aya","prix_robe_bleue":"5000F","vip":"oui"}
{"nom":"Konan","livraison":"Cocody"}
{}

Échange :
${transcript}`;

  try {
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
      console.log(`Profil mis à jour pour ${whatsappNumber}:`, profileUpdate);
    }
  } catch (err) {
    // Extraction silencieuse — une erreur ici ne doit jamais bloquer la réponse principale
    console.error('Extraction profil échouée (non bloquant):', err.message);
  }
}

// ─── HISTORIQUE ───────────────────────────────────────────────────────────────

async function getHistoryFromSupabase(sessionId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY);

  if (error) {
    console.error('Erreur récupération historique Supabase:', error.message);
    return [];
  }
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

// ─── ACCÈS ────────────────────────────────────────────────────────────────────

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

// ─── UTILITAIRES ─────────────────────────────────────────────────────────────

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── SÉCURITÉ WEBHOOK ─────────────────────────────────────────────────────────

function verifierSignatureTwilio(req, res, next) {
  const signatureRecue = req.headers['x-twilio-signature'];
  const urlComplete = `${URL_BACKEND}${req.originalUrl}`;

  const estValide = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signatureRecue,
    urlComplete,
    req.body
  );

  if (!estValide) {
    console.log('⚠️ Requête webhook rejetée — signature Twilio invalide ou absente');
    return res.status(403).send('Accès refusé');
  }

  next();
}

// ─── CLAUDE ──────────────────────────────────────────────────────────────────

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
  return data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

async function askClaudeReporting(transcript) {
  // NOUVEAU : règle explicite pour ne pas confondre "demande de prix" et "intention d'achat confirmée"
  const systemPrompt =
    "Tu es l'assistant de gestion d'un commerçant ivoirien. Analyse ces conversations de la journée et fais un bilan STRICTEMENT en 3 phrases très simples, sans termes techniques : " +
    "1. Combien de clients ont écrit. " +
    "2. Qui a CONFIRMÉ vouloir acheter et quoi (donne le numéro du client) — UNIQUEMENT si le client a exprimé une intention claire de finaliser (ex: \"je le prends\", \"je commande\", \"envoyez les détails de livraison\", a donné une adresse ou confirmé un paiement). " +
    "IMPORTANT : un client qui a SEULEMENT demandé un prix, un stock, ou une information, SANS confirmer vouloir acheter, n'est PAS un client prêt à acheter — dis plutôt qu'il \"s'est renseigné sur le prix\" ou \"a montré de l'intérêt sans confirmer\", ne dis jamais qu'il est \"prêt à commander\" dans ce cas. " +
    "Si aucun client n'a confirmé d'achat, dis-le clairement plutôt que d'exagérer une simple demande de prix. " +
    "3. Le produit le plus demandé." +
    REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;

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

// ─── BILAN QUOTIDIEN ──────────────────────────────────────────────────────────

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
      return { envoye: false, raison: "Aucun message aujourd'hui" };
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

cron.schedule('0 18 * * *', () => {
  envoyerBilanQuotidien();
});

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────

const SYSTEM_WHATSAPP_BASE =
  "Tu es l'assistant WhatsApp de Boutique Adjoua Mode, une boutique de vêtements à Abidjan. Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. Garde le fil de la conversation en t'appuyant sur les échanges précédents." + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;

const SYSTEM_DEMO =
  "Tu es l'assistante virtuelle de la Boutique Adjoua Mode, une boutique de vêtements féminins tendance située à Cocody, Abidjan, Côte d'Ivoire...\n[Règles de vouvoiement, tarifs de 5000 à 85000 FCFA, livraisons 2-4h]" + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('NTA Assistant backend en ligne ✅');
});

app.get('/trigger-report', async (req, res) => {
  const secretFourni = req.query.secret || req.headers['x-cron-secret'];
  if (!CRON_SECRET || secretFourni !== CRON_SECRET) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const resultat = await envoyerBilanQuotidien();
  res.json(resultat);
});

app.post('/webhook', verifierSignatureTwilio, async (req, res) => {
  const incomingMsg = req.body.Body;
  // NOUVEAU : normalisation du numéro dès la réception, avant tout usage
  const from = normaliserNumeroIvoirien(req.body.From);

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

    // Sauvegarde du message entrant
    await saveMessageToSupabase(from, 'user', incomingMsg);

    // Récupération parallèle : historique + profil client
    const [history, profile] = await Promise.all([
      getHistoryFromSupabase(from),
      getClientProfile(from),
    ]);

    // Injection du profil dans le system prompt (coût négligeable ~15 tokens)
    const profileLine = formatProfileForPrompt(profile);
    const systemPrompt = SYSTEM_WHATSAPP_BASE + profileLine;

    // Réponse principale
    const reply = await askClaude(history, systemPrompt);
    await saveMessageToSupabase(from, 'assistant', reply);

    // Extraction et mise à jour du profil en arrière-plan (non bloquant)
    // On passe l'historique complet + le nouveau message pour une meilleure extraction
    const historyForExtraction = [...history, { role: 'assistant', content: reply }];
    extractAndUpdateProfile(from, historyForExtraction).catch(() => {});

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

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
