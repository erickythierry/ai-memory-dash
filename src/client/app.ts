// Bundle do frontend. Compilado por tsconfig.client.json para public/static/app.js
// como script classico: sem import/export, entao as funcoes de topo continuam
// globais e os `onclick=` do index.html seguem funcionando.

// Bibliotecas vindas de CDN via <script> no index.html.
declare const marked: any;
declare const hljs: any;
declare const mermaid: any;

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
    let currentHistoryData: Json = null;
    let currentSessionId: string | null = null;

    // Inicialização
    document.addEventListener('DOMContentLoaded', () => {
      loadProjects();
      const ta = $area('editorTextarea');
      ta.addEventListener('input', onEditorInput);
      ta.addEventListener('keydown', onEditorKeydown);
      ta.addEventListener('blur', closeWikiPopup);
    });

    function switchSidebarTab(tab: string) {
      currentActiveTab = tab;
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
      } catch (err) {
        alert('Erro ao carregar projetos: ' + errMsg(err));
      }
    }

    // Uma metrica do card. Fica fora quando o valor e zero, para o card nao
    // virar uma fileira de zeros nos projetos vazios.
    function projectStat(icon: string, value: number, label: string, tone = 'text-slate-400') {
      if (!value) return '';
      return `<span class="inline-flex items-center gap-1 ${tone}" title="${label}">
        <span class="opacity-70">${icon}</span><span class="font-medium">${value}</span>
      </span>`;
    }

    function renderProjects(projects: Json[]) {
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
          <div class="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500">
            <span title="Última atualização">${updatedText}</span>
            ${relativeText ? `<span class="text-slate-500 ml-auto mr-2">${relativeText}</span>` : ''}
            <button onclick="event.stopPropagation(); downloadZipDirect('${p.workspace_name}', '${p.project_name}')" title="Baixar ZIP" class="p-1 hover:text-emerald-400 transition">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            </button>
          </div>
        `;
        grid.appendChild(card);
      });
    }

    function goToProjects() {
      $('projectsView').classList.remove('hidden');
      $('searchView').classList.add('hidden');
      $('projectDetailView').classList.add('hidden');
      currentProject = null;
      currentDocPath = null;
      currentSessionId = null;
      closeGraph();
      updateBreadcrumb();
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

      // Reset viewer para exibir a Atividade Recente (igual ao ai-memory original)
      $('docHeader').classList.add('hidden');
      renderRecentActivityPlaceholder();

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
            <span class="truncate flex items-center gap-1.5" title="${p.title || p.path}">
              ${flagIcons}<span class="truncate">${p.title || p.path}</span>
            </span>
            <span class="text-[10px] text-slate-500 opacity-0 group-hover:opacity-100 transition shrink-0 ml-1">.md</span>
          `;
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
      renderSidebarPages(currentPagesList); // re-render para atualizar classe ativa
      updateBreadcrumb();

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
          const bodyEl = $('docMarkdownBody');
          bodyEl.innerHTML = marked.parse(currentDocData.body);

          // Syntax Highlighting com highlight.js
          bodyEl.querySelectorAll('pre code').forEach((block) => {
            if (!block.classList.contains('language-mermaid')) {
              hljs.highlightElement(block);
            }
          });

          // Renderização de diagramas Mermaid
          bodyEl.querySelectorAll<HTMLElement>('.language-mermaid, pre.mermaid').forEach(async (el, idx) => {
            const code = el.innerText;
            const insertId = 'mermaid-' + idx + '-' + Date.now();
            try {
              const { svg } = await mermaid.render(insertId, code);
              const parent = el.closest('pre') || el;
              const wrapper = document.createElement('div');
              wrapper.className = 'my-4 p-4 rounded-lg bg-slate-900 border border-slate-800 flex justify-center';
              wrapper.innerHTML = svg;
              parent.replaceWith(wrapper);
            } catch (err) {
              console.warn('Mermaid render error:', err);
            }
          });
        }
      } else {
        btnEdit.className = 'px-2.5 py-1 text-xs rounded-md bg-blue-600 text-white font-medium';
        btnView.className = 'px-2.5 py-1 text-xs rounded-md text-slate-400 hover:text-slate-200';
        docViewer.classList.add('hidden');
        docEditor.classList.remove('hidden');
        if (feedbackSec) feedbackSec.classList.add('hidden');

        $area('editorTextarea').value = currentDocData ? currentDocData.body : '';
        $input('editPinned').checked = !!currentDocData?.frontmatter?.pinned;
        $sel('editTier').value = currentDocData?.frontmatter?.tier || 'semantic';
      }
    }

    async function saveCurrentDoc() {
      if (!currentProject || !currentDocPath) return;

      const newBody = $area('editorTextarea').value;
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

    async function confirmDeleteDoc() {
      if (!currentProject || !currentDocPath) return;
      const ok = confirm(`Tem certeza que deseja DELETAR o documento "${currentDocPath}" do ai-memory?`);
      if (!ok) return;

      try {
        const res = await fetch(`/api/page?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}&path=${encodeURIComponent(currentDocPath)}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Falha ao deletar');

        currentDocPath = null;
        currentDocData = null;
        $('docHeader').classList.add('hidden');
        await loadProjectPages();
        renderRecentActivityView();
      } catch (err) {
        alert('Erro ao deletar: ' + errMsg(err));
      }
    }

    function downloadCurrentDoc() {
      if (!currentProject || !currentDocPath) return;
      window.location.href = `/api/download/file?workspace=${encodeURIComponent(currentWorkspace)}&project=${encodeURIComponent(currentProject!)}&path=${encodeURIComponent(currentDocPath)}`;
    }

    function downloadProjectZip() {
      if (!currentProject) return;
      downloadZipDirect(currentWorkspace, currentProject);
    }

    function downloadZipDirect(workspace: string, project: string) {
      window.location.href = `/api/download/zip?workspace=${encodeURIComponent(workspace)}&project=${encodeURIComponent(project)}`;
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
        html += `
          <span>/</span>
          <span class="text-blue-400 truncate max-w-xs font-mono">${currentDocPath}</span>
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

    const KIND_COLORS: Record<string, string> = {
      decision: '#f59e0b', gotcha: '#f43f5e', concept: '#8b5cf6', fact: '#22d3ee',
      note: '#64748b', session: '#334155', runbook: '#10b981', preference: '#ec4899'
    };
    const kindColor = (k: string) => KIND_COLORS[k] || '#64748b';

    window.addEventListener('keydown', (ev) => {
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
    }

    // Fecha o grafo e descarta os dados. Chamada de todo ponto que troca o que
    // esta na tela: sem isso o grafo de um projeto sobrevivia a navegacao e
    // reaparecia sobre o proximo.
    function closeGraph() {
      stopGraph();
      graphData = null;
      const panel = $('graphView');
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

      // Posicao inicial em circulo: converge mais rapido e evita o empurrao
      // caotico de comecar todo mundo no mesmo ponto.
      nodes.forEach((n: Json, i: number) => {
        const a = (i / nodes.length) * Math.PI * 2;
        n.x = W / 2 + Math.cos(a) * Math.min(W, H) * 0.35;
        n.y = H / 2 + Math.sin(a) * Math.min(W, H) * 0.35;
        n.vx = 0; n.vy = 0;
      });

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

      const nodeEls = nodes.map((n: Json) => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.style.cursor = 'pointer';

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
        t.textContent = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title;
        g.appendChild(t);

        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = `${n.project}/${n.path}\n${n.kind} · ${n.degree} conexões`;
        g.appendChild(title);

        g.onclick = () => {
          if (graphView.panned) return;   // arrastou o fundo: nao e clique
          if (n.external) return openProject(n.workspace, n.project).then(() => loadDoc(n.path));
          toggleGraphView();
          loadDoc(n.path);
        };
        gNodes.appendChild(g);
        return g;
      });

      // Verlet simplificado: repulsao entre todos, mola nas arestas, gravidade
      // fraca ao centro. Alpha decai para a coisa parar sozinha.
      let alpha = 1;
      const tick = () => {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d2 = dx * dx + dy * dy || 0.01;
            if (d2 > 90000) continue;              // longe demais: ignora
            const f = 900 / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
          }
        }
        for (const e of edges) {
          const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
          const d = Math.hypot(dx, dy) || 0.01;
          const f = (d - 70) * 0.02;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          e.source.vx += fx; e.source.vy += fy;
          e.target.vx -= fx; e.target.vy -= fy;
        }
        for (const n of nodes) {
          n.vx += (W / 2 - n.x) * 0.002;
          n.vy += (H / 2 - n.y) * 0.002;
          n.x += n.vx * alpha; n.y += n.vy * alpha;
          n.vx *= 0.82; n.vy *= 0.82;
          n.x = Math.max(20, Math.min(W - 20, n.x));
          n.y = Math.max(20, Math.min(H - 20, n.y));
        }

        edges.forEach((e: Json, i: number) => {
          edgeEls[i].setAttribute('x1', e.source.x); edgeEls[i].setAttribute('y1', e.source.y);
          edgeEls[i].setAttribute('x2', e.target.x); edgeEls[i].setAttribute('y2', e.target.y);
        });
        nodes.forEach((n: Json, i: number) => nodeEls[i].setAttribute('transform', `translate(${n.x},${n.y})`));

        alpha *= 0.985;
        if (alpha > 0.02) {
          graphSim = requestAnimationFrame(tick);
        } else {
          graphSim = null;
          fitGraph();   // layout assentou: enquadra o resultado
        }
      };
      tick();
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
      loadSessionObservations(sessionId);
    }

    async function openRawSessionDetail(rawSession: Json) {
      currentSessionId = rawSession.session_id;
      currentDocPath = null;
      currentDocData = null;
      updateBreadcrumb();

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
      const ta = $area('editorTextarea');
      const next = insertWikiLink(ta.value, wikiStart, ta.selectionStart, String(page.path));
      ta.value = next.value;
      closeWikiPopup();
      ta.focus();
      ta.setSelectionRange(next.caret, next.caret);
    }

    function onEditorInput() {
      const ta = $area('editorTextarea');
      // `[[` mais o que foi digitado depois dele, sem passar de linha.
      const open = wikiOpenMatch(ta.value.slice(0, ta.selectionStart));
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

    function onEditorKeydown(e: KeyboardEvent) {
      if (wikiStart < 0) return;
      if (e.key === 'Escape') { closeWikiPopup(); e.preventDefault(); return; }
      if (!wikiMatches.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        wikiIndex = (wikiIndex + (e.key === 'ArrowDown' ? 1 : wikiMatches.length - 1)) % wikiMatches.length;
        drawWikiPopup('');
        e.preventDefault();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        applyWikiLink(wikiIndex);
        e.preventDefault();
      }
    }

    function escapeHtml(text: string) {
      if (!text) return '';
      const div = document.createElement('div');
      div.innerText = text;
      return div.innerHTML;
    }
