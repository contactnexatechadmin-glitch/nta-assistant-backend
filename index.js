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
const PREFIXES_MOOV = ['01', '02', '03', '40', '41', '42', '43', '50', '51', '52', '53', '70', '71', '72', '73'];
const PREFIXES_MTN = ['04', '05', '06', '44', '45', '46', '54', '55', '56', '64', '65', '66', '74', '75', '76', '84', '85', '86', '94', '95', '96'];
const PREFIXES_ORANGE = ['07', '08', '09', '47', '48', '49', '57', '58', '59', '67', '68', '69', '77', '78', '79', '87', '88', '89', '97', '98'];

function normaliserNumeroIvoirien(numeroBrut) {
  if (!numeroBrut) return numeroBrut;

  let digits = numeroBrut.replace('whatsapp:', '').replace('+', '');

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
    } else {
      console.warn(`Numéro ivoirien à 8 chiffres non reconnu (préfixe ${prefixeAncien}) : ${numeroBrut}`);
    }
  }

  return `+225${numeroLocalFinal}`;
}

function versFormatMeta(numero) {
  return numero.replace('whatsapp:', '').replace('+', '');
}

function nettoyerJSON(raw) {
  if (!raw) return raw;
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
}

// ─── PROFIL CLIENT ────────────────────────────────────────────────────────────
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

function formatProfileForPrompt(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';

  const parts = Object.entries(profile)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');

  return `\n\n[Profil client connu] ${parts}`;
}

async function extractAndUpdateProfile(whatsappNumber, history) {
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
    const response = await fetch('[https://api.anthropic.com/v1/messages](https://api.anthropic.com/v1/messages)', {
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
  const response = await fetch('[https://api.anthropic.com/v1/messages](https://api.anthropic.com/v1/messages)', {
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

  const response = await fetch('[https://api.anthropic.com/v1/messages](https://api.anthropic.com/v1/messages)', {
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

// ─── DÉTECTION DE COMMANDE CONFIRMÉE (ALERTE IMMÉDIATE) ───────────────────────
async function extraireDetailsCommande(transcript) {
  const systemPrompt =
    "Analyse cet échange WhatsApp entre un client et un vendeur. Une commande vient d'être confirmée. " +
    "Extrait les détails de CETTE commande précise (la plus récente, celle qui vient d'être confirmée — pas une commande plus ancienne mentionnée plus tôt dans la conversation). " +
    "Réponds UNIQUEMENT avec un objet JSON compact, sans aucun texte autour : " +
    "{\"produit\":\"...\",\"prix\":\"...\",\"adresse\":\"...\",\"heure_livraison\":\"...\"} (mets \"non précisé\" si une info manque).";

  try {
    const response = await fetch('[https://api.anthropic.com/v1/messages](https://api.anthropic.com/v1/messages)', {
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

async function detecterEtAlerterCommande(sessionId, merchant, from, history, reply) {
  if (!reply.includes('Commande confirmée')) {
    return;
  }

  const profile = await getClientProfile(sessionId);

  const transcript = [...history, { role: 'assistant', content: reply }]
    .map(m => `${m.role === 'user' ? 'Client' : 'Bot'}: ${m.content}`)
    .join('\n');

  const detection = await extraireDetailsCommande(transcript);
  console.log(`Commande confirmée détectée pour ${sessionId} — détails :`, JSON.stringify(detection));

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
  envoyerBilanQuotidien().catch(err => console.error('Erreur Cron quotidien:', err.message));
});

// ─── BILAN HEBDOMADAIRE ────────────────────────────────────────────────────────
function extrairePrixNumerique(prixTexte) {
  if (!prixTexte) return 0;
  const chiffres = prixTexte.replace(/[^\d]/g, '');
  return chiffres ? parseInt(chiffres, 10) : 0;
}

async function recupererCommandes(phoneNumberId, joursDebut, joursFin) {
  const debut = new Date();
  debut.setHours(0, 0, 0, 0);
  debut.setDate(debut.getDate() - joursDebut);

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

  const response = await fetch('[https://api.anthropic.com/v1/messages](https://api.anthropic.com/v1/messages)', {
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
      messages: [{ role: 'user', content: contenu }],
    }),
  });

  if (!response.ok) throw new Error('Erreur API Reporting hebdomadaire');
  const data = await response.json();
  return data.content[0].text;
}

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
  envoyerBilanHebdomadaire().catch(err => console.error('Erreur Cron hebdomadaire:', err.message));
});

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
const SYSTEM_WHATSAPP_BASE =
  "Tu es l'assistant WhatsApp d'un commerçant ivoirien. Réponds en français, de façon chaleureuse, brève et utile, comme un vendeur sympathique. Garde le fil de la conversation en t'appuyant sur les échanges précédents.";

const SYSTEM_DEMO =
  "Tu es l'assist
