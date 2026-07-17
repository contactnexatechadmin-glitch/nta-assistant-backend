import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const app = express();

// verify() capture le corps brut de la requête, nécessaire pour valider la
// signature HMAC de Meta (X-Hub-Signature-256) une fois META_APP_SECRET configuré.
app.use(express.json({
  limit: '15mb', // augmenté pour accepter les photos du catalogue envoyées en base64
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

const MAX_HISTORY_ENVOYE_A_CLAUDE = 10;

const REGLE_FORMATAGE_WHATSAPP =
  "\n\nIMPORTANT - Format du texte : WhatsApp utilise UN SEUL astérisque pour le gras (*comme ceci*), jamais deux. N'utilise JAMAIS le format **comme ceci** (style Markdown classique), cela affiche des étoiles parasites et gêne la lecture. Pour l'italique, WhatsApp utilise un seul underscore (_comme ceci_).";

const REGLE_EMOTICONES =
  "\n\nIMPORTANT - Usage des émoticônes : N'utilise PAS d'émoticône de sourire/rire (😁😅😂🤣😄😃😀☺️😊😆ou similaire) à chaque phrase ou à chaque paragraphe. Tu n'es pas obligé d'en mettre une dans chaque message. Utilise au maximum UNE SEULE émoticône de ce type par message entier, et seulement quand elle apporte vraiment quelque chose. Privilégie les mots pour exprimer la sympathie plutôt que les émoticônes répétées. En revanche, les émoticônes qui illustrent un produit ou un objet concret (vêtements, accessoires, etc., comme 👗 👔 👠 🛍️) restent libres et ne sont pas concernées par cette limite.";

const REGLE_PRECISION_EMOJI_PRODUIT =
  "\n\nIMPORTANT - Précision de l'émoticône produit : quand tu mentionnes un produit précis, tu PEUX (et c'est encouragé) ajouter une émoticône qui l'illustre — ça aide beaucoup à la lecture, notamment pour les personnes moins à l'aise avec la lecture. " +
  "Mais choisis-la avec exactitude selon le type réel de l'article : 👕 pour un t-shirt, 👔 UNIQUEMENT pour une chemise habillée, 👗 pour une robe, 👠 pour des chaussures à talon, 👟 pour des baskets/sport, 👜 pour un sac, 👖 pour un pantalon/jean. " +
  "Si le type exact du produit n'est pas clair ou ne correspond à aucune de ces catégories précises, utilise l'émoticône générique 🛍️ plutôt que de deviner une émoticône qui pourrait être fausse.";

const REGLE_CONFIRMATION_COMMANDE =
  "\n\nIMPORTANT - Confirmation de commande : quand un client a fini de préciser ce qu'il veut acheter (produit, adresse, heure de livraison), fais un récapitulatif clair de CETTE commande précise, puis termine TOUJOURS ta phrase par exactement : \"Vous confirmez cette commande ?\" (jamais reformulé autrement). " +
  "Si le client répond ensuite positivement à cette question (oui, je confirme, d'accord, etc.) SANS apporter de correction ou changement au récapitulatif, commence OBLIGATOIREMENT ta réponse par exactement la phrase \"Commande confirmée !\" avant d'ajouter quoi que ce soit d'autre (même si le client enchaîne avec une autre question dans le même message). " +
  "N'écris JAMAIS \"Commande confirmée !\" si le client n'a pas répondu positivement à la question de confirmation, ou s'il est en train de corriger/modifier sa commande. " +
  "IMPORTANT - Ne jamais mélanger les commandes : si le client a déjà confirmé une commande plus tôt dans la conversation, ne la reprends jamais dans le récapitulatif d'une NOUVELLE commande. Chaque commande se traite, se récapitule et se confirme séparément.";

const REGLE_ESCALADE =
  "\n\nIMPORTANT - Honnêteté et escalade vers le commerçant : tu es un assistant 100% autonome, aucun humain ne reprend la conversation derrière toi. Ne prétends JAMAIS \"vérifier le stock\", \"consulter l'équipe\" ou \"revenir vers le client\" si tu ne peux pas le faire toi-même — c'est un mensonge. " +
  "Dans les cas suivants uniquement : (1) une information précise manque dans tes instructions (prix, stock, détail non fourni), (2) le client fait une réclamation ou signale un litige, (3) le client négocie un prix ou une condition hors de ce que tu es autorisé à accepter — réponds avec empathie sur le fond, PUIS termine ta réponse par exactement cette phrase, mot pour mot : \"Notre équipe est informée et reviendra vers vous si besoin.\" " +
  "N'utilise cette phrase exacte QUE dans ces trois cas précis, jamais ailleurs, et jamais pour une simple question à laquelle tu sais répondre ou un client simplement impatient (dans ce dernier cas, rassure-le toi-même avec empathie, sans escalader).";

const REGLE_POLITESSE_SALUTATION =
  "\n\nIMPORTANT - Politesse et salutation : si le message du client contient une salutation (bonjour, bonsoir, salut, etc.), réponds-y TOUJOURS brièvement et chaleureusement avant d'enchaîner sur le sujet commercial — SANS AUCUNE EXCEPTION. " +
  "Cette règle s'applique même si le client salue plusieurs fois dans la même conversation, et même si le message contient aussi une photo ou une demande commerciale en même temps. Ne jamais ignorer une salutation pour foncer directement sur la vente.";

const REGLE_CATALOGUE_TEMPS_REEL =
  "\n\nIMPORTANT - Autorité absolue de la base de données temps réel : les informations contenues dans la balise <base_de_donnees_temps_reel> représentent la vérité absolue à la seconde près. Cette balise a autorité totale sur tout l'historique de la conversation. " +
  "Si un article est marqué [EN STOCK] dans cette balise, tu dois le proposer normalement au client, MÊME SI tu as affirmé le contraire dans tes messages précédents de cette même conversation. Si un article est marqué [RUPTURE] dans cette balise, il est indisponible MÊME SI tu as dit le contraire avant. " +
  "Ne traite jamais une répétition dans l'historique comme une preuve de vérité : seule la balise <base_de_donnees_temps_reel> du message actuel compte, elle est régénérée à chaque message et reflète l'état réel actuel du stock. " +
  "IMPORTANT - Langage naturel du statut : les labels [EN STOCK] / [RUPTURE] sont un format INTERNE pour toi, jamais à répéter tels quels au client. Traduis-les toujours en langage humain, intégré dans la phrase : \"disponible\" ou \"malheureusement plus disponible\" (ou équivalent), jamais \"Statut : EN STOCK\" ni aucune ligne façon fiche d'inventaire.";

const REGLE_ALTERNATIVE_RUPTURE =
  "\n\nIMPORTANT - Rebond commercial sur rupture de stock : quand un article demandé par le client est en rupture ([RUPTURE] dans le catalogue), ne propose JAMAIS plusieurs alternatives à la fois, et ne dis jamais une phrase vague au pluriel comme \"je vous montre d'autres articles\". " +
  "Choisis UNE SEULE alternative précise — la plus proche en catégorie de produit et en prix — et mets-la en avant clairement dans une vraie phrase commerciale naturelle et chaleureuse (jamais un dump brut du champ \"Détails visuels\", reformule toujours). " +
  "Reste sur cette unique alternative nommée, jamais une liste.";

const REGLE_PHOTO_PRODUIT =
  "\n\nIMPORTANT - Tag photo produit : quand — et UNIQUEMENT quand — tu viens de recommander UNE SEULE alternative précise suite à une rupture de stock (voir règle ci-dessus), termine ta réponse par une ligne séparée, exactement au format : PHOTO_PRODUIT: NomExactDuProduit — en reprenant le nom EXACT tel qu'il apparaît après \"Produit :\" dans le catalogue ci-dessous. " +
  "N'ajoute JAMAIS cette ligne dans les autres cas : jamais pour un produit disponible normalement, jamais si tu mentionnes ou listes plusieurs produits, jamais si tu n'es pas sûr du nom exact. " +
  "Cette ligne est un signal technique invisible pour le client (elle est retirée avant l'envoi) : ne l'explique jamais, n'y fais jamais référence dans ta phrase, et n'écris jamais son contenu ailleurs que sur cette ligne finale dédiée.";

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
 * Donne au bot la notion du temps réel, absente par défaut d'un LLM.
 * Retourne une ligne à coller au system prompt, ex :
 *   "[Info temps réel] Nous sommes actuellement : dimanche 12 juillet, 14h32 (heure d'Abidjan)."
 * Le marchand ayant décrit ses horaires en texte libre dans son system_prompt
 * (ex: "Lundi au samedi, 7h30-16h30"), Claude compare lui-même cette ligne à
 * ces horaires pour savoir si la boutique est ouverte ou fermée — pas besoin
 * de champ structuré séparé en base.
 */
function formatDateHeureAbidjan() {
  const maintenant = new Date().toLocaleString('fr-FR', {
    timeZone: 'Africa/Abidjan',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `\n\n[Info temps réel] Nous sommes actuellement : ${maintenant} (heure d'Abidjan). ` +
    "Si cette date/heure tombe en dehors des horaires d'ouverture ou un jour de fermeture : dis-le HONNÊTEMENT au client, une seule fois, dans ta réponse (ne mens jamais sur le statut ouvert/fermé). " +
    "MAIS ce n'est qu'une précision à donner en passant : tu CONTINUES la conversation commerciale normalement, exactement comme un jour ouvrable. Réponds quand même aux questions (prix, produits, disponibilité), argumente, essaie de convaincre le client d'acheter. " +
    "Ne dis JAMAIS que tu vas transmettre la demande à quelqu'un d'autre, qu'une équipe va rappeler, ou que le client doit attendre l'ouverture pour avoir une réponse — c'est faux, tu es seul à gérer cette conversation et tu es capable de répondre toi-même immédiatement. " +
    "Le seul impact réel de la fermeture : la LIVRAISON ne pourra se faire qu'à la réouverture. Utilise donc ça comme argument de vente, pas comme excuse pour ne pas répondre : prends sa commande maintenant, précise juste que la livraison se fera dès la reprise.";
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

// ─── CATALOGUE PRODUITS (TEXTE RICHE, SANS PHOTO) ─────────────────────────────
//
// Aucune image n'est stockée (ni Supabase Storage, ni Render). Chaque produit
// est décrit en texte riche par le DG (champ `description`, "détails visuels"),
// injecté intégralement dans le system_prompt à chaque message. Le champ
// `en_rupture` permet de signaler une indisponibilité sans supprimer la fiche.

async function getCatalogueProduits(phoneNumberId) {
  const { data, error } = await supabase
    .from('catalogue_produits')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Erreur lecture catalogue produits:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Formate le catalogue produits d'un commerçant en texte riche à injecter
 * dans le system_prompt. Chaque produit inclut ses détails visuels (pour la
 * reconnaissance d'image) et son statut de stock.
 */
function formatCatalogueForPrompt(produits) {
  if (!produits || produits.length === 0) return '';

  const fiches = produits.map(p => {
    const lignes = [
      `Produit : ${p.nom_produit}${p.variante ? ' (' + p.variante + ')' : ''}`,
      `Prix : ${p.prix}`,
      `Détails visuels : ${p.description || 'non précisés'}`,
      `Statut : ${p.en_rupture ? '[RUPTURE]' : '[EN STOCK]'}`,
    ];
    return lignes.join('\n');
  }).join('\n\n');

  return `\n\n<base_de_donnees_temps_reel>\n${fiches}\n</base_de_donnees_temps_reel>`;
}

async function getProduitCatalogue(id) {
  const { data, error } = await supabase
    .from('catalogue_produits')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('Erreur lecture produit catalogue:', error.message);
    return null;
  }
  return data;
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

/**
 * Nettoie un texte avant de l'insérer dans un paramètre de template Meta :
 * l'API rejette les paramètres contenant des sauts de ligne ou plus de 4
 * espaces/tabulations consécutifs.
 */
function nettoyerParametreTemplate(texte) {
  return (texte || '').replace(/\s+/g, ' ').trim();
}

/**
 * Envoie le bilan (quotidien ou hebdomadaire) via le template Meta approuvé
 * "bilan_commercant". Contrairement à sendWhatsAppMessage (texte libre, valide
 * uniquement dans la fenêtre des 24h), un template approuvé peut être envoyé
 * à tout moment — indispensable puisque le propriétaire n'écrit pas forcément
 * au bot chaque jour.
 */
async function sendBilanTemplate(fromPhoneNumberId, to, nomCommerce, periode, texteBilan) {
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
      type: 'template',
      template: {
        name: 'bilan_commercant',
        language: { code: 'fr' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: nettoyerParametreTemplate(nomCommerce) },
            { type: 'text', text: nettoyerParametreTemplate(periode) },
            { type: 'text', text: nettoyerParametreTemplate(texteBilan) },
          ],
        }],
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Erreur envoi template bilan Meta:', response.status, errText);
    throw new Error(`Meta API (template) a répondu ${response.status}: ${errText}`);
  }

  return response.json();
}

/**
 * Envoie une alerte (commande confirmée ou escalade) via le template Meta
 * approuvé "alerte_marchand". Remplace l'ancien envoi en texte libre, qui
 * échouait si le propriétaire n'avait pas écrit au bot dans les 24h.
 */
async function sendAlerteTemplate(fromPhoneNumberId, to, nomCommerce, texteAlerte) {
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
      type: 'template',
      template: {
        name: 'alerte_marchand',
        language: { code: 'fr' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: nettoyerParametreTemplate(nomCommerce) },
            { type: 'text', text: nettoyerParametreTemplate(texteAlerte) },
          ],
        }],
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Erreur envoi template alerte Meta:', response.status, errText);
    throw new Error(`Meta API (template alerte) a répondu ${response.status}: ${errText}`);
  }

  return response.json();
}

// ─── IMAGES (RÉCEPTION PHOTO CLIENT + COMPARAISON CATALOGUE) ─────────────────
//
// Quand un client final envoie une photo (ex: capture d'un produit vu sur les
// réseaux), Meta ne transmet qu'un media_id — il faut d'abord demander l'URL
// réelle du fichier à l'API Graph, puis télécharger le fichier lui-même,
// avant de pouvoir l'envoyer à Claude en vision.

async function telechargerMediaMeta(mediaId) {
  const infoRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
  });
  if (!infoRes.ok) {
    throw new Error(`Erreur récupération info média Meta: ${infoRes.status}`);
  }
  const info = await infoRes.json();

  const mediaRes = await fetch(info.url, {
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
  });
  if (!mediaRes.ok) {
    throw new Error(`Erreur téléchargement fichier média Meta: ${mediaRes.status}`);
  }

  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType: info.mime_type || 'image/jpeg' };
}

