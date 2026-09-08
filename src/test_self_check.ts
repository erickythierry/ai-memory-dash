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
  console.log('✅ Toda troca de tela fecha o grafo, descarta os dados e esconde a barra da doc');

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
