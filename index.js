import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const app = express();

// verify() capture le corps brut de la requête, nécessaire pour valider la
// signature HMAC de Meta (X-Hub-Signature-256) une fois META_APP_SECRET configuré.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET; // optionnel pour l'instant, à activer avant la prod réelle

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const MESSAGE_ACCES_COUPE =
  "Merci pour votre message 🙏 Notre service de réponse automatique est temporairement indisponible. Veuillez nous contacter directement.";

// Augmenté à 20 messages (suffisant pour tout échange en cours, économique en tokens)
const MAX_HISTORY = 20;

const REGLE_FORMATAGE_WHATSAPP =
  "\n\nIMPORTANT - Format du texte : WhatsApp utilise UN SEUL astérisque pour le gras (*comme ceci*), jamais deux. N'utilise JAMAIS le format **comme ceci** (style Markdown classique), cela affiche des étoiles parasites et gêne la lecture. Pour l'italique, WhatsApp utilise un seul underscore (_comme ceci_).";

const REGLE_EMOTICONES =
  "\n\nIMPORTANT - Usage des émoticônes : N'utilise PAS d'émoticône de sourire/rire (😁😅😂🤣😄😃😀☺️😊😆ou similaire) à chaque phrase ou à chaque paragraphe. Tu n'es pas obligé d'en mettre une dans chaque message. Utilise au maximum UNE SEULE émoticône de ce type par message entier, et seulement quand elle apporte vraiment quelque chose. Privilégie les mots pour exprimer la sympathie plutôt que les émoticônes répétées. En revanche, les émoticônes qui illustrent un produit ou un objet concret (vêtements, accessoires, etc., comme 👗 👔 👠 🛍️) restent libres et ne sont pas concernées par cette limite.";

const REGLE_CONFIRMATION_COMMANDE =
  "\n\nIMPORTANT - Confirmation de commande : quand un client a fini de préciser ce qu'il veut acheter (produit, adresse, heure de livraison), fais un récapitulatif clair de CETTE commande précise, puis termine TOUJOURS ta phrase par exactement : \"Vous confirmez cette commande ?\" (jamais reformulé autrement). " +
  "Si le client répond ensuite positivement à cette question (oui, je confirme, d'accord, etc.) SANS apporter de correction ou changement au récapitulatif, commence OBLIGATOIREMENT ta réponse par exactement la phrase \"Commande confirmée !\" avant d'ajouter quoi que ce soit d'autre (même si le client enchaîne avec une autre question dans le même message). " +
  "N'écris JAMAIS \"Commande confirmée !\" si le client n'a pas répondu positivement à la question de confirmation, ou s'il est en train de corriger/modifier sa commande. " +
  "IMPORTANT - Ne jamais mélanger les commandes : si le client a déjà confirmé une commande plus tôt dans la conversation, ne la reprends jamais dans le récapitulatif d'une NOUVELLE commande. Chaque commande se traite, se récapitule et se confirme séparément.";

// ─── NORMALISATION DES NUMÉROS IVOIRIENS ──────────────────────────────────────
//
// Depuis le 31 janvier 2021, la Côte d'Ivoire est passée de 8 à 10 chiffres.
// Selon l'opérateur d'origine, il faut ajouter un préfixe fixe devant l'ancien
// numéro à 8 chiffres pour obtenir le nouveau numéro à 10 chiffres :
//   - Moov  → préfixe "01"
//   - MTN   → préfixe "05"
//   - Orange→ préfixe "07"
// Cette fonction ramène TOUJOURS un numéro vers le même format canonique
// (+225 + 10 chiffres), pour qu'un même client ne soit jamais compté comme
// deux clients différents selon le format reçu.

const PREFIXES_MOOV = ['01', '02', '03', '40', '41', '42', '43', '50', '51', '52', '53', '70', '71', '72', '73'];
const PREFIXES_MTN = ['04', '05', '06', '44', '45', '46', '54', '55', '56', '64', '65', '66', '74', '75', '76', '84', '85', '86', '94', '95', '96'];
const PREFIXES_ORANGE = ['07', '08', '09', '47', '48', '49', '57', '58', '59', '67', '68', '69', '77', '78', '79', '87', '88', '89', '97', '98'];

