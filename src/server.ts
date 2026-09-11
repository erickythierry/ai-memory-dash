import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/server.js roda de dentro de dist/, entao a raiz do projeto fica um nivel acima.
const ROOT = path.resolve(__dirname, '..');

// Respostas do ai-memory: JSON dinamico de um servico externo, sem schema
// publicado. Tipar campo a campo aqui so criaria um contrato falso.
type Json = any;

interface HealthMap extends Map<string, string[]> {}

// Carrega .env simples sem dependência externa
function loadEnv(): void {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        if (!process.env[k!.trim()]) {
          process.env[k!.trim()] = v.join('=').trim();
        }
      }
    }
  }
}
loadEnv();

const AI_MEMORY_URL = (process.env.AI_MEMORY_URL || '').replace(/\/+$/, '');
const AI_MEMORY_AUTH_TOKEN = process.env.AI_MEMORY_AUTH_TOKEN || '';

// Sem instancia padrao: a dash nao tem ai-memory proprio, aponta para o seu.
if (!AI_MEMORY_URL || !AI_MEMORY_AUTH_TOKEN) {
  console.error('Faltou configurar AI_MEMORY_URL e AI_MEMORY_AUTH_TOKEN. Copie .env.example para .env.');
  process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3838', 10);
const HOST = process.env.HOST || '127.0.0.1';
// ponytail: teto simples em vez de paginacao - o servidor aceita 500 sem cap
// e o maior projeto tem 77 paginas. Paginar quando algum passar disso.
const PAGE_LIMIT = 500;
// O upstream nao guarda backup nenhum: POST /admin/backup devolve o tar.gz no
// corpo e pronto. Quem quiser historico tem que salvar de fora — e este dir.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups');
const BACKUP_NAME = /^backup-[0-9T-]+\.tar\.gz$/;

let mcpReqId = 0;

// Helper para chamar ferramentas MCP do ai-memory
async function mcpCall(name: string, args: Record<string, unknown>): Promise<Json> {
  mcpReqId++;
  const mcpUrl = AI_MEMORY_URL.endsWith('/mcp') ? AI_MEMORY_URL : `${AI_MEMORY_URL}/mcp`;
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AI_MEMORY_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'User-Agent': 'ai-memory-dash/1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: mcpReqId,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`MCP error ${res.status}: ${txt}`);
  }

  const data = await res.json() as Json;
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  // ai-memory retorna resultado como string JSON dentro de data.result.content[0].text
  const content = data.result?.content?.[0]?.text;
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

// Proxy para a API v1 do ai-memory (projects, search, etc.)
async function fetchApiV1(subpath: string): Promise<Json> {
  const url = `${AI_MEMORY_URL}/api/v1${subpath}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${AI_MEMORY_AUTH_TOKEN}`,
      'User-Agent': 'ai-memory-dash/1.0'
    }
  });
  if (!res.ok) {
    throw new Error(`Upstream API v1 error ${res.status}`);
  }
  return res.json() as Promise<Json>;
}

