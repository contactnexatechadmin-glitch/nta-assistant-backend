import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function analyserEtSauvegarderMetadata(sessionId, texteMessage) {
  try {
    const systemPromptMetadata = 
      "Tu es un agent d'analyse de données spécialisé dans le e-commerce.\n" +
      "Analyse le message d'un client et extrait les informations STRICTEMENT au format JSON.\n" +
      "Ne renvoie RIEN d'autre que le JSON (pas de phrases d'introduction, pas de balises markdown).\n\n" +
      "Structure attendue :\n" +
      "{\n" +
      "  \"intent_category\": \"vente\" ou \"demande_prix\" ou \"disponibilite_stock\" ou \"reclamation\" ou \"autre\",\n" +
      "  \"product_mentioned\": \"nom du produit\" ou null,\n" +
      "  \"estimated_value\": nombre (montant estimé si achat/commande, ex: 15000) ou 0,\n" +
      "  \"requires_action\": true ou false,\n" +
      "  \"action_details\": \"résumé de l'action humaine nécessaire\" ou null\n" +
      "}";

    const messagePayload = [{ role: 'user', content: texteMessage }];
    
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
        system: systemPromptMetadata,
        messages: messagePayload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Échec analyse Claude: ${response.status}`);
    }

    const data = await response.json();
    const rawText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    const metadata = JSON.parse(rawText);

    const { error } = await supabase
      .from('interactions_metadata')
      .insert([{
        session_id: sessionId,
        intent_category: metadata.intent_category || 'autre',
        product_mentioned: metadata.product_mentioned || null,
        estimated_value: metadata.estimated_value || 0,
        requires_action: metadata.requires_action || false,
        action_details: metadata.action_details || null
      }]);

    if (error) {
      console.error('Erreur insertion interactions_metadata:', error.message);
    }
  } catch (err) {
    console.error('Erreur lors de l\'extraction/sauvegarde des métadonnées:', err.message);
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

// SERVIR LE DASHBOARD SUR LA ROUTE RACINE
app.get('/', (req, res) => { 
  res.sendFile(path.join(__dirname, 'nta_dashboard_reporting.html')); 
});

// ROUTE DE REPORTING EN JSON (UTILISÉE PAR LE DASHBOARD)
app.get('/reporting', async (req, res) => {
  try {
    const { data: records, error } = await supabase
      .from('interactions_metadata')
      .select('*')
      .order('interaction_date', { ascending: false });

    if (error) throw error;

    let totalValue = 0;
    let actionsCount = 0;
    const categoriesMap = {};

    records.forEach(rec => {
      totalValue += Number(rec.estimated_value || 0);
      if (rec.requires_action) actionsCount++;
      
      const cat = rec.intent_category || 'autre';
      categoriesMap[cat] = (categoriesMap[cat] || 0) + 1;
    });

    res.json({
      summary: {
        total_interactions: records.length,
        estimated_pipeline_value: totalValue,
        pending_actions_count: actionsCount
      },
      categories_distribution: categoriesMap,
      recent_leads: records
    });
  } catch (err) {
    console.error('Erreur génération reporting:', err.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des données de reporting' });
  }
});

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
    analyserEtSauvegarderMetadata(from, incomingMsg);

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
    analyserEtSauvegarderMetadata(sessionId, message);

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
