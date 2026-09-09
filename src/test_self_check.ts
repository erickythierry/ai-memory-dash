// Self-check de ponta a ponta contra a sua instancia do ai-memory.
// Descobre projetos e paginas em runtime, entao roda em qualquer instancia.
// Precisa de um .env valido. Nao escreve nada fora do sinal de feedback do passo 8.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Respostas do proprio servidor: JSON dinamico, sem schema. Nao vale inventar
// interfaces so para o self-check.
type Json = any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// DASH_URL/PORT permitem rodar contra uma instancia em outra porta (a de producao
// costuma estar ocupando a 3838).
const PORT = process.env.PORT || '3838';
const BASE = process.env.DASH_URL || `http://127.0.0.1:${PORT}`;
const get = async (p: string): Promise<Response> => {
  const res = await fetch(BASE + p);
  assert.strictEqual(res.status, 200, `GET ${p} devolveu ${res.status}`);
  return res;
};
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const getJson = async (p: string): Promise<Json> => (await get(p)).json();

let serverProc: ChildProcess | null = null;
try {
  await fetch(`${BASE}/api/projects`);
} catch {
  serverProc = spawn('node', ['dist/server.js'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, PORT } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

try {
  // 1. Lista de projetos
  const projects: Json[] = await getJson('/api/projects');
  assert(Array.isArray(projects), 'Projetos deve ser um array');
  assert(projects.length > 0, 'A instancia precisa de ao menos um projeto para o self-check');
  console.log(`✅ GET /api/projects retornou ${projects.length} projetos`);

  // 1b. Cards da tela inicial: /api/projects precisa vir enriquecido com o overview
  const withStats = projects.filter((p: Json) => p.stats);
  assert(withStats.length > 0, 'Nenhum projeto veio com stats; o enriquecimento do overview falhou');
  for (const p of withStats) {
    for (const k of ['sessions', 'observations', 'pages_all', 'pending_handoffs', 'orphans', 'rot']) {
      assert.strictEqual(typeof p.stats[k], 'number', `stats.${k} de ${p.project_name} deveria ser numero`);
    }
  }
  assert(withStats.some((p: Json) => p.stats.sessions > 0), 'Nenhum projeto reportou sessoes; suspeito de stats zerado');
  console.log(`✅ ${withStats.length}/${projects.length} projetos vieram com stats de sessoes, handoffs e saude`);

  const targets = projects
    .filter((p: Json) => p.project_name)
    .map((p: Json) => ({ workspace: p.workspace_name || 'default', project: p.project_name }));
  assert(targets.length > 0, 'Nao consegui extrair workspace/project da resposta');

  // 2. Primeiro projeto que tenha paginas, e o maior deles para o teste de truncamento
  let target: Json = null;
  let biggest: { project: string | null; pages: Json[] } = { project: null, pages: [] };
  for (const t of targets) {
    const pages: Json[] = await getJson(`/api/pages?${q(t)}`);
    assert(Array.isArray(pages), `Paginas de ${t.project} deve ser um array`);
    if (!target && pages.length > 0) target = { ...t, pages };
    if (pages.length > biggest.pages.length) biggest = { ...t, pages };
  }
  assert(target, 'Nenhum projeto tem paginas; nao da para validar leitura e download');
  console.log(`✅ GET /api/pages retornou ${target.pages.length} paginas em ${target.project}`);

  // 3. Leitura de um documento
  const testDoc = target.pages[0].path;
  const pageData: Json = await getJson(`/api/page?${q({ workspace: target.workspace, project: target.project, path: testDoc })}`);
  assert.strictEqual(pageData.path, testDoc);
  assert(typeof pageData.body === 'string', 'Corpo do doc deve ser string');
  console.log(`✅ GET /api/page leu "${testDoc}" (${pageData.body.length} bytes)`);

  // 4. Download de um markdown
  const resDownload = await get(`/api/download/file?${q({ workspace: target.workspace, project: target.project, path: testDoc })}`);
  assert.strictEqual(resDownload.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.strictEqual(await resDownload.text(), pageData.body, 'Download deve bater com o corpo lido');
  console.log('✅ GET /api/download/file baixou markdown identico ao corpo');

  // 5. Download do projeto inteiro em zip
  const resZip = await get(`/api/download/zip?${q({ workspace: target.workspace, project: target.project })}`);
  assert.strictEqual(resZip.headers.get('content-type'), 'application/zip');
  const zipBuffer = await resZip.arrayBuffer();
  assert(zipBuffer.byteLength > 0, 'Zip nao pode ser vazio');
  console.log(`✅ GET /api/download/zip empacotou ${target.project} (${zipBuffer.byteLength} bytes)`);

  // 6. Historico: toda sessao aparece, consolidada em pagina wiki ou nao
  let sessionHit: Json = null;
  for (const t of targets) {
    const data: Json = await getJson(`/api/sessions?${q(t)}`);
    assert(Array.isArray(data.sessions), 'sessions deve ser um array');
    if (data.sessions.length > 0) {
      sessionHit = { ...t, data };
      break;
    }
  }
  if (sessionHit) {
    const sessions: Json[] = sessionHit.data.sessions;
    for (const sess of sessions) {
      assert(sess.session_id, 'toda sessao precisa de session_id');
      assert.strictEqual(typeof sess.observation_count, 'number', 'observation_count deve ser numero');
    }
    // A regressao que motivou isto: a lista so trazia sessao com pagina em
    // sessions/, entao sessao nao consolidada — e suas observacoes — sumia.
    const briefed = sessionHit.data.briefing?.counts?.sessions;
    if (typeof briefed === 'number' && briefed > 0) {
      assert(sessions.length >= briefed,
        `Listagem trouxe ${sessions.length} sessoes mas o briefing conta ${briefed}: sessao sumindo da tela`);
    }
    console.log(`✅ GET /api/sessions retornou ${sessions.length} sessoes em ${sessionHit.project} (${sessions.filter((x: Json) => !x.page).length} sem pagina consolidada)`);

    // 7. Observacoes de uma sessao, o numero que o card da tela inicial mostra
    const withObs: Json = sessions.find((x: Json) => x.observation_count > 0) || sessions[0];
    const obsData: Json = await getJson(`/api/session/observations?${q({ workspace: sessionHit.workspace, project: sessionHit.project, session_id: withObs.session_id, limit: '5' })}`);
    assert(Array.isArray(obsData.observations), 'observations deve ser um array');
    if (withObs.observation_count > 0) {
      assert(obsData.observations.length > 0,
        `Sessao diz ter ${withObs.observation_count} observacoes mas nenhuma veio`);
    }
    console.log(`✅ GET /api/session/observations retornou ${obsData.observations.length} de ${withObs.observation_count} observacoes`);
  } else {
    console.log('⏭️  Nenhuma sessao na instancia; passos 6 e 7 pulados');
  }

  // 7a. Grafo de links: nos, arestas e coerencia com as paginas do projeto
  const graphTarget: Json = await (async () => {
    for (const t of targets) {
      const g: Json = await getJson(`/api/graph?${q(t)}`);
      if (g.edges.length > 0) return { ...t, g };
    }
    return null;
  })();
  if (graphTarget) {
    const { nodes, edges }: { nodes: Json[]; edges: Json[] } = graphTarget.g;
    const ids = new Set(nodes.map((n: Json) => n.id));
    for (const e of edges) {
      // Aresta orfa de no quebra o render: todo alvo cross-project vira no externo.
      assert(ids.has(e.from), `aresta sai de no inexistente: ${e.from}`);
      assert(ids.has(e.to), `aresta aponta para no inexistente: ${e.to}`);
    }
    const degree = new Map<string, number>(nodes.map((n: Json) => [n.id, 0]));
    for (const e of edges) {
      degree.set(e.from, degree.get(e.from)! + 1);
      degree.set(e.to, degree.get(e.to)! + 1);
    }
    for (const n of nodes) {
      assert.strictEqual(n.degree, degree.get(n.id), `grau errado em ${n.id}`);
      if (n.orphan) assert.strictEqual(n.degree, 0, `${n.id} marcado orfao mas tem arestas`);
    }
    // Wikilink escrito so com o basename (`[[mapa-repos]]`) vem sem `links` do
    // upstream; o grafo tem que resolver assim mesmo, senao a pagina vira orfa.
    const basenames = new Map<string, string>();
    for (const n of nodes) if (!n.external && !basenames.has(String(n.path).replace(/\.md$/, '').split('/').pop()!))
      basenames.set(String(n.path).replace(/\.md$/, '').split('/').pop()!, n.id);
    for (const n of nodes.filter((n: Json) => !n.external).slice(0, 40)) {
      const page: Json = await getJson(`/api/page?${q({ workspace: n.workspace, project: n.project, path: n.path })}`);
      const alvos = [...String(page.body_markdown || '').matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)]
        .map((m) => basenames.get(m[1]!.trim().replace(/\.md$/, '').split('/').pop()!))
        .filter((id) => id && id !== n.id);
      for (const alvo of alvos)
        assert(edges.some((e: Json) => e.from === n.id && e.to === alvo),
          `wikilink de ${n.path} para ${alvo} sumiu do grafo`);
    }
    console.log(`✅ GET /api/graph montou ${nodes.length} nos e ${edges.length} arestas em ${graphTarget.project} (${nodes.filter((n: Json) => n.external).length} externos)`);
  } else {
    console.log('⏭️  Nenhum projeto com links; passo 7a pulado');
  }

  // 7b. Paginas vem marcadas com as flags de saude que o card resume
  const flagged: Json = await (async () => {
    for (const t of targets) {
      const pages: Json[] = await getJson(`/api/pages?${q(t)}`);
      const hit = pages.filter((p: Json) => (p.health || []).length > 0);
      if (hit.length) return { ...t, pages, hit };
    }
    return null;
  })();
  if (flagged) {
    const valid = new Set(['orphan', 'stale', 'duplicate']);
    for (const p of flagged.hit) {
      for (const f of p.health) assert(valid.has(f), `flag de saude desconhecida: ${f}`);
    }
    console.log(`✅ ${flagged.hit.length}/${flagged.pages.length} paginas de ${flagged.project} vieram marcadas`);
  } else {
    console.log('⏭️  Nenhuma pagina com flag de saude; passo 7b pulado');
  }

  // 8. Sinal de feedback (unica escrita do self-check)
  const resFeedback = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: target.workspace, project: target.project, path: testDoc, signal: 'helpful' })
  });
  assert.strictEqual(resFeedback.status, 200);
  assert(((await resFeedback.json()) as Json).success, 'Feedback deve retornar sucesso');
  console.log('✅ POST /api/feedback registrou sinal "helpful"');

  // 9. Frontend
  const html = await (await get('/')).text();
  assert(html.includes('mermaid'), 'HTML deve conter suporte a mermaid');
  assert(html.includes('highlight.js'), 'HTML deve conter suporte a highlight.js');
  assert(!html.includes('__AI_MEMORY_URL__'), 'Placeholder da URL upstream deve ser substituido no serve');
  assert(html.includes('/static/app.js'), 'HTML deve carregar o bundle compilado do frontend');
  assert((await get('/static/app.js')).status === 200, '/static/app.js precisa ser servido');
  console.log('✅ GET / entregou o frontend SPA e o bundle /static/app.js');

  // 9b. O grafo tem que morrer em toda troca de tela. O bug era ele sobreviver a
  // navegacao e reaparecer sobre o proximo projeto, com os nos do anterior.
  // Le o fonte TS: o app.js compilado e reindentado pelo tsc, entao o corte por
  // indentacao so e confiavel no arquivo original.
  const app = fs.readFileSync(path.join(ROOT, 'src/client/app.ts'), 'utf8');
  for (const fn of ['goToProjects', 'openProject', 'setDocMode', 'closeGraph']) {
    const at = app.indexOf(`function ${fn}(`);
    assert(at !== -1, `funcao ${fn} sumiu do frontend`);
    if (fn === 'closeGraph') continue;
    // Corpo ate a proxima declaracao de funcao no mesmo nivel de indentacao.
    const rest = app.slice(at);
    const end = rest.indexOf('\n    }');
    assert(rest.slice(0, end).includes('closeGraph()'),
      `${fn} nao chama closeGraph(): grafo vai sobreviver a navegacao`);
  }
  assert(app.includes('graphData = null'), 'closeGraph precisa descartar graphData do projeto antigo');

  // A barra de acoes age sobre currentDocPath — deixar o Deletar visivel sobre o
  // grafo apagaria a doc aberta antes dele.
  const openBody = app.slice(app.indexOf('async function toggleGraphView()'));
  const openEnd = openBody.indexOf('\n    }');
  assert(/docHeader'\)\.classList\.add\('hidden'\)/.test(openBody.slice(0, openEnd)),
    'abrir o grafo precisa esconder docHeader: o botao Deletar agiria na doc anterior');
  // Reabrir o grafo do mesmo projeto nao pode re-simular: a animacao de entrada
  // vale uma vez, repetida a cada reabertura vira ruido. E fechar tem que apagar
  // o desenho, senao o grafo antigo pisca antes do fetch novo.
  const closeBody = app.slice(app.indexOf('function closeGraph()'));
  assert(/graphSvg'\)\.innerHTML = ''/.test(closeBody.slice(0, closeBody.indexOf('\n    }'))),
    'closeGraph precisa limpar o svg: senao o grafo anterior reaparece ao abrir');
  assert(app.includes('const restored = !!cached && nodes.every'),
    'o grafo perdeu o reaproveitamento do layout ja assentado');
  console.log('✅ Toda troca de tela fecha o grafo, limpa o desenho e reusa o layout ja assentado');

  // 9c. Titulo do handoff: a lista mostrava so o nome do agente, igual em todos.
  // Extrai a funcao do bundle e testa a derivacao a partir do summary.
  const bundle = fs.readFileSync(path.join(ROOT, 'public/static/app.js'), 'utf8');
  const fnSrc = bundle.match(/function handoffTitle\(h\)[\s\S]*?\n\}/)?.[0];
  assert(fnSrc, 'handoffTitle sumiu do bundle');
  const handoffTitle = new Function(`${fnSrc}; return handoffTitle;`)() as (h: Json) => string;
  assert.strictEqual(handoffTitle({ title: 'Explicito' }), 'Explicito');
  assert.strictEqual(handoffTitle({ summary: 'Started: reorganizar projetos\n\nLast: x' }), 'reorganizar projetos');
  assert.strictEqual(handoffTitle({ summary: '' }), '');
  assert.strictEqual(handoffTitle({ summary: 'a'.repeat(120) }).length, 91, 'titulo longo deve truncar com reticencia');
  assert(bundle.includes('function setHandoffFilter('), 'filtro de estado dos handoffs sumiu do bundle');
  console.log('✅ Handoffs: titulo derivado do summary e filtro por estado presentes');

  // 9d. Busca com escopo: workspace+project so valem juntos no upstream, e o
  // limite default de 10 dele era curto demais para a tela de resultados.
  const searchTerm = String(target.pages[0].title || '').split(/\s+/).find((w: string) => w.length > 4) || 'memory';
  const globalHits: Json[] = await getJson(`/api/search?${q({ q: searchTerm })}`);
  const scopedHits: Json[] = await getJson(`/api/search?${q({ q: searchTerm, workspace: target.workspace, project: target.project })}`);
  assert(Array.isArray(globalHits) && Array.isArray(scopedHits), 'busca deve devolver array');
  assert(scopedHits.every((r: Json) => r.project === target.project),
    `busca com escopo vazou para outros projetos: ${[...new Set(scopedHits.map((r: Json) => r.project))].join(', ')}`);
  assert(scopedHits.length <= globalHits.length, 'busca com escopo nao pode trazer mais que a global');
  // workspace sem project e recusado pelo upstream; a dash tem que ignorar o par incompleto.
  const halfScoped: Json[] = await getJson(`/api/search?${q({ q: searchTerm, workspace: target.workspace })}`);
  assert(Array.isArray(halfScoped), 'workspace sem project deve cair na busca global, nao dar erro');
  console.log(`✅ GET /api/search: ${globalHits.length} global, ${scopedHits.length} restrito a ${target.project}`);

  // 9e. Autocomplete de wikilink do editor: as duas partes puras vem do bundle.
  // O alvo tem que ser o path sem `.md` — slug puro nao resolve e vira broken_link.
  const wikiSrc = ['wikiOpenMatch', 'insertWikiLink']
    .map(fn => bundle.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`))?.[0]);
  assert(wikiSrc.every(Boolean), 'autocomplete de wikilink sumiu do bundle');
  const wiki = new Function(`${wikiSrc.join(';')}; return { wikiOpenMatch, insertWikiLink };`)() as Json;
  assert.deepStrictEqual(wiki.wikiOpenMatch('texto [[not'), { term: 'not', start: 6 });
  assert.strictEqual(wiki.wikiOpenMatch('sem colchete'), null);
  assert.strictEqual(wiki.wikiOpenMatch('[[ja fechado]] depois'), null, 'link ja fechado nao pode reabrir a lista');
  assert.strictEqual(wiki.wikiOpenMatch('[[quebra\nlinha'), null, 'a busca nao atravessa linha');
  const inserted = wiki.insertWikiLink('ver [[not aqui', 4, 9, 'notes/x.md');
  assert.strictEqual(inserted.value, 'ver [[notes/x]] aqui');
  assert.strictEqual(inserted.caret, 15, 'caret deve parar depois do ]]');
  console.log('✅ Editor: autocomplete de wikilink insere o path sem .md');

  // 9e-bis. Editor markdown: CodeMirror + overlay do wikilink + preview.
  // Sao pecas de DOM/CDN, entao o que da para checar sem browser e que o HTML
  // pede os arquivos e que o bundle registra o modo e o toggle.
  assert(html.includes('codemirror/5.65.16/codemirror.min.js'), 'CodeMirror sumiu do HTML');
  assert(html.includes('mode/gfm/gfm.min.js') && html.includes('addon/mode/overlay.min.js'),
    'modo gfm + overlay sao o que colore markdown e wikilink');
  assert(html.includes('id="editorPreview"') && html.includes('onclick="toggleEditorPreview()"'),
    'preview lado a lado e seu botao sumiram do HTML');
  assert(bundle.includes("defineMode('gfm-wiki'") || bundle.includes('defineMode("gfm-wiki"'),
    'overlay do wikilink sumiu do bundle');
  assert(/function toggleEditorPreview\(/.test(bundle) && bundle.includes('aim:editorPreview'),
    'toggle do preview sumiu do bundle');
  console.log('✅ Editor: CodeMirror com realce de wikilink e preview alternavel');

  // 9e-ter. Novo projeto: nao ha endpoint de criar projeto no upstream, ele
  // nasce da primeira pagina. O que da para checar sem escrever de verdade e o
  // slug (o nome vira diretorio) e a presenca do modal.
  assert(html.includes('id="newProjectModal"') && html.includes('onclick="openNewProjectModal()"'),
    'criacao de projeto sumiu da home');
  const slugSrc = bundle.match(/function slugProject\([\s\S]*?\n  \}/)?.[0]
    || bundle.match(/function slugProject\([\s\S]*?\n\}/)?.[0];
  assert(slugSrc, 'slugProject sumiu do bundle');
  const slugProject = new Function(`${slugSrc}; return slugProject;`)() as (n: string) => string;
  assert.strictEqual(slugProject('Cliente Acme'), 'cliente-acme');
  assert.strictEqual(slugProject('Projeto Ção/Teste'), 'projeto-cao-teste');
  assert.strictEqual(slugProject('  --meu-projeto--  '), 'meu-projeto', 'nao pode sobrar tracos nas pontas');
  assert.strictEqual(slugProject(''), '');
  console.log('✅ Home: criar projeto semeia a primeira pagina e o slug vira o diretorio');

  // 9e-quater. Deletar projeto/workspace: as rotas /admin sao as unicas que
  // apagam de verdade e nao tem dry-run, entao o teste so exercita as recusas —
  // parametro faltando e a guarda do workspace `default`.
  const wss: Json[] = await getJson('/api/workspaces');
  assert(Array.isArray(wss) && wss.some((w: Json) => w.workspace_name === 'default'),
    '/api/workspaces deve listar ao menos o default');
  const semParam = await fetch(`${BASE}/api/project`, { method: 'DELETE' });
  assert.strictEqual(semParam.status, 400, 'DELETE /api/project sem escopo tem que recusar');
  const defProtegido = await fetch(`${BASE}/api/workspace?workspace=default`, { method: 'DELETE' });
  assert.strictEqual(defProtegido.status, 400, 'o workspace default nao pode ser deletado pela dash');
  assert(((await defProtegido.json()) as Json).error, 'a recusa do default precisa dizer o motivo');
  console.log(`✅ Delete: ${wss.length} workspace(s) listado(s), rota recusa escopo vazio e protege o default`);

  // 9e-quinquies. Backups: gerar custa um tar.gz de ~9 MB no upstream, entao o
  // teste so lista e checa o filtro do nome — que e o que impede `../` chegar
  // ao fs do container.
  const backups: Json[] = await getJson('/api/backups');
  assert(Array.isArray(backups), '/api/backups deve devolver array');
  assert(backups.every((b: Json) => /^backup-[0-9T-]+\.tar\.gz$/.test(b.name) && b.bytes > 0),
    'backup listado tem que ter nome no padrao e tamanho');
  for (const evil of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'server.js']) {
    const r = await fetch(`${BASE}/api/backup/file?name=${encodeURIComponent(evil)}`);
    assert.strictEqual(r.status, 404, `download de backup aceitou nome fora do padrao: ${evil}`);
  }
  console.log(`✅ Backups: ${backups.length} no disco da dash, nome fora do padrao nao baixa`);

  // 9f. Rotas reais: a URL tem que sobreviver a um reload. Testa o ida-e-volta
  // entre buildUrl (estado -> URL) e parseRoute (URL -> estado), e o fallback
  // do servidor que devolve o index em qualquer caminho da SPA.
  const grab = (name: string) => bundle.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
  const buildUrlSrc = grab('buildUrl');
  const parseRouteSrc = grab('parseRoute');
  assert(buildUrlSrc && parseRouteSrc, 'roteador sumiu do bundle');
  const buildUrl = (st: Json) => new Function('st',
    `let {currentWorkspace,currentProject,currentDocPath,currentSessionId,currentActiveTab,currentDocMode}=st; ${buildUrlSrc}; return buildUrl();`)(st) as string;
  const parseRoute = new Function(`${parseRouteSrc}; return parseRoute;`)() as (p: string, q: string) => Json;

  const states: Json[] = [
    { currentWorkspace: 'default', currentProject: null, currentDocPath: null, currentSessionId: null, currentActiveTab: 'docs', currentDocMode: 'view' },
    { currentWorkspace: 'default', currentProject: 'meu-projeto', currentDocPath: null, currentSessionId: null, currentActiveTab: 'docs', currentDocMode: 'view' },
    { currentWorkspace: 'default', currentProject: 'meu-projeto', currentDocPath: null, currentSessionId: null, currentActiveTab: 'handoffs', currentDocMode: 'view' },
    { currentWorkspace: 'default', currentProject: 'meu-projeto', currentDocPath: 'notes/a b/ç.md', currentSessionId: null, currentActiveTab: 'docs', currentDocMode: 'edit' },
    { currentWorkspace: 'default', currentProject: 'x', currentDocPath: null, currentSessionId: 'abc-123', currentActiveTab: 'docs', currentDocMode: 'view' }
  ];
  for (const st of states) {
    const [pathPart, queryPart = ''] = buildUrl(st).split('?');
    const back = parseRoute(pathPart!, queryPart);
    if (!st.currentProject) { assert.strictEqual(back.view, 'projects'); continue; }
    assert.strictEqual(back.project, st.currentProject);
    assert.strictEqual(back.workspace, st.currentWorkspace);
    assert.strictEqual(back.docPath, st.currentDocPath, 'path da doc nao sobreviveu ao round-trip');
    assert.strictEqual(back.sessionId, st.currentSessionId);
    assert.strictEqual(back.tab, st.currentActiveTab);
    assert.strictEqual(back.edit, st.currentDocMode === 'edit');
  }
  assert.strictEqual(parseRoute('/rota/invalida', '').view, 'projects', 'rota desconhecida deve cair na home');

  // Fallback do servidor: sem ele, recarregar numa doc daria 404.
  for (const route of ['/p/default/meu-projeto', '/p/default/meu-projeto/doc/notes/foo.md', '/search?q=x']) {
    const r = await fetch(BASE + route);
    assert.strictEqual(r.status, 200, `rota ${route} deveria devolver o index`);
    assert((r.headers.get('content-type') || '').includes('text/html'), `rota ${route} deveria ser HTML`);
  }
  const missingApi = await fetch(`${BASE}/api/naoexiste`);
  assert.strictEqual(missingApi.status, 404, 'rota /api/ desconhecida nao pode cair no fallback da SPA');
  console.log('✅ Rotas: URL sobrevive ao reload e o servidor devolve o index nas rotas da SPA');

  // 10. Sem CORS wildcard: rotas de escrita nao podem ser dirigidas por site externo
  const resCors = await get('/api/projects');
  assert.strictEqual(resCors.headers.get('access-control-allow-origin'), null,
    'Nao deve expor Access-Control-Allow-Origin (rotas POST/DELETE escrevem na memoria)');
  console.log('✅ Sem cabecalho CORS wildcard nas rotas de API');

  // 11. Listagem nao pode truncar no limite (o bug antigo parava em 100)
  assert.notStrictEqual(biggest.pages.length, 100, 'Exatamente 100 paginas indica truncamento pelo limite antigo');
  assert.notStrictEqual(biggest.pages.length, 500, 'Bateu no PAGE_LIMIT: hora de paginar');
  console.log(`✅ Maior projeto (${biggest.project}) listou ${biggest.pages.length} paginas sem truncar`);

  // 12. Ler handoffs nao pode consumi-los (o GET /handoff do upstream marca aceito)
  const handoffTarget: Json = await (async () => {
    for (const t of targets) {
      const d: Json = await getJson(`/api/handoffs?${q(t)}`);
      if ((d.pending_count || 0) > 0) return { ...t, before: d.pending_count };
    }
    return null;
  })();
  if (handoffTarget) {
    for (let i = 0; i < 3; i++) {
      const d: Json = await getJson(`/api/handoffs?${q({ workspace: handoffTarget.workspace, project: handoffTarget.project })}`);
      assert.strictEqual(d.pending_count, handoffTarget.before,
        `Ler /api/handoffs consumiu handoff: ${handoffTarget.before} -> ${d.pending_count}`);
    }
    console.log(`✅ /api/handoffs leu ${handoffTarget.project} 4x sem consumir (${handoffTarget.before} pendentes)`);
  } else {
    console.log('⏭️  Nenhum handoff pendente na instancia; passo 12 pulado');
  }

  console.log('\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!');
} catch (err) {
  console.error('❌ Falha no teste:', err);
  process.exitCode = 1;
} finally {
  if (serverProc) serverProc.kill();
}