// Rotas /admin do ai-memory: fora da API v1, sempre POST com corpo JSON.
// Sao as unicas que apagam projeto ou workspace inteiro — nao ha equivalente
// nas ferramentas MCP, que so deletam pagina a pagina.
async function adminPost(subpath: string, payload: Record<string, unknown>): Promise<Json> {
  const res = await fetch(`${AI_MEMORY_URL}/admin${subpath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AI_MEMORY_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ai-memory-dash/1.0'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) {
    // O upstream responde texto puro em erro de payload e JSON no resto.
    throw new Error(`Upstream admin${subpath} ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Listagem de paginas do projeto. Fonte unica: `memory_recent` cappa em 100
// hits e escondia a pagina 101 em diante (lista lateral, zip e sessoes).
async function listPages(workspace: string, project: string): Promise<Json[]> {
  const listing: Json = await fetchApiV1(
    `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/pages?limit=${PAGE_LIMIT}`
  );
  return Array.isArray(listing) ? listing : listing?.pages || [];
}

// Mapa path -> ['orphan'|'stale'|'duplicate'], para marcar as paginas na lista.
// Falha aqui nao pode derrubar a listagem: sem saude, so nao ha marcador.
async function healthByPath(workspace: string, project: string): Promise<HealthMap> {
  const map: HealthMap = new Map();
  try {
    const ov: Json = await fetchApiV1(
      `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/overview?limit=${PAGE_LIMIT}`
    );
    const buckets: Record<string, Json[] | undefined> = {
      orphan: ov?.health?.orphan_pages,
      stale: ov?.health?.stale_pages,
      duplicate: ov?.health?.duplicate_pages
    };
    for (const [flag, pages] of Object.entries(buckets)) {
      for (const p of pages || []) {
        if (!p?.path) continue;
        map.set(p.path, [...(map.get(p.path) || []), flag]);
      }
    }
  } catch (e) {
    console.error(`saude de ${project} indisponivel:`, errMsg(e));
  }
  return map;
}

// Erro em catch e `unknown` no TS; so queremos a mensagem para log e resposta.
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // ponytail: sem CORS de proposito - o frontend e same-origin e as rotas
  // DELETE/POST escrevem na memoria. Allow-Origin '*' deixava qualquer site
  // aberto no navegador apagar paginas via fetch.

  try {
    // 1. Static frontend. A SPA tem rotas reais (/p/<ws>/<proj>/doc/...), entao
    // qualquer GET que nao seja /api/ nem /static/ devolve o index e o roteador
    // do cliente resolve o caminho — sem isso, recarregar a pagina daria 404.
    const isAppRoute = req.method === 'GET'
      && !pathname.startsWith('/api/')
      && !pathname.startsWith('/static/');

    if (pathname === '/' || pathname === '/index.html' || isAppRoute) {
      const htmlPath = path.join(ROOT, 'public', 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8')
        .replaceAll('__AI_MEMORY_URL__', AI_MEMORY_URL);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (pathname.startsWith('/static/')) {
      const filePath = path.join(ROOT, 'public', pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    // 2. GET /api/projects
    if (pathname === '/api/projects' && req.method === 'GET') {
      const projects: Json[] = await fetchApiV1('/projects');

      // O /projects do upstream so traz page_count e last_updated. O /overview de
      // cada projeto traz sessoes, observacoes, handoffs e saude numa chamada so,
      // entao enriquece em paralelo. Um projeto que falhe vira stats null em vez
      // de derrubar a listagem inteira.
      const enriched = await Promise.all((projects || []).map(async (p: Json) => {
        try {
          const ov: Json = await fetchApiV1(
            `/workspaces/${encodeURIComponent(p.workspace_name)}/projects/${encodeURIComponent(p.project_name)}/overview`
          );
          const counts = ov?.briefing?.counts || {};
          const health = ov?.health || {};
          return {
            ...p,
            stats: {
              sessions: counts.sessions || 0,
              observations: counts.observations || 0,
              pages_all: counts.pages_all || 0,
              pending_handoffs: ov?.briefing?.pending_handoff_count || 0,
              // Separados de proposito. Orfao ("nenhum [[wikilink]] entra ou sai")
            // e quase sempre benigno: paginas de sessions/ e _lint/report.md caem
            // ai por natureza. Rot de verdade e stale (episodic parado ha 30d) e
            // titulo duplicado. health.contradictions e hardcoded 0 no upstream,
            // entao nao entra na conta.
            orphans: health.orphans || 0,
            rot: (health.stale || 0) + (health.duplicates || 0)
            }
          };
        } catch (e) {
          console.error(`overview de ${p.project_name} falhou:`, errMsg(e));
          return { ...p, stats: null };
        }
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(enriched));
      return;
    }

    // 2b. GET /api/workspaces — o nivel acima do projeto, com a contagem.
    if (pathname === '/api/workspaces' && req.method === 'GET') {
      const workspaces: Json = await fetchApiV1('/workspaces');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(workspaces || []));
      return;
    }

    // 2c. DELETE /api/project?workspace=...&project=...
    // Apaga o projeto inteiro (paginas, sessoes, observacoes, handoffs). O
    // upstream nao tem dry-run: sem `confirm` devolve 422 e nao apaga nada.
    if (pathname === '/api/project' && req.method === 'DELETE') {
      const workspace = parsedUrl.searchParams.get('workspace');
      const project = parsedUrl.searchParams.get('project');
      if (!workspace || !project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspace and project are required' }));
        return;
      }
      const result = await adminPost('/purge-project', { workspace, project, confirm: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 2d. DELETE /api/workspace?workspace=...
    // Leva junto todo projeto que estiver dentro. `default` fica de fora: e o
    // workspace de todo .ai-memory.toml da maquina, um clique nao pode zerar.
    if (pathname === '/api/workspace' && req.method === 'DELETE') {
      const workspace = parsedUrl.searchParams.get('workspace');
      if (!workspace) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspace is required' }));
        return;
      }
      if (workspace === 'default') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'o workspace default nao pode ser deletado pela dash' }));
        return;
      }
      const result = await adminPost('/delete-workspace', { workspace });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 2e. GET /api/backups — o que ja foi baixado para o disco da dash.
    if (pathname === '/api/backups' && req.method === 'GET') {
      const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];
      const list = files.filter(f => BACKUP_NAME.test(f)).map(name => {
        const st = fs.statSync(path.join(BACKUP_DIR, name));
        return { name, bytes: st.size, created: st.mtime.toISOString() };
      }).sort((a, b) => b.created.localeCompare(a.created));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    // 2f. POST /api/backup — pede um tar.gz novo ao upstream e guarda aqui.
    if (pathname === '/api/backup' && req.method === 'POST') {
      const upstream = await fetch(`${AI_MEMORY_URL}/admin/backup`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AI_MEMORY_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'ai-memory-dash/1.0'
        },
        body: '{}'
      });
      if (!upstream.ok) {
        throw new Error(`Upstream /admin/backup ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`);
      }
      // ponytail: buffer inteiro em memoria - o arquivo hoje tem 9 MB. Trocar
      // por stream se o wiki crescer a ponto de isso pesar.
      const buf = Buffer.from(await upstream.arrayBuffer());
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const name = `backup-${new Date().toISOString().slice(0, 19).replace(/[:]/g, '-')}.tar.gz`;
      fs.writeFileSync(path.join(BACKUP_DIR, name), buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, name, bytes: buf.length, created: new Date().toISOString() }));
      return;
    }

    // 2g. GET /api/backup/file?name=... e DELETE /api/backup?name=...
    // `name` vem da URL: so o formato gerado aqui passa, senao `../` deixaria
    // ler ou apagar qualquer arquivo do container.
    if ((pathname === '/api/backup/file' && req.method === 'GET')
      || (pathname === '/api/backup' && req.method === 'DELETE')) {
      const name = parsedUrl.searchParams.get('name') || '';
      const file = path.join(BACKUP_DIR, name);
      if (!BACKUP_NAME.test(name) || !fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'backup nao encontrado' }));
        return;
      }
      if (req.method === 'DELETE') {
        fs.unlinkSync(file);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': fs.statSync(file).size
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // 3. GET /api/search?q=...&workspace=...&project=...&limit=...
    if (pathname === '/api/search' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || '';
      const workspace = parsedUrl.searchParams.get('workspace');
      const project = parsedUrl.searchParams.get('project');
      // O default do upstream e 10, curto demais para uma tela de resultados.
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);

      // workspace e project so valem juntos: o upstream recusa um sem o outro.
      const scope = workspace && project
        ? `&workspace=${encodeURIComponent(workspace)}&project=${encodeURIComponent(project)}`
        : '';
      const results = await fetchApiV1(`/search?q=${encodeURIComponent(q)}&limit=${limit}${scope}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
      return;
    }

    // 4. GET /api/pages?workspace=...&project=...
    if (pathname === '/api/pages' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');
      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project parameter is required' }));
        return;
      }

      // A listagem v1 e a fonte: `memory_recent` cappa em 100 hits, o que
      // escondia a pagina 101 em diante. Em paralelo, o drill-down de saude
      // para marcar cada uma na lista. O `limit` do overview e o teto das listas
      // stale/duplicate/orphan: o default e 10, o que truncaria a marcacao.
      const [pages, health] = await Promise.all([
        listPages(workspace, project),
        healthByPath(workspace, project)
      ]);

      const hits = pages.map((p: Json) => ({
        ...p,
        kind: p.kind || 'note',
        tier: p.tier || 'semantic',
        health: health.get(p.path) || []
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hits));
      return;
    }

    // 5. GET /api/page?workspace=...&project=...&path=...
    if (pathname === '/api/page' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');
      const docPath = parsedUrl.searchParams.get('path');

      if (!project || !docPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project and path are required' }));
        return;
      }

      const page = await mcpCall('memory_read_page', { workspace, project, path: docPath });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(page));
      return;
    }

    // 5.0 GET /api/graph?workspace=...&project=...
    if (pathname === '/api/graph' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');
      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }

      // Os links so existem na pagina inteira: nem a listagem nem o /graph do
      // upstream (que e so cross-project) os trazem. Entao busca cada pagina em
      // paralelo — 77 paginas levam ~300ms.
      const paths: Json[] = await listPages(workspace, project);

      const pages: Json[] = await Promise.all(paths.map((p: Json) =>
        fetchApiV1(`/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/pages/${p.path}`)
          .catch(() => null)
      ));

      const nodes = new Map<string, Json>();
      // O upstream so resolve wikilink escrito com o path inteiro. Quem escreve
      // `[[mapa-repos]]` (estilo Obsidian) fica com `links: []` e a
      // pagina aparece orfa no grafo. Indice basename -> path fecha a lacuna.
      // ponytail: primeiro path vence quando dois arquivos tem o mesmo nome.
      const pathSet = new Set<string>(paths.map((p: Json) => p.path));
      const byBasename = new Map<string, string>();
      for (const p of paths) {
        const base = String(p.path).replace(/\.md$/, '').split('/').pop()!;
        if (!byBasename.has(base)) byBasename.set(base, p.path);
      }
      const bodyLinks = (page: Json): string[] => {
        const out: string[] = [];
        for (const m of String(page?.body_markdown || '').matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)) {
          const raw = m[1]!.trim().replace(/\.md$/, '');
          const hit = pathSet.has(`${raw}.md`) ? `${raw}.md` : byBasename.get(raw.split('/').pop()!);
          if (hit) out.push(hit);
        }
        return out;
      };
      const key = (ws: string, pr: string, pa: string) => `${ws}/${pr}/${pa}`;

      paths.forEach((p: Json, i: number) => {
        nodes.set(key(workspace, project, p.path), {
          id: key(workspace, project, p.path),
          workspace, project, path: p.path,
          title: p.title || p.path,
          kind: p.kind || 'note',
          tier: p.tier,
          // A listagem nao traz created_at; a pagina inteira, ja buscada acima, traz.
          created_at: pages[i]?.created_at || null,
          updated_at: pages[i]?.updated_at || p.updated_at || null,
          external: false,
          orphan: false, // recalculado pelo grau depois das arestas
          degree: 0
        });
      });

      const edges: { from: string; to: string }[] = [];
      const seen = new Set<string>();
      for (const page of pages) {
        if (!page?.path) continue;
        const from = key(page.workspace, page.project, page.path);
        const links: Json[] = [
          ...(page.links || []),
          ...bodyLinks(page).map((path) => ({ path }))
        ];
        for (const l of links) {
          if (!l.path) continue;
          const to = key(l.workspace || workspace, l.project || project, l.path);
          if (from === to || seen.has(`${from}>${to}`)) continue;
          seen.add(`${from}>${to}`);
          // Alvo em outro projeto vira no externo, para a aresta nao sumir.
          if (!nodes.has(to)) {
            nodes.set(to, {
              id: to,
              workspace: l.workspace || workspace,
              project: l.project || project,
              path: l.path,
              title: l.title || l.path,
              kind: l.kind || 'note',
              external: true,
              orphan: false,
              degree: 0
            });
          }
          edges.push({ from, to });
          nodes.get(from)!.degree++;
          nodes.get(to)!.degree++;
        }
      }

      // Orfa aqui e grau zero: o `orphan` do health upstream nao enxerga o
      // wikilink por basename e marcaria pagina conectada como orfa.
      for (const n of nodes.values()) n.orphan = n.degree === 0;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodes: [...nodes.values()], edges }));
      return;
    }

    // 5.1 GET /api/sessions?workspace=...&project=...
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');
      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }

      // A listagem do upstream e a fonte: traz toda sessao com seu
      // observation_count, consolidada em pagina wiki ou nao. Antes isto filtrava
      // memory_recent por 'sessions/', entao sessao sem pagina — justamente onde
      // ficam as observacoes ainda nao consolidadas — sumia da tela.
      const [listing, pages, briefing]: Json[] = await Promise.all([
        // include_open: sem isso o upstream esconde a sessao ainda em curso — a
        // que costuma ter as observacoes mais recentes. limit=100 e o teto dele.
        fetchApiV1(`/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/sessions?include_open=true&limit=100`),
        listPages(workspace, project),
        mcpCall('memory_briefing', { workspace, project })
      ]);

      // Casa cada sessao com a pagina consolidada correspondente, quando existe.
      const pageBySession = new Map<string, Json>();
      for (const h of pages as Json[]) {
        if (h.path.startsWith('sessions/')) {
          pageBySession.set(h.path.replace(/^sessions\//, '').replace(/\.md$/, ''), h);
        }
      }

      const sessions = (listing?.sessions || []).map((s: Json) => ({
        ...s,
        page: pageBySession.get(s.session_id) || null
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions, briefing }));
      return;
    }

    // 5.2 GET /api/session/observations?workspace=...&project=...&session_id=...&limit=...&offset=...
    if (pathname === '/api/session/observations' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');
      const sessionId = parsedUrl.searchParams.get('session_id') || undefined;
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
      const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);

      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }

      const args: Record<string, unknown> = { workspace, project, limit, offset, order: 'asc' };
      if (sessionId) args.session_id = sessionId;

      const data = await mcpCall('memory_read_session_observations', args);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    // 6. POST /api/page (Salvar ou Editar página)
    if (pathname === '/api/page' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data: Json = JSON.parse(body);

      const { workspace = 'default', project, path: docPath, body: docBody, tier = 'semantic', pinned = false, tags = [] } = data;
      if (!project || !docPath || docBody === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project, path, and body are required' }));
        return;
      }

      const writeArgs: Record<string, unknown> = { workspace, project, path: docPath, body: docBody, tier, pinned, tags };
      if (data.scope) writeArgs.scope = data.scope;

      const result = await mcpCall('memory_write_page', writeArgs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 7. DELETE /api/page?workspace=...&project=...&path=...
    if (pathname === '/api/page' && req.method === 'DELETE') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');
      const docPath = parsedUrl.searchParams.get('path');

      if (!project || !docPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project and path are required' }));
        return;
      }

      const result = await mcpCall('memory_delete_page', { workspace, project, path: docPath });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 8. GET /api/download/file?workspace=...&project=...&path=...
    if (pathname === '/api/download/file' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');
      const docPath = parsedUrl.searchParams.get('path');

      if (!project || !docPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project and path are required' }));
        return;
      }

      const page = await mcpCall('memory_read_page', { workspace, project, path: docPath });
      if (!page || !page.body) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Page not found' }));
        return;
      }

      const filename = path.basename(docPath).replace(/[^\w.\-]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(page.body);
      return;
    }

    // 8.1 POST /api/feedback (Registrar sinal de utilidade / stale / wrong)
    if (pathname === '/api/feedback' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data: Json = JSON.parse(body);
      const { workspace = 'default', project, path: docPath, signal, reason } = data;

      if (!project || !docPath || !signal) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project, path and signal are required' }));
        return;
      }

      const args: Record<string, unknown> = { workspace, project, path: docPath, signal };
      if (reason) args.reason = reason;

      const result = await mcpCall('memory_feedback', args);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 8.2 GET /api/handoffs?workspace=...&project=...
    if (pathname === '/api/handoffs' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');

      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }

      // Listagem read-only. NAO usar GET /handoff daqui: aquele endpoint e o do
      // hook de session-start e marca o handoff como aceito antes de responder,
      // entao abrir esta tela consumia os handoffs pendentes um a um.
      const listing: Json = await fetchApiV1(
        `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/handoffs?limit=50`
      );
      const handoffs: Json[] = listing?.handoffs || [];

      // O briefing continua sendo a fonte da contagem exibida no card.
      const briefing = await mcpCall('memory_briefing', { workspace, project });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pending_count: briefing?.pending_handoff_count || 0,
        handoffs,
        active_handoff: handoffs.find((h: Json) => h.state === 'open') || null
      }));
      return;
    }

    // 8.3 POST /api/handoff/cancel (Cancelar/consumir handoff aberto)
    if (pathname === '/api/handoff/cancel' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data: Json = body ? JSON.parse(body) : {};
      const { workspace = 'default', project, handoff_id } = data;

      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }

      let result: Json = null;
      if (handoff_id) {
        result = await mcpCall('memory_handoff_cancel', { workspace, project, handoff_id, any_owner: true });
      } else {
        // Aceita/consome o handoff aberto para que pare de ficar pendente
        result = await mcpCall('memory_handoff_accept', { workspace, project, any_owner: true });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 8.3 POST /api/lint (Executar auditoria de regras, duplicações e links)
    if (pathname === '/api/lint' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data: Json = body ? JSON.parse(body) : {};
      const { workspace = 'default', project, no_llm = false } = data;

      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }

      const result = await mcpCall('memory_lint', { workspace, project, no_llm, dry_run: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 8.4 POST /api/consolidate (Consolidação LLM manual de sessão)
    if (pathname === '/api/consolidate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      const { session_id, multi_page = false } = data;

      if (!session_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_id is required' }));
        return;
      }

      const result = await mcpCall('memory_consolidate', { session_id, multi_page });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // 9. GET /api/download/zip?workspace=...&project=...
    if (pathname === '/api/download/zip' && req.method === 'GET') {
      const workspace = parsedUrl.searchParams.get('workspace') || 'default';
      const project = parsedUrl.searchParams.get('project');

      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }

      const hits: Json[] = await listPages(workspace, project);

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${project}-wiki.zip"`
      });

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err: Error) => {
        console.error('Zip error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      archive.pipe(res);

      // Busca o conteúdo de cada página e empacota no zip mantendo estrutura de diretórios
      for (const hit of hits) {
        try {
          const page = await mcpCall('memory_read_page', { workspace, project, path: hit.path });
          if (page && page.body) {
            archive.append(page.body, { name: hit.path });
          }
        } catch (e) {
          console.error(`Error archiving ${hit.path}:`, errMsg(e));
        }
      }

      await archive.finalize();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: errMsg(err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ai-memory-dash rodando em http://${HOST}:${PORT}`);
  console.log(`Conectado ao ai-memory em: ${AI_MEMORY_URL}`);
});
