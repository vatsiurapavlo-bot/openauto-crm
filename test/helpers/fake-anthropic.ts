/**
 * Atrapa Anthropic Messages API do testów (lokalny serwer HTTP).
 * Zwraca zadany wynik narzędzia; zapisuje ostatnie żądanie, żeby sprawdzić, co wysyłamy (prywatność).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startFakeAnthropic() {
  const state = {
    status: 200,
    input: {} as Record<string, unknown> | null,
    raw: null as unknown,
    last: null as null | { headers: http.IncomingHttpHeaders; body: any },
    calls: 0,
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    state.calls++;
    let body: any = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      /* zły JSON */
    }
    state.last = { headers: req.headers, body };
    if (req.url !== '/v1/messages' || req.method !== 'POST') {
      res.writeHead(404);
      return res.end();
    }
    if (state.status !== 200) {
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    }
    const content =
      state.raw ??
      (state.input === null
        ? [{ type: 'text', text: 'Nie wiem' }]
        : [{ type: 'tool_use', id: 'toolu_1', name: body?.tool_choice?.name ?? 'x', input: state.input }]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content, stop_reason: 'tool_use' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