function normaliserNumeroIvoirien(numeroBrut) {
  if (!numeroBrut) return numeroBrut;

  let digits = numeroBrut.replace('whatsapp:', '').replace('+', '');

  // Retire le code pays 225 s'il est présent, pour travailler sur le numéro local
  if (digits.startsWith('225')) {
    digits = digits.slice(3);
  } else {
    // Numéro non-ivoirien (ex: numéro de test US Meta) : on ne touche à rien
    return `+${digits}`;
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

  return `+225${numeroLocalFinal}`;
}

// Convertit un numéro au format attendu par l'API Meta : chiffres uniquement,
// sans "+" ni préfixe "whatsapp:". Ex: "+2250700000000" → "2250700000000"
function versFormatMeta(numero) {
  return numero.replace('whatsapp:', '').replace('+', '');
}

/**
 * Claude entoure parfois sa réponse JSON de balises markdown (```json ... ```).
 * Cette fonction retire ces balises avant parsing, pour éviter des échecs
 * silencieux de JSON.parse() sur du texte par ailleurs valide.
 */
function nettoyerJSON(raw) {
  if (!raw) return raw;
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
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
    const raw = nettoyerJSON(data.content?.filter(b => b.type === 'text').map(b => b.text).join('').trim());

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

/**
 * Récupère les messages du jour pour UN SEUL commerçant.
 * Le session_id est toujours construit comme "phoneNumberId:numeroClient",
 * donc on filtre avec un LIKE sur ce préfixe pour isoler ses conversations
 * de celles des autres commerçants.
 */
async function getTodayMessagesForMerchant(phoneNumberId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('conversations')
    .select('session_id, role, content')
    .like('session_id', `${phoneNumberId}:%`)
    .gte('created_at', today.toISOString())
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`Erreur récupération messages du jour pour ${phoneNumberId}:`, error.message);
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

// ─── COMMERÇANTS (MULTI-TENANT) ───────────────────────────────────────────────
//
// Un seul webhook Meta reçoit les messages de TOUS les commerçants. Chaque
// message entrant contient l'ID du numéro qui l'a reçu (value.metadata.phone_
// number_id) — c'est cet ID qui permet de savoir quel commerçant est concerné,
// et donc quel system_prompt utiliser. Table Supabase : `merchants`, qui est
// désormais la source unique de vérité (config technique + infos commerciales).

async function getMerchant(phoneNumberId) {
  const { data, error } = await supabase
    .from('merchants')
    .select('phone_number_id, nom_commerce, system_prompt, actif, numero_proprietaire')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();

  if (error) {
    console.error('Erreur lecture merchant:', error.message);
    return null;
  }
  return data;
}

/**
 * Récupère tous les commerçants actifs, pour le bilan quotidien multi-tenant.
 */
async function getMerchantsActifs() {
  const { data, error } = await supabase
    .from('merchants')
    .select('phone_number_id, nom_commerce, numero_proprietaire, actif')
    .eq('actif', true);

  if (error) {
    console.error('Erreur récupération commerçants actifs:', error.message);
    return [];
  }
  return data || [];
}

// ─── ACCÈS ────────────────────────────────────────────────────────────────────
//
// Le statut de suspension vit désormais dans merchants.suspendu (table `clients`
// abandonnée). Le sessionId étant construit "phoneNumberId:numeroClient", on
// extrait le phoneNumberId pour retrouver le bon commerçant.

async function estSuspendu(sessionId) {
  const phoneNumberId = sessionId.split(':')[0];

  const { data, error } = await supabase
    .from('merchants')
    .select('suspendu')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();

  if (error) {
    console.error('Erreur lecture statut suspendu Supabase:', error.message);
    return false;
  }
  if (!data) return false;
  return data.suspendu === true;
}

// ─── SÉCURITÉ WEBHOOK META ─────────────────────────────────────────────────────
//
// Meta signe chaque requête webhook avec HMAC SHA256 (header X-Hub-Signature-256),
// calculé à partir du corps brut de la requête et de l'App Secret de l'app Meta.
// Tant que META_APP_SECRET n'est pas configuré sur Render, on laisse passer sans
// vérifier (phase de test) — à activer impérativement avant la mise en prod réelle.

function verifierSignatureMeta(req, res, next) {
  if (!META_APP_SECRET) {
    return next();
  }

  const signatureRecue = req.headers['x-hub-signature-256'];
  if (!signatureRecue) {
    console.log('⚠️ Requête webhook Meta rejetée — signature absente');
    return res.sendStatus(403);
  }

  const signatureAttendue =
    'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');

  if (signatureRecue !== signatureAttendue) {
    console.log('⚠️ Requête webhook Meta rejetée — signature invalide');
    return res.sendStatus(403);
  }

  next();
}

// ─── ENVOI DE MESSAGES VIA META GRAPH API ─────────────────────────────────────

async function sendWhatsAppMessage(fromPhoneNumberId, to, text) {
  const toMeta = versFormatMeta(to);

  const response = await fetch(`https://graph.facebook.com/v20.0/${fromPhoneNumberId}/messages`, {
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
      'accept-encoding': 'identity',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Voici les échanges du jour :\n${transcript}` }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur API Reporting : ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.content[0].text;
}

// ─── DÉTECTION DE COMMANDE CONFIRMÉE (ALERTE IMMÉDIATE) ───────────────────────
//
// Contrairement à l'extraction de profil (non-bloquante, silencieuse en cas
// d'échec), cette détection est critique : une commande manquée est une vente
// perdue. On attend son résultat avant de considérer le message traité, et en
// cas d'échec on logue clairement (🚨) pour pouvoir vérifier manuellement,
// plutôt que de laisser l'erreur disparaître sans trace.

/**
 * Extrait les détails d'une commande (produit, prix, adresse, heure de
 * livraison) à partir de la conversation. Appelée UNIQUEMENT quand le code a
 * déjà vérifié que la réponse du bot contient la phrase verrouillée
 * "Commande confirmée !" — plus besoin de faire juger la confirmation par
 * l'IA, seulement d'en extraire les détails.
 */
async function extraireDetailsCommande(transcript) {
  const systemPrompt =
    "Analyse cet échange WhatsApp entre un client et un vendeur. Une commande vient d'être confirmée. " +
    "Extrait les détails de CETTE commande précise (la plus récente, celle qui vient d'être confirmée — pas une commande plus ancienne mentionnée plus tôt dans la conversation). " +
    "Réponds UNIQUEMENT avec un objet JSON compact, sans aucun texte autour : " +
    "{\"produit\":\"...\",\"prix\":\"...\",\"adresse\":\"...\",\"heure_livraison\":\"...\"} (mets \"non précisé\" si une info manque).";

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
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Échange :\n${transcript}` }],
      }),
    });

    if (!response.ok) {
      console.error('🚨 Extraction détails commande — API Claude a répondu', response.status);
      return { produit: 'non précisé', prix: 'non précisé', adresse: 'non précisé', heure_livraison: 'non précisé' };
    }

    const data = await response.json();
    const raw = nettoyerJSON(data.content?.filter(b => b.type === 'text').map(b => b.text).join('').trim());
    return JSON.parse(raw);
  } catch (err) {
    console.error('🚨 Extraction détails commande échouée (vérifier manuellement) :', err.message);
    return { produit: 'non précisé', prix: 'non précisé', adresse: 'non précisé', heure_livraison: 'non précisé' };
  }
}

