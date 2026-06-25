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

// Récupère l'historique depuis Supabase (les X derniers messages, triés par date)
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

// Sauvegarde un nouveau message dans l'historique Supabase
async function saveMessageToSupabase(sessionId, role, content) {
  const { error } = await supabase
    .from('conversations')
    .insert([{ session_id: sessionId, role, content }]);

  if (error) {
    console.error('Erreur sauvegarde message Supabase:', error.message);
  }
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

// Vérifie dans Supabase si un numéro WhatsApp est suspendu.
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
    // Vérification du statut avant toute réponse IA
    const suspendu = await estSuspendu(from);
    if (suspendu) {
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response><Message>${escapeXml(MESSAGE_ACCES_COUPE)}</Message></Response>`);
    }

    // 1. Sauvegarde le message reçu du client dans Supabase
    await saveMessageToSupabase(from, 'user', incomingMsg);
    
    // 2. Récupère l'historique complet (y compris le message actuel)
    const history = await getHistoryFromSupabase(from);
    
    // 3. Demande la réponse à Claude
    const reply = await askClaude(history, SYSTEM_WHATSAPP);
    
    // 4. Sauvegarde la réponse de l'IA dans Supabase
    await saveMessageToSupabase(from, 'assistant', reply);

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
    // 1. Sauvegarde le message de la démo
    await saveMessageToSupabase(sessionId, 'user', message);
    
    // 2. Récupère l'historique
    const history = await getHistoryFromSupabase(sessionId);
    
    // 3. Interroge Claude
    const reply = await askClaude(history, SYSTEM_DEMO);
    
    // 4. Sauvegarde la réponse
    await saveMessageToSupabase(sessionId, 'assistant', reply);

    res.json({ reply });
  } catch (err) {
    console.error('Erreur démo Claude API:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ===== Routes de gestion des clients (dashboard) =====

// Ajouter un nouveau client
app.post('/clients', async (req, res) => {
  const { name, whatsapp_number, sector, price, start_date, trial } = req.body;

  if (!name || !whatsapp_number || !start_date) {
    return res.status(400).json({ error: 'name, whatsapp_number et start_date sont requis' });
  }

  const { data, error } = await supabase
    .from('clients')
    .insert([
      {
        name,
        whatsapp_number,
        sector: sector || null,
        price: price || 29000,
        start_date,
        trial: trial !== undefined ? trial : true,
        suspended: false,
      },
    ])
    .select();

  if (error) {
    console.error('Erreur ajout client Supabase:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ client: data[0] });
});

// Mettre à jour un client existant
app.patch('/clients/:whatsapp', async (req, res) => {
  const { whatsapp } = req.params;
  const updates = req.body;

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('whatsapp_number', whatsapp)
    .select();

  if (error) {
    console.error('Erreur mise à jour client Supabase:', error.message);
    return res.status(500).json({ error: error.message });
  }

  if (!data || data.length === 0) {
    return res.status(404).json({ error: 'Client non trouvé' });
  }

  res.json({ client: data[0] });
});

// Supprimer un client
app.delete('/clients/:whatsapp', async (req, res) => {
  const { whatsapp } = req.params;

  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('whatsapp_number', whatsapp);

  if (error) {
    console.error('Erreur suppression client Supabase:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.status(204).send();
});

// Lister tous les clients
app.get('/clients', async (req, res) => {
  const { data, error } = await supabase.from('clients').select('*');

  if (error) {
    console.error('Erreur lecture clients Supabase:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ clients: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