// ─── TAG PHOTO_PRODUIT (REBOND COMMERCIAL SUR RUPTURE) ────────────────────────
//
// Quand Claude recommande UNE SEULE alternative précise suite à une rupture,
// il termine sa réponse par "PHOTO_PRODUIT: NomDuProduit" (voir REGLE_PHOTO_
// PRODUIT). Ce tag n'est jamais montré au client : on le retire du texte avant
// envoi/sauvegarde, puis on l'utilise pour retrouver la fiche produit et, si
// elle a une photo enregistrée, envoyer cette photo juste après le texte.

function extraireTagPhotoProduit(texte) {
  if (!texte) return { texteNettoye: texte, nomProduitPhoto: null };

  const regex = /\n*PHOTO_PRODUIT\s*:\s*(.+?)\s*$/i;
  const match = texte.match(regex);
  if (!match) return { texteNettoye: texte, nomProduitPhoto: null };

  return {
    texteNettoye: texte.slice(0, match.index).trim(),
    nomProduitPhoto: match[1].trim(),
  };
}

/**
 * Retrouve la fiche produit correspondant au nom donné par le tag. Recherche
 * d'abord une correspondance exacte (insensible à la casse), puis en dernier
 * recours une correspondance partielle, pour tolérer une légère variation de
 * formulation de la part de Claude.
 */