/**
 * Envoie une alerte WhatsApp immédiate au propriétaire dès qu'une commande est
 * confirmée par un client. La confirmation n'est plus jugée par l'IA : le bot
 * est configuré pour écrire exactement "Commande confirmée !" au début de sa
 * réponse quand (et seulement quand) le client vient de confirmer — le code
 * n'a qu'à vérifier la présence de cette phrase verrouillée, ce qui élimine
 * les faux positifs/négatifs liés à l'interprétation.
 * On compare ensuite le détail de la commande (produit + adresse + heure) à
 * la dernière commande déjà alertée pour ce client, pour éviter un doublon si
 * le bot répète "Commande confirmée !" plusieurs fois pour la même commande.
 */
async function detecterEtAlerterCommande(sessionId, merchant, from, history, reply) {
  if (!reply.includes('Commande confirmée')) {
    return; // Pas de confirmation explicite dans cette réponse — rien à faire
  }

  const profile = await getClientProfile(sessionId);

  const transcript = [...history, { role: 'assistant', content: reply }]
    .map(m => `${m.role === 'user' ? 'Client' : 'Bot'}: ${m.content}`)
    .join('\n');

  const detection = await extraireDetailsCommande(transcript);
  console.log(`Commande confirmée détectée pour ${sessionId} — détails :`, JSON.stringify(detection));

  // On compare au détail exact de la dernière commande déjà alertée pour ce
  // client (pas juste "aujourd'hui") : si le client répète sa confirmation
  // dans la même conversation, on n'alerte pas deux fois pour LA MÊME commande.
  // Mais si les détails diffèrent (même le même jour), c'est une nouvelle
  // commande — le client peut très bien commander plusieurs fois par jour.
  const signatureNouvelle = `${detection.produit || ''}|${detection.adresse || ''}|${detection.heure_livraison || ''}`;
  const signaturePrecedente = profile?.derniere_commande_alertee || '';

  if (signatureNouvelle === signaturePrecedente) {
    console.log(`Détection commande — ${sessionId} : commande identique déjà alertée, on ignore.`);
    return;
  }

  if (!merchant.numero_proprietaire) {
    console.error(`🚨 Commande confirmée pour ${merchant.nom_commerce} mais numero_proprietaire manquant — alerte impossible, vérifier Supabase`);
    return;
  }

  const texteAlerte =
    `🛒 *NOUVELLE COMMANDE — ${merchant.nom_commerce}*\n\n` +
    `Client : ${from}\n` +
    `Produit : ${detection.produit || 'non précisé'}\n` +
    `Prix : ${detection.prix || 'non précisé'}\n` +
    `Adresse : ${detection.adresse || 'non précisée'}\n` +
    `Livraison souhaitée : ${detection.heure_livraison || 'non précisée'}\n\n` +
    `Pense à confirmer et organiser la livraison.`;

  await sendWhatsAppMessage(merchant.phone_number_id, merchant.numero_proprietaire, texteAlerte);
  await saveClientProfile(sessionId, { derniere_commande_alertee: signatureNouvelle });
  await enregistrerCommande(merchant, from, detection);
  console.log(`Alerte commande envoyée pour ${merchant.nom_commerce} (client ${from})`);
}

