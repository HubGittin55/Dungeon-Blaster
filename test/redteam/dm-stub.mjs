// Slow DM stub on :8080. Delays 2s per completion so two rounds genuinely overlap.
// Returns a craft mutation citing slot 1's first intent id found in the prompt.
import { createServer } from 'node:http';
const DELAY = Number(process.env.DM_DELAY_MS || 2000);
const server = createServer(async (req, res) => {
  if (req.url === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const text = JSON.stringify(body.messages || []);
    // find slot 1's first intent id: "[r1s1] slot 1: ..."
    const m = text.match(/\[([^\]]+)\]\s*slot 1:/);
    const intentId = m ? m[1] : 'i1';
    await new Promise((s) => setTimeout(s, DELAY));
    const contract = {
      narration: 'Bram works the wood and sinew into a lashed club.',
      mutations: [{
        id: 'm1', tool: 'craft_item', actor: 1, intent: intentId,
        args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] },
      }],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(contract) } }] }));
  }
  res.writeHead(404); res.end();
});
server.listen(8080, '127.0.0.1', () => console.log(`slow DM stub on :8080, delay ${DELAY}ms`));
