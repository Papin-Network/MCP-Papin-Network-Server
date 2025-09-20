import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const KANKA_BASE = 'https://kanka.io/api/1.0';
const TOKEN = process.env.KANKA_TOKEN;
const DEFAULT_CAMPAIGN_ID = process.env.KANKA_CAMPAIGN_ID || null;
const PORT = Number(process.env.PORT || 3030);

if (!TOKEN) {
  console.error('❌ Manca KANKA_TOKEN nel .env');
  process.exit(1);
}

async function kanka(path, init = {}) {
  const res = await fetch(`${KANKA_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Kanka ${res.status} ${res.statusText}: ${txt}`);
  }
  return res.json();
}

const server = new McpServer({
  name: 'mcp-kanka',
  version: '0.2.0'
});

/** TOOL: lista campagne */
server.registerTool(
  'kanka_list_campaigns',
  {
    title: 'List Campaigns',
    description: 'Lista tutte le campagne accessibili.',
    inputSchema: {}
  },
  async () => {
    const data = await kanka('/campaigns');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

/** TOOL: lista entità per tipo */
server.registerTool(
  'kanka_list_entities',
  {
    title: 'List Entities',
    description: 'Lista entità (characters, locations, items, ecc.) in una campagna.',
    inputSchema: {
      campaign_id: z.string().optional(),
      entity: z.string().describe('characters | locations | items | families | notes | journals | quests | organizations | races | events | tags | abilities | calendars | dice_rolls')
    }
  },
  async ({ campaign_id, entity }) => {
    const campaignId = campaign_id || DEFAULT_CAMPAIGN_ID;
    if (!campaignId) throw new Error('campaign_id mancante e KANKA_CAMPAIGN_ID non impostato');
    const data = await kanka(`/campaigns/${campaignId}/${entity}?page=1&limit=100`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

/** TOOL: dettaglio entità */
server.registerTool(
  'kanka_get_entity',
  {
    title: 'Get Entity',
    description: 'Dettaglio entità per tipo + id.',
    inputSchema: {
      campaign_id: z.string().optional(),
      entity: z.string(),
      id: z.number()
    }
  },
  async ({ campaign_id, entity, id }) => {
    const campaignId = campaign_id || DEFAULT_CAMPAIGN_ID;
    if (!campaignId) throw new Error('campaign_id mancante e KANKA_CAMPAIGN_ID non impostato');
    const data = await kanka(`/campaigns/${campaignId}/${entity}/${id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

/** TOOL: ricerca per nome */
server.registerTool(
  'kanka_search_by_name',
  {
    title: 'Search by Name',
    description: 'Ricerca entità per nome (match parziale).',
    inputSchema: {
      campaign_id: z.string().optional(),
      entity: z.string(),
      name: z.string()
    }
  },
  async ({ campaign_id, entity, name }) => {
    const campaignId = campaign_id || DEFAULT_CAMPAIGN_ID;
    if (!campaignId) throw new Error('campaign_id mancante e KANKA_CAMPAIGN_ID non impostato');
    const data = await kanka(`/campaigns/${campaignId}/${entity}?name=${encodeURIComponent(name)}&page=1&limit=50`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

/** TOOL: chiamata grezza GET */
server.registerTool(
  'kanka_raw_get',
  {
    title: 'Raw GET',
    description: 'Chiama un path Kanka non coperto dagli altri tool (solo GET).',
    inputSchema: { path: z.string().describe('Es: /campaigns/123/characters?page=2') }
  },
  async ({ path }) => {
    const data = await kanka(path);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ---- App HTTP con compatibilità doppio trasporto ----
const app = express();
app.use(express.json());

// STREAMABLE HTTP (moderno): /mcp
app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ request: req, response: res });
  await server.connect(transport);
});

// SSE Legacy (per client più vecchi): /sse + /messages
const sseTransports = /** @type {Record<string, SSEServerTransport>} */ ({});

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  sseTransports[transport.sessionId] = transport;
  res.on('close', () => delete sseTransports[transport.sessionId]);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (!transport) return res.status(400).send('No transport for sessionId');
  await transport.handlePostMessage(req, res, req.body);
});

app.get('/', (_req, res) => {
  const rows = [
    {
      label: 'KANKA_TOKEN',
      present: Boolean(TOKEN),
      description: 'Token API obbligatorio per autenticarsi su Kanka.'
    },
    {
      label: 'KANKA_CAMPAIGN_ID',
      present: Boolean(DEFAULT_CAMPAIGN_ID),
      description: 'Facoltativo. Impostato come campagna predefinita per le chiamate.'
    }
  ].map(({ label, present, description }) => `
        <tr>
          <td>${label}</td>
          <td><span class="status status-${present ? 'ok' : 'warn'}">${present ? 'CONFIGURATO' : 'NON IMPOSTATO'}</span></td>
          <td>${description}</td>
        </tr>`).join('');

  res.type('html').send(`<!DOCTYPE html>
  <html lang="it">
    <head>
      <meta charset="utf-8" />
      <title>MCP Papin Network Server • Debug</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root {
          color-scheme: light dark;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: radial-gradient(circle at top, #12121a, #050506);
          color: #f5f5f5;
          min-height: 100%;
        }
        body {
          margin: 0;
          padding: 3rem 1.5rem 4rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .card {
          width: min(960px, 100%);
          background: rgba(13, 17, 23, 0.92);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 18px;
          padding: 2.75rem clamp(1.5rem, 5vw, 3.5rem);
          backdrop-filter: blur(12px);
          box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
        }
        h1 {
          margin-top: 0;
          font-size: clamp(2rem, 5vw, 2.75rem);
          letter-spacing: 0.04em;
        }
        p {
          line-height: 1.6;
          color: rgba(245, 245, 245, 0.85);
        }
        .grid {
          margin-top: 2.5rem;
          display: grid;
          gap: 1.75rem;
        }
        section {
          background: rgba(255, 255, 255, 0.03);
          border-radius: 12px;
          padding: 1.5rem clamp(1rem, 4vw, 1.75rem);
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        section h2 {
          margin-top: 0;
          font-size: 1.25rem;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 1rem;
          font-size: 0.95rem;
        }
        th, td {
          padding: 0.5rem 0.75rem;
          text-align: left;
        }
        tr:not(:last-child) td {
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .status {
          font-weight: 600;
          letter-spacing: 0.04em;
          padding: 0.35rem 0.75rem;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
        }
        .status-ok {
          background: rgba(46, 204, 113, 0.15);
          color: #2ecc71;
        }
        .status-warn {
          background: rgba(241, 196, 15, 0.18);
          color: #f1c40f;
        }
        code {
          background: rgba(255, 255, 255, 0.08);
          padding: 0.15rem 0.4rem;
          border-radius: 6px;
          font-size: 0.9rem;
        }
        button {
          background: #6c5ce7;
          color: white;
          border: none;
          padding: 0.7rem 1.2rem;
          border-radius: 999px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        button:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 25px rgba(108, 92, 231, 0.25);
        }
        .endpoint-list {
          display: grid;
          gap: 1rem;
        }
        .endpoint {
          padding: 0.9rem 1rem;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.04);
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 0.95rem;
        }
        .endpoint span {
          display: block;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.6);
          margin-top: 0.2rem;
        }
        footer {
          margin-top: 3rem;
          font-size: 0.85rem;
          text-align: center;
          color: rgba(255, 255, 255, 0.55);
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>MCP Papin Network Server</h1>
        <p>Questa pagina di atterraggio ti aiuta a verificare rapidamente che il server e la configurazione per l'integrazione con Kanka siano operativi.</p>
        <div class="grid">
          <section>
            <h2>Stato runtime</h2>
            <p id="health-message">Verifica in corso...</p>
            <button id="health-check">Riesegui controllo /health</button>
          </section>
          <section>
            <h2>Variabili d'ambiente</h2>
            <table>
              <thead>
                <tr>
                  <th>Chiave</th>
                  <th>Stato</th>
                  <th>Descrizione</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </section>
          <section>
            <h2>Endpoint disponibili</h2>
            <div class="endpoint-list">
              <div class="endpoint">
                GET <code>/health</code>
                <span>Controllo rapido per assicurarsi che il server Express risponda.</span>
              </div>
              <div class="endpoint">
                POST <code>/mcp</code>
                <span>Endpoint principale per il trasporto Streamable MCP (preferito).</span>
              </div>
              <div class="endpoint">
                GET <code>/sse</code> &amp; POST <code>/messages</code>
                <span>Trasporto legacy basato su SSE per client meno recenti.</span>
              </div>
            </div>
          </section>
        </div>
        <footer>
          Suggerimento: usa <code>curl http://localhost:${PORT}/health</code> o un client MCP compatibile per testare gli endpoint.
        </footer>
      </div>
      <script>
        const healthMessage = document.getElementById('health-message');
        const healthButton = document.getElementById('health-check');

        async function checkHealth() {
          healthMessage.textContent = 'Verifica in corso...';
          try {
            const response = await fetch('/health');
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const body = await response.json();
            healthMessage.innerHTML = '✅ /health OK — <code>' + JSON.stringify(body) + '</code>';
          } catch (error) {
            console.error(error);
            healthMessage.innerHTML = '❌ Errore nella chiamata a /health: <code>' + error.message + '</code>';
          }
        }

        healthButton.addEventListener('click', checkHealth);
        checkHealth();
      </script>
    </body>
  </html>`);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ MCP Kanka server avviato:
  • Streamable HTTP: http://localhost:${PORT}/mcp
  • SSE (legacy):   http://localhost:${PORT}/sse`);
});