/**
 * Enregistre chaque commande détectée dans la table `commandes`, pour servir
 * de base au bilan hebdomadaire. Aucune saisie manuelle : ça s'exécute
 * automatiquement, au même moment que l'alerte envoyée au marchand.
 */
async function enregistrerCommande(merchant, from, detection) {
  const { error } = await supabase.from('commandes').insert([{
    phone_number_id: merchant.phone_number_id,
    numero_client: from,
    produit: detection.produit || null,
    prix_estime: detection.prix || null,
    adresse_livraison: detection.adresse || null,
    heure_livraison_souhaitee: detection.heure_livraison || null,
    nom_commerce: merchant.nom_commerce,
  }]);

  if (error) {
    console.error(`🚨 Erreur enregistrement commande dans Supabase pour ${merchant.nom_commerce} :`, error.message);
  }
}

// ─── BILAN QUOTIDIEN (MULTI-TENANT) ───────────────────────────────────────────
//
// Boucle sur chaque commerçant actif, génère un bilan séparé à partir de SES
// SEULES conversations du jour, et l'envoie sur SON numéro de propriétaire —
// depuis son propre phone_number_id (pas celui de NTA).

async function envoyerBilanQuotidien() {
  console.log('--- Déclenchement du bilan multi-tenant ---');

  const merchants = await getMerchantsActifs();
  if (merchants.length === 0) {
    console.log('Aucun commerçant actif trouvé.');
    return { envoye: false, raison: 'Aucun commerçant actif' };
  }

  const resultats = [];

  for (const merchant of merchants) {
    const { phone_number_id, nom_commerce, numero_proprietaire } = merchant;

    if (!numero_proprietaire) {
      console.log(`Bilan ignoré pour ${nom_commerce} : numero_proprietaire manquant.`);
      resultats.push({ commerce: nom_commerce, envoye: false, raison: 'numero_proprietaire manquant' });
      continue;
    }

    try {
      const messagesJour = await getTodayMessagesForMerchant(phone_number_id);

      if (messagesJour.length === 0) {
        console.log(`Aucun message aujourd'hui pour ${nom_commerce}. Pas de bilan envoyé.`);
        resultats.push({ commerce: nom_commerce, envoye: false, raison: "Aucun message aujourd'hui" });
        continue;
      }

      const transcript = messagesJour
        .map((m) => `${m.role === 'user' ? 'Client ' + m.session_id : 'Bot'} : ${m.content}`)
        .join('\n');
      const bilan = await askClaudeReporting(transcript);

      await sendWhatsAppMessage(phone_number_id, numero_proprietaire, `📊 *BILAN DE LA JOURNÉE — ${nom_commerce}*\n\n${bilan}`);
      console.log(`Bilan envoyé avec succès pour ${nom_commerce} !`);
      resultats.push({ commerce: nom_commerce, envoye: true });
    } catch (err) {
      console.error(`Erreur bilan pour ${nom_commerce} :`, err.message);
      resultats.push({ commerce: nom_commerce, envoye: false, raison: err.message });
    }
  }

  return { envoye: true, details: resultats };
}

