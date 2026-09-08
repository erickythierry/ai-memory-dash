// Self-check de ponta a ponta contra a sua instancia do ai-memory.
// Descobre projetos e paginas em runtime, entao roda em qualquer instancia.
// Precisa de um .env valido. Nao escreve nada fora do sinal de feedback do passo 8.
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:3838';
const get = async (p) => {
  const res = await fetch(BASE + p);
  assert.strictEqual(res.status, 200, `GET ${p} devolveu ${res.status}`);
  return res;
};
const q = (o) => new URLSearchParams(o).toString();

let serverProc = null;
try {
  await fetch(`${BASE}/api/projects`);
} catch {
  serverProc = spawn('node', ['server.js'], { stdio: 'pipe' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

try {
  // 1. Lista de projetos
  const projects = await (await get('/api/projects')).json();
  assert(Array.isArray(projects), 'Projetos deve ser um array');
  assert(projects.length > 0, 'A instancia precisa de ao menos um projeto para o self-check');
  console.log(`✅ GET /api/projects retornou ${projects.length} projetos`);

  // 1b. Cards da tela inicial: /api/projects precisa vir enriquecido com o overview
  const withStats = projects.filter((p) => p.stats);
  assert(withStats.length > 0, 'Nenhum projeto veio com stats; o enriquecimento do overview falhou');
  for (const p of withStats) {
    for (const k of ['sessions', 'observations', 'pages_all', 'pending_handoffs', 'orphans', 'rot']) {
      assert.strictEqual(typeof p.stats[k], 'number', `stats.${k} de ${p.project_name} deveria ser numero`);
    }
  }
  assert(withStats.some((p) => p.stats.sessions > 0), 'Nenhum projeto reportou sessoes; suspeito de stats zerado');
  console.log(`✅ ${withStats.length}/${projects.length} projetos vieram com stats de sessoes, handoffs e saude`);

  const targets = projects
    .filter((p) => p.project_name)
    .map((p) => ({ workspace: p.workspace_name || 'default', project: p.project_name }));
  assert(targets.length > 0, 'Nao consegui extrair workspace/project da resposta');

  // 2. Primeiro projeto que tenha paginas, e o maior deles para o teste de truncamento
  let target = null;
  let biggest = { project: null, pages: [] };
  for (const t of targets) {
    const pages = await (await get(`/api/pages?${q(t)}`)).json();
    assert(Array.isArray(pages), `Paginas de ${t.project} deve ser um array`);
    if (!target && pages.length > 0) target = { ...t, pages };
    if (pages.length > biggest.pages.length) biggest = { ...t, pages };
  }
  assert(target, 'Nenhum projeto tem paginas; nao da para validar leitura e download');
  console.log(`✅ GET /api/pages retornou ${target.pages.length} paginas em ${target.project}`);

  // 3. Leitura de um documento
  const testDoc = target.pages[0].path;
  const pageData = await (await get(`/api/page?${q({ workspace: target.workspace, project: target.project, path: testDoc })}`)).json();
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
  let sessionHit = null;
  for (const t of targets) {
    const data = await (await get(`/api/sessions?${q(t)}`)).json();
    assert(Array.isArray(data.sessions), 'sessions deve ser um array');
    if (data.sessions.length > 0) {
      sessionHit = { ...t, data };
      break;
    }
  }
  if (sessionHit) {
    const sessions = sessionHit.data.sessions;
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
    console.log(`✅ GET /api/sessions retornou ${sessions.length} sessoes em ${sessionHit.project} (${sessions.filter(x => !x.page).length} sem pagina consolidada)`);

    // 7. Observacoes de uma sessao, o numero que o card da tela inicial mostra
    const withObs = sessions.find((x) => x.observation_count > 0) || sessions[0];
    const obsData = await (await get(`/api/session/observations?${q({ workspace: sessionHit.workspace, project: sessionHit.project, session_id: withObs.session_id, limit: 5 })}`)).json();
    assert(Array.isArray(obsData.observations), 'observations deve ser um array');
    if (withObs.observation_count > 0) {
      assert(obsData.observations.length > 0,
        `Sessao diz ter ${withObs.observation_count} observacoes mas nenhuma veio`);
    }
    console.log(`✅ GET /api/session/observations retornou ${obsData.observations.length} de ${withObs.observation_count} observacoes`);
  } else {
    console.log('⏭️  Nenhuma sessao na instancia; passos 6 e 7 pulados');
  }

  // 7b. Paginas vem marcadas com as flags de saude que o card resume
  const flagged = await (async () => {
    for (const t of targets) {
      const pages = await (await get(`/api/pages?${q(t)}`)).json();
      const hit = pages.filter((p) => (p.health || []).length > 0);
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
  assert((await resFeedback.json()).success, 'Feedback deve retornar sucesso');
  console.log('✅ POST /api/feedback registrou sinal "helpful"');

  // 9. Frontend
  const html = await (await get('/')).text();
  assert(html.includes('mermaid'), 'HTML deve conter suporte a mermaid');
  assert(html.includes('highlight.js'), 'HTML deve conter suporte a highlight.js');
  assert(!html.includes('__AI_MEMORY_URL__'), 'Placeholder da URL upstream deve ser substituido no serve');
  console.log('✅ GET / entregou o frontend SPA');

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
  const handoffTarget = await (async () => {
    for (const t of targets) {
      const d = await (await get(`/api/handoffs?${q(t)}`)).json();
      if ((d.pending_count || 0) > 0) return { ...t, before: d.pending_count };
    }
    return null;
  })();
  if (handoffTarget) {
    for (let i = 0; i < 3; i++) {
      const d = await (await get(`/api/handoffs?${q({ workspace: handoffTarget.workspace, project: handoffTarget.project })}`)).json();
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
