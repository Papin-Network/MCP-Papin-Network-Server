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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ MCP Kanka server avviato:
  • Streamable HTTP: http://localhost:${PORT}/mcp
  • SSE (legacy):   http://localhost:${PORT}/sse`);
});