cron.schedule('0 18 * * *', () => {
  envoyerBilanQuotidien();
});

// ─── BILAN HEBDOMADAIRE ────────────────────────────────────────────────────────
//
// S'appuie sur la table `commandes`, alimentée automatiquement à chaque
// alerte de commande confirmée (voir enregistrerCommande). Aucune saisie
// manuelle nécessaire. Vocabulaire volontairement prudent ("environ",
// "estimation") car on ne sait pas si chaque commande a été réellement
// livrée/payée — ce ne sont que des commandes confirmées par le client.

/**
 * Extrait un nombre à partir d'un texte de prix libre (ex: "50000F" → 50000).
 * Retourne 0 si aucun chiffre n'est trouvé (ex: "non précisé").
 */
function extrairePrixNumerique(prixTexte) {
  if (!prixTexte) return 0;
  const chiffres = prixTexte.replace(/[^\d]/g, '');
  return chiffres ? parseInt(chiffres, 10) : 0;
}

/**
 * Récupère les commandes d'un commerçant sur une plage de jours donnée,
 * en partant d'aujourd'hui. Ex: recupererCommandes(phoneNumberId, 7, 0) =
 * les 7 derniers jours ; recupererCommandes(phoneNumberId, 14, 7) = les
 * 7 jours d'avant (pour comparaison semaine sur semaine).
 */
async function recupererCommandes(phoneNumberId, joursDebut, joursFin) {
  const debut = new Date();
  debut.setHours(0, 0, 0, 0);
  debut.setDate(debut.getDate() - joursDebut);

  // Si joursFin est 0 (semaine en cours), la borne de fin doit être MAINTENANT
  // (pas minuit aujourd'hui), sinon les commandes du jour même sont exclues.
  const fin = new Date();
  if (joursFin > 0) {
    fin.setHours(0, 0, 0, 0);
    fin.setDate(fin.getDate() - joursFin);
  }

  const { data, error } = await supabase
    .from('commandes')
    .select('produit, prix_estime, created_at')
    .eq('phone_number_id', phoneNumberId)
    .gte('created_at', debut.toISOString())
    .lt('created_at', fin.toISOString());

  if (error) {
    console.error(`Erreur récupération commandes pour ${phoneNumberId}:`, error.message);
    return [];
  }
  return data || [];
}

