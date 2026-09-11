// Bundle do frontend. Compilado por tsconfig.client.json para public/static/app.js
// como script classico: sem import/export, entao as funcoes de topo continuam
// globais e os `onclick=` do index.html seguem funcionando.

// Bibliotecas vindas de CDN via <script> no index.html.
declare const marked: any;
declare const hljs: any;
declare const mermaid: any;
declare const CodeMirror: any;

// Respostas da API da dash: JSON dinamico do ai-memory, sem schema publicado.
type Json = any;

// Os ids vem do index.html; se um sumir, o erro certo e o TypeError na hora,
// nao um `null` silencioso espalhado por cada chamada.
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const $input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const $sel = (id: string): HTMLSelectElement => document.getElementById(id) as HTMLSelectElement;
const $area = (id: string): HTMLTextAreaElement => document.getElementById(id) as HTMLTextAreaElement;

// A barra de feedback vive dentro do #docViewer, que e reescrito a cada render
// (atividade recente, doc aberta). Guardar o no aqui e reanexa-lo depois evita
// que ela suma - antes bastava passar pela tela de atividade recente para perder
// os botoes de feedback ate o proximo reload.
const feedbackNode = document.getElementById('docFeedbackSection')!;

// Erro em catch e `unknown`; nas telas so a mensagem interessa.
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

    // Estado da Aplicação
    let currentWorkspace = 'default';
    let currentProject: string | null = null;
    let currentDocPath: string | null = null;
    let currentDocData: Json = null;
    let currentPagesList: Json[] = [];
    let currentActiveTab = 'docs'; // 'docs' ou 'history'
    let currentDocMode: 'view' | 'edit' = 'view';
    let currentHistoryData: Json = null;
    let currentSessionId: string | null = null;

    // --- Rotas ------------------------------------------------------------
    // A URL e derivada do estado, num lugar so: cada acao chama syncUrl() e o
    // caminho sai de currentProject/currentDocPath/etc. Recarregar a pagina faz
    // o inverso — applyRoute() reexecuta as mesmas funcoes de navegacao.
    // `routing` silencia syncUrl durante o replay, senao cada passo do replay
    // empilharia uma entrada no historico.
    let routing = false;

    function buildUrl(): string {
      if (!currentProject) return '/';
      const base = `/p/${encodeURIComponent(currentWorkspace)}/${encodeURIComponent(currentProject)}`;
      const qs = new URLSearchParams();
      if (currentActiveTab !== 'docs') qs.set('tab', currentActiveTab);

      let path = base;
      if (currentDocPath) {
        path = `${base}/doc/${currentDocPath.split('/').map(encodeURIComponent).join('/')}`;
        if (currentDocMode === 'edit') qs.set('edit', '1');
      } else if (currentSessionId) {
        path = `${base}/session/${encodeURIComponent(currentSessionId)}`;
      }
      const q = qs.toString();
      return q ? `${path}?${q}` : path;
    }

    function syncUrl(replace = false) {
      if (routing) return;
      const url = buildUrl();
      if (url === location.pathname + location.search) return;
      history[replace ? 'replaceState' : 'pushState']({}, '', url);
    }

    // Busca tem URL propria: nao deriva do estado de projeto/doc.
    function syncSearchUrl(q: string, scoped: boolean) {
      if (routing) return;
      const qs = new URLSearchParams({ q });
      if (scoped && currentProject) {
        qs.set('workspace', currentWorkspace);
        qs.set('project', currentProject);
      }
      history.pushState({}, '', `/search?${qs}`);
    }

    // Parse puro do caminho, separado do DOM: e o inverso de buildUrl e o
    // self-check testa o ida-e-volta dos dois.
    function parseRoute(pathname: string, search: string) {
      const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const qs = new URLSearchParams(search);
      if (parts[0] === 'search') {
        return { view: 'search', q: qs.get('q') || '', workspace: qs.get('workspace'), project: qs.get('project') };
      }
      if (parts[0] !== 'p' || !parts[1] || !parts[2]) return { view: 'projects' };
      return {
        view: 'project',
        workspace: parts[1],
        project: parts[2],
        tab: qs.get('tab') === 'history' || qs.get('tab') === 'handoffs' ? qs.get('tab') : 'docs',
        docPath: parts[3] === 'doc' && parts.length > 4 ? parts.slice(4).join('/') : null,
        sessionId: parts[3] === 'session' && parts[4] ? parts[4] : null,
        edit: qs.get('edit') === '1'
      } as Json;
    }

    async function applyRoute() {
      routing = true;
      try {
        const r = parseRoute(location.pathname, location.search) as Json;

        if (r.view === 'search') {
          const q = r.q;
          $input('searchInput').value = q;
          const ws = r.workspace;
          const pr = r.project;
          if (ws && pr) {
            // Escopo veio na URL: abre o projeto antes, para o botao e o
            // breadcrumb ficarem coerentes com o resultado exibido.
            await openProject(ws, pr);
            searchScopeProject = true;
            updateSearchScopeBtn();
          }
          if (q) await doSearch();
          return;
        }

        if (r.view !== 'project') {
          goToProjects();
          return;
        }

        await openProject(r.workspace, r.project);
        if (r.tab !== 'docs') switchSidebarTab(r.tab);

        if (r.docPath) {
          await loadDoc(r.docPath);
          if (r.edit) setDocMode('edit');
        } else if (r.sessionId) {
          // A sessao bruta so tem seus metadados na listagem; espera o
          // historico carregar para abrir com agente/cwd/inicio preenchidos.
          await loadProjectHistory();
          const sess = (currentHistoryData?.sessions || []).find((x: Json) => x.session_id === r.sessionId);
          if (sess) openSession(sess);
          else openRawSessionDetail({ session_id: r.sessionId });
        }
      } finally {
        routing = false;
        syncUrl(true); // normaliza a URL (rota invalida vira o estado real)
      }
    }

    // Inicialização
    document.addEventListener('DOMContentLoaded', () => {
      loadProjects();
      applyRoute();
      window.addEventListener('popstate', applyRoute);
    });

    function switchSidebarTab(tab: string) {
      currentActiveTab = tab;
      syncUrl();
      const tabBtnDocs = $('tabBtnDocs');
      const tabBtnHistory = $('tabBtnHistory');
      const tabBtnHandoffs = $('tabBtnHandoffs');
      const tabContentDocs = $('tabContentDocs');
      const tabContentHistory = $('tabContentHistory');
      const tabContentHandoffs = $('tabContentHandoffs');

      // Reset tabs style
      [tabBtnDocs, tabBtnHistory, tabBtnHandoffs].forEach(btn => {
        btn.className = 'flex-1 py-2 text-center font-medium border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center justify-center gap-1 transition';
      });
      [tabContentDocs, tabContentHistory, tabContentHandoffs].forEach(c => c.classList.add('hidden'));

      if (tab === 'docs') {
        tabBtnDocs.className = 'flex-1 py-2 text-center font-medium border-b-2 border-blue-500 text-blue-400 flex items-center justify-center gap-1 transition';
        tabContentDocs.classList.remove('hidden');
      } else if (tab === 'history') {
        tabBtnHistory.className = 'flex-1 py-2 text-center font-medium border-b-2 border-blue-500 text-blue-400 flex items-center justify-center gap-1 transition';
        tabContentHistory.classList.remove('hidden');
        if (!currentHistoryData) loadProjectHistory();
      } else if (tab === 'handoffs') {
        tabBtnHandoffs.className = 'flex-1 py-2 text-center font-medium border-b-2 border-blue-500 text-blue-400 flex items-center justify-center gap-1 transition';
        tabContentHandoffs.classList.remove('hidden');
        renderHandoffsList();
      }
    }

    async function loadProjects() {
      try {
        const res = await fetch('/api/projects');
        const projects = await res.json();
        renderProjects(projects);
        loadWorkspaces(); // barra de cima, independente do grid
      } catch (err) {
        alert('Erro ao carregar projetos: ' + errMsg(err));
      }
    }

    async function loadWorkspaces() {
      const bar = $('workspacesBar');
      try {
        const list: Json[] = await (await fetch('/api/workspaces')).json();
        bar.innerHTML = list.map((w: Json) => {
          const plural = w.project_count === 1 ? 'projeto' : 'projetos';
          // `default` nao ganha lixeira: e o workspace de todo .ai-memory.toml
          // da maquina. O servidor tambem recusa, isto aqui e so a UI.
          const del = w.workspace_name === 'default' ? '' : `
            <button onclick="confirmDeleteWorkspace('${w.workspace_name}', ${w.project_count})"
              title="Deletar o workspace ${w.workspace_name} e tudo dentro dele"
              class="ml-1 -mr-1 p-0.5 rounded hover:bg-rose-900/40 hover:text-rose-400 transition">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>`;
          return `<span class="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-lg border border-slate-800 bg-slate-900/60 text-[11px] text-slate-400">
            <span class="font-mono text-slate-300">${escapeHtml(w.workspace_name)}</span>
            <span class="text-slate-500">${w.project_count} ${plural} · ${w.page_count} págs</span>
            ${del}
          </span>`;
        }).join('');
      } catch (err) {
        bar.innerHTML = `<span class="text-[11px] text-slate-600">Workspaces indisponíveis: ${escapeHtml(errMsg(err))}</span>`;
      }
    }

    // Apagar projeto e workspace nao tem volta e o upstream nao tem dry-run:
    // por isso exige digitar o nome, nao um confirm() de um clique so.
    function confirmByTyping(name: string, aviso: string): boolean {
      const typed = prompt(`${aviso}\n\nDigite "${name}" para confirmar:`);
      if (typed === null) return false;
      if (typed.trim() !== name) {
        alert('O nome não confere — nada foi apagado.');
        return false;
      }
      return true;
    }

    async function confirmDeleteProject(workspace: string, project: string, pages: number) {
      if (!confirmByTyping(project,
        `Apagar o projeto ${workspace}/${project}?\n\nLeva junto ${pages} página(s), sessões, observações e handoffs.`)) return;
      try {
        const res = await fetch(`/api/project?workspace=${encodeURIComponent(workspace)}&project=${encodeURIComponent(project)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao deletar projeto');
        if (currentProject === project && currentWorkspace === workspace) goToProjects();
        await loadProjects();
      } catch (err) {
        alert('Erro ao deletar projeto: ' + errMsg(err));
      }
    }

    async function confirmDeleteWorkspace(workspace: string, projectCount: number) {
      if (!confirmByTyping(workspace,
        `Apagar o workspace ${workspace}?\n\nLeva junto ${projectCount} projeto(s) e tudo que houver dentro deles.`)) return;
      try {
        const res = await fetch(`/api/workspace?workspace=${encodeURIComponent(workspace)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao deletar workspace');
        if (currentWorkspace === workspace) goToProjects();
        await loadProjects();
      } catch (err) {
        alert('Erro ao deletar workspace: ' + errMsg(err));
      }
    }

    let allProjects: Json[] = [];

    // Uma metrica do card. Fica fora quando o valor e zero, para o card nao
    // virar uma fileira de zeros nos projetos vazios.
    function projectStat(icon: string, value: number, label: string, tone = 'text-slate-400') {
      if (!value) return '';
      return `<span class="inline-flex items-center gap-1 ${tone}" title="${label}">
        <span class="opacity-70">${icon}</span><span class="font-medium">${value}</span>
      </span>`;
    }

    function renderProjects(projects: Json[]) {
      allProjects = projects || [];
      const grid = $('projectsGrid');
      grid.innerHTML = '';

      projects.forEach((p: Json) => {
        const card = document.createElement('div');
        card.className = 'rounded-xl border border-slate-800 bg-slate-900/50 hover:bg-slate-900 hover:border-slate-700 transition p-5 flex flex-col justify-between cursor-pointer group';
        card.onclick = () => openProject(p.workspace_name, p.project_name);

        const updatedText = p.last_updated ? new Date(p.last_updated).toLocaleString('pt-BR') : 'Sem updates recentes';
        const relativeText = p.last_updated ? timeAgo(p.last_updated) : '';
        const st = p.stats;

        const stats = st ? [
          projectStat('🗂️', st.sessions, `${st.sessions} sessões registradas`),
          projectStat('💬', st.observations, `${st.observations} observações capturadas`),
          projectStat('📥', st.pending_handoffs, `${st.pending_handoffs} handoff(s) pendente(s)`, 'text-amber-400'),
          projectStat('🔗', st.orphans, `${st.orphans} página(s) sem nenhum [[wikilink]] entrando ou saindo`, 'text-slate-500'),
          projectStat('⚠️', st.rot, `${st.rot} página(s) precisando de atenção: episódica parada há mais de 30 dias, ou título duplicado`, 'text-rose-400')
        ].filter(Boolean).join('') : '';

        const statsRow = stats
          ? `<div class="flex items-center gap-3 text-[11px] mb-1">${stats}</div>`
          : `<div class="text-[11px] text-slate-600 mb-1">${st ? 'Projeto vazio' : 'Métricas indisponíveis'}</div>`;

        card.innerHTML = `
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-mono text-slate-500">${p.workspace_name}/</span>
              <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 group-hover:bg-blue-900/40 group-hover:text-blue-300 transition">
                ${p.page_count} ${p.page_count === 1 ? 'doc' : 'docs'}
              </span>
            </div>
            <h3 class="text-base font-bold text-slate-100 group-hover:text-blue-400 transition mb-2">
              ${p.project_name}
            </h3>
            ${statsRow}
          </div>
          <div class="mt-4 pt-3 border-t border-slate-800/80 flex items-center gap-2 text-[11px] text-slate-500">
            <span class="truncate" title="Última atualização">${updatedText}${relativeText ? ` <span class="text-slate-600">· ${relativeText}</span>` : ''}</span>
            <div class="ml-auto shrink-0 flex items-center">
            <button onclick="event.stopPropagation(); downloadZipDirect('${p.workspace_name}', '${p.project_name}')" title="Baixar ZIP" class="p-1 hover:text-emerald-400 transition">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            </button>
            <button onclick="event.stopPropagation(); confirmDeleteProject('${p.workspace_name}', '${p.project_name}', ${p.page_count})" title="Deletar projeto" class="p-1 hover:text-rose-400 transition">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
            </div>
          </div>
        `;
        grid.appendChild(card);
      });
    }

    function goToProjects() {
      $('projectsView').classList.remove('hidden');
      $('searchView').classList.add('hidden');
      $('projectDetailView').classList.add('hidden');
      $('backupsView').classList.add('hidden');
      currentProject = null;
      currentDocPath = null;
      currentSessionId = null;
      closeGraph();
      updateBreadcrumb();
      syncUrl();
    }

    async function openProject(workspace: string, project: string) {
      currentWorkspace = workspace;
      currentProject = project;
      currentDocPath = null;
      currentDocData = null;
      currentHistoryData = null;
      currentSessionId = null;
      closeGraph();
      switchSidebarTab('docs');

      $('projectsView').classList.add('hidden');
      $('searchView').classList.add('hidden');
      $('projectDetailView').classList.remove('hidden');

      $('sidebarProjectTitle').innerText = `${workspace}/${project}`;
      updateBreadcrumb();

      // Reset viewer para exibir a Atividade Recente (igual ao ai-memory original).
      // O setDocMode e o que tira o editor da tela: zerar currentDocPath la em
      // cima nao mexe no DOM, entao quem trocava de projeto no meio de uma
      // edicao seguia com o editor aberto, carregado com o texto do anterior.
      setDocMode('view');
      $('docHeader').classList.add('hidden');
      renderRecentActivityPlaceholder();

      syncUrl();
      await loadProjectPages();
      renderRecentActivityView();
      loadProjectHistory(); // Carrega contagem do histórico em background
    }

    function renderRecentActivityPlaceholder() {
      const viewer = $('docViewer');
      viewer.innerHTML = `
        <div class="max-w-5xl w-full mx-auto py-4">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">Atividade Recente</div>
          <div class="text-slate-500 text-xs py-8 text-center">Carregando atividade recente...</div>
        </div>
      `;
    }

    function renderRecentActivityView() {
      if (currentDocPath || currentSessionId) return;
      const viewer = $('docViewer');
      if (!currentPagesList || currentPagesList.length === 0) {
        viewer.innerHTML = `
          <div class="max-w-5xl w-full mx-auto py-4">
            <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">Atividade Recente</div>
            <div class="text-slate-500 text-xs py-8 text-center">Nenhum documento recente neste projeto.</div>
          </div>
        `;
        return;
      }

      // Ordena pelas páginas mais recentes
      const sorted = [...currentPagesList].sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });

      let itemsHtml = sorted.map(p => {
        const kind = p.kind || 'note';
        const color = kindColor(kind);
        const timeStr = timeAgo(p.updated_at);
        const flags = (p.health || []).map((f: string) => HEALTH_FLAGS[f]).filter(Boolean);
        const flagIcons = flags.map((f: Json) => `<span class="${f.tone}" title="${f.title}">${f.icon}</span>`).join(' ');

        return `
          <div onclick="loadDoc('${escapeHtml(p.path)}')" class="p-3 rounded-lg border border-slate-800/80 bg-slate-900/40 hover:bg-slate-900/80 hover:border-slate-700 cursor-pointer transition flex items-center justify-between group">
            <div class="min-w-0 pr-4">
              <div class="text-sm font-medium text-slate-200 group-hover:text-blue-300 transition truncate flex items-center gap-1.5">
                ${flagIcons ? `<span>${flagIcons}</span>` : ''}
                <span>${escapeHtml(p.title || p.path)}</span>
              </div>
              <div class="flex items-center gap-2 mt-1">
                <span class="px-1.5 py-0.2 rounded text-[10px] font-mono font-medium" style="background: ${color}20; color: ${color}; border: 1px solid ${color}40">${escapeHtml(kind)}</span>
                <span class="text-xs text-slate-500 font-mono truncate">${escapeHtml(p.path)}</span>
              </div>
            </div>
            <div class="text-xs text-slate-500 shrink-0 tabular-nums">
              ${timeStr}
            </div>
          </div>
        `;
      }).join('');

      viewer.innerHTML = `
        <div class="max-w-5xl w-full mx-auto py-4">
          <div class="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
            <div>
              <h2 class="text-base font-bold text-slate-100">${escapeHtml(currentWorkspace)}/${escapeHtml(currentProject!)}</h2>
              <div class="text-xs text-slate-400 font-medium uppercase tracking-wider mt-0.5">Atividade Recente</div>
            </div>
            <span class="text-xs text-slate-500">${sorted.length} ${sorted.length === 1 ? 'documento' : 'documentos'}</span>
          </div>
          <div class="space-y-2">
            ${itemsHtml}
          </div>
        </div>
      `;
    }

    // Sidebar redimensionavel: largura em px salva no localStorage.
    (function initSidebarResize() {
      const aside = $('projectSidebar');
      const grip = $('sidebarResizer');
      const saved = parseInt(localStorage.getItem('sidebarWidth') || '', 10);
      if (saved) aside.style.width = saved + 'px';

      grip.addEventListener('mousedown', e => {
        e.preventDefault();
        const move = (ev: MouseEvent) => {
          const w = Math.min(700, Math.max(200, ev.clientX - aside.getBoundingClientRect().left));
          aside.style.width = w + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.userSelect = '';
          localStorage.setItem('sidebarWidth', String(parseInt(aside.style.width, 10)));
        };
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    })();

    function timeAgo(dateStr: string | null | undefined) {
      if (!dateStr) return '';
      const now = Date.now();
      const diff = Math.max(0, now - new Date(dateStr).getTime());
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return 'agora mesmo';
      const min = Math.floor(sec / 60);
      if (min < 60) return `há ${min} ${min === 1 ? 'minuto' : 'minutos'}`;
      const hrs = Math.floor(min / 60);
      if (hrs < 24) return `há ${hrs} ${hrs === 1 ? 'hora' : 'horas'}`;
      const days = Math.floor(hrs / 24);
      if (days < 30) return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
      const months = Math.floor(days / 30);
      if (months < 12) return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;
      const years = Math.floor(days / 365);
      return `há ${years} ${years === 1 ? 'ano' : 'anos'}`;
    }

    async function loadProjectPages() {
      try {
        const res = await fetch(`/api/pages?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}`);
        const pages = await res.json();
        currentPagesList = pages;
        $('sidebarDocCount').innerText = `${pages.length} ${pages.length === 1 ? 'documento' : 'documentos'}`;
        renderSidebarPages(pages);
      } catch (err) {
        alert('Erro ao carregar lista de páginas: ' + errMsg(err));
      }
    }

    // Marcadores de saude de uma pagina. Espelham os icones do card de projeto.
    const HEALTH_FLAGS: Record<string, { icon: string; tone: string; title: string }> = {
      orphan:    { icon: '🔗', tone: 'text-slate-600', title: 'Órfã: nenhum [[wikilink]] entra ou sai desta página' },
      stale:     { icon: '⌛', tone: 'text-rose-400',  title: 'Episódica sem atualização há mais de 30 dias' },
      duplicate: { icon: '⧉',  tone: 'text-rose-400',  title: 'Outra página deste projeto tem o mesmo título' }
    };

    const SVG_DOWNLOAD = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>';
    const SVG_TRASH = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>';

    // Botao de icone que nao dispara o clique do item em volta.
    function iconButton(svg: string, title: string, tone: string, onClick: () => void): HTMLButtonElement {
      const b = document.createElement('button');
      b.className = `p-0.5 rounded text-slate-500 ${tone} transition`;
      b.title = title;
      b.innerHTML = svg;
      b.onclick = (e: MouseEvent) => { e.stopPropagation(); onClick(); };
      return b;
    }

    function renderSidebarPages(pages: Json[]) {
      const container = $('pagesListContainer');
      container.innerHTML = '';

      if (!pages || pages.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500 p-2">Nenhum documento encontrado.</div>';
        return;
      }

      // Agrupa por pasta (prefixo até a primeira barra)
      const groups: Record<string, Json[]> = {};
      pages.forEach((p: Json) => {
        const parts = p.path.split('/');
        let folder = 'raiz';
        if (parts.length > 1) {
          folder = parts[0] + '/';
        }
        if (!groups[folder]) groups[folder] = [];
        groups[folder].push(p);
      });

      Object.keys(groups).sort().forEach(folder => {
        const groupEl = document.createElement('div');
        groupEl.className = 'mb-3';

        const header = document.createElement('div');
        header.className = 'text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-2 py-1 flex items-center gap-1.5';
        header.innerHTML = `
          <svg class="w-3 h-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
          <span>${folder}</span>
        `;
        groupEl.appendChild(header);

        const list = document.createElement('ul');
        list.className = 'space-y-0.5 mt-0.5';

        groups[folder].forEach(p => {
          const item = document.createElement('li');
          const isSelected = currentDocPath === p.path;
          item.className = `px-2.5 py-1.5 rounded-lg text-xs cursor-pointer truncate transition flex items-center justify-between group ${
            isSelected ? 'bg-blue-600/20 text-blue-300 font-medium border border-blue-500/30' : 'text-slate-300 hover:bg-slate-800/80 hover:text-slate-100'
          }`;
          item.onclick = () => loadDoc(p.path);

          // Mesmos marcadores dos cards da tela inicial, agora na pagina que os gera.
          const flags = (p.health || []).map((f: string) => HEALTH_FLAGS[f]).filter(Boolean);
          const flagIcons = flags.map((f: Json) => `<span class="${f.tone}" title="${f.title}">${f.icon}</span>`).join('');

          item.innerHTML = `
            <span class="truncate flex items-center gap-1.5" title="${escapeHtml(p.title || p.path)}">
              ${flagIcons}<span class="truncate">${escapeHtml(p.title || p.path)}</span>
            </span>
          `;

          // Baixar e deletar direto do item, no lugar onde antes so aparecia o
          // sufixo `.md`. Montados via DOM, e nao no innerHTML, para o path nao
          // ter que sobreviver a um onclick inline com aspas.
          const actions = document.createElement('span');
          actions.className = 'shrink-0 ml-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition';
          actions.appendChild(iconButton(SVG_DOWNLOAD, `Baixar ${p.path}`, 'hover:text-emerald-400', () => downloadDoc(p.path)));
          actions.appendChild(iconButton(SVG_TRASH, `Deletar ${p.path}`, 'hover:text-rose-400', () => confirmDeleteDoc(p.path)));
          item.appendChild(actions);

          list.appendChild(item);
        });

        groupEl.appendChild(list);
        container.appendChild(groupEl);
      });
    }

    function filterSidebarPages() {
      const term = $input('pageFilterInput').value.toLowerCase();
      if (!term) {
        renderSidebarPages(currentPagesList);
        return;
      }
      const filtered = currentPagesList.filter(p =>
        p.path.toLowerCase().includes(term) || (p.title && p.title.toLowerCase().includes(term))
      );
      renderSidebarPages(filtered);
    }

    async function loadDoc(docPath: string) {
      currentDocPath = docPath;
      currentSessionId = null;
      renderSidebarPages(currentPagesList); // re-render para atualizar classe ativa
      updateBreadcrumb();
      syncUrl();

      try {
        const res = await fetch(`/api/page?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}&path=${encodeURIComponent(docPath)}`);
        const page = await res.json();
        currentDocData = page;

        $('docHeader').classList.remove('hidden');
        $('docActions').classList.remove('hidden');
        $('docPath').innerText = page.path;

        // Metadados badges
        const tierBadge = $('docTierBadge');
        if (page.frontmatter?.tier) {
          tierBadge.innerText = page.frontmatter.tier;
          tierBadge.className = 'px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider bg-blue-950 text-blue-300 border border-blue-800';
          tierBadge.classList.remove('hidden');
        } else {
          tierBadge.classList.add('hidden');
        }

        const pinnedBadge = $('docPinnedBadge');
        if (page.frontmatter?.pinned) {
          pinnedBadge.classList.remove('hidden');
        } else {
          pinnedBadge.classList.add('hidden');
        }

        // Render Markdown
        setDocMode('view');
      } catch (err) {
        alert('Erro ao carregar documento: ' + errMsg(err));
      }
    }

    function setDocMode(mode: 'view' | 'edit') {
      currentDocMode = mode;
      syncUrl();
      const btnView = $('btnViewMode');
      const btnEdit = $('btnEditMode');
      const docViewer = $('docViewer');
      const docEditor = $('docEditor');
      const feedbackSec = $('docFeedbackSection');

      // Clicar numa pagina com o grafo aberto mostrava os dois painéis.
      closeGraph();
      closeWikiPopup();

      if (mode === 'view') {
        btnView.className = 'px-2.5 py-1 text-xs rounded-md bg-blue-600 text-white font-medium';
        btnEdit.className = 'px-2.5 py-1 text-xs rounded-md text-slate-400 hover:text-slate-200';
        docViewer.classList.remove('hidden');
        docEditor.classList.add('hidden');
        if (feedbackSec) feedbackSec.classList.remove('hidden');

        if (currentDocData && currentDocData.body) {
          // O titulo do frontmatter e o que a lista e os cards mostram; sem ele
          // aqui, a doc aberta nao tem ligacao visual com o item clicado.
          const docTitle = currentDocData.title || currentDocData.frontmatter?.title || currentDocData.path;
          const docKind = currentDocData.kind || currentDocData.frontmatter?.kind;
          // Doc que ja abre com `# Titulo` igual ao do frontmatter nao precisa do
          // cabecalho: sao as sessions (comecam em `##`) que ficavam sem titulo.
          const firstHeading = (currentDocData.body.match(/^\s*#\s+(.+)$/m) || [])[1];
          const duplicated = !!firstHeading && firstHeading.trim().toLowerCase() === String(docTitle).trim().toLowerCase();
          const kindBadge = docKind
            ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium" style="background: ${kindColor(docKind)}20; color: ${kindColor(docKind)}; border: 1px solid ${kindColor(docKind)}40">${escapeHtml(docKind)}</span>`
            : '';
          docViewer.innerHTML = `
            ${duplicated ? '' : `<div class="mb-5 pb-3 border-b border-slate-800">
              <h1 class="text-xl font-bold text-slate-100">${escapeHtml(docTitle)}</h1>
              <div class="flex items-center gap-2 mt-1.5">
                ${kindBadge}
                <span class="text-xs font-mono text-slate-500 truncate">${escapeHtml(currentDocData.path || '')}</span>
              </div>
            </div>`}
            <div id="docMarkdownBody" class="markdown-body text-slate-300"></div>
          `;
          docViewer.appendChild(feedbackNode);
          renderMarkdownInto($('docMarkdownBody'), currentDocData.body);
        }
      } else {
        btnEdit.className = 'px-2.5 py-1 text-xs rounded-md bg-blue-600 text-white font-medium';
        btnView.className = 'px-2.5 py-1 text-xs rounded-md text-slate-400 hover:text-slate-200';
        docViewer.classList.add('hidden');
        docEditor.classList.remove('hidden');
        if (feedbackSec) feedbackSec.classList.add('hidden');

        const ed = editorCm();
        ed.setValue(currentDocData ? currentDocData.body : '');
        // O container acabou de sair do `hidden`: sem refresh o CodeMirror
        // mediu altura zero e a doc abre em branco.
        ed.refresh();
        ed.focus();
        applyEditorPreview();
        $input('editPinned').checked = !!currentDocData?.frontmatter?.pinned;
        $sel('editTier').value = currentDocData?.frontmatter?.tier || 'semantic';
      }
    }

    // Markdown -> HTML com realce e mermaid. Mesmo caminho para a doc aberta e
    // para o preview do editor, senao os dois divergem na primeira mudanca.
    function renderMarkdownInto(el: HTMLElement, body: string) {
      el.innerHTML = marked.parse(body || '');

      el.querySelectorAll('pre code').forEach((block) => {
        if (!block.classList.contains('language-mermaid')) {
          hljs.highlightElement(block);
        }
      });

      el.querySelectorAll<HTMLElement>('.language-mermaid, pre.mermaid').forEach(async (node, idx) => {
        const code = node.innerText;
        const insertId = 'mermaid-' + idx + '-' + Date.now();
        try {
          const { svg } = await mermaid.render(insertId, code);
          const parent = node.closest('pre') || node;
          const wrapper = document.createElement('div');
          wrapper.className = 'my-4 p-4 rounded-lg bg-slate-900 border border-slate-800 flex justify-center';
          wrapper.innerHTML = svg;
          parent.replaceWith(wrapper);
        } catch (err) {
          console.warn('Mermaid render error:', err);
        }
      });
    }

    async function saveCurrentDoc() {
      if (!currentProject || !currentDocPath) return;

      const newBody = editorCm().getValue();
      const pinned = $input('editPinned').checked;
      const tier = $sel('editTier').value;

      const btnSave = $('btnSaveDoc') as HTMLButtonElement;
      btnSave.disabled = true;
      btnSave.innerText = 'Salvando...';

      try {
        const res = await fetch('/api/page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace: currentWorkspace,
            project: currentProject,
            path: currentDocPath,
            body: newBody,
            pinned,
            tier
          })
        });

        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao salvar');

        currentDocData.body = newBody;
        if (!currentDocData.frontmatter) currentDocData.frontmatter = {};
        currentDocData.frontmatter.pinned = pinned;
        currentDocData.frontmatter.tier = tier;

        setDocMode('view');
        await loadProjectPages();
      } catch (err) {
        alert('Erro ao salvar documento: ' + errMsg(err));
      } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
          <span>Salvar Alterações</span>
        `;
      }
    }

    async function confirmDeleteDoc(docPath: string | null = currentDocPath) {
      if (!currentProject || !docPath) return;
      const ok = confirm(`Tem certeza que deseja DELETAR o documento "${docPath}" do ai-memory?`);
      if (!ok) return;

      try {
        const res = await fetch(`/api/page?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}&path=${encodeURIComponent(docPath)}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao deletar');

        // Deletar pela lista lateral nao mexe na doc aberta, a menos que seja ela.
        if (currentDocPath === docPath) {
          currentDocPath = null;
          currentDocData = null;
          setDocMode('view');
          $('docHeader').classList.add('hidden');
        }
        await loadProjectPages();
        renderRecentActivityView();
      } catch (err) {
        alert('Erro ao deletar: ' + errMsg(err));
      }
    }

    function downloadDoc(docPath: string | null = currentDocPath) {
      if (!currentProject || !docPath) return;
      window.location.href = `/api/download/file?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}&path=${encodeURIComponent(docPath)}`;
    }

    function downloadProjectZip() {
      if (!currentProject) return;
      downloadZipDirect(currentWorkspace, currentProject);
    }

    function downloadZipDirect(workspace: string, project: string) {
      window.location.href = `/api/download/zip?workspace=${encodeURIComponent(workspace)}&project=${encodeURIComponent(project)}`;
    }

    // --- Backups ----------------------------------------------------------
    // O upstream nao mantem historico: POST /admin/backup devolve o tar.gz e
    // esquece. A dash guarda o arquivo e esta tela lista o que ela ja baixou —
    // backup feito por fora (curl, cron no servidor) nao aparece aqui.
    function openBackupsView() {
      $('projectsView').classList.add('hidden');
      $('searchView').classList.add('hidden');
      $('projectDetailView').classList.add('hidden');
      $('backupsView').classList.remove('hidden');
      loadBackups();
    }

    function humanBytes(n: number): string {
      const mb = n / 1024 / 1024;
      return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    }

    async function loadBackups() {
      const list = $('backupsList');
      try {
        const items: Json[] = await (await fetch('/api/backups')).json();
        if (!items.length) {
          list.innerHTML = '<div class="text-xs text-slate-500 py-10 text-center border border-dashed border-slate-800 rounded-xl">Nenhum backup ainda. O botão acima gera o primeiro.</div>';
          return;
        }
        list.innerHTML = items.map((b: Json) => `
          <div class="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
            <svg class="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"></path></svg>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-mono text-slate-200 truncate">${escapeHtml(b.name)}</div>
              <div class="text-[11px] text-slate-500">${new Date(b.created).toLocaleString('pt-BR')} · ${humanBytes(b.bytes)} · ${timeAgo(b.created)}</div>
            </div>
            <a href="/api/backup/file?name=${encodeURIComponent(b.name)}" title="Baixar" class="p-1.5 text-slate-400 hover:text-emerald-400 transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            </a>
            <button onclick="deleteBackup('${b.name}')" title="Deletar" class="p-1.5 text-slate-400 hover:text-rose-400 transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>`).join('');
      } catch (err) {
        list.innerHTML = `<div class="text-xs text-rose-400 py-6 text-center">Erro ao listar backups: ${escapeHtml(errMsg(err))}</div>`;
      }
    }

    async function createBackup() {
      const btn = $('btnCreateBackup') as HTMLButtonElement;
      const label = btn.innerHTML; // guarda o icone junto com o texto
      btn.disabled = true;
      btn.innerText = 'Gerando...'; // o upstream monta o tar.gz na hora, demora
      try {
        const res = await fetch('/api/backup', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao gerar backup');
        await loadBackups();
      } catch (err) {
        alert('Erro ao gerar backup: ' + errMsg(err));
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    }

    async function deleteBackup(name: string) {
      if (!confirm(`Apagar o backup ${name}?`)) return;
      try {
        const res = await fetch(`/api/backup?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao apagar');
        await loadBackups();
      } catch (err) {
        alert('Erro ao apagar backup: ' + errMsg(err));
      }
    }

    // --- Novo projeto -----------------------------------------------------
    // O ai-memory nao tem "criar projeto": o projeto nasce quando a primeira
    // pagina e escrita nele (memory_write_page cria o projeto que nao existe).
    // Entao criar = semear notes/index.md e abrir a doc para edicao.
    function openNewProjectModal() {
      $input('newProjectName').value = '';
      $input('newProjectWorkspace').value = 'default';
      previewProjectSlug();
      $('newProjectModal').classList.remove('hidden');
      $input('newProjectName').focus();
    }

    function closeNewProjectModal() {
      $('newProjectModal').classList.add('hidden');
    }

    // Nome vira diretorio no ai-memory: mesma forma dos projetos criados pelos
    // hooks (minusculo, sem acento, sem espaco).
    function slugProject(name: string): string {
      return (name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    }

    function previewProjectSlug() {
      const raw = $input('newProjectName').value;
      const slug = slugProject(raw);
      const hint = $('newProjectSlug');
      hint.innerText = slug
        ? `Vai virar: ${slug}`
        : 'Minúsculas, sem acento nem espaço — o nome vira o diretório no ai-memory.';
      hint.className = `text-[11px] mt-1 font-mono ${slug && slug !== raw.trim() ? 'text-amber-400' : 'text-slate-500'}`;
    }

    async function createProjectSubmit() {
      const raw = $input('newProjectName').value.trim();
      const project = slugProject(raw);
      const workspace = slugProject($input('newProjectWorkspace').value) || 'default';
      const seedPath = 'notes/index.md';

      if (!project) {
        alert('Informe um nome de projeto (letras, números, - . _)');
        return;
      }
      if (allProjects.some((p: Json) => p.project_name === project && p.workspace_name === workspace)) {
        alert(`O projeto ${workspace}/${project} já existe.`);
        return;
      }

      const btn = $('btnCreateProject') as HTMLButtonElement;
      btn.disabled = true;
      btn.innerText = 'Criando...';
      try {
        const res = await fetch('/api/page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace,
            project,
            path: seedPath,
            // O H1 vira o titulo da pagina no ai-memory; usa o nome como foi
            // digitado, com acento e maiuscula, nao o slug do diretorio.
            body: `# ${raw}\n\n_Projeto criado pela dash. Descreva aqui o escopo e o que vale lembrar._\n`,
            tier: 'semantic'
          })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao criar projeto');

        closeNewProjectModal();
        loadProjects(); // atualiza a home por baixo, sem segurar a navegacao
        await openProject(workspace, project);
        await loadDoc(seedPath);
        setDocMode('edit');
      } catch (err) {
        alert('Erro ao criar projeto: ' + errMsg(err));
      } finally {
        btn.disabled = false;
        btn.innerText = 'Criar Projeto';
      }
    }

    // Modal Criação de Nova Doc
    function openNewDocModal() {
      $input('newDocPath').value = '';
      $area('newDocBody').value = '';
      $input('newDocPinned').checked = false;
      $sel('newDocTier').value = 'semantic';
      $('newDocModal').classList.remove('hidden');
    }

    function closeNewDocModal() {
      $('newDocModal').classList.add('hidden');
    }

    async function createDocSubmit() {
      const docPath = $input('newDocPath').value.trim();
      const body = $area('newDocBody').value.trim();
      const pinned = $input('newDocPinned').checked;
      const tier = $sel('newDocTier').value;

      if (!docPath) {
        alert('Por favor informe o caminho do arquivo (ex: notes/meu-doc.md)');
        return;
      }
      if (!body) {
        alert('Por favor informe o conteúdo do arquivo');
        return;
      }

      try {
        const res = await fetch('/api/page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace: currentWorkspace,
            project: currentProject,
            path: docPath,
            body,
            pinned,
            tier
          })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao criar');

        closeNewDocModal();
        await loadProjectPages();
        await loadDoc(docPath);
      } catch (err) {
        alert('Erro ao criar página: ' + errMsg(err));
      }
    }

    // Busca FTS5. O escopo so existe com um projeto aberto; ao voltar para a
    // lista de projetos a busca volta a ser global.
    let searchScopeProject = false;

    function toggleSearchScope() {
      searchScopeProject = !searchScopeProject;
      updateSearchScopeBtn();
      if ($input('searchInput').value.trim()) doSearch();
    }

    function updateSearchScopeBtn() {
      const btn = $('searchScopeBtn');
      if (!currentProject) {
        searchScopeProject = false;
        btn.classList.add('hidden');
        return;
      }
      btn.classList.remove('hidden');
      btn.innerText = searchScopeProject ? `só em ${currentProject}` : 'todos os projetos';
      btn.className = searchScopeProject
        ? 'shrink-0 px-2 py-1 rounded-lg border text-[10px] font-medium transition max-w-[10rem] truncate bg-blue-600 border-blue-500 text-white'
        : 'shrink-0 px-2 py-1 rounded-lg border text-[10px] font-medium transition max-w-[10rem] truncate bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200';
    }

    async function doSearch() {
      const q = $input('searchInput').value.trim();
      if (!q) return;

      const scope = searchScopeProject && currentProject
        ? `&workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject)}`
        : '';

      syncSearchUrl(q, !!scope);

      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}${scope}`);
        const results = await res.json();

        $('projectsView').classList.add('hidden');
        $('projectDetailView').classList.add('hidden');
        $('searchView').classList.remove('hidden');

        $('searchQueryLabel').innerText = scope ? `${q} (em ${currentProject})` : q;
        renderSearchResults(results);
      } catch (err) {
        alert('Erro na busca: ' + errMsg(err));
      }
    }

    function renderSearchResults(results: Json[]) {
      const container = $('searchResults');
      container.innerHTML = '';

      if (!results || results.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500 py-6">Nenhum resultado encontrado para o termo pesquisado.</div>';
        return;
      }

      results.forEach((r: Json) => {
        const item = document.createElement('div');
        item.className = 'p-4 rounded-xl border border-slate-800 bg-slate-900/60 hover:border-slate-700 cursor-pointer transition';
        item.onclick = async () => {
          await openProject(r.workspace || 'default', r.project);
          await loadDoc(r.path);
        };

        item.innerHTML = `
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-mono text-blue-400 font-medium">${r.project}/${r.path}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">${r.kind || 'doc'}</span>
          </div>
          <h4 class="text-sm font-semibold text-slate-100 mb-1.5">${r.title || r.path}</h4>
          <div class="text-xs text-slate-400 line-clamp-2 leading-relaxed">${r.snippet || ''}</div>
        `;
        container.appendChild(item);
      });
    }

    function updateBreadcrumb() {
      updateSearchScopeBtn();
      const b = $('breadcrumb');
      if (!currentProject) {
        b.innerHTML = '';
        b.classList.add('hidden');
        return;
      }
      b.classList.remove('hidden');
      let html = `
        <a href="javascript:void(0)" onclick="goToProjects()" class="hover:text-slate-200">projetos</a>
        <span>/</span>
        <a href="javascript:void(0)" onclick="openProject('${escapeHtml(currentWorkspace)}', '${escapeHtml(currentProject!)}')" class="text-slate-300 hover:text-white font-medium">${escapeHtml(currentWorkspace)}/${escapeHtml(currentProject!)}</a>
      `;
      if (currentDocPath) {
        // O path e truncado no meio quando o nome e longo, dai o title no hover
        // e o botao de copiar: e o que se cola num [[wikilink]] ou numa chamada
        // do MCP.
        html += `
          <span>/</span>
          <span class="text-blue-400 truncate max-w-xs font-mono" title="${escapeHtml(currentDocPath)}">${escapeHtml(currentDocPath)}</span>
          <button id="btnCopyPath" onclick="copyDocPath()" title="Copiar caminho do documento" class="shrink-0 p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
          </button>
        `;
      }
      b.innerHTML = html;
    }

    // ======================= Grafo de links =======================
    // ponytail: simulacao de forcas escrita a mao em ~50 linhas em vez de puxar
    // d3. O maior projeto tem 79 nos, entao o O(n²) de repulsao e irrelevante.
    // Trocar por quadtree/d3-force so se algum projeto passar de uns 500 nos.
    let graphData: Json = null;
    let graphSim: number | null = null;
    // Layout ja assentado, por projeto: reabrir o grafo do mesmo projeto
    // restaura as posicoes em vez de re-simular. A animacao de entrada vale
    // uma vez; repetida a cada reabertura vira ruido.
    let graphLayout: { key: string; pos: Record<string, { x: number; y: number }> } | null = null;
    let graphNodesRef: Json[] = [];

    const graphKey = () => `${currentWorkspace}/${currentProject}`;

    function saveGraphLayout() {
      if (!graphNodesRef.length) return;
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of graphNodesRef) {
        if (typeof n.x === 'number' && typeof n.y === 'number') pos[n.id] = { x: n.x, y: n.y };
      }
      graphLayout = { key: graphKey(), pos };
    }

    const KIND_COLORS: Record<string, string> = {
      decision: '#f59e0b', gotcha: '#f43f5e', concept: '#8b5cf6', fact: '#22d3ee',
      note: '#64748b', session: '#334155', runbook: '#10b981', preference: '#ec4899'
    };
    const kindColor = (k: string) => KIND_COLORS[k] || '#64748b';

    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !$('graphNodeModal').classList.contains('hidden')) return closeGraphNodeModal();
      if (ev.key !== 'f' && ev.key !== 'F') return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
      if ($('graphView')?.classList.contains('hidden')) return;
      fitGraph();
    });

    // Pan e zoom aplicados num <g> envolvente: um transform, nenhum recalculo
    // da simulacao. `panned` distingue arrasto do fundo de clique num no.
    const graphView = { k: 1, tx: 0, ty: 0, panned: false };

    function applyGraphView() {
      const vp = document.querySelector('#gViewport');
      if (!vp) return;
      vp.setAttribute('transform', `translate(${graphView.tx},${graphView.ty}) scale(${graphView.k})`);
      $('graphZoomLabel').innerText = Math.round(graphView.k * 100) + '%';
      // Abaixo disso o label de 9px fica ilegivel e so sobrepoe: mostra so os hubs.
      $('graphSvg').classList.toggle('lod', graphView.k < 1.3);
    }

    function resetGraphView(svg: SVGSVGElement) {
      graphView.k = 1; graphView.tx = 0; graphView.ty = 0; graphView.panned = false;
      applyGraphView();
      if (svg.dataset.zoomBound) return;
      svg.dataset.zoomBound = '1';

      // Zoom ancorado no cursor: o ponto sob o mouse fica parado.
      svg.addEventListener('wheel', (ev: WheelEvent) => {
        ev.preventDefault();
        const r = svg.getBoundingClientRect();
        const mx = ev.clientX - r.left, my = ev.clientY - r.top;
        const k = Math.min(8, Math.max(0.15, graphView.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
        graphView.tx = mx - (mx - graphView.tx) * (k / graphView.k);
        graphView.ty = my - (my - graphView.ty) * (k / graphView.k);
        graphView.k = k;
        applyGraphView();
      }, { passive: false });

      let dragging: { x: number; y: number; tx: number; ty: number } | null = null;
      svg.addEventListener('mousedown', (ev: MouseEvent) => {
        dragging = { x: ev.clientX, y: ev.clientY, tx: graphView.tx, ty: graphView.ty };
        graphView.panned = false;
        svg.style.cursor = 'grabbing';
      });
      window.addEventListener('mousemove', (ev: MouseEvent) => {
        if (!dragging) return;
        const dx = ev.clientX - dragging.x, dy = ev.clientY - dragging.y;
        if (Math.hypot(dx, dy) > 3) graphView.panned = true;
        graphView.tx = dragging.tx + dx;
        graphView.ty = dragging.ty + dy;
        applyGraphView();
      });
      window.addEventListener('mouseup', () => {
        dragging = null;
        svg.style.cursor = 'grab';
        // Zera no proximo tick, depois do click do no ter sido avaliado.
        setTimeout(() => { graphView.panned = false; }, 0);
      });
      svg.addEventListener('dblclick', () => fitGraph());
    }

    // Enquadra o conteudo: le a caixa real dos nos ja posicionados.
    function fitGraph() {
      const svg = $('graphSvg') as unknown as SVGSVGElement;
      const vp = svg?.querySelector<SVGGraphicsElement>('#gViewport');
      if (!vp) return;

      graphView.k = 1; graphView.tx = 0; graphView.ty = 0;
      applyGraphView();

      const b = vp.getBBox();
      if (!b.width || !b.height) return;
      const r = svg.getBoundingClientRect();
      const pad = 30;
      const k = Math.min(8, Math.max(0.15,
        Math.min((r.width - pad * 2) / b.width, (r.height - pad * 2) / b.height)));
      graphView.k = k;
      graphView.tx = (r.width - b.width * k) / 2 - b.x * k;
      graphView.ty = (r.height - b.height * k) / 2 - b.y * k;
      applyGraphView();
    }

    async function toggleGraphView() {
      const view = $('graphView');
      if (!view.classList.contains('hidden')) {
        closeGraph();
        setDocMode('view');
        return;
      }

      $('docViewer').classList.add('hidden');
      $('docEditor').classList.add('hidden');
      // A barra da doc age sobre currentDocPath — inclusive o Deletar. Com o
      // grafo na tela ela nao tem contexto nenhum, entao sai junto.
      $('docHeader').classList.add('hidden');
      view.classList.remove('hidden');
      view.classList.add('flex');

      $('graphSummary').innerText = 'Carregando grafo...';
      try {
        const res = await fetch(`/api/graph?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}`);
        graphData = await res.json();
        if (graphData.error) throw new Error(graphData.error);
        renderGraph();
      } catch (err) {
        $('graphSummary').innerText = 'Erro ao montar o grafo: ' + errMsg(err);
      }
    }

    function stopGraph() {
      if (graphSim) { cancelAnimationFrame(graphSim); graphSim = null; }
      saveGraphLayout(); // fechar no meio da simulacao tambem guarda o que ja tem
    }

    // Fecha o grafo e descarta os dados. Chamada de todo ponto que troca o que
    // esta na tela: sem isso o grafo de um projeto sobrevivia a navegacao e
    // reaparecia sobre o proximo.
    function closeGraph() {
      stopGraph();
      graphData = null;
      graphNodesRef = [];
      const panel = $('graphView');
      // Limpa o desenho: sem isso o grafo antigo reaparecia por um instante ao
      // reabrir, antes do fetch novo terminar.
      $('graphSvg').innerHTML = '';
      if (!panel || panel.classList.contains('hidden')) return;
      panel.classList.add('hidden');
      panel.classList.remove('flex');
      // Abrir o grafo escondeu o viewer; devolve, senao a area principal fica
      // em branco para quem so navegou (setDocMode ajusta depois, se for o caso).
      $('docViewer').classList.remove('hidden');
      if (currentDocPath || currentSessionId) {
        $('docHeader').classList.remove('hidden');
      }
    }

    function renderGraph() {
      stopGraph();
      if (!graphData) return;

      const hideOrphans = $input('graphHideOrphans').checked;
      const nodes = graphData.nodes
        .filter((n: Json) => !(hideOrphans && n.degree === 0))
        .map((n: Json) => ({ ...n }));
      const byId = new Map<string, Json>(nodes.map((n: Json) => [n.id, n]));
      const edges = graphData.edges
        .map((e: Json) => ({ source: byId.get(e.from), target: byId.get(e.to) }))
        .filter((e: Json) => e.source && e.target);

      const svg = $('graphSvg') as unknown as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      const W = rect.width || 800, H = rect.height || 600;

      const orphanCount = graphData.nodes.filter((n: Json) => n.degree === 0).length;
      $('graphSummary').innerHTML =
        `<strong class="text-slate-200">${nodes.length}</strong> páginas · ` +
        `<strong class="text-slate-200">${edges.length}</strong> links · ` +
        `${orphanCount} sem nenhuma conexão`;

      const kinds = [...new Set<string>(nodes.map((n: Json) => n.kind))].sort();
      $('graphLegend').innerHTML = kinds
        .map((k: string) => `<div><span style="color:${kindColor(k)}">●</span> ${k}</div>`).join('')
        + '<div class="text-slate-600 mt-1">tracejado = outro projeto</div>';

      if (nodes.length === 0) {
        svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#475569" font-size="13">Nenhuma página para exibir.</text>';
        return;
      }

      // Layout guardado deste mesmo projeto cobre todos os nos? Entao entra
      // pronto, sem simular. Senao, posicao inicial em circulo: converge mais
      // rapido e evita o empurrao caotico de comecar todo mundo no mesmo ponto.
      const cached = graphLayout && graphLayout.key === graphKey() ? graphLayout.pos : null;
      const restored = !!cached && nodes.every((n: Json) => cached[n.id]);

      // Conectados nascem num circulo pequeno no centro e orfas num anel por
      // fora: comecando todos no mesmo anel, o cluster assentava na borda.
      const connected = nodes.filter((n: Json) => n.degree > 0);
      const orphans = nodes.filter((n: Json) => n.degree === 0);
      const place = (group: Json[], r: number) => group.forEach((n: Json, i: number) => {
        const a = (i / group.length) * Math.PI * 2;
        n.x = W / 2 + Math.cos(a) * r;
        n.y = H / 2 + Math.sin(a) * r;
      });
      if (restored) {
        nodes.forEach((n: Json) => { n.x = cached![n.id]!.x; n.y = cached![n.id]!.y; });
      } else {
        place(connected, Math.sqrt(connected.length) * 12);
        place(orphans, Math.min(W, H) * 0.45);
      }
      nodes.forEach((n: Json) => { n.vx = 0; n.vy = 0; });
      graphNodesRef = nodes;

      const radius = (n: Json) => 4 + Math.min(n.degree, 8);

      svg.innerHTML = `
        <g id="gViewport">
          <g id="gEdges" stroke-linecap="round"></g>
          <g id="gNodes"></g>
        </g>
      `;
      const gEdges = svg.querySelector('#gEdges')!;
      const gNodes = svg.querySelector('#gNodes')!;
      resetGraphView(svg);

      const edgeEls = edges.map((e: Json) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        const cross = e.source.project !== e.target.project;
        el.setAttribute('stroke', cross ? '#7c3aed' : '#1e293b');
        el.setAttribute('stroke-width', cross ? '1.4' : '1');
        if (cross) el.setAttribute('stroke-dasharray', '3 3');
        gEdges.appendChild(el);
        return el;
      });

      const neighbors = new Map<Json, Set<Json>>(nodes.map((n: Json) => [n, new Set([n])]));
      for (const e of edges) {
        neighbors.get(e.source)!.add(e.target);
        neighbors.get(e.target)!.add(e.source);
      }

      const setHover = (n: Json | null) => {
        svg.classList.toggle('hovering', !!n);
        const near = n ? neighbors.get(n)! : null;
        nodes.forEach((m: Json, i: number) => {
          const el = nodeEls[i];
          el.classList.toggle('hl', !!near?.has(m));
          el.classList.toggle('hover', m === n);
          // Label cheio so no no sob o mouse; o resto segue truncado.
          el.querySelector('text')!.textContent = m === n ? m.title : shortTitle(m.title);
        });
        edges.forEach((e: Json, i: number) => {
          edgeEls[i].classList.toggle('hl', !!n && (e.source === n || e.target === n));
        });
      };
      const shortTitle = (s: string) => s.length > 28 ? s.slice(0, 27) + '…' : s;

      const nodeEls = nodes.map((n: Json) => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.style.cursor = 'pointer';
        g.classList.add('gnode');
        if (n.degree < 3) g.classList.add('minor');
        // Caixa que o no ocupa: circulo em cima, label de 9px (~5.2px/char)
        // embaixo. A colisao usa isso; so o raio deixava nome em cima de nome.
        n.hw = Math.max(radius(n), shortTitle(n.title).length * 2.6);
        n.top = radius(n);
        n.bot = radius(n) + 13;

        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('r', String(radius(n)));
        c.setAttribute('fill', n.degree === 0 ? '#1e293b' : kindColor(n.kind));
        c.setAttribute('stroke', n.external ? '#7c3aed' : (n.degree === 0 ? '#334155' : '#0f172a'));
        c.setAttribute('stroke-width', n.external ? '1.5' : '1');
        if (n.external) c.setAttribute('stroke-dasharray', '2 2');
        g.appendChild(c);

        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('font-size', '9');
        t.setAttribute('fill', n.degree === 0 ? '#475569' : '#94a3b8');
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('dy', String(radius(n) + 10));
        t.textContent = shortTitle(n.title);
        g.appendChild(t);

        // Vai pro fim do grupo: o SVG desenha em ordem, entao o nome cheio
        // fica por cima dos vizinhos em vez de embaixo. So move se ainda nao
        // for o ultimo: mover dispara mouseenter de novo, e o loop tirava o no
        // do DOM entre mousedown e mouseup, matando o click.
        g.onmouseenter = () => {
          if (gNodes.lastChild !== g) gNodes.appendChild(g);
          setHover(n);
        };
        g.onmouseleave = () => setHover(null);
        g.onclick = () => {
          if (graphView.panned) return;   // arrastou o fundo: nao e clique
          openGraphNodeModal(n);
        };
        gNodes.appendChild(g);
        return g;
      });

      // Verlet simplificado: repulsao entre todos, mola nas arestas, gravidade
      // fraca ao centro. Alpha decai para a coisa parar sozinha.
      // Frames proporcionais ao tamanho: grafo de 20 nos assenta em ~70 frames
      // e esperava os mesmos ~4s de um de 150.
      const frames = Math.min(260, Math.max(70, nodes.length * 3));
      const decay = Math.pow(0.02, 1 / frames);
      let alpha = 1;
      let ring = -1;   // raio do anel das orfas, suavizado entre frames
      const tick = () => {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d2 = dx * dx + dy * dy || 0.01;
            const d = Math.sqrt(d2);
            // Colisao por caixa, pelo eixo de menor penetracao. Comeca como
            // empurrao na velocidade e so vira correcao de posicao conforme
            // o alpha esfria: corrigir posicao desde o 1o frame brigava com as
            // outras forcas e o grafo grande tremia ate assentar.
            const ox = a.hw + b.hw + 6 - Math.abs(dx);
            const oy = (dy >= 0 ? a.bot + b.top : a.top + b.bot) + 4 - Math.abs(dy);
            if (ox > 0 && oy > 0) {
              const hard = (1 - alpha) * (1 - alpha) / 2;
              if (ox < oy) {
                const s = Math.sign(dx || 1);
                a.vx -= ox * 0.15 * s; b.vx += ox * 0.15 * s;
                a.x -= ox * hard * s; b.x += ox * hard * s;
              } else {
                const s = Math.sign(dy || 1);
                a.vy -= oy * 0.15 * s; b.vy += oy * 0.15 * s;
                a.y -= oy * hard * s; b.y += oy * hard * s;
              }
            }
            if (d2 > 250000) continue;             // longe demais: ignora
            // Piso no d²: par nascido quase no mesmo ponto levava um chute de
            // milhares de px e o fitGraph caia no zoom minimo tentando enquadrar.
            const f = 800 / Math.max(d2, 400);
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
          }
        }
        for (const e of edges) {
          const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
          const d = Math.hypot(dx, dy) || 0.01;
          const f = (d - 60) * 0.02;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          e.source.vx += fx; e.source.vy += fy;
          e.target.vx -= fx; e.target.vy -= fy;
        }
        // Orfas sao puxadas para um anel 40px alem do no conectado mais
        // distante; conectados, com gravidade um pouco maior, ficam no miolo.
        // O raio segue o cluster devagar: recalculado seco a cada frame, ele
        // pulava junto com o no mais distante e o anel inteiro oscilava.
        let far = 0;
        for (const n of connected) far = Math.max(far, Math.hypot(n.x - W / 2, n.y - H / 2) + n.hw);
        ring = ring < 0 ? far : ring + (far - ring) * 0.1;
        for (const n of nodes) {
          if (n.degree === 0 && connected.length) {
            const dx = n.x - W / 2, dy = n.y - H / 2, d = Math.hypot(dx, dy) || 1;
            const f = (ring + 40 - d) * 0.02;
            n.vx += (dx / d) * f; n.vy += (dy / d) * f;
          } else {
            const k = n.degree > 0 ? 0.004 : 0.002;
            n.vx += (W / 2 - n.x) * k;
            n.vy += (H / 2 - n.y) * k;
          }
          n.x += n.vx * alpha; n.y += n.vy * alpha;
          n.vx *= 0.82; n.vy *= 0.82;
          // Sem prender na tela: o clamp espremia projeto grande contra a
          // borda. O fitGraph no fim enquadra o que sobrar.
        }

        edges.forEach((e: Json, i: number) => {
          edgeEls[i].setAttribute('x1', e.source.x); edgeEls[i].setAttribute('y1', e.source.y);
          edgeEls[i].setAttribute('x2', e.target.x); edgeEls[i].setAttribute('y2', e.target.y);
        });
        nodes.forEach((n: Json, i: number) => nodeEls[i].setAttribute('transform', `translate(${n.x},${n.y})`));

        alpha *= decay;
        if (alpha > 0.02) {
          graphSim = requestAnimationFrame(tick);
        } else {
          graphSim = null;
          saveGraphLayout();
          fitGraph();   // layout assentou: enquadra o resultado
        }
      };

      if (restored) {
        // Desenha uma vez nas posicoes guardadas e para por aqui.
        edges.forEach((e: Json, i: number) => {
          edgeEls[i].setAttribute('x1', e.source.x); edgeEls[i].setAttribute('y1', e.source.y);
          edgeEls[i].setAttribute('x2', e.target.x); edgeEls[i].setAttribute('y2', e.target.y);
        });
        nodes.forEach((n: Json, i: number) => nodeEls[i].setAttribute('transform', `translate(${n.x},${n.y})`));
        fitGraph();
      } else {
        tick();
      }
    }

    let graphSelected: Json = null;

    function openGraphNodeModal(n: Json) {
      graphSelected = n;
      const when = (s: string | null) => s ? `${new Date(s).toLocaleString('pt-BR')} · ${timeAgo(s)}` : '—';
      const rows: [string, string][] = [
        ['Projeto', `${n.workspace}/${n.project}${n.external ? ' (outro projeto)' : ''}`],
        ['Caminho', n.path],
        ['Tipo', n.kind],
        ['Tier', n.tier || '—'],
        ['Conexões', String(n.degree)],
        ['Criado em', when(n.created_at)],
        ['Atualizado em', when(n.updated_at)]
      ];
      $('graphNodeDot').style.background = kindColor(n.kind);
      $('graphNodeTitle').innerText = n.title;
      $('graphNodeMeta').innerHTML = rows.map(([k, v]) =>
        `<dt class="text-slate-500">${k}</dt><dd class="text-slate-300 font-mono break-all">${escapeHtml(v)}</dd>`).join('');
      $('graphNodeModal').classList.remove('hidden');
    }

    function closeGraphNodeModal() {
      $('graphNodeModal').classList.add('hidden');
    }

    function openGraphNodeDoc() {
      const n = graphSelected;
      if (!n) return;
      closeGraphNodeModal();
      if (n.external) return openProject(n.workspace, n.project).then(() => loadDoc(n.path));
      toggleGraphView();
      loadDoc(n.path);
    }

    // Histórico de Sessões
    async function loadProjectHistory() {
      if (!currentProject) return;
      try {
        const res = await fetch(`/api/sessions?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}`);
        const data = await res.json();
        currentHistoryData = data;

        const sessions = data.sessions || [];
        $('historyBadgeCount').innerText = sessions.length;
        $('handoffsBadgeCount').innerText = data.briefing?.pending_handoff_count || 0;

        renderHistoryList(sessions, data.briefing);
      } catch (err) {
        console.error('Erro ao carregar histórico:', err);
      }
    }

    function renderHistoryList(sessions: Json[], briefing: Json) {
      const container = $('historyListContainer');
      container.innerHTML = '';

      if (sessions.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500 p-3 text-center">Nenhuma sessão encontrada para este projeto.</div>';
        return;
      }

      // As observações do card da tela inicial moram aqui: cada sessão abre a
      // própria timeline, consolidada em página wiki ou não.
      const totalObs = sessions.reduce((n: number, s: Json) => n + (s.observation_count || 0), 0)
        || briefing?.counts?.observations || 0;

      const summaryCard = document.createElement('div');
      summaryCard.className = 'p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs text-slate-400 mb-3';
      summaryCard.innerHTML = `
        <div class="font-semibold text-slate-200 mb-1 flex items-center justify-between">
          <span>Resumo do Histórico</span>
          <span class="text-[11px] text-blue-400">${sessions.length} ${sessions.length === 1 ? 'sessão' : 'sessões'}</span>
        </div>
        <div class="text-[11px] text-slate-400">💬 ${totalObs} observações — abra uma sessão para ler</div>
      `;
      container.appendChild(summaryCard);

      sessions.forEach((s: Json) => {
        const item = document.createElement('div');
        const isSelected = currentSessionId === s.session_id
          || (s.page && currentDocPath === s.page.path);

        item.className = `p-2.5 rounded-lg border text-xs cursor-pointer transition flex flex-col gap-1 ${
          isSelected
            ? 'bg-blue-600/20 text-blue-300 font-medium border-blue-500/30'
            : 'bg-slate-900/40 border-slate-800/80 text-slate-300 hover:bg-slate-800 hover:border-slate-700'
        }`;
        item.onclick = () => openSession(s);

        const badge = s.page
          ? '<span class="text-[10px] px-1 py-0.2 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">consolidada</span>'
          : '<span class="text-[10px] px-1 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-800">bruta</span>';

        const when = s.started_at ? new Date(s.started_at).toLocaleString('pt-BR') : '';
        const title = s.page?.title || s.cwd || s.agent_kind || 'Sessão';

        item.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="font-mono text-[10px] text-blue-400">#${s.session_id.substring(0, 8)}</span>
            ${badge}
          </div>
          <div class="font-medium text-slate-200 truncate" title="${title}">${title}</div>
          <div class="flex items-center justify-between text-[10px] text-slate-500">
            <span>${when}</span>
            <span title="${s.observation_count} observações">💬 ${s.observation_count || 0}</span>
          </div>
        `;
        container.appendChild(item);
      });
    }

    // Sessão consolidada abre a página wiki e a timeline; sessão bruta, só a timeline.
    function openSession(s: Json) {
      currentSessionId = s.session_id;
      if (s.page) return openSessionDetail(s.page);
      return openRawSessionDetail(s);
    }

    async function openSessionDetail(sessionDoc: Json) {
      await loadDoc(sessionDoc.path);
      const sessionId = sessionDoc.path.replace('sessions/', '').replace('.md', '');
      currentSessionId = sessionId;
      // loadDoc ja colocou /doc/sessions/<id>.md na URL; a sessao consolidada
      // e uma pagina como outra qualquer, entao a URL do doc e a canonica.
      loadSessionObservations(sessionId);
    }

    async function openRawSessionDetail(rawSession: Json) {
      currentSessionId = rawSession.session_id;
      currentDocPath = null;
      currentDocData = null;
      updateBreadcrumb();
      syncUrl();

      $('docHeader').classList.remove('hidden');
      $('docActions').classList.add('hidden');
      $('docPath').innerText = `Sessão: ${rawSession.session_id}`;
      $('docTierBadge').classList.add('hidden');
      $('docPinnedBadge').classList.add('hidden');

      const docViewer = $('docViewer');
      docViewer.classList.remove('hidden');
      $('docEditor').classList.add('hidden');

      docViewer.innerHTML = `
        <div class="mb-6 p-4 rounded-xl border border-slate-800 bg-slate-900/40">
          <div class="flex items-center justify-between mb-2">
            <h2 class="text-base font-bold text-slate-100 font-mono">Sessão ${rawSession.session_id}</h2>
            <div class="flex items-center gap-2">
              <button onclick="consolidateSessionLLM('${rawSession.session_id}')" class="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs text-white font-medium flex items-center gap-1.5 transition">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                <span>Consolidar via LLM</span>
              </button>
              <span class="px-2 py-0.5 rounded text-xs bg-amber-950 text-amber-300 border border-amber-800">histórico bruto</span>
            </div>
          </div>
          <div class="text-xs text-slate-400 space-y-1">
            ${rawSession.agent_kind ? `<div><strong class="text-slate-300">Agente:</strong> ${rawSession.agent_kind}</div>` : ''}
            ${rawSession.cwd ? `<div><strong class="text-slate-300">CWD:</strong> <code class="font-mono text-slate-200">${rawSession.cwd}</code></div>` : ''}
            ${rawSession.started_at ? `<div><strong class="text-slate-300">Iniciada em:</strong> ${new Date(rawSession.started_at).toLocaleString('pt-BR')}</div>` : ''}
          </div>
        </div>
        <div id="rawTimelineContainer" class="space-y-3 font-mono text-xs">
          <div class="text-slate-500 text-xs py-4 text-center">Carregando observações da sessão...</div>
        </div>
      `;

      try {
        const res = await fetch(`/api/session/observations?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}&session_id=${encodeURIComponent(rawSession.session_id)}&limit=100`);
        const data = await res.json();
        const obsContainer = $('rawTimelineContainer');
        if (obsContainer && data?.observations) {
          obsContainer.innerHTML = '';
          data.observations.forEach((o: Json) => {
            const row = document.createElement('div');
            row.className = 'p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-slate-300';

            let badgeColor = 'bg-slate-800 text-slate-400';
            if (o.kind === 'user-prompt') badgeColor = 'bg-blue-950 text-blue-300 border border-blue-800';
            if (o.kind === 'session-start') badgeColor = 'bg-purple-950 text-purple-300 border border-purple-800';
            if (o.kind === 'stop' || o.kind === 'session-end') badgeColor = 'bg-emerald-950 text-emerald-300 border border-emerald-800';

            const timeStr = o.created_at ? new Date(o.created_at).toLocaleTimeString('pt-BR') : '';

            row.innerHTML = `
              <div class="flex items-center justify-between mb-1.5 font-sans">
                <div class="flex items-center gap-2">
                  <span class="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider ${badgeColor}">${o.kind}</span>
                  <span class="text-slate-200 font-semibold text-xs truncate max-w-md">${o.title || ''}</span>
                </div>
                <span class="text-[10px] text-slate-500">${timeStr}</span>
              </div>
              ${o.body ? `<pre class="mt-1 text-slate-300 text-[11px] whitespace-pre-wrap overflow-x-auto bg-slate-950/80 p-2.5 rounded border border-slate-900 max-h-48 leading-relaxed">${escapeHtml(o.body)}</pre>` : ''}
            `;
            obsContainer.appendChild(row);
          });
        }
      } catch (err) {
        console.error('Erro ao carregar observações da sessão bruta:', err);
      }
    }

    async function loadSessionObservations(sessionId: string) {
      try {
        const res = await fetch(`/api/session/observations?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}&session_id=${encodeURIComponent(sessionId)}&limit=100`);
        const data = await res.json();
        if (data && data.observations && data.observations.length > 0) {
          renderObservationsTimeline(data.observations, data.total);
        }
      } catch (err) {
        console.warn('Não foi possível carregar timeline de observações:', err);
      }
    }

    function renderObservationsTimeline(observations: Json[], total: number) {
      const docViewer = $('docViewer');

      const timelineSection = document.createElement('div');
      timelineSection.className = 'mt-10 pt-6 border-t border-slate-800';
      timelineSection.innerHTML = `
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-bold text-slate-100 uppercase tracking-wider flex items-center gap-2">
            <span>Timeline da Sessão</span>
            <span class="text-xs font-normal text-slate-400 font-mono">(${observations.length} de ${total || observations.length} eventos)</span>
          </h3>
        </div>
        <div class="space-y-3 font-mono text-xs" id="timelineContainer"></div>
      `;

      const container = timelineSection.querySelector('#timelineContainer')!;

      observations.forEach((o: Json) => {
        const row = document.createElement('div');
        row.className = 'p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-slate-300';

        let badgeColor = 'bg-slate-800 text-slate-400';
        if (o.kind === 'user-prompt') badgeColor = 'bg-blue-950 text-blue-300 border border-blue-800';
        if (o.kind === 'session-start') badgeColor = 'bg-purple-950 text-purple-300 border border-purple-800';
        if (o.kind === 'stop' || o.kind === 'session-end') badgeColor = 'bg-emerald-950 text-emerald-300 border border-emerald-800';

        const timeStr = o.created_at ? new Date(o.created_at).toLocaleTimeString('pt-BR') : '';

        row.innerHTML = `
          <div class="flex items-center justify-between mb-1.5 font-sans">
            <div class="flex items-center gap-2">
              <span class="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider ${badgeColor}">${o.kind}</span>
              <span class="text-slate-200 font-semibold text-xs truncate max-w-md">${o.title || ''}</span>
            </div>
            <span class="text-[10px] text-slate-500">${timeStr}</span>
          </div>
          ${o.body ? `<pre class="mt-1 text-slate-300 text-[11px] whitespace-pre-wrap overflow-x-auto bg-slate-950/80 p-2.5 rounded border border-slate-900 max-h-40 leading-relaxed">${escapeHtml(o.body)}</pre>` : ''}
        `;
        container.appendChild(row);
      });

      docViewer.appendChild(timelineSection);
    }

    // 1. Copiar Markdown Bruto
    function copyCurrentMarkdown() {
      if (!currentDocData || !currentDocData.body) return;
      navigator.clipboard.writeText(currentDocData.body).then(() => {
        const lbl = $('btnCopyLabel');
        const orig = lbl.innerText;
        lbl.innerText = 'Copiado!';
        setTimeout(() => { lbl.innerText = orig; }, 2000);
      });
    }

    function copyDocPath() {
      if (!currentDocPath) return;
      navigator.clipboard.writeText(currentDocPath).then(() => {
        const btn = $('btnCopyPath');
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
        btn.classList.add('text-emerald-400');
        setTimeout(() => {
          // O breadcrumb pode ter sido reescrito nesse meio tempo; so restaura
          // se ainda for o mesmo botao.
          if (!btn.isConnected) return;
          btn.innerHTML = orig;
          btn.classList.remove('text-emerald-400');
        }, 1500);
      });
    }

    // 2. Feedback de Documentação (helpful, stale, wrong)
    async function sendDocFeedback(signal: string) {
      if (!currentProject || !currentDocPath) return;
      let reason = '';
      if (signal === 'stale' || signal === 'wrong') {
        reason = prompt(`Por que este documento está ${signal === 'stale' ? 'desatualizado' : 'incorreto'}? (opcional):`) || '';
      }

      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace: currentWorkspace,
            project: currentProject,
            path: currentDocPath,
            signal,
            reason
          })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao registrar feedback');
        alert(`Feedback "${signal}" registrado com sucesso no ai-memory!`);
      } catch (err) {
        alert('Erro ao enviar feedback: ' + errMsg(err));
      }
    }

    // 3. Auditoria Lint do Projeto
    async function triggerLintAudit() {
      if (!currentProject) return;
      if (!confirm(`Deseja rodar a auditoria de consistência (lint) no projeto ${currentProject}?`)) return;

      try {
        const res = await fetch('/api/lint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: currentWorkspace, project: currentProject, no_llm: false })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao rodar lint');

        await loadProjectPages();
        // O lint só grava _lint/report.md quando acha algo; sem achado a página não existe.
        if (currentPagesList.some(p => p.path === '_lint/report.md')) {
          loadDoc('_lint/report.md');
        } else {
          alert('Auditoria concluída: nenhum achado, nada gravado em _lint/report.md');
        }
      } catch (err) {
        alert('Erro ao rodar auditoria: ' + errMsg(err));
      }
    }

    // 4. Consolidação LLM de Sessão
    async function consolidateSessionLLM(sessionId: string) {
      if (!confirm(`Deseja consolidar a sessão ${sessionId} via LLM? O ai-memory compilará os prompts em um documento sessions/${sessionId}.md.`)) return;

      try {
        const res = await fetch('/api/consolidate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, multi_page: false })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao consolidar');

        alert('Sessão consolidada com sucesso via LLM!');
        await loadProjectPages();
        await loadProjectHistory();
        switchSidebarTab('history');
      } catch (err) {
        alert('Erro ao consolidar sessão: ' + errMsg(err));
      }
    }

    // 5. Gestão de Handoffs
    const HANDOFF_STATES: Record<string, { label: string; badge: string; card: string; icon: string }> = {
      open:     { label: 'Pendente', badge: 'bg-amber-900/60 text-amber-200 border-amber-700/50', card: 'bg-amber-950/20 border-amber-800/50', icon: '📥' },
      accepted: { label: 'Consumido', badge: 'bg-slate-800 text-slate-300 border-slate-700', card: 'bg-slate-900/40 border-slate-800', icon: '✔️' },
      expired:  { label: 'Expirado', badge: 'bg-rose-950/60 text-rose-300 border-rose-900/60', card: 'bg-slate-900/40 border-slate-800', icon: '⌛' }
    };

    // Handoff nao tem campo de titulo no upstream: o `title` fica para quando
    // tiver, e ate la a primeira linha do summary (sem o prefixo "Started:")
    // identifica o item melhor que so o nome do agente repetido em toda a lista.
    function handoffTitle(h: Json): string {
      if (h.title) return String(h.title);
      const first = String(h.summary || '').split('\n').map(l => l.trim()).find(Boolean);
      if (!first) return '';
      const clean = first.replace(/^(Started|Last)\s*:\s*/i, '').replace(/^[#*\s]+/, '');
      return clean.length > 90 ? clean.slice(0, 90).trimEnd() + '…' : clean;
    }

    function renderHandoffCard(h: Json) {
      const st = HANDOFF_STATES[h.state] || { label: h.state, badge: 'bg-slate-800 text-slate-300 border-slate-700', card: 'bg-slate-900/40 border-slate-800', icon: '•' };
      const when = h.at ? new Date(h.at).toLocaleString('pt-BR') : '';
      const title = handoffTitle(h);
      const list = (title: string, items: string[] | undefined) => (items && items.length)
        ? `<div class="mt-2"><div class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">${title}</div><ul class="list-disc list-inside text-slate-400 space-y-0.5">${items!.map((i: string) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`
        : '';

      const body = h.redacted
        ? '<div class="text-slate-500 italic">Conteúdo retido pelo servidor: autentique-se para ler este handoff.</div>'
        : `<div class="markdown-body text-[11px] leading-relaxed">${marked.parse(h.summary || '_Sem resumo._')}</div>
           ${list('Perguntas em aberto', h.open_questions)}
           ${list('Próximos passos', h.next_steps)}
           ${list('Arquivos tocados', h.files_touched)}`;

      const discard = h.state === 'open'
        ? `<button onclick="cancelHandoff('${h.id}')" class="mt-3 w-full py-2 px-3 rounded-lg bg-rose-950/60 hover:bg-rose-900/80 border border-rose-900/60 text-rose-200 text-xs font-medium transition">Descartar / Expirar Este Handoff</button>`
        : '';

      return `
        <div class="p-3.5 rounded-xl border text-xs flex flex-col gap-2 ${st.card}">
          <div class="border-b border-slate-800/60 pb-2">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold text-slate-200 flex items-center gap-1.5 min-w-0">
                <span>${st.icon}</span><span class="truncate">${escapeHtml(h.agent || 'agente')}</span>
              </span>
              <span class="shrink-0 px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider border ${st.badge}">${st.label}</span>
            </div>
            ${title ? `<div class="mt-1 text-slate-300 font-medium leading-snug">${escapeHtml(title)}</div>` : ''}
          </div>
          <div class="text-[10px] text-slate-500">${when}${h.cwd ? ' · ' + escapeHtml(h.cwd) : ''}</div>
          <div class="max-h-80 overflow-y-auto bg-slate-950/60 p-3 rounded-lg border border-slate-900 text-slate-300">${body}</div>
          ${discard}
        </div>`;
    }

    // Lista carregada e filtro atual: trocar de filtro nao refaz a requisicao.
    let handoffsCache: Json[] = [];
    let handoffFilter = 'all';

    function setHandoffFilter(state: string) {
      handoffFilter = state;
      drawHandoffsList();
    }

    function drawHandoffsList() {
      const container = $('handoffsListContainer');

      // Pendente primeiro — e o unico acionavel; dentro de cada grupo, mais recente antes.
      const sorted = [...handoffsCache].sort((a, b) => {
        const rank = (h: Json) => (h.state === 'open' ? 0 : 1);
        return rank(a) - rank(b) || new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime();
      });

      const counts: Record<string, number> = { all: sorted.length };
      for (const h of sorted) counts[h.state] = (counts[h.state] || 0) + 1;

      const chips = [
        { key: 'all', label: 'Todos' },
        { key: 'open', label: HANDOFF_STATES.open!.label },
        { key: 'accepted', label: HANDOFF_STATES.accepted!.label },
        { key: 'expired', label: HANDOFF_STATES.expired!.label }
      ].filter(c => c.key === 'all' || counts[c.key])
       .map(c => {
        const on = handoffFilter === c.key;
        return `<button onclick="setHandoffFilter('${c.key}')" class="px-2 py-0.5 rounded-full border text-[10px] font-medium transition ${
          on ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
        }">${c.label} <span class="opacity-70">${counts[c.key] || 0}</span></button>`;
      }).join('');

      const visible = handoffFilter === 'all' ? sorted : sorted.filter(h => h.state === handoffFilter);
      const cards = visible.length
        ? `<div class="flex flex-col gap-3">${visible.map(renderHandoffCard).join('')}</div>`
        : '<div class="text-xs text-slate-500 p-4 text-center">Nenhum handoff neste filtro.</div>';

      container.innerHTML = `<div class="flex flex-wrap items-center gap-1.5 mb-3">${chips}</div>${cards}`;
    }

    async function renderHandoffsList() {
      const container = $('handoffsListContainer');
      container.innerHTML = '<div class="text-xs text-slate-500 p-3 text-center">Carregando handoffs...</div>';

      try {
        const res = await fetch(`/api/handoffs?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao carregar handoffs');

        $('handoffsBadgeCount').innerText = data.pending_count || 0;

        handoffsCache = data.handoffs || [];
        if (handoffsCache.length === 0) {
          container.innerHTML = '<div class="text-xs text-slate-500 p-4 text-center">Nenhum handoff neste projeto. O próximo agente iniciará com contexto limpo.</div>';
          return;
        }

        drawHandoffsList();
      } catch (err) {
        container.innerHTML = `<div class="text-xs text-rose-400 p-3">Erro ao carregar handoffs: ${errMsg(err)}</div>`;
      }
    }

    async function cancelHandoff(handoffId: string | null) {
      if (!confirm('Deseja descartar este handoff? O próximo agente não receberá este contexto.')) return;

      try {
        const res = await fetch('/api/handoff/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: currentWorkspace, project: currentProject, handoff_id: handoffId })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao descartar handoff');
        alert('Handoff descartado com sucesso!');
        await loadProjectHistory();
        renderHandoffsList();
      } catch (err) {
        alert('Erro ao descartar handoff: ' + errMsg(err));
      }
    }

    // 6. Upload de arquivos por Drag and Drop
    function handleDragOver(e: DragEvent) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.add('drop-active');
    }

    function handleDragLeave(e: DragEvent) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.remove('drop-active');
    }

    async function handleDropFile(e: DragEvent) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.remove('drop-active');

      if (!currentProject) {
        alert('Selecione um projeto antes de enviar arquivos.');
        return;
      }

      const files = e.dataTransfer!.files;
      if (!files || files.length === 0) return;

      for (const file of files) {
        if (!file.name.endsWith('.md')) {
          alert(`O arquivo ${file.name} não é um markdown (.md). Ignorado.`);
          continue;
        }

        const text = await file.text();
        let targetPath = prompt(`Caminho no wiki para "${file.name}":`, `notes/${file.name}`);
        if (!targetPath) continue;

        try {
          const res = await fetch('/api/page', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspace: currentWorkspace,
              project: currentProject,
              path: targetPath,
              body: text,
              tier: 'semantic',
              pinned: false
            })
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Erro ao enviar');
          alert(`Arquivo ${file.name} salvo com sucesso em ${targetPath}!`);
        } catch (err) {
          alert(`Erro ao salvar ${file.name}: ` + errMsg(err));
        }
      }

      await loadProjectPages();
    }

    // --- Editor markdown (CodeMirror 5) -----------------------------------
    // A <textarea> do HTML segue sendo o no de origem: `fromTextArea` a esconde
    // e assume o texto. Criado na primeira edicao, nao no load — quem so le doc
    // nao paga por ele.
    let cm: any = null;

    function editorCm() {
      if (cm) return cm;
      // `gfm` cobre markdown + blocos de codigo; o overlay so acrescenta o
      // `[[wikilink]]`, que e sintaxe do ai-memory e nao do markdown.
      CodeMirror.defineMode('gfm-wiki', (cfg: Json) =>
        CodeMirror.overlayMode(CodeMirror.getMode(cfg, 'gfm'), {
          token(stream: Json) {
            if (stream.match(/\[\[[^\]\n]*\]\]/)) return 'wikilink';
            while (stream.next() != null && !stream.match(/\[\[/, false)) { /* pula ate o proximo [[ */ }
            return null;
          }
        }));

      // Enter/Tab/setas sao do popup do wikilink quando ele esta aberto; fora
      // disso, CodeMirror.Pass devolve a tecla para o comportamento padrao.
      const whenPopup = (fn: () => void) => () => {
        if (wikiStart < 0 || !wikiMatches.length) return CodeMirror.Pass;
        fn();
      };

      cm = CodeMirror.fromTextArea($area('editorTextarea'), {
        mode: 'gfm-wiki',
        theme: 'aim',
        lineNumbers: true,
        lineWrapping: true,
        styleActiveLine: true,
        indentUnit: 2,
        extraKeys: {
          Up: whenPopup(() => moveWikiIndex(-1)),
          Down: whenPopup(() => moveWikiIndex(1)),
          Tab: whenPopup(() => applyWikiLink(wikiIndex)),
          Enter: (c: Json) => {
            if (wikiStart >= 0 && wikiMatches.length) return applyWikiLink(wikiIndex);
            c.execCommand('newlineAndIndentContinueMarkdownList');
          },
          Esc: () => {
            if (wikiStart < 0) return CodeMirror.Pass;
            closeWikiPopup();
          },
          'Ctrl-S': () => saveCurrentDoc(),
          'Cmd-S': () => saveCurrentDoc()
        }
      });
      cm.on('changes', onEditorInput);
      cm.on('changes', scheduleEditorPreview);
      cm.on('scroll', syncPreviewScroll);
      cm.on('blur', closeWikiPopup);
      return cm;
    }

    // --- Preview lado a lado ----------------------------------------------
    // Desligado por padrao (a tela ja e estreita com a sidebar); a escolha fica
    // no localStorage porque quem edita muito quer o preview em toda doc.
    let previewOn = localStorage.getItem('aim:editorPreview') === '1';
    let previewTimer = 0;

    function toggleEditorPreview() {
      previewOn = !previewOn;
      localStorage.setItem('aim:editorPreview', previewOn ? '1' : '0');
      applyEditorPreview();
    }

    function applyEditorPreview() {
      $('editorPreview').classList.toggle('hidden', !previewOn);
      $('btnTogglePreview').className = previewOn
        ? 'ml-auto shrink-0 px-2 py-1 rounded-md border border-blue-700/60 bg-blue-900/40 text-blue-300 flex items-center gap-1'
        : 'ml-auto shrink-0 px-2 py-1 rounded-md border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 flex items-center gap-1';
      if (previewOn) drawEditorPreview();
      cm?.refresh(); // a metade que sobrou mudou de largura
    }

    // Redesenhar a cada tecla custa marked + hljs + mermaid; 250ms depois da
    // ultima tecla e imperceptivel ao digitar e evita o retrabalho.
    function scheduleEditorPreview() {
      if (!previewOn) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(drawEditorPreview, 250);
    }

    function drawEditorPreview() {
      renderMarkdownInto($('editorPreviewBody'), editorCm().getValue());
      syncPreviewScroll();
    }

    // ponytail: rolagem proporcional, nao casada por linha/bloco. Mapear linha
    // do fonte para o no renderizado exige source maps do marked; a proporcao
    // acerta o suficiente e so o editor manda (uma direcao, sem loop).
    function syncPreviewScroll() {
      if (!previewOn || !cm) return;
      const pane = $('editorPreview');
      const info = cm.getScrollInfo();
      const editorMax = info.height - info.clientHeight;
      const previewMax = pane.scrollHeight - pane.clientHeight;
      if (editorMax <= 0 || previewMax <= 0) return;
      pane.scrollTop = (info.top / editorMax) * previewMax;
    }

    // --- Autocomplete de wikilink no editor -------------------------------
    // Digitar `[[` abre a lista das paginas do projeto (a mesma ja carregada na
    // sidebar, sem request novo). O alvo do link e o path sem `.md`: slug puro
    // nao resolve no ai-memory e vira broken_link no lint.
    let wikiMatches: Json[] = [];
    let wikiIndex = 0;
    let wikiStart = -1; // posicao do `[[` que abriu a lista

    function closeWikiPopup() {
      wikiStart = -1;
      wikiMatches = [];
      $('wikiLinkPopup').classList.add('hidden');
    }

    function drawWikiPopup(term: string) {
      const popup = $('wikiLinkPopup');
      popup.classList.remove('hidden');
      popup.innerHTML = wikiMatches.map((p: Json, i: number) => `
        <div onmousedown="event.preventDefault(); applyWikiLink(${i})" class="px-3 py-2 cursor-pointer border-b border-slate-800/60 last:border-0 ${
          i === wikiIndex ? 'bg-blue-600/20' : 'hover:bg-slate-900'
        }">
          <div class="text-slate-200 truncate">${escapeHtml(p.title || p.path)}</div>
          <div class="text-[10px] font-mono text-slate-500 truncate">${escapeHtml(p.path)}</div>
        </div>`).join('')
        || `<div class="px-3 py-2 text-slate-500">Nenhuma página casa com "${escapeHtml(term)}"</div>`;
      const active = popup.children[wikiIndex] as HTMLElement | undefined;
      active?.scrollIntoView({ block: 'nearest' });
    }

    function moveWikiIndex(delta: number) {
      wikiIndex = (wikiIndex + delta + wikiMatches.length) % wikiMatches.length;
      drawWikiPopup('');
    }

    // Partes puras, separadas do DOM para poderem ser testadas no self-check.
    function wikiOpenMatch(beforeCaret: string): { term: string; start: number } | null {
      const open = beforeCaret.match(/\[\[([^\[\]\n]*)$/);
      return open ? { term: open[1]!, start: beforeCaret.length - open[0].length } : null;
    }

    function insertWikiLink(value: string, start: number, caret: number, pagePath: string) {
      const target = pagePath.replace(/\.md$/, '');
      const before = value.slice(0, start);
      return { value: `${before}[[${target}]]${value.slice(caret)}`, caret: before.length + target.length + 4 };
    }

    function applyWikiLink(i: number) {
      const page = wikiMatches[i];
      if (!page || wikiStart < 0) return;
      const c = editorCm();
      const caret = c.indexFromPos(c.getCursor());
      const next = insertWikiLink(c.getValue(), wikiStart, caret, String(page.path));
      // replaceRange em vez de setValue: mantem undo, scroll e o resto do doc.
      c.replaceRange(next.value.slice(wikiStart, next.caret), c.posFromIndex(wikiStart), c.posFromIndex(caret));
      closeWikiPopup();
      c.focus();
      c.setCursor(c.posFromIndex(next.caret));
    }

    function onEditorInput() {
      const c = editorCm();
      const caret = c.indexFromPos(c.getCursor());
      // `[[` mais o que foi digitado depois dele, sem passar de linha.
      const open = wikiOpenMatch(c.getValue().slice(0, caret));
      if (!open) return closeWikiPopup();

      const term = open.term.toLowerCase();
      wikiStart = open.start;
      wikiMatches = currentPagesList
        .filter((p: Json) => !term
          || String(p.path).toLowerCase().includes(term)
          || String(p.title || '').toLowerCase().includes(term))
        .slice(0, 8);
      wikiIndex = 0;
      drawWikiPopup(open.term);
    }

    function escapeHtml(text: string) {
      if (!text) return '';
      const div = document.createElement('div');
      div.innerText = text;
      return div.innerHTML;
    }