function trouverProduitParNom(catalogue, nomProduit) {
  if (!catalogue || !nomProduit) return null;
  const nomNormalise = nomProduit.toLowerCase().trim();

  const exact = catalogue.find(p => p.nom_produit.toLowerCase().trim() === nomNormalise);
  if (exact) return exact;

  return catalogue.find(p =>
    p.nom_produit.toLowerCase().includes(nomNormalise) || nomNormalise.includes(p.nom_produit.toLowerCase())
  ) || null;
}

/**
 * Envoie UNE photo produit via Meta (à partir d'une URL publique Supabase
 * Storage). Jamais appelée en rafale : le webhook n'envoie qu'un seul appel
 * par réponse, pour un seul produit maximum.
 */
async function envoyerImageWhatsApp(fromPhoneNumberId, to, imageUrl) {
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
      type: 'image',
      image: { link: imageUrl },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Erreur envoi image produit Meta:', response.status, errText);
    throw new Error(`Meta API (image) a répondu ${response.status}: ${errText}`);
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

/**
 * Envoie UNIQUEMENT la photo du client à Claude (Haiku, rapide et économique).
 * Le catalogue n'est plus envoyé en photos : il est déjà présent en texte
 * riche dans systemPrompt (voir formatCatalogueForPrompt), ce qui rend le
 * coût de cet appel indépendant de la taille du catalogue du commerçant.
 *
 * IMPORTANT : `history` reçu ici doit déjà EXCLURE le placeholder texte du
 * message photo en cours (voir le webhook) — sinon Claude reçoit deux tours
 * "client" collés d'affilée (le placeholder, puis l'image), ce qui le pousse
 * à s'ancrer sur d'anciens tours de la conversation au lieu de traiter cette
 * image comme la question actuelle du client.
 *
 * `legendeClient` porte le texte RÉEL éventuellement tapé par le client en
 * légende de sa photo (ex: "Bonjour, vous avez ça ?"). Comme le placeholder
 * a été retiré de l'historique, ce texte doit être réinjecté explicitement
 * ici — sinon une salutation ou une question tapée avec la photo disparaît
 * purement et simplement.
 */
async function askClaudeAvecImage(history, systemPrompt, imageClientBase64, imageClientMimeType, legendeClient) {
  const ligneLegende = legendeClient
    ? `Le client a envoyé ce message avec sa photo : "${legendeClient}". Réponds-y d'abord (une salutation ou une question mérite toujours une réponse) avant de parler du produit — ne l'ignore jamais.`
    : "Le client n'a pas ajouté de texte à sa photo.";

  const instructionAnalyseImage =
    "Le client vient d'envoyer la photo ci-dessous (capture d'écran ou photo vue sur les réseaux). " + ligneLegende + " " +
    "Identifie le produit en croisant discrètement l'image avec les \"Détails visuels\" de chaque produit de ton catalogue. " +
    "Présente-le directement et avec assurance, comme un vendeur qui connaît son stock par cœur — ne dis JAMAIS que tu \"reconnais\", \"identifies\" ou \"analyses\" l'image à voix haute, ça sonne comme si tu débutais dans ta propre boutique. " +
    "Annonce la disponibilité en langage humain et naturel, intégré dans la phrase : \"disponible\" si le produit est en stock, \"malheureusement plus disponible\" (ou une formulation équivalente) sinon. N'écris JAMAIS \"Statut :\" suivi d'un label technique comme \"EN STOCK\" ou \"RUPTURE\" — ce n'est pas un vendeur, c'est un robot d'inventaire qui parle comme ça. " +
    "Ne rajoute pas non plus d'annonce artificielle du type \"Bonne nouvelle —\" : donne l'info directement, avec un ton chaleureux mais sobre. " +
    "S'il y a un doute entre deux articles très similaires, pose une question de clarification au client plutôt que de deviner. " +
    "Si l'article est indisponible, signale-le poliment et invite le client à regarder d'autres articles disponibles. " +
    "Si rien ne correspond clairement dans le catalogue, dis-le honnêtement et demande une précision, sans jamais inventer un prix ou une disponibilité.";

  const messageUtilisateur = {
    role: 'user',
    content: [
      { type: 'text', text: instructionAnalyseImage },
      { type: 'image', source: { type: 'base64', media_type: imageClientMimeType, data: imageClientBase64 } },
    ],
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'accept-encoding': 'identity',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: [...history, messageUtilisateur],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API (vision) a répondu ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

async function askClaudeReporting(transcript) {
  const systemPrompt =
    "Tu es l'assistant de gestion d'un commerçant ivoirien. Analyse ces conversations de la journée et fais un bilan STRICTEMENT en 3 points très simples, sans termes techniques : " +
    "1. Combien de clients UNIQUES ont écrit — compte par numéro de téléphone distinct, jamais par nombre de messages. Si le même numéro a envoyé plusieurs messages séparés, ça reste UN SEUL client, pas plusieurs. " +
    "2. Qui a CONFIRMÉ vouloir acheter et quoi (donne le numéro du client) — UNIQUEMENT si le client a exprimé une intention claire de finaliser (ex: \"je le prends\", \"je commande\", \"envoyez les détails de livraison\", a donné une adresse ou confirmé un paiement). " +
    "IMPORTANT : un client qui a SEULEMENT demandé un prix, un stock, ou une information, SANS confirmer vouloir acheter, n'est PAS un client prêt à acheter — dis plutôt qu'il \"s'est renseigné sur le prix\" ou \"a montré de l'intérêt sans confirmer\", ne dis jamais qu'il est \"prêt à commander\" dans ce cas. " +
    "Si aucun client n'a confirmé d'achat, dis-le clairement plutôt que d'exagérer une simple demande de prix. " +
    "3. Le produit le plus demandé. " +
    "FORMAT OBLIGATOIRE : numérote 1., 2., 3. chacun sur sa PROPRE ligne (saut de ligne avant chaque numéro), jamais les trois à la suite sur une seule ligne." +
    REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES + REGLE_PRECISION_EMOJI_PRODUIT;

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

  await sendAlerteTemplate(merchant.phone_number_id, merchant.numero_proprietaire, merchant.nom_commerce, texteAlerte);
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

// ─── ALERTE D'ESCALADE (INFO MANQUANTE, RÉCLAMATION, NÉGOCIATION, MÉCONTENTEMENT) ──
//
// Même mécanique que l'alerte de commande : une phrase verrouillée dans le
// prompt ("Notre équipe est informée et reviendra vers vous si besoin.")
// déclenche la détection, plutôt que de faire juger l'IA sans ancrage fiable.

/**
 * Extrait la catégorie et un résumé court du motif d'escalade, à partir de la
 * conversation. Appelée UNIQUEMENT quand le code a déjà vérifié la présence
 * de la phrase verrouillée dans la réponse du bot.
 */
async function extraireDetailsEscalade(transcript, dernierMessageClient) {
  const systemPrompt =
    "Le bot d'un commerçant vient d'escalader une situation vers le propriétaire, DÉCLENCHÉE PAR LE TOUT DERNIER MESSAGE DU CLIENT (fourni séparément ci-dessous). " +
    "Détermine la catégorie exacte de CE dernier message précis (ignore les sujets plus anciens de l'historique déjà résolus ou différents) parmi ces trois choix : " +
    "\"info_manquante\" (une information précise manquait), \"reclamation\" (réclamation ou litige), \"negociation_hors_bareme\" (négociation de prix/condition hors barème). " +
    "Réponds UNIQUEMENT avec un objet JSON compact, sans aucun texte autour : " +
    "{\"categorie\":\"...\",\"resume\":\"...\"} — le résumé doit tenir en une phrase courte et concrète, basée sur CE dernier message (ex: \"Le client demande si la livraison est possible à Yopougon, non précisé dans mes instructions\").";

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
        messages: [{ role: 'user', content: `Historique complet (contexte) :\n${transcript}\n\n---\nTOUT DERNIER MESSAGE DU CLIENT (celui qui a déclenché l'escalade) :\n${dernierMessageClient}` }],
      }),
    });

    if (!response.ok) {
      console.error('🚨 Extraction détails escalade — API Claude a répondu', response.status);
      return { categorie: 'info_manquante', resume: 'Détails non disponibles (erreur technique).' };
    }

    const data = await response.json();
    const raw = nettoyerJSON(data.content?.filter(b => b.type === 'text').map(b => b.text).join('').trim());
    return JSON.parse(raw);
  } catch (err) {
    console.error('🚨 Extraction détails escalade échouée (vérifier manuellement) :', err.message);
    return { categorie: 'info_manquante', resume: 'Détails non disponibles (erreur technique).' };
  }
}