/**
 * Calcule les statistiques brutes d'une liste de commandes : nombre total,
 * chiffre d'affaires estimé (somme des prix numériques trouvés), et produit
 * le plus fréquent.
 */
function calculerStats(commandes) {
  const nombre = commandes.length;
  const chiffreAffaires = commandes.reduce((total, c) => total + extrairePrixNumerique(c.prix_estime), 0);

  const compteurProduits = {};
  for (const c of commandes) {
    const nom = c.produit || 'non précisé';
    compteurProduits[nom] = (compteurProduits[nom] || 0) + 1;
  }
  let produitTop = null;
  let maxCount = 0;
  for (const [nom, count] of Object.entries(compteurProduits)) {
    if (count > maxCount) {
      maxCount = count;
      produitTop = nom;
    }
  }

  return { nombre, chiffreAffaires, produitTop };
}

/**
 * Demande à Claude de reformuler les statistiques en un message WhatsApp
 * naturel et prudent (jamais de chiffre présenté comme certain).
 */
async function formulerBilanHebdomadaire(nomCommerce, statsSemaine, statsSemainePrecedente) {
  const systemPrompt =
    "Tu es l'assistant de gestion d'un commerçant ivoirien. Rédige un bilan HEBDOMADAIRE en français, chaleureux et simple, en 4-5 phrases maximum. " +
    "IMPORTANT : ces chiffres viennent de commandes CONFIRMÉES par les clients via WhatsApp, mais on ne sait pas si elles ont toutes été réellement livrées et payées. " +
    "Utilise TOUJOURS un vocabulaire prudent : \"environ\", \"à peu près\", \"estimation\", jamais de chiffre présenté comme certain ou définitif. " +
    "Compare à la semaine précédente (en hausse / en baisse / stable) si les deux chiffres sont disponibles. " +
    "Mentionne le produit le plus demandé de la semaine." +
    REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;

  const contenu = `Commerce : ${nomCommerce}
Cette semaine : environ ${statsSemaine.nombre} commande(s) confirmée(s), chiffre d'affaires estimé à environ ${statsSemaine.chiffreAffaires} FCFA, produit le plus demandé : ${statsSemaine.produitTop || 'aucun'}.
Semaine précédente : environ ${statsSemainePrecedente.nombre} commande(s), chiffre d'affaires estimé à environ ${statsSemainePrecedente.chiffreAffaires} FCFA.`;

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
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: contenu }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur API Reporting hebdomadaire : ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.content[0].text;
}

/**
 * Boucle sur chaque commerçant actif, calcule ses statistiques de la semaine
 * (et de la semaine précédente pour comparaison), et envoie le bilan
 * hebdomadaire à son numero_proprietaire.
 */
async function envoyerBilanHebdomadaire() {
  console.log('--- Déclenchement du bilan hebdomadaire ---');

  const merchants = await getMerchantsActifs();
  if (merchants.length === 0) {
    console.log('Aucun commerçant actif trouvé.');
    return;
  }

  for (const merchant of merchants) {
    const { phone_number_id, nom_commerce, numero_proprietaire } = merchant;

    if (!numero_proprietaire) {
      console.log(`Bilan hebdo ignoré pour ${nom_commerce} : numero_proprietaire manquant.`);
      continue;
    }

    try {
      const [commandesSemaine, commandesSemainePrecedente] = await Promise.all([
        recupererCommandes(phone_number_id, 6, 0),
        recupererCommandes(phone_number_id, 13, 6),
      ]);

      if (commandesSemaine.length === 0) {
        console.log(`Aucune commande cette semaine pour ${nom_commerce}. Pas de bilan hebdo envoyé.`);
        continue;
      }

      const statsSemaine = calculerStats(commandesSemaine);
      const statsSemainePrecedente = calculerStats(commandesSemainePrecedente);

      const bilan = await formulerBilanHebdomadaire(nom_commerce, statsSemaine, statsSemainePrecedente);

      await sendWhatsAppMessage(phone_number_id, numero_proprietaire, `📈 *BILAN DE LA SEMAINE — ${nom_commerce}*\n\n${bilan}`);
      console.log(`Bilan hebdomadaire envoyé avec succès pour ${nom_commerce} !`);
    } catch (err) {
      console.error(`Erreur bilan hebdomadaire pour ${nom_commerce} :`, err.message);
    }
  }
}

