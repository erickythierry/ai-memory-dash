# ai-memory-dash

Dashboard sidecar para o [**ai-memory**](https://github.com/akitaonrails/ai-memory) que adiciona o que
falta na dash oficial: **editar** num editor markdown de verdade, **criar** e **apagar**
projetos e workspaces, **baixar** documentos — um markdown avulso ou o projeto inteiro
em `.zip` — e guardar **backups** do servidor.

Não é um fork nem um patch. É um processo separado que fala com a sua instância do
ai-memory pela API pública dela. O projeto original fica intacto.

> **Você precisa de uma instância do ai-memory rodando.** Esta dash não guarda nada:
> toda leitura e escrita vai para o seu servidor. Sem ele, não há o que mostrar.

## O que ela faz

| | |
|---|---|
| **Navegar** | Cards de projeto com sessões, observações, handoffs pendentes e saúde; páginas agrupadas por pasta; busca full-text |
| **Ler** | Markdown renderizado, com realce de sintaxe e diagramas mermaid |
| **Editar** | Editor markdown (CodeMirror) com realce de sintaxe e de `[[wikilink]]`, autocomplete de link ao digitar `[[`, preview lado a lado alternável e `Ctrl+S` |
| **Criar** | Página nova, e projeto novo — o ai-memory cria o projeto ao receber a primeira página, então a dash semeia `notes/index.md` |
| **Deletar** | Página, projeto inteiro ou workspace inteiro |
| **Baixar** | Um `.md` avulso ou o projeto inteiro em `.zip`, com a estrutura de pastas |
| **Backups** | Snapshot do servidor (wiki + SQLite) baixado e guardado em disco, com histórico, download e remoção |
| **Histórico** | Toda sessão do projeto com sua contagem de observações; clicar abre a timeline completa |
| **Manutenção** | Sinais de feedback (`helpful`/`stale`/`wrong`), lint do projeto, consolidação LLM de sessão |
| **Grafo** | Mapa de links do projeto, com zoom, pan e navegação por clique |
| **Handoffs** | Histórico completo por estado (pendente / consumido / expirado), com descarte explícito |

## Requisitos

- Node.js 18+ (usa `fetch` nativo e `node:` imports).
- Código em TypeScript: `npm run build` compila `src/` para `dist/` (servidor) e
  `public/static/app.js` (frontend). `npm start` já roda o build antes de subir.
- Uma instância do ai-memory acessível, com um token bearer.

## Instalação

```bash
git clone <este-repo> ai-memory-dash
cd ai-memory-dash
npm install
cp .env.example .env
$EDITOR .env      # aponte AI_MEMORY_URL e cole o AI_MEMORY_AUTH_TOKEN
npm start
```

Abre em <http://127.0.0.1:3838>.

### Docker

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
```

O `.env` é lido pelo compose (`env_file`), e `HOST` é forçado para `0.0.0.0` dentro
do container — a porta é publicada só em `127.0.0.1:3838`, então continua fora da rede.

`restart: unless-stopped` faz o container subir junto com o daemon do Docker, ou seja,
junto com o sistema. Para desligar de vez: `docker compose down`.

O compose monta `./backups` no container (os snapshots ficam no host, não na imagem),
além de `./dist` e `./public` em modo leitura — assim `npm run build` no host recarrega
o frontend sem rebuild da imagem. Mudança em `src/server.ts` precisa de restart do
container, porque o processo Node já carregou o `dist/server.js`. Volume novo pede
`docker compose up -d`, não `docker restart`.

Se o seu ai-memory rodar em `localhost` da própria máquina, `AI_MEMORY_URL` precisa
apontar para `http://host.docker.internal:PORTA` (ou use `network_mode: host`).

## Configuração

| Variável | Padrão | Para quê |
|---|---|---|
| `AI_MEMORY_URL` | *(obrigatória)* | URL base da sua instância do ai-memory, sem barra final. Não há instância padrão — o servidor recusa subir sem isso. |
| `AI_MEMORY_AUTH_TOKEN` | *(obrigatória)* | Token bearer da sua instância. |
| `PORT` | `3838` | Porta local. |
| `HOST` | `127.0.0.1` | Interface de bind. Leia a seção de segurança antes de mudar. |
| `BACKUP_DIR` | `./backups` | Onde os snapshots baixados do servidor ficam guardados. No Docker é um volume; sem ele o histórico morre com o container. |

O `.env` é lido por um parser de 10 linhas no próprio `src/server.ts` — variáveis de
ambiente já definidas têm precedência sobre o arquivo. Sem `dotenv`.

## Segurança

**A dash não tem autenticação própria.** Ela carrega o seu token e o repassa em toda
chamada ao upstream. Quem alcança a porta 3838 manda na sua memória, incluindo apagar
páginas. As decisões daí:

- **Bind em `127.0.0.1` por padrão.** Mudar `HOST` para `0.0.0.0` expõe rotas de escrita
  sem autenticação para toda a rede. Se precisar de acesso remoto, ponha atrás de um
  proxy reverso que autentique, não abra a porta direto.
- **Sem cabeçalhos CORS, de propósito.** O frontend é same-origin e não precisa deles.
  Um `Access-Control-Allow-Origin: *` deixaria qualquer site aberto no seu navegador
  fazer `fetch` na dash e apagar páginas — o self-check trava se o cabeçalho voltar.
- **O `.env` nunca entra no git** (está no `.gitignore`). O `.env.example` só tem
  placeholders. Se você já colou um token real em algum arquivo versionado, rotacione
  o token: apagar o commit não basta.
- **`Content-Disposition` sanitizado.** O nome do arquivo no download é filtrado
  (`[^\w.\-]` → `_`) para que um path de página não injete cabeçalho.
- **Mensagens de erro do upstream chegam ao cliente** em `{"error": ...}`. Aceitável
  numa dash local; não exponha a porta publicamente contando com o contrário.
- **As rotas de apagar projeto e workspace são as mais perigosas da dash** — chamam
  `/admin` no upstream, que não tem dry-run. A UI exige digitar o nome, e o servidor
  recusa apagar o workspace `default`, que é o de todo `.ai-memory.toml` da máquina.
- **Nome de backup restrito ao padrão gerado aqui** (`backup-<ISO>.tar.gz`). O nome
  vem da query string, e sem esse filtro um `../` leria ou apagaria qualquer arquivo
  do container.

## API

Todas as rotas devolvem JSON, exceto os downloads.

| Rota | Método | O que faz |
|---|---|---|
| `/api/projects` | GET | Lista projetos, cada um enriquecido com `stats` (sessões, observações, handoffs pendentes, órfãs, rot) |
| `/api/search?q=` | GET | Busca full-text |
| `/api/graph?workspace=&project=` | GET | Nós e arestas do grafo de `[[wikilinks]]` do projeto |
| `/api/pages?workspace=&project=` | GET | Páginas do projeto, cada uma com `health: []` (`orphan`, `stale`, `duplicate`) |
| `/api/page?workspace=&project=&path=` | GET | Lê uma página |
| `/api/page` | POST | Cria ou edita (`{workspace, project, path, body, tier, pinned, tags, scope}`) |
| `/api/page?workspace=&project=&path=` | DELETE | Apaga uma página |
| `/api/download/file?workspace=&project=&path=` | GET | Baixa um markdown |
| `/api/download/zip?workspace=&project=` | GET | Baixa o projeto em zip |
| `/api/sessions?workspace=&project=` | GET | Todas as sessões (abertas inclusive) com `observation_count` e a página consolidada, quando existe |
| `/api/session/observations?workspace=&project=&session_id=` | GET | Observações brutas |
| `/api/feedback` | POST | Sinal `helpful`/`stale`/`wrong` numa página |
| `/api/lint` | POST | Auditoria do projeto |
| `/api/consolidate` | POST | Consolidação LLM de uma sessão |
| `/api/handoffs?workspace=&project=` | GET | Lista handoffs (todos os estados), leitura não-destrutiva |
| `/api/handoff/cancel` | POST | Consome ou cancela um handoff |
| `/api/workspaces` | GET | Workspaces com contagem de projetos e páginas |
| `/api/project?workspace=&project=` | DELETE | Apaga o projeto inteiro (`/admin/purge-project`) |
| `/api/workspace?workspace=` | DELETE | Apaga o workspace e tudo dentro (`/admin/delete-workspace`); recusa `default` |
| `/api/backups` | GET | Snapshots já guardados no disco da dash |
| `/api/backup` | POST | Pede um snapshot novo ao upstream e salva |
| `/api/backup/file?name=` | GET | Baixa um snapshot guardado |
| `/api/backup?name=` | DELETE | Apaga um snapshot guardado |

## Como funciona

Dois caminhos até o upstream:

- **JSON-RPC em `/mcp`** para tudo que é ferramenta do ai-memory — `memory_recent`,
  `memory_read_page`, `memory_write_page`, `memory_delete_page`, `memory_lint`,
  `memory_consolidate`, handoffs.
- **`GET /api/v1/*`** para `projects`, `search`, `overview`, `workspaces` e a listagem
  de handoffs.
- **`POST /admin/*`** para o que não existe como ferramenta MCP: apagar projeto,
  apagar workspace e gerar backup.

`/api/projects` compõe as duas coisas: pega a lista do upstream e busca o `/overview` de
cada projeto em paralelo para preencher os números do card. Um projeto cujo overview
falhe vira `stats: null` em vez de derrubar a listagem.

### O grafo precisa das páginas inteiras

`GET /api/v1/graph` do upstream devolve **apenas arestas cross-project** — não é o
grafo de links de um projeto. Os `[[wikilinks]]` só aparecem no corpo completo da
página (`links`/`backlinks`), e a listagem de páginas não os traz. Então `/api/graph`
busca cada página em paralelo: ~300ms para as 77 do maior projeto aqui.

Alvos em outro projeto viram nós externos no resultado, senão uma aresta apontaria
para um nó inexistente e o projeto cujo único link é cross-project apareceria
inteiramente órfão.

O layout é uma simulação de forças de ~50 linhas em SVG, sem biblioteca: repulsão
O(n²), mola nas arestas, gravidade fraca ao centro e `alpha` decaindo até parar.
Com dezenas de nós isso é irrelevante; acima de uns 500 vale trocar por d3-force.

### Não existe "criar projeto", e o workspace sobra

O ai-memory não tem endpoint de criar projeto: **o projeto passa a existir quando a
primeira página é escrita nele** — `memory_write_page` cria o `project` (e o
`workspace`) que ainda não existir. Por isso o modal de projeto novo semeia
`notes/index.md`, e o nome digitado vira slug (minúsculo, sem acento) porque é ele que
vira diretório no wiki.

Do outro lado, apagar tem duas rotas com contratos diferentes, ambas em `/admin`:

| Rota | Contrato |
|---|---|
| `POST /admin/purge-project` | Exige `workspace` + `project` + `confirm: true`. Sem `confirm` devolve 422 e não apaga nada — **não é dry-run**, é recusa. Deixa o workspace vazio para trás. |
| `POST /admin/delete-workspace` | Só `{"workspace": "..."}`. **Não pede `confirm`**: apaga na primeira chamada, com todos os projetos dentro. |

Não existe `/admin/purge-workspace` (404) — o nome é `delete-`. E não há dry-run em
nenhuma das duas, o que é a razão de a UI exigir digitar o nome antes.

### O upstream não guarda backup nenhum

`POST /admin/backup` **devolve o `.tar.gz` no corpo da resposta** (wiki + snapshot do
SQLite) e esquece o assunto: não há rota de listar (`/admin/backups` → 404) nem de
restaurar (`/admin/restore` → 404). Logo, "histórico de backups" não é algo que se
consulte no servidor — é o que a dash arquivou em `BACKUP_DIR`. Backup gerado por fora
(um `curl`, um cron no servidor) não aparece na tela.

Restaurar continua sendo trabalho manual: extrair o tar sobre o `data_dir` do
ai-memory, com o serviço parado.

### O editor é CodeMirror 5, carregado por CDN

O frontend é um script clássico, sem bundler — por isso CodeMirror **5** (UMD, um
`<script src>`) e não o 6, que é ESM e exigiria empacotamento. O realce de
`[[wikilink]]` é um `overlayMode` de ~5 linhas sobre o modo `gfm`: wikilink é sintaxe
do ai-memory, não do markdown, então não vem de fábrica em modo nenhum.

O preview lado a lado reusa exatamente o mesmo `renderMarkdownInto()` do modo leitura
(marked + highlight.js + mermaid), senão os dois divergiriam na primeira mudança. A
rolagem casada é proporcional, não linha a linha: mapear linha do fonte para o nó
renderizado exigiria source maps do marked.

### Duas armadilhas na listagem de sessões

`GET /api/v1/.../sessions` **omite por padrão a sessão ainda em curso** — é preciso
`?include_open=true`. Sem isso o total de observações da tela não fecha com o do
briefing, e some justamente a sessão com o material mais recente. O teto de `limit`
é 100.

E não tente montar a lista filtrando páginas por prefixo `sessions/`: só aparece
sessão já consolidada em markdown, então tudo que ainda não passou pelo consolidador
fica invisível — inclusive suas observações.

### Os contadores de saúde

O upstream expõe quatro, definidos em SQL (`crates/ai-memory-store/src/reader.rs`):

| Contador | O que ele conta de fato |
|---|---|
| `stale` | Páginas de tier `episodic` com `updated_at` há mais de 30 dias |
| `duplicates` | Páginas agrupadas por **título**, `HAVING count > 1`, somando `count - 1` |
| `orphans` | Páginas sem nenhum `[[wikilink]]`, nem entrando nem saindo |
| `contradictions` | Hardcoded `0` no upstream — nunca conta nada |

A dash **não soma os quatro**. `orphans` sai sozinho, em cinza: páginas de `sessions/` e
`_lint/report.md` caem nessa conta por natureza, e "ninguém linkou esta nota" não é
apodrecimento. O alerta em vermelho (`rot`) é só `stale + duplicates`. `contradictions`
fica de fora enquanto for constante.

O zip é montado em streaming com `archiver`, buscando cada página e preservando a
estrutura de diretórios do wiki.

**Uma armadilha do upstream, para quem for escrever algo parecido:** `GET /handoff` é
o endpoint do hook de *session-start*, e ele **marca o handoff como aceito antes de
responder**. Usá-lo para popular uma tela consome um handoff a cada visita. A leitura
correta é `GET /api/v1/workspaces/{ws}/projects/{proj}/handoffs`, que lista todos os
estados sem efeito colateral — é o que esta dash usa, e o self-check trava se alguém
voltar ao endpoint destrutivo.

Uma nota sobre limites: `PAGE_LIMIT = 500` no `src/server.ts`. O upstream aceita esse
valor sem cap e suporta `offset`, então paginação de verdade é fácil de adicionar —
só não vale a complexidade enquanto nenhum projeto chegar perto disso. O self-check
falha quando um projeto bate no teto, para você não descobrir por um zip incompleto.

## Testes

```bash
npm run selfcheck            # compila e roda
PORT=3839 npm run selfcheck  # se a 3838 já estiver ocupada
npm run typecheck            # só o tsc, sem subir nada
```

Roda de ponta a ponta contra a sua instância: descobre projetos e páginas em runtime,
então funciona em qualquer servidor. Sobe o `dist/server.js` sozinho se ele não estiver de pé.
Não escreve nada além de um sinal de feedback `helpful` numa página existente.

Das rotas destrutivas ele exercita só as recusas — escopo faltando, workspace `default`,
nome de backup fora do padrão — porque apagar de verdade não teria como ser desfeito, e
gerar um backup a cada execução custaria alguns MB por rodada.

## Estrutura

```
src/server.ts          # servidor HTTP, proxy MCP e rotas da API
src/client/app.ts      # frontend (compila para public/static/app.js)
src/test_self_check.ts # self-check de ponta a ponta
public/index.html      # markup da SPA, carrega /static/app.js
backups/               # snapshots baixados do servidor (fora do git)
tsconfig.json          # build do servidor  -> dist/
tsconfig.client.json   # build do frontend  -> public/static/app.js
```

Dependência única: `archiver`. O resto é stdlib do Node — o frontend puxa Tailwind,
marked, highlight.js, mermaid e CodeMirror por CDN, sem passo de bundling.

## Licença

[MIT](LICENSE).