const LIBELLES_CATEGORIE_ESCALADE = {
  info_manquante: 'Information manquante',
  reclamation: 'Réclamation / litige',
  negociation_hors_bareme: 'Négociation hors barème',
};

/**
 * Envoie une alerte WhatsApp immédiate au propriétaire dès que le bot escalade
 * une situation (phrase verrouillée détectée). Une seule alerte par sujet
 * précis pour ce client — comparaison au dernier motif déjà alerté, stocké
 * dans client_profiles, pour éviter le spam si la conversation continue sur
 * le même point.
 */
async function detecterEtAlerterEscalade(sessionId, merchant, from, history, reply) {
  if (!reply.includes('Notre équipe est informée et reviendra vers vous')) {
    return; // Pas d'escalade explicite dans cette réponse — rien à faire
  }

  const profile = await getClientProfile(sessionId);

  const transcript = [...history, { role: 'assistant', content: reply }]
    .map(m => `${m.role === 'user' ? 'Client' : 'Bot'}: ${m.content}`)
    .join('\n');

  const dernierMessageClient = [...history].reverse().find(m => m.role === 'user')?.content || '';

  const detection = await extraireDetailsEscalade(transcript, dernierMessageClient);
  console.log(`Escalade détectée pour ${sessionId} — détails :`, JSON.stringify(detection));

  const signatureNouvelle = `${detection.categorie || ''}|${detection.resume || ''}`;
  const signaturePrecedente = profile?.derniere_escalade_alertee || '';

  if (signatureNouvelle === signaturePrecedente) {
    console.log(`Escalade — ${sessionId} : même sujet déjà alerté, on ignore.`);
    return;
  }

  if (!merchant.numero_proprietaire) {
    console.error(`🚨 Escalade pour ${merchant.nom_commerce} mais numero_proprietaire manquant — alerte impossible, vérifier Supabase`);
    return;
  }

  const libelle = LIBELLES_CATEGORIE_ESCALADE[detection.categorie] || 'Situation à vérifier';
  const texteAlerte =
    `⚠️ *${libelle} — ${merchant.nom_commerce}*\n\n` +
    `Client : ${from}\n` +
    `Résumé : ${detection.resume || 'non précisé'}\n\n` +
    `Le bot a informé le client que vous seriez tenu au courant.`;

  await sendAlerteTemplate(merchant.phone_number_id, merchant.numero_proprietaire, merchant.nom_commerce, texteAlerte);
  await saveClientProfile(sessionId, { derniere_escalade_alertee: signatureNouvelle });
  console.log(`Alerte escalade envoyée pour ${merchant.nom_commerce} (client ${from}) — ${libelle}`);
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

      await sendBilanTemplate(phone_number_id, numero_proprietaire, nom_commerce, 'la journée', bilan);
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
    REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES + REGLE_PRECISION_EMOJI_PRODUIT;

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

      await sendBilanTemplate(phone_number_id, numero_proprietaire, nom_commerce, 'la semaine', bilan);
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

// ─── ROUTES CATALOGUE (GESTION DES PHOTOS PRODUITS) ───────────────────────────
//
// Utilisées par l'onglet "Catalogue" du dashboard, sur la fiche de chaque
// commerçant. La photo arrive en base64 depuis le formulaire (pas de champ
// de formulaire HTML classique, tout passe en JSON comme le reste de l'API).

app.get('/merchants/:phone_number_id/catalogue', async (req, res) => {
  const { phone_number_id } = req.params;
  const produits = await getCatalogueProduits(phone_number_id);
  res.json({ produits });
});

app.post('/merchants/:phone_number_id/catalogue', async (req, res) => {
  const { phone_number_id } = req.params;
  const { nom_produit, prix, variante, description, en_rupture, image_url } = req.body;

  if (!nom_produit || !prix || !description) {
    return res.status(400).json({ error: 'nom_produit, prix et description (détails visuels) sont requis' });
  }

  try {
    const { data, error } = await supabase.from('catalogue_produits').insert([{
      phone_number_id,
      nom_produit,
      prix,
      variante: variante || null,
      description,
      en_rupture: en_rupture === true,
      image_url: image_url || null,
    }]).select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ produit: data[0] });
  } catch (err) {
    console.error('Erreur ajout produit catalogue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/catalogue/:id', async (req, res) => {
  const { id } = req.params;
  const { nom_produit, prix, variante, description, en_rupture, image_url } = req.body;

  try {
    const produitExistant = await getProduitCatalogue(id);
    if (!produitExistant) return res.status(404).json({ error: 'Produit introuvable' });

    const misAJour = {};
    if (nom_produit !== undefined) misAJour.nom_produit = nom_produit;
    if (prix !== undefined) misAJour.prix = prix;
    if (variante !== undefined) misAJour.variante = variante;
    if (description !== undefined) misAJour.description = description;
    if (en_rupture !== undefined) misAJour.en_rupture = en_rupture === true;
    if (image_url !== undefined) misAJour.image_url = image_url || null;

    const { data, error } = await supabase
      .from('catalogue_produits')
      .update(misAJour)
      .eq('id', id)
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ produit: data[0] });
  } catch (err) {
    console.error('Erreur modification produit catalogue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload d'une photo produit vers Supabase Storage (bucket public "produits").
// Reçoit l'image en base64 depuis le dashboard, retourne l'URL publique à
// stocker dans catalogue_produits.image_url. Photo optionnelle : sert
// uniquement au rebond commercial (tag PHOTO_PRODUIT), jamais à la
// reconnaissance d'image (qui reste basée sur le texte "Détails visuels").
app.post('/upload-image', async (req, res) => {
  const { imageBase64, mimeType } = req.body;

  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'imageBase64 et mimeType requis' });
  }

  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    const extension = (mimeType.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
    const cheminFichier = `catalogue/${crypto.randomUUID()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from('produits')
      .upload(cheminFichier, buffer, { contentType: mimeType, upsert: false });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const { data } = supabase.storage.from('produits').getPublicUrl(cheminFichier);
    res.json({ image_url: data.publicUrl });
  } catch (err) {
    console.error('Erreur upload image catalogue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/catalogue/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const produitExistant = await getProduitCatalogue(id);
    if (!produitExistant) return res.status(404).json({ error: 'Produit introuvable' });

    const { error } = await supabase.from('catalogue_produits').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur suppression produit catalogue:', err.message);
    res.status(500).json({ error: err.message });
  }
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

    // Les webhooks Meta couvrent aussi les accusés de statut (envoyé/lu/livré/
    // échoué), qui n'ont pas de champ "messages". On les logue (surtout les
    // échecs) pour diagnostiquer les cas où Meta accepte l'envoi (200 OK) mais
    // échoue à livrer ensuite silencieusement, sans qu'aucune erreur ne
    // remonte à notre code au moment de l'envoi.
    if (!message) {
      const statut = value?.statuses?.[0];
      if (statut) {
        if (statut.status === 'failed') {
          const erreur = statut.errors?.[0];
          console.error(`🚨 Échec de livraison Meta — destinataire ${statut.recipient_id}, message ${statut.id} : ${erreur?.title || 'raison inconnue'} (code ${erreur?.code || '?'})`);
        } else {
          console.log(`Statut message ${statut.id} → ${statut.status} (destinataire ${statut.recipient_id})`);
        }
      }
      return;
    }

    // ID du numéro Meta qui a REÇU ce message — identifie le commerçant concerné.
    const phoneNumberId = value?.metadata?.phone_number_id;
    const from = normaliserNumeroIvoirien(message.from);

    // Les clients peuvent envoyer une photo (produit vu sur les réseaux) au
    // lieu d'un texte. On télécharge alors la photo depuis Meta pour
    // l'analyser en vision ; le texte sauvegardé sert de trace lisible dans
    // l'historique (pas d'affichage d'image dans le transcript texte).
    let incomingMsg = message.text?.body;
    let imageClient = null;

    if (message.type === 'image' && message.image?.id) {
      try {
        imageClient = await telechargerMediaMeta(message.image.id);
      } catch (err) {
        console.error('🚨 Erreur téléchargement photo client (Meta):', err.message);
      }
      incomingMsg = message.image.caption || '[Photo envoyée par le client]';
    }

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
    const [history, profile, catalogue] = await Promise.all([
      getHistoryFromSupabase(sessionId),
      getClientProfile(sessionId),
      getCatalogueProduits(phoneNumberId),
    ]);

    // System prompt propre au commerçant (fallback sur le prompt générique
    // si jamais system_prompt est vide dans Supabase)
    const basePrompt = merchant.system_prompt || SYSTEM_WHATSAPP_BASE;
    const profileLine = formatProfileForPrompt(profile);
    const catalogueLine = formatCatalogueForPrompt(catalogue);
    const ligneStatutTemps = formatDateHeureAbidjan();
    const systemPrompt = basePrompt + REGLE_FORMATAGE_WHATSAPP + REGLE_EMOTICONES + REGLE_CONFIRMATION_COMMANDE + REGLE_ESCALADE + REGLE_POLITESSE_SALUTATION + profileLine + catalogueLine + REGLE_CATALOGUE_TEMPS_REEL + REGLE_ALTERNATIVE_RUPTURE + REGLE_PHOTO_PRODUIT + ligneStatutTemps;

    const historiquePourAppel = history.slice(-MAX_HISTORY_ENVOYE_A_CLAUDE);

    // Réponse principale — vision si le client a envoyé une photo, sinon texte classique
    let replyBrut;
    if (imageClient) {
      // Le message "user" qu'on vient de sauvegarder ci-dessus (placeholder
      // "[Photo envoyée par le client]") est déjà le dernier élément de
      // `history`. askClaudeAvecImage rajoute son propre tour "user" (la
      // vraie image) : si on lui passait `history` tel quel, Claude recevrait
      // deux tours "client" collés d'affilée, et s'ancrerait sur d'anciens
      // échanges au lieu de traiter cette photo comme la question actuelle.
      // On retire donc ce placeholder avant l'appel vision.
      const historyPourVision = historiquePourAppel.slice(0, -1);
      try {
        replyBrut = await askClaudeAvecImage(historyPourVision, systemPrompt, imageClient.base64, imageClient.mimeType, message.image.caption || '');
      } catch (err) {
        console.error('🚨 Erreur analyse vision de la photo client:', err.message);
        replyBrut = "Merci pour la photo ! Je n'arrive pas à l'analyser pour le moment — pourriez-vous me préciser le nom du produit qui vous intéresse ?";
      }
    } else {
      replyBrut = await askClaude(historiquePourAppel, systemPrompt);
    }
    // Retire le tag technique PHOTO_PRODUIT (invisible pour le client) avant
    // toute sauvegarde ou envoi — voir REGLE_PHOTO_PRODUIT.
    const { texteNettoye: reply, nomProduitPhoto } = extraireTagPhotoProduit(replyBrut);

    await saveMessageToSupabase(sessionId, 'assistant', reply);

    // Extraction et mise à jour du profil en arrière-plan (non bloquant —
    // une info de confort manquée n'a pas de conséquence grave)
    const historyForExtraction = [...history, { role: 'assistant', content: reply }];
    extractAndUpdateProfile(sessionId, historyForExtraction).catch(() => {});

    await sendWhatsAppMessage(phoneNumberId, from, reply);

    // Envoi de la photo du produit recommandé, UNIQUEMENT si Claude a posé le
    // tag PHOTO_PRODUIT et que ce produit a une photo enregistrée. Jamais plus
    // d'une photo par réponse (un seul tag possible, une seule fiche trouvée).
    if (nomProduitPhoto) {
      const produitPhoto = trouverProduitParNom(catalogue, nomProduitPhoto);
      if (produitPhoto?.image_url) {
        try {
          await envoyerImageWhatsApp(phoneNumberId, from, produitPhoto.image_url);
        } catch (err) {
          console.error(`🚨 Erreur envoi photo produit alternative (${nomProduitPhoto}) :`, err.message);
        }
      } else {
        console.log(`Tag PHOTO_PRODUIT reçu pour "${nomProduitPhoto}" mais aucune photo enregistrée — poursuite en texte seul.`);
      }
    }

    // Détection de commande confirmée + alerte immédiate au marchand.
    // Contrairement à l'extraction de profil, on ATTEND ce résultat et on
    // logue clairement (🚨) en cas d'échec — une commande manquée est une
    // vente perdue, pas un détail de confort.
    try {
      await detecterEtAlerterCommande(sessionId, merchant, from, history, reply);
    } catch (err) {
      console.error(`🚨 Erreur alerte commande pour ${merchant.nom_commerce} (${sessionId}) :`, err.message);
    }

    // Détection d'escalade (info manquante, réclamation, négociation hors
    // barème, client mécontent) + alerte immédiate au marchand.
    try {
      await detecterEtAlerterEscalade(sessionId, merchant, from, history, reply);
    } catch (err) {
      console.error(`🚨 Erreur alerte escalade pour ${merchant.nom_commerce} (${sessionId}) :`, err.message);
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