cron.schedule('0 20 * * 0', () => {
  envoyerBilanHebdomadaire();
});

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────

// Fallback utilisé uniquement si un commerçant n'a pas encore de system_prompt
// renseigné dans Supabase — les règles de formatage/émoticônes sont ajoutées
// une seule fois, centralement, dans le webhook (pas ici).
const SYSTEM_WHATSAPP_BASE =
  "Tu es l'assistant WhatsApp d'un commerçant ivoirien. Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. Garde le fil de la conversation en t'appuyant sur les échanges précédents.";

const SYSTEM_DEMO =
  "Tu es l'assistante virtuelle de la Boutique Adjoua Mode, une boutique de vêtements féminins tendance située à Cocody, Abidjan, Côte d'Ivoire...\n[Règles de vouvoiement, tarifs de 5000 à 85000 FCFA, livraisons 2-4h]" + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES;

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('NTA Assistant backend en ligne ✅');
});

// Route de vérification du Webhook Meta (Semaine 2, Étape 1 — déjà validée)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

app.get('/trigger-report', async (req, res) => {
  const secretFourni = req.query.secret || req.headers['x-cron-secret'];
  if (!CRON_SECRET || secretFourni !== CRON_SECRET) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  // Réponse volontairement courte pour cron-job.org (qui rejette les réponses
  // trop volumineuses) — le détail complet par commerçant reste dans les logs
  // Render, consultable manuellement si besoin de vérifier.
  const resultat = await envoyerBilanQuotidien();
  res.json({ ok: true });
});

app.get('/trigger-weekly-report', async (req, res) => {
  const secretFourni = req.query.secret || req.headers['x-cron-secret'];
  if (!CRON_SECRET || secretFourni !== CRON_SECRET) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  await envoyerBilanHebdomadaire();
  res.json({ ok: true });
});

// ─── ROUTES DASHBOARD (GESTION DES COMMERÇANTS) ───────────────────────────────
//
// Utilisées par le tableau de bord HTML. `phone_number_id` sert de clé (fiable,
// jamais mal saisi, contrairement à un numéro de téléphone). Le champ
// `suspendu` contrôle l'accès réel du bot (coupure pour non-paiement) — dès
// qu'il passe à true, le webhook cesse de répondre au client final concerné.

app.get('/merchants', async (req, res) => {
  const { data, error } = await supabase.from('merchants').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ merchants: data || [] });
});

app.post('/merchants', async (req, res) => {
  const {
    phone_number_id, nom_commerce, system_prompt,
    numero_proprietaire, prix, secteur, essai, date_debut,
  } = req.body;

  if (!phone_number_id || !nom_commerce || !numero_proprietaire) {
    return res.status(400).json({ error: 'phone_number_id, nom_commerce et numero_proprietaire sont requis' });
  }

  const { data, error } = await supabase.from('merchants').insert([{
    phone_number_id,
    nom_commerce,
    system_prompt: system_prompt || null,
    actif: true,
    suspendu: false,
    numero_proprietaire,
    prix: prix || 29000,
    secteur: secteur || null,
    essai: essai !== undefined ? essai : true,
    date_debut: date_debut || new Date().toISOString(),
  }]).select();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ merchant: data[0] });
});

app.patch('/merchants/:phone_number_id', async (req, res) => {
  const { phone_number_id } = req.params;
  const { data, error } = await supabase
    .from('merchants')
    .update(req.body)
    .eq('phone_number_id', phone_number_id)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ merchant: data[0] });
});

app.delete('/merchants/:phone_number_id', async (req, res) => {
  const { phone_number_id } = req.params;
  const { error } = await supabase.from('merchants').delete().eq('phone_number_id', phone_number_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Réception des messages entrants — format Meta Cloud API (Semaine 2, Étape 2)
app.post('/webhook', verifierSignatureMeta, async (req, res) => {
  // Meta attend une réponse 200 très rapide, sinon il considère l'envoi en échec
  // et retente (jusqu'à créer des doublons). On répond tout de suite, puis on
  // traite le message et on envoie la réponse séparément via l'API Graph.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Les webhooks Meta couvrent aussi les accusés de statut (envoyé/lu/livré),
    // qui n'ont pas de champ "messages" — on les ignore silencieusement.
    if (!message) return;

    // ID du numéro Meta qui a REÇU ce message — identifie le commerçant concerné.
    const phoneNumberId = value?.metadata?.phone_number_id;
    const incomingMsg = message.text?.body;
    const from = normaliserNumeroIvoirien(message.from);

    if (!incomingMsg || !from || !phoneNumberId) return;

    // Identification du commerçant via son numéro Meta (table `merchants`)
    const merchant = await getMerchant(phoneNumberId);
    if (!merchant) {
      console.error(`Aucun commerçant trouvé pour phone_number_id=${phoneNumberId}`);
      return;
    }
    if (!merchant.actif) {
      await sendWhatsAppMessage(phoneNumberId, from, MESSAGE_ACCES_COUPE);
      return;
    }

    // On isole l'historique et le profil par commerçant ET par client, pour
    // qu'un même numéro client ne mélange jamais les conversations de deux
    // commerçants différents.
    const sessionId = `${phoneNumberId}:${from}`;

    const suspendu = await estSuspendu(sessionId);
    if (suspendu) {
      await sendWhatsAppMessage(phoneNumberId, from, MESSAGE_ACCES_COUPE);
      return;
    }

    // Sauvegarde du message entrant
    await saveMessageToSupabase(sessionId, 'user', incomingMsg);

    // Récupération parallèle : historique + profil client
    const [history, profile] = await Promise.all([
      getHistoryFromSupabase(sessionId),
      getClientProfile(sessionId),
    ]);

    // System prompt propre au commerçant (fallback sur le prompt générique
    // si jamais system_prompt est vide dans Supabase)
    const basePrompt = merchant.system_prompt || SYSTEM_WHATSAPP_BASE;
    const profileLine = formatProfileForPrompt(profile);
    const systemPrompt = basePrompt + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES + REGLE_CONFIRMATION_COMMANDE + profileLine;

    // Réponse principale
    const reply = await askClaude(history, systemPrompt);
    await saveMessageToSupabase(sessionId, 'assistant', reply);

    // Extraction et mise à jour du profil en arrière-plan (non bloquant —
    // une info de confort manquée n'a pas de conséquence grave)
    const historyForExtraction = [...history, { role: 'assistant', content: reply }];
    extractAndUpdateProfile(sessionId, historyForExtraction).catch(() => {});

    await sendWhatsAppMessage(phoneNumberId, from, reply);

    // Détection de commande confirmée + alerte immédiate au marchand.
    // Contrairement à l'extraction de profil, on ATTEND ce résultat et on
    // logue clairement (🚨) en cas d'échec — une commande manquée est une
    // vente perdue, pas un détail de confort.
    try {
      await detecterEtAlerterCommande(sessionId, merchant, from, history, reply);
    } catch (err) {
      console.error(`🚨 Erreur alerte commande pour ${merchant.nom_commerce} (${sessionId}) :`, err.message);
    }
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

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
