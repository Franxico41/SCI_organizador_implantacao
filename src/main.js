/* ═══════════════════════════════════════════════════════════════════
   SCI Implantações — v3.0 Renderer
   Persistência via SQLite/Electron IPC.
   ═══════════════════════════════════════════════════════════════════ */

const STATUS = [
  "Não iniciado",
  "Aguardando configuração",
  "Aguardando treinamento",
  "Aguardando virada",
  "Aguardando API",
  "Concluído"
];
const ATRASO_DIAS = 7;

/* ─── Utils ─────────────────────────────────────────────────────── */

function hasDate(value) {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function computeFase(client) {
  const pc  = !!client.primeiroContatoFeito;
  const cfg = !!client.configuracaoFeita;
  const trn = !!client.treinamentoFeito;
  const vrd = !!client.viradaFeita;
  const api = !!client.apiImplantada;

  if (vrd && api) return "Concluído";
  if (vrd && !api) return "Aguardando API";
  if (pc && cfg && trn && !vrd) return "Aguardando virada";
  if (pc && cfg) return "Aguardando treinamento";
  if (pc) return "Aguardando configuração";
  return "Não iniciado";
}

function formatDate(value) {
  if (!value) return "—";
  if (!hasDate(value)) return value;
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetween(start, end) {
  if (!hasDate(start) || !hasDate(end)) return null;
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

function daysSince(value, now = new Date()) {
  if (!hasDate(value)) return null;
  return daysBetween(value, todayIso(now));
}

function isOpen(client) {
  return !client.implantacaoConcluida;
}

function isLate(client, now = new Date()) {
  const age = daysSince(client.primeiroContato, now);
  return isOpen(client) && !client.pausado && age !== null && age > ATRASO_DIAS;
}

function isWaitingApi(client) {
  return isOpen(client) && !client.pausado && computeFase(client) === "Aguardando API";
}

function isInWeek(dateValue, now = new Date()) {
  if (!hasDate(dateValue)) return false;
  const date = new Date(`${dateValue}T00:00:00`);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = start.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return date >= start && date <= end;
}

function calculateMetrics(clients, now = new Date()) {
  const total = clients.length;
  const open = clients.filter(isOpen).length;
  const concluded = clients.filter(c => !!c.implantacaoConcluida).length;
  const viradasSemana = clients.filter(c => isOpen(c) && !c.pausado && isInWeek(c.viradaAgendamento, now)).length;
  const durations = clients
    .map(c => daysBetween(c.primeiroContato, c.viradaAgendamento))
    .filter(v => typeof v === "number" && Number.isFinite(v));
  const averageDays = durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : 0;
  return { total, open, concluded, viradasSemana, averageDays };
}

function countByStatus(clients) {
  return STATUS.reduce((acc, status) => {
    acc[status] = clients.filter(c => !c.pausado && !c.implantacaoConcluida && computeFase(c) === status).length;
    return acc;
  }, {});
}

function slug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  const e = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
  return String(value ?? "").replace(/[&<>"']/g, c => e[c]);
}

function generateId(prefix = "") {
  return `${prefix}${Date.now()}-${Math.random().toString(36).substr(2,9)}`;
}

function showToast(message, type = "info") {
  const container = document.querySelector("#toastStack");
  if (!container) { if (type === "error") alert(message); return; }
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML = `<span>${escapeHtml(message)}</span><button type="button" aria-label="Fechar aviso">×</button>`;
  container.appendChild(toast);
  const close = () => toast.classList.add("toast--hide");
  toast.querySelector("button").addEventListener("click", close);
  setTimeout(close, type === "error" ? 7000 : 4200);
  toast.addEventListener("transitionend", () => toast.remove(), { once: true });
}

function setButtonLoading(button, loading, textWhenLoading = "Aguarde...") {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = textWhenLoading;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    delete button.dataset.originalText;
  }
}

/* ─── Estado ─────────────────────────────────────────────────────── */

const state = {
  clients: [],
  agenda:  { manualTasks: [], order: [] },
  filters: { statuses: [], query: "" },
  sort:    { field: null, dir: "asc" },
};

const app = document.querySelector("#app");
const loadingOverlay = document.querySelector("#loadingOverlay");
let dom = {};
let dragSrcId = null;

/* ─── Persistência ───────────────────────────────────────────────── */

async function loadAll() {
  const [clients, agenda] = await Promise.all([
    window.sci.listarClientes(),
    window.sci.listarAgenda(),
  ]);
  state.clients = (clients || []).map(normalizeClientState);
  state.agenda  = agenda  || { manualTasks: [], order: [] };
}

function normalizeClientState(c) {
  return {
    ...c,
    pausado: !!c.pausado,
    motivoPausa: c.motivoPausa || "",
    observacaoPausa: c.observacaoPausa || "",
    pausadoEm: c.pausadoEm || "",
    implantacaoConcluida: !!c.implantacaoConcluida,
    implantacaoConcluidaEm: c.implantacaoConcluidaEm || "",
  };
}

async function saveCliente(cliente) {
  const result = await window.sci.salvarCliente(normalizeClientState(cliente));
  if (result?.ok === false) showToast(`Erro ao salvar: ${result.erro || "erro desconhecido"}`, "error");
  return result;
}

async function saveAgenda() {
  await window.sci.salvarAgenda(state.agenda);
}

function showManagedDialog(dialogEl, focusTarget) {
  if (!dialogEl) return;
  if (!dialogEl.open) dialogEl.show();
  document.body.classList.add("has-open-dialog");
  requestAnimationFrame(() => focusTarget?.focus());
}

function closeManagedDialog(dialogEl) {
  if (!dialogEl) return;
  if (dialogEl.open) dialogEl.close();
  syncDialogLayerState();
}

function syncDialogLayerState() {
  if (![dom.dialog, dom.pauseDialog, dom.agendaDialog].some(current => current?.open)) {
    document.body.classList.remove("has-open-dialog");
  }
}

/* ─── Agenda helpers ─────────────────────────────────────────────── */

function normalizeAgendaTask(task) {
  const cliente = state.clients.find(c => c.id === task.clienteId);
  return {
    id: task.id,
    type: "manual",
    clienteId: task.clienteId || "",
    label: cliente?.cliente || "Sem cliente vinculado",
    titulo: task.titulo || task.text || "Ação sem título",
    descricao: task.descricao || "",
    text: task.text || task.titulo || "",
  };
}

function getAgendaTaskList() {
  return state.agenda.manualTasks.map(normalizeAgendaTask);
}

function getAgendaOrdered() {
  const all = getAgendaTaskList();
  const order = state.agenda.order || [];
  const mapped = new Map(all.map(t => [t.id, t]));
  const ordered = order.map(id => mapped.get(id)).filter(Boolean);
  const rest = all.filter(t => !order.includes(t.id));
  return [...ordered, ...rest];
}

function moveAgendaItem(id, dir) {
  const all = getAgendaOrdered();
  const order = all.map(t => t.id);
  const idx = order.indexOf(id);
  if (idx === -1) return;
  const newIdx = dir === "up" ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  state.agenda.order = order;
  saveAgenda();
  renderAgenda();
}

function reorderAgenda(srcId, targetId) {
  const all = getAgendaOrdered();
  const order = all.map(t => t.id);
  const si = order.indexOf(srcId);
  const ti = order.indexOf(targetId);
  if (si === -1 || ti === -1 || si === ti) return;
  order.splice(si, 1);
  order.splice(ti, 0, srcId);
  state.agenda.order = order;
  saveAgenda();
  renderAgenda();
}

/* ─── HTML inicial ───────────────────────────────────────────────── */

function initializeApp() {
  app.innerHTML = `
    <header class="hero">
      <div>
        <p class="eyebrow">Controle operacional</p>
        <h1>Dashboard de Implantação</h1>
        <p class="hero__text">SCI v3.0 com indicadores reais, filtros, agenda manual, pausados e conclusão operacional.</p>
      </div>
      <div class="hero__actions">
        <button id="addRecordBtn" class="button button--primary" type="button">+ Nova implantação</button>
        <button id="backupBtn" class="button button--ghost" type="button">Backup</button>
        <button id="restoreBackupBtn" class="button button--ghost" type="button">Restaurar</button>
        <button id="openDataFolderBtn" class="button button--ghost" type="button">Abrir dados</button>
      </div>
    </header>

    <div id="toastStack" class="toast-stack" aria-live="polite" aria-atomic="true"></div>

    <main class="page-shell">
      <section class="data-location-card" aria-label="Local dos dados">
        <div><strong>Dados locais</strong><span id="dbPathHint">Carregando local do banco...</span></div>
        <small>Fluxo apenas por banco de dados. Para atualizar outra máquina, use Backup e Restaurar.</small>
      </section>

      <section class="summary-grid summary-grid--v3" aria-label="Resumo da implantação">
        <article class="summary-card"><span class="summary-card__label">Total de clientes</span><strong id="totalClients">0</strong><small>Todos os registros</small></article>
        <article class="summary-card summary-card--warning"><span class="summary-card__label">Em aberto</span><strong id="openCount">0</strong><small>Não marcados como implantação concluída</small></article>
        <article class="summary-card summary-card--success"><span class="summary-card__label">Concluídos</span><strong id="completedCount">0</strong><small>Marcados pelo botão Concluir</small></article>
        <article class="summary-card"><span class="summary-card__label">Viradas da semana</span><strong id="weekTurnsCount">0</strong><small>Data de virada nesta semana</small></article>
        <article class="summary-card"><span class="summary-card__label">Tempo médio real</span><strong id="averageDays">0d</strong><small>Primeiro contato até virada</small></article>
      </section>

      <section class="dashboard-grid">
        <article class="panel">
          <div class="panel__header"><div><p class="eyebrow">Distribuição</p><h2>Clientes por fase</h2></div></div>
          <div id="phaseChart" class="phase-chart" aria-label="Gráfico por fase"></div>
        </article>

        <article class="panel panel--timeline">
          <div class="panel__header"><div><p class="eyebrow">Agenda</p><h2>Próximas ações</h2></div></div>
          <div class="agenda-add-row agenda-add-row--structured">
            <select id="agendaClientSelect" title="Cliente da ação"></select>
            <input id="agendaTitleInput" type="text" placeholder="Título da ação..." />
            <input id="agendaDescriptionInput" type="text" placeholder="Descrição curta..." />
            <button id="agendaAddBtn" class="button button--primary" type="button">Adicionar</button>
          </div>
          <ol id="timelineList" class="timeline-list"></ol>
        </article>
      </section>

      <section class="panel table-panel">
        <div class="panel__header panel__header--stacked">
          <div><p class="eyebrow">Base de controle</p><h2>Implantações em operação</h2></div>
          <div class="toolbar toolbar--v3">
            <label>Buscar<input id="searchInput" type="search" placeholder="Cliente, observação, datas ou fase..." /></label>
            <button id="clearFiltersBtn" class="button" type="button">Limpar filtros</button>
            <button id="resetDataBtn" class="button button--danger" type="button">Limpar registros</button>
          </div>
        </div>
        <div class="status-filter-box" id="statusFilterBox"></div>
        <div class="table-meta"><span id="filteredCount">0 registros exibidos</span><span>Clientes pausados e concluídos ficam nas tabelas separadas abaixo.</span></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="col-client sortable" data-sort="cliente">Cliente <span class="sort-icon">⇅</span></th>
                <th class="col-phase align-center sortable" data-sort="fase">Fase <span class="sort-icon">⇅</span></th>
                <th class="col-date align-center sortable" data-sort="primeiroContato">Primeiro contato <span class="th-check-hint">✓</span> <span class="sort-icon">⇅</span></th>
                <th class="col-date align-center sortable" data-sort="configuracao">Configuração <span class="th-check-hint">✓</span> <span class="sort-icon">⇅</span></th>
                <th class="col-date align-center sortable" data-sort="treinamento">Treinamento <span class="th-check-hint">✓</span> <span class="sort-icon">⇅</span></th>
                <th class="col-date align-center sortable" data-sort="viradaAgendamento">Virada <span class="th-check-hint">✓</span> <span class="sort-icon">⇅</span></th>
                <th class="col-api align-center sortable" data-sort="apiImplantada">API implantada <span class="th-check-hint">✓</span> <span class="sort-icon">⇅</span></th>
                <th class="col-notes sortable" data-sort="observacoes">Observações <span class="sort-icon">⇅</span></th>
                <th class="col-actions align-center">Ações</th>
              </tr>
            </thead>
            <tbody id="recordsTableBody"></tbody>
          </table>
        </div>
        <p id="emptyState" class="empty-state" hidden>Nenhum registro encontrado. Ajuste os filtros ou cadastre uma nova implantação.</p>
      </section>

      <section class="panel table-panel paused-panel" id="pausedPanel" hidden>
        <div class="panel__header"><div><p class="eyebrow">Pausadas / bloqueadas</p><h2>Implantações pausadas</h2></div></div>
        <div class="mini-table-wrap"><table class="mini-table"><thead><tr><th>Cliente</th><th>Fase</th><th>Motivo</th><th>Pausado desde</th><th>Ações</th></tr></thead><tbody id="pausedTableBody"></tbody></table></div>
      </section>

      <section class="panel table-panel completed-panel" id="completedPanel" hidden>
        <div class="panel__header"><div><p class="eyebrow">Finalizadas</p><h2>Implantações concluídas</h2></div></div>
        <div class="mini-table-wrap"><table class="mini-table"><thead><tr><th>Cliente</th><th>Fase calculada</th><th>Concluída em</th><th>Ações</th></tr></thead><tbody id="completedTableBody"></tbody></table></div>
      </section>
    </main>

    <dialog id="recordDialog" class="record-dialog">
      <form id="recordForm">
        <div class="dialog-header"><div><p class="eyebrow">Cadastro</p><h2 id="dialogTitle">Nova implantação</h2></div><button class="icon-button" type="button" id="closeDialogBtn" aria-label="Fechar">×</button></div>
        <input type="hidden" id="recordId" />
        <div class="form-grid">
          <label class="form-grid__wide">Cliente<input id="clientInput" required placeholder="Ex.: 725 - Cliente ABC" /></label>
          <div class="form-date-row"><label>Primeiro contato<input id="firstContactInput" type="date" /></label><label class="check-label"><input type="checkbox" id="firstContactFeito" /> Já ocorreu</label></div>
          <div class="form-date-row"><label>Configuração<input id="configurationInput" type="date" /></label><label class="check-label"><input type="checkbox" id="configuracaoFeita" /> Já ocorreu</label></div>
          <div class="form-date-row"><label>Treinamento<input id="trainingInput" type="date" /></label><label class="check-label"><input type="checkbox" id="treinamentoFeito" /> Já ocorreu</label></div>
          <div class="form-date-row"><label>Virada<input id="goLiveInput" type="date" /></label><label class="check-label"><input type="checkbox" id="viradaFeita" /> Já ocorreu</label></div>
          <label class="check-label form-grid__wide"><input type="checkbox" id="apiImplantada" /> API implantada</label>
          <label class="form-grid__wide">Observações<textarea id="notesInput" rows="3" placeholder="Pendências, status da API, etc."></textarea></label>
          <div class="form-grid__wide fase-preview"><span class="fase-preview__label">Fase calculada:</span><span id="fasePreviewPill" class="pill phase-nao-iniciado">Não iniciado</span></div>
        </div>
        <div class="dialog-actions"><button type="button" id="cancelDialogBtn" class="button">Cancelar</button><button type="submit" class="button button--primary">Salvar</button></div>
      </form>
    </dialog>

    <dialog id="pauseDialog" class="record-dialog">
      <form id="pauseForm">
        <div class="dialog-header"><div><p class="eyebrow">Pausar implantação</p><h2 id="pauseDialogTitle">Pausar</h2></div><button class="icon-button" type="button" id="closePauseDialogBtn" aria-label="Fechar">×</button></div>
        <input type="hidden" id="pauseClientId" />
        <div class="form-grid">
          <label class="form-grid__wide">Motivo<select id="pauseReasonInput"><option>Aguardando cliente</option><option>Aguardando API</option><option>Aguardando suporte</option><option>Aguardando financeiro</option><option>Problema técnico</option><option>Outro</option></select></label>
          <label class="form-grid__wide">Observação<textarea id="pauseNoteInput" rows="3" placeholder="Detalhe opcional da pausa..."></textarea></label>
        </div>
        <div class="dialog-actions"><button type="button" id="cancelPauseDialogBtn" class="button">Cancelar</button><button type="submit" class="button button--danger">Pausar implantação</button></div>
      </form>
    </dialog>

    <dialog id="agendaDialog" class="record-dialog">
      <form id="agendaForm">
        <div class="dialog-header"><div><p class="eyebrow">Agenda</p><h2 id="agendaDialogTitle">Editar ação</h2></div><button class="icon-button" type="button" id="closeAgendaDialogBtn" aria-label="Fechar">×</button></div>
        <input type="hidden" id="agendaTaskId" />
        <div class="form-grid">
          <label class="form-grid__wide">Cliente<select id="agendaDialogClientSelect"></select></label>
          <label class="form-grid__wide">Título<input id="agendaDialogTitleInput" required placeholder="Ex.: Confirmar virada" /></label>
          <label class="form-grid__wide">Descrição<textarea id="agendaDialogDescriptionInput" rows="4" placeholder="Detalhes da ação..."></textarea></label>
        </div>
        <div class="dialog-actions"><button type="button" id="cancelAgendaDialogBtn" class="button">Cancelar</button><button type="submit" class="button button--primary">Salvar ação</button></div>
      </form>
    </dialog>
  `;
}

function cacheDomElements() {
  dom = {
    addRecordBtn: document.querySelector("#addRecordBtn"), resetDataBtn: document.querySelector("#resetDataBtn"), clearFiltersBtn: document.querySelector("#clearFiltersBtn"),
    backupBtn: document.querySelector("#backupBtn"), restoreBackupBtn: document.querySelector("#restoreBackupBtn"), openDataFolderBtn: document.querySelector("#openDataFolderBtn"), dbPathHint: document.querySelector("#dbPathHint"),
    filteredCount: document.querySelector("#filteredCount"), searchInput: document.querySelector("#searchInput"), statusFilterBox: document.querySelector("#statusFilterBox"),
    tableBody: document.querySelector("#recordsTableBody"), tableHead: document.querySelector("thead tr"), emptyState: document.querySelector("#emptyState"), pausedPanel: document.querySelector("#pausedPanel"), pausedTableBody: document.querySelector("#pausedTableBody"), completedPanel: document.querySelector("#completedPanel"), completedTableBody: document.querySelector("#completedTableBody"),
    totalClients: document.querySelector("#totalClients"), openCount: document.querySelector("#openCount"), completedCount: document.querySelector("#completedCount"), weekTurnsCount: document.querySelector("#weekTurnsCount"), averageDays: document.querySelector("#averageDays"), phaseChart: document.querySelector("#phaseChart"),
    timelineList: document.querySelector("#timelineList"), agendaClientSelect: document.querySelector("#agendaClientSelect"), agendaTitleInput: document.querySelector("#agendaTitleInput"), agendaDescriptionInput: document.querySelector("#agendaDescriptionInput"), agendaAddBtn: document.querySelector("#agendaAddBtn"), agendaDialog: document.querySelector("#agendaDialog"), agendaForm: document.querySelector("#agendaForm"), agendaDialogTitle: document.querySelector("#agendaDialogTitle"), closeAgendaDialogBtn: document.querySelector("#closeAgendaDialogBtn"), cancelAgendaDialogBtn: document.querySelector("#cancelAgendaDialogBtn"), agendaTaskId: document.querySelector("#agendaTaskId"), agendaDialogClientSelect: document.querySelector("#agendaDialogClientSelect"), agendaDialogTitleInput: document.querySelector("#agendaDialogTitleInput"), agendaDialogDescriptionInput: document.querySelector("#agendaDialogDescriptionInput"),
    dialog: document.querySelector("#recordDialog"), form: document.querySelector("#recordForm"), dialogTitle: document.querySelector("#dialogTitle"), closeDialogBtn: document.querySelector("#closeDialogBtn"), cancelDialogBtn: document.querySelector("#cancelDialogBtn"), recordId: document.querySelector("#recordId"), clientInput: document.querySelector("#clientInput"), firstContactInput: document.querySelector("#firstContactInput"), firstContactFeito: document.querySelector("#firstContactFeito"), configurationInput: document.querySelector("#configurationInput"), configuracaoFeita: document.querySelector("#configuracaoFeita"), trainingInput: document.querySelector("#trainingInput"), treinamentoFeito: document.querySelector("#treinamentoFeito"), goLiveInput: document.querySelector("#goLiveInput"), viradaFeita: document.querySelector("#viradaFeita"), apiImplantada: document.querySelector("#apiImplantada"), notesInput: document.querySelector("#notesInput"), fasePreviewPill: document.querySelector("#fasePreviewPill"),
    pauseDialog: document.querySelector("#pauseDialog"), pauseForm: document.querySelector("#pauseForm"), pauseDialogTitle: document.querySelector("#pauseDialogTitle"), closePauseDialogBtn: document.querySelector("#closePauseDialogBtn"), cancelPauseDialogBtn: document.querySelector("#cancelPauseDialogBtn"), pauseClientId: document.querySelector("#pauseClientId"), pauseReasonInput: document.querySelector("#pauseReasonInput"), pauseNoteInput: document.querySelector("#pauseNoteInput"),
  };
}

function refreshAgendaClientSelects() {
  const available = state.clients.filter(c => !c.implantacaoConcluida);
  const options = '<option value="">Sem cliente vinculado</option>' + available.slice().sort((a,b) => String(a.cliente||"").localeCompare(String(b.cliente||""), "pt-BR")).map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.cliente || "Sem nome")}</option>`).join("");
  if (dom.agendaClientSelect) dom.agendaClientSelect.innerHTML = options;
  if (dom.agendaDialogClientSelect) dom.agendaDialogClientSelect.innerHTML = options;
}

function populateStaticFilters() {
  dom.statusFilterBox.innerHTML = STATUS.map(status => `
    <label class="status-check"><input type="checkbox" value="${escapeHtml(status)}" /><span>${escapeHtml(status)}</span></label>
  `).join("");
}

/* ─── Render ─────────────────────────────────────────────────────── */

function renderMetrics() {
  const m = calculateMetrics(state.clients);
  dom.totalClients.textContent = m.total;
  dom.openCount.textContent = m.open;
  dom.completedCount.textContent = m.concluded;
  dom.weekTurnsCount.textContent = m.viradasSemana;
  dom.averageDays.textContent = `${m.averageDays}d`;
}

function renderChart() {
  const byStatus = countByStatus(state.clients);
  const total = Object.values(byStatus).reduce((s, v) => s + v, 0) || 1;
  dom.phaseChart.innerHTML = STATUS.map(status => {
    const count = byStatus[status] || 0;
    const percent = Math.round((count / total) * 100);
    return `<div class="chart-row"><div class="chart-row__meta"><span>${escapeHtml(status)}</span><span>${count} (${percent}%)</span></div><div class="chart-row__bar"><div class="chart-row__fill chart-row__fill--${slug(status)}" style="width:${percent}%"></div></div></div>`;
  }).join("");
}

function renderAgenda() {
  const tasks = getAgendaOrdered();
  if (!tasks.length) {
    dom.timelineList.innerHTML = `<li class="agenda-empty"><span>Nenhuma ação criada.<br>Use os campos acima para criar uma ação manual.</span></li>`;
    return;
  }
  dom.timelineList.innerHTML = tasks.map((task, idx) => `
    <li class="agenda-item agenda-item--${task.type}" draggable="true" data-task-id="${escapeHtml(task.id)}">
      <span class="drag-handle" title="Arrastar para reordenar">⠿</span>
      <div class="agenda-item__content"><strong class="agenda-title">${escapeHtml(`${task.label} - ${task.titulo}`)}</strong>${task.descricao ? `<span class="agenda-text">${escapeHtml(task.descricao)}</span>` : ""}</div>
      <div class="agenda-item__btns"><button class="icon-button agenda-up" data-id="${escapeHtml(task.id)}" title="Mover para cima" ${idx === 0 ? "disabled" : ""}>↑</button><button class="icon-button agenda-down" data-id="${escapeHtml(task.id)}" title="Mover para baixo" ${idx === tasks.length-1 ? "disabled" : ""}>↓</button><button class="icon-button agenda-edit" data-id="${escapeHtml(task.id)}" title="Editar ação">✎</button><button class="icon-button agenda-del" data-id="${escapeHtml(task.id)}" title="Excluir ação">×</button></div>
    </li>`).join("");
}

function getSortedClients(clients) {
  if (!state.sort.field) return clients;
  const { field, dir } = state.sort;
  return [...clients].sort((a,b) => {
    let cmp = 0;
    if (field === "fase") cmp = STATUS.indexOf(computeFase(a)) - STATUS.indexOf(computeFase(b));
    else if (field === "apiImplantada") cmp = (a.apiImplantada ? 1 : 0) - (b.apiImplantada ? 1 : 0);
    else cmp = String(a[field] || "").toLowerCase().localeCompare(String(b[field] || "").toLowerCase(), "pt-BR");
    return dir === "asc" ? cmp : -cmp;
  });
}

function filterClients(clients, filters) {
  const query = filters.query.toLowerCase().trim();
  return clients.filter(client => {
    if (client.pausado || client.implantacaoConcluida) return false;
    const fase = computeFase(client);
    const matchesStatus = !filters.statuses.length || filters.statuses.includes(fase);
    const haystack = `${client.cliente} ${client.observacoes} ${client.primeiroContato} ${client.configuracao} ${client.treinamento} ${client.viradaAgendamento} ${fase}`.toLowerCase();
    return matchesStatus && (!query || haystack.includes(query));
  });
}

function renderSortHeaders() {
  dom.tableHead.querySelectorAll("th[data-sort]").forEach(th => {
    const field = th.dataset.sort;
    const icon = th.querySelector(".sort-icon");
    if (!icon) return;
    if (state.sort.field === field) { icon.textContent = state.sort.dir === "asc" ? "▲" : "▼"; th.classList.add("sorted"); }
    else { icon.textContent = "⇅"; th.classList.remove("sorted"); }
  });
}

function buildDateCell(client, dateField, checkField, label) {
  const val = client[dateField] || "";
  const checked = client[checkField] ? "checked" : "";
  const doneClass = client[checkField] ? "date-done" : "";
  return `<td class="col-date align-center"><div class="date-cell"><label class="check-wrap" title="Marcar '${label}' como realizado"><input type="checkbox" class="done-check" data-check="${checkField}" ${checked} /><span class="check-visual"></span></label><div class="editable-cell ${doneClass}" data-field="${dateField}"><span class="cell-value">${escapeHtml(formatDate(val))}</span><button class="cell-pencil" type="button" title="Editar ${label}">✎</button></div></div></td>`;
}

function renderTable() {
  const visible = getSortedClients(filterClients(state.clients, state.filters));
  dom.emptyState.hidden = visible.length > 0;
  const operationalTotal = state.clients.filter(c => !c.pausado && !c.implantacaoConcluida).length;
  dom.filteredCount.textContent = operationalTotal === visible.length ? `${visible.length} registro${visible.length === 1 ? "" : "s"} exibido${visible.length === 1 ? "" : "s"}` : `${visible.length} de ${operationalTotal} registros exibidos`;
  renderSortHeaders();

  dom.tableBody.innerHTML = visible.map(client => {
    const fase = computeFase(client);
    return `<tr data-id="${escapeHtml(client.id)}">
      <td class="col-client"><div class="client-cell"><button type="button" class="situacao-btn ${client.situacao ? 'situacao-btn--filled' : ''}" data-action="situacao" title="Situação do cliente"><span class="situacao-btn__icon">📝</span></button><div class="editable-cell" data-field="cliente"><span class="cell-value"><strong>${escapeHtml(client.cliente)}</strong></span><button class="cell-pencil" type="button" title="Editar cliente">✎</button></div></div></td>
      <td class="col-phase align-center fase-cell"><span class="pill phase-${slug(fase)}">${escapeHtml(fase)}</span></td>
      ${buildDateCell(client,"primeiroContato","primeiroContatoFeito","Primeiro contato")}
      ${buildDateCell(client,"configuracao","configuracaoFeita","Configuração")}
      ${buildDateCell(client,"treinamento","treinamentoFeito","Treinamento")}
      ${buildDateCell(client,"viradaAgendamento","viradaFeita","Virada")}
      <td class="col-api align-center"><label class="check-wrap" title="Marcar API implantada"><input type="checkbox" class="api-check" ${client.apiImplantada ? "checked" : ""} /><span class="check-visual"></span></label></td>
      <td class="col-notes"><div class="editable-cell" data-field="observacoes"><span class="cell-value">${escapeHtml(client.observacoes || "—")}</span><button class="cell-pencil" type="button" title="Editar observações">✎</button></div></td>
      <td class="col-actions align-center"><div class="actions actions--v3"><button class="icon-button pause-btn" title="Pausar implantação">⏸</button><button class="icon-button finish-btn" title="Concluir implantação">✓</button><button class="icon-button delete-btn" title="Excluir">🗑</button></div></td>
    </tr>`;
  }).join("");
}

function renderPausedTable() {
  const paused = state.clients.filter(c => c.pausado && !c.implantacaoConcluida);
  dom.pausedPanel.hidden = paused.length === 0;
  dom.pausedTableBody.innerHTML = paused.map(c => `<tr data-id="${escapeHtml(c.id)}" class="paused-row"><td><strong>${escapeHtml(c.cliente)}</strong></td><td><span class="pill phase-${slug(computeFase(c))}">${escapeHtml(computeFase(c))}</span></td><td>${escapeHtml(c.motivoPausa || "—")}${c.observacaoPausa ? `<br><small>${escapeHtml(c.observacaoPausa)}</small>` : ""}</td><td>${escapeHtml(formatDate(c.pausadoEm))}</td><td><button class="button button--small resume-btn" type="button">Retomar</button></td></tr>`).join("");
}

function faseFinal(client) {
  if (client.implantacaoConcluida && !client.apiImplantada) return "Concluído sem API";
  return computeFase(client);
}

function renderCompletedTable() {
  const completed = state.clients.filter(c => c.implantacaoConcluida);
  dom.completedPanel.hidden = completed.length === 0;
  dom.completedTableBody.innerHTML = completed.map(c => `<tr data-id="${escapeHtml(c.id)}"><td><strong>${escapeHtml(c.cliente)}</strong></td><td><span class="pill phase-${slug(faseFinal(c))}">${escapeHtml(faseFinal(c))}</span></td><td>${escapeHtml(formatDate(c.implantacaoConcluidaEm))}</td><td><button class="button button--small reopen-btn" type="button">Reabrir</button></td></tr>`).join("");
}

function render() {
  refreshAgendaClientSelects();
  renderMetrics();
  renderChart();
  renderAgenda();
  renderTable();
  renderPausedTable();
  renderCompletedTable();
}

/* ─── Edição e dialogs ───────────────────────────────────────────── */

const DATE_FIELDS = ["primeiroContato","configuracao","treinamento","viradaAgendamento"];

function startInlineEdit(editableCell, field, client) {
  if (editableCell.dataset.editing === "1") return;
  editableCell.dataset.editing = "1";
  const isDate = DATE_FIELDS.includes(field);
  const isTextarea = field === "observacoes";
  const valueSpan = editableCell.querySelector(".cell-value");
  const pencilBtn = editableCell.querySelector(".cell-pencil");
  pencilBtn.style.display = "none";
  valueSpan.style.display = "none";
  let input;
  if (isDate) input = Object.assign(document.createElement("input"), { type:"date", value: client[field] || "" });
  else if (isTextarea) input = Object.assign(document.createElement("textarea"), { value: client[field] || "", rows: 3 });
  else input = Object.assign(document.createElement("input"), { type:"text", value: client[field] || "" });
  input.className = "inline-input";
  editableCell.appendChild(input);
  requestAnimationFrame(() => {
    input.focus();
    if (!isDate && !isTextarea) input.select();
  });

  async function commit() {
    if (editableCell.dataset.saving === "1") return;
    editableCell.dataset.saving = "1";
    const newVal = isDate ? input.value : input.value.trim();
    client[field] = newVal;
    await saveCliente(client);
    cleanup();
    render();
  }
  function cleanup() {
    delete editableCell.dataset.editing;
    delete editableCell.dataset.saving;
    input.remove();
    pencilBtn.style.display = "";
    valueSpan.style.display = "";
  }
  input.addEventListener("blur", commit);
  if (isDate) input.addEventListener("change", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !isTextarea) { e.preventDefault(); commit(); }
    if (e.key === "Escape") { input.removeEventListener("blur", commit); cleanup(); }
  });
}

function updateFasePreview() {
  const mock = {
    primeiroContato: dom.firstContactInput.value,
    primeiroContatoFeito: dom.firstContactFeito.checked,
    configuracao: dom.configurationInput.value,
    configuracaoFeita: dom.configuracaoFeita.checked,
    treinamento: dom.trainingInput.value,
    treinamentoFeito: dom.treinamentoFeito.checked,
    viradaAgendamento: dom.goLiveInput.value,
    viradaFeita: dom.viradaFeita.checked,
    apiImplantada: dom.apiImplantada.checked,
  };
  const fase = computeFase(mock);
  dom.fasePreviewPill.textContent = fase;
  dom.fasePreviewPill.className = `pill phase-${slug(fase)}`;
}

function openDialog(client = null) {
  dom.form.reset();
  dom.dialogTitle.textContent = client ? "Editar implantação" : "Nova implantação";
  dom.recordId.value = client?.id || "";
  dom.clientInput.value = client?.cliente || "";
  dom.firstContactInput.value = client?.primeiroContato || "";
  dom.firstContactFeito.checked = !!client?.primeiroContatoFeito;
  dom.configurationInput.value = client?.configuracao || "";
  dom.configuracaoFeita.checked = !!client?.configuracaoFeita;
  dom.trainingInput.value = client?.treinamento || "";
  dom.treinamentoFeito.checked = !!client?.treinamentoFeito;
  dom.goLiveInput.value = client?.viradaAgendamento || "";
  dom.viradaFeita.checked = !!client?.viradaFeita;
  dom.apiImplantada.checked = !!client?.apiImplantada;
  dom.notesInput.value = client?.observacoes || "";
  updateFasePreview();
  showManagedDialog(dom.dialog, dom.clientInput);
}

function openPauseDialog(client) {
  dom.pauseClientId.value = client.id;
  dom.pauseDialogTitle.textContent = `Pausar ${client.cliente || "implantação"}`;
  dom.pauseReasonInput.value = "Aguardando cliente";
  dom.pauseNoteInput.value = "";
  showManagedDialog(dom.pauseDialog, dom.pauseReasonInput);
}

/* ─── Painel flutuante de situação do cliente ───────────────────── */

let situacaoPanelCount = 0;

function openSituacaoPanel(client) {
  const existing = document.querySelector(`.situacao-panel[data-id="${CSS.escape(client.id)}"]`);
  if (existing) {
    existing.classList.remove("situacao-panel--minimized");
    existing.style.zIndex = String(6000 + situacaoPanelCount++);
    existing.querySelector(".situacao-panel__body")?.focus();
    return;
  }

  const offset = situacaoPanelCount % 6;
  const panel = document.createElement("div");
  panel.className = "situacao-panel";
  panel.dataset.id = client.id;
  panel.style.right = `${20 + offset * 24}px`;
  panel.style.bottom = `${20 + offset * 24}px`;
  panel.style.zIndex = String(6000 + situacaoPanelCount++);
  panel.innerHTML = `
    <div class="situacao-panel__header">
      <strong class="situacao-panel__title">${escapeHtml(client.cliente || "Cliente")}</strong>
      <div class="situacao-panel__btns">
        <button type="button" class="situacao-panel__btn situacao-min" title="Minimizar">–</button>
        <button type="button" class="situacao-panel__btn situacao-close" title="Fechar">×</button>
      </div>
    </div>
    <textarea class="situacao-panel__body" placeholder="Escreva a situação atual deste cliente...">${escapeHtml(client.situacao || "")}</textarea>
  `;
  document.body.appendChild(panel);

  const header = panel.querySelector(".situacao-panel__header");
  const textarea = panel.querySelector(".situacao-panel__body");
  const minBtn = panel.querySelector(".situacao-min");
  const closeBtn = panel.querySelector(".situacao-close");

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      client.situacao = textarea.value;
      await saveCliente(client);
      syncSituacaoIndicator(client);
    }, 500);
  };
  const saveNow = async () => {
    clearTimeout(saveTimer);
    client.situacao = textarea.value;
    await saveCliente(client);
    syncSituacaoIndicator(client);
  };

  textarea.addEventListener("input", scheduleSave);
  textarea.addEventListener("blur", saveNow);

  minBtn.addEventListener("click", () => {
    panel.classList.toggle("situacao-panel--minimized");
  });
  header.addEventListener("dblclick", () => panel.classList.toggle("situacao-panel--minimized"));

  closeBtn.addEventListener("click", async () => {
    await saveNow();
    panel.remove();
  });

  panel.addEventListener("mousedown", () => {
    panel.style.zIndex = String(6000 + situacaoPanelCount++);
  });

  // Arrastar pelo cabeçalho
  header.addEventListener("mousedown", e => {
    if (e.target.closest(".situacao-panel__btn")) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    const startRight = window.innerWidth - rect.right;
    const startBottom = window.innerHeight - rect.bottom;
    function onMove(ev) {
      panel.style.right = `${startRight - (ev.clientX - startX)}px`;
      panel.style.bottom = `${startBottom - (ev.clientY - startY)}px`;
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  requestAnimationFrame(() => textarea.focus());
}

function syncSituacaoIndicator(client) {
  document.querySelectorAll(`tr[data-id="${CSS.escape(client.id)}"] .situacao-btn`).forEach(btn => {
    btn.classList.toggle("situacao-btn--filled", !!client.situacao);
  });
}

function getValidationIssues(client) {
  const issues = [];
  if (!client.primeiroContatoFeito && !hasDate(client.primeiroContato)) issues.push("Primeiro contato não marcado/preenchido");
  if (!client.configuracaoFeita && !hasDate(client.configuracao)) issues.push("Configuração não marcada/preenchida");
  if (!client.treinamentoFeito && !hasDate(client.treinamento)) issues.push("Treinamento não marcado/preenchido");
  if (!client.viradaFeita && !hasDate(client.viradaAgendamento)) issues.push("Virada não marcada/preenchida");
  if (!client.apiImplantada) issues.push("API implantada não marcada");
  return issues;
}

async function concluirImplantacao(client) {
  const issues = getValidationIssues(client);
  let msg = `Marcar "${client.cliente}" como implantação concluída?`;
  if (issues.length) msg += `\n\nPendências encontradas:\n- ${issues.join("\n- ")}\n\nConcluir mesmo assim?`;
  if (!confirm(msg)) return;
  client.implantacaoConcluida = true;
  client.implantacaoConcluidaEm = todayIso();
  client.pausado = false;
  await saveCliente(client);
  render();
  showToast("Implantação concluída e separada da tabela principal.", "success");
}

/* ─── Eventos ───────────────────────────────────────────────────── */

function bindEvents() {
  [dom.dialog, dom.pauseDialog, dom.agendaDialog].forEach(dialogEl => {
    dialogEl.addEventListener("close", syncDialogLayerState);
  });
  dom.addRecordBtn.addEventListener("click", () => openDialog());
  dom.resetDataBtn.addEventListener("click", async () => {
    if (!confirm("Apagar todos os registros da base local?\n\nEsta ação não pode ser desfeita sem um backup.")) return;
    const result = await window.sci.limparTodosClientes();
    if (!result?.ok) { showToast(`Erro ao limpar registros: ${result?.erro || "erro desconhecido"}`, "error"); return; }
    state.clients = [];
    state.agenda = { manualTasks: [], order: [] };
    state.filters = { statuses: [], query: "" };
    state.sort = { field: null, dir: "asc" };
    dom.searchInput.value = "";
    dom.statusFilterBox.querySelectorAll("input").forEach(i => i.checked = false);
    if (dom.dialog.open) closeManagedDialog(dom.dialog);
    if (dom.pauseDialog.open) closeManagedDialog(dom.pauseDialog);
    if (dom.agendaDialog.open) closeManagedDialog(dom.agendaDialog);
    dom.form.reset();
    dom.pauseForm.reset();
    dom.agendaForm.reset();
    render();
    showToast("Registros e agenda apagados.", "success");
  });
  dom.backupBtn.addEventListener("click", async () => {
    setButtonLoading(dom.backupBtn, true, "Salvando...");
    const result = await window.sci.exportarBackup();
    setButtonLoading(dom.backupBtn, false);
    if (result.ok) showToast(`Backup salvo: ${result.caminho}`, "success");
    else if (!result.cancelado) showToast(`Erro ao salvar backup: ${result.erro}`, "error");
  });
  dom.restoreBackupBtn.addEventListener("click", async () => {
    if (!confirm("Restaurar um backup vai substituir todos os dados locais atuais. Continuar?")) return;
    setButtonLoading(dom.restoreBackupBtn, true, "Restaurando...");
    const result = await window.sci.importarBackup();
    setButtonLoading(dom.restoreBackupBtn, false);
    if (result.ok) { await loadAll(); render(); showToast("Backup restaurado com sucesso.", "success"); }
    else if (!result.cancelado) showToast(`Erro ao restaurar backup: ${result.erro}`, "error");
  });
  dom.openDataFolderBtn.addEventListener("click", async () => {
    const result = await window.sci.abrirPastaDados();
    if (result?.ok === false) showToast(`Erro ao abrir pasta de dados: ${result.erro}`, "error");
  });

  dom.searchInput.addEventListener("input", e => { state.filters.query = e.target.value; renderTable(); });
  dom.statusFilterBox.addEventListener("change", () => {
    state.filters.statuses = [...dom.statusFilterBox.querySelectorAll("input:checked")].map(i => i.value);
    renderTable();
  });
  dom.clearFiltersBtn.addEventListener("click", () => {
    state.filters = { statuses: [], query: "" };
    dom.searchInput.value = "";
    dom.statusFilterBox.querySelectorAll("input").forEach(i => i.checked = false);
    renderTable();
  });

  dom.closeDialogBtn.addEventListener("click", () => closeManagedDialog(dom.dialog));
  dom.cancelDialogBtn.addEventListener("click", () => closeManagedDialog(dom.dialog));
  [dom.firstContactInput, dom.configurationInput, dom.trainingInput, dom.goLiveInput, dom.apiImplantada, dom.firstContactFeito, dom.configuracaoFeita, dom.treinamentoFeito, dom.viradaFeita].forEach(el => {
    el.addEventListener("change", updateFasePreview);
    if (el.tagName === "INPUT" && (el.type === "date" || el.type === "text")) el.addEventListener("input", updateFasePreview);
  });

  dom.form.addEventListener("submit", async e => {
    e.preventDefault();
    const id = dom.recordId.value;
    const existing = id ? state.clients.find(c => c.id === id) : {};
    const clientData = normalizeClientState({
      ...existing,
      id: id || generateId(dom.clientInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-") + "-"),
      cliente: dom.clientInput.value.trim(),
      primeiroContato: dom.firstContactInput.value,
      primeiroContatoFeito: dom.firstContactFeito.checked,
      configuracao: dom.configurationInput.value,
      configuracaoFeita: dom.configuracaoFeita.checked,
      treinamento: dom.trainingInput.value,
      treinamentoFeito: dom.treinamentoFeito.checked,
      viradaAgendamento: dom.goLiveInput.value,
      viradaFeita: dom.viradaFeita.checked,
      apiImplantada: dom.apiImplantada.checked,
      observacoes: dom.notesInput.value.trim(),
    });
    await saveCliente(clientData);
    if (id) { const idx = state.clients.findIndex(c => c.id === id); if (idx !== -1) state.clients[idx] = clientData; }
    else state.clients.unshift(clientData);
    closeManagedDialog(dom.dialog);
    render();
    showToast(id ? "Implantação atualizada." : "Implantação cadastrada.", "success");
  });

  dom.closePauseDialogBtn.addEventListener("click", () => closeManagedDialog(dom.pauseDialog));
  dom.cancelPauseDialogBtn.addEventListener("click", () => closeManagedDialog(dom.pauseDialog));
  dom.pauseForm.addEventListener("submit", async e => {
    e.preventDefault();
    const client = state.clients.find(c => c.id === dom.pauseClientId.value);
    if (!client) return;
    client.pausado = true;
    client.motivoPausa = dom.pauseReasonInput.value;
    client.observacaoPausa = dom.pauseNoteInput.value.trim();
    client.pausadoEm = todayIso();
    await saveCliente(client);
    closeManagedDialog(dom.pauseDialog);
    render();
    showToast("Implantação pausada e movida para a mini tabela.", "success");
  });

  dom.tableHead.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
    const field = th.dataset.sort;
    if (state.sort.field === field) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    else { state.sort.field = field; state.sort.dir = "asc"; }
    renderTable();
  }));

  dom.tableBody.addEventListener("click", async e => {
    const row = e.target.closest("tr[data-id]");
    if (!row) return;
    const client = state.clients.find(c => c.id === row.dataset.id);
    if (!client) return;
    const apiInput = e.target.closest(".api-check");
    if (apiInput) { client.apiImplantada = apiInput.checked; await saveCliente(client); render(); return; }
    const situacaoBtn = e.target.closest(".situacao-btn");
    if (situacaoBtn) { openSituacaoPanel(client); return; }
    const checkInput = e.target.closest(".done-check");
    if (checkInput) { client[checkInput.dataset.check] = checkInput.checked; await saveCliente(client); render(); return; }
    const pencilBtn = e.target.closest(".cell-pencil");
    if (pencilBtn) {
      e.preventDefault();
      e.stopPropagation();
      const cell = pencilBtn.closest(".editable-cell");
      startInlineEdit(cell, cell.dataset.field, client);
      return;
    }
    const pauseBtn = e.target.closest(".pause-btn");
    if (pauseBtn) { openPauseDialog(client); return; }
    const finishBtn = e.target.closest(".finish-btn");
    if (finishBtn) { concluirImplantacao(client); return; }
    const deleteBtn = e.target.closest(".delete-btn");
    if (deleteBtn && confirm(`Excluir "${client.cliente}"?`)) {
      const result = await window.sci.excluirCliente(client.id);
      if (result?.ok === false) { showToast(`Erro ao excluir: ${result.erro || "erro desconhecido"}`, "error"); return; }
      state.clients = state.clients.filter(c => c.id !== client.id);
      render();
      showToast("Implantação excluída.", "success");
    }
  });

  dom.pausedTableBody.addEventListener("click", async e => {
    const btn = e.target.closest(".resume-btn");
    if (!btn) return;
    const row = btn.closest("tr[data-id]");
    const client = state.clients.find(c => c.id === row?.dataset.id);
    if (!client) return;
    client.pausado = false;
    await saveCliente(client);
    render();
    showToast("Implantação retomada.", "success");
  });

  dom.completedTableBody.addEventListener("click", async e => {
    const btn = e.target.closest(".reopen-btn");
    if (!btn) return;
    const row = btn.closest("tr[data-id]");
    const client = state.clients.find(c => c.id === row?.dataset.id);
    if (!client) return;
    if (!confirm(`Reabrir "${client.cliente}"?`)) return;
    client.implantacaoConcluida = false;
    client.implantacaoConcluidaEm = "";
    await saveCliente(client);
    render();
    showToast("Implantação reaberta.", "success");
  });

  async function addManualTask() {
    const titulo = dom.agendaTitleInput.value.trim();
    const descricao = dom.agendaDescriptionInput.value.trim();
    const clienteId = dom.agendaClientSelect.value;
    if (!titulo) { showToast("Informe um título para a ação.", "warning"); return; }
    const task = { id: generateId("manual-"), clienteId, titulo, descricao, text: titulo };
    state.agenda.manualTasks.push(task);
    state.agenda.order.push(task.id);
    await saveAgenda();
    dom.agendaTitleInput.value = "";
    dom.agendaDescriptionInput.value = "";
    renderAgenda();
  }
  function openAgendaDialog(task) {
    refreshAgendaClientSelects();
    dom.agendaDialogTitle.textContent = "Editar ação";
    dom.agendaTaskId.value = task.id;
    dom.agendaDialogClientSelect.value = task.clienteId || "";
    dom.agendaDialogTitleInput.value = task.titulo || task.text || "";
    dom.agendaDialogDescriptionInput.value = task.descricao || "";
    showManagedDialog(dom.agendaDialog, dom.agendaDialogTitleInput);
  }
  dom.agendaAddBtn.addEventListener("click", addManualTask);
  [dom.agendaTitleInput, dom.agendaDescriptionInput].forEach(input => input.addEventListener("keydown", e => { if (e.key === "Enter") addManualTask(); }));
  dom.closeAgendaDialogBtn.addEventListener("click", () => closeManagedDialog(dom.agendaDialog));
  dom.cancelAgendaDialogBtn.addEventListener("click", () => closeManagedDialog(dom.agendaDialog));
  dom.agendaForm.addEventListener("submit", async e => {
    e.preventDefault();
    const task = state.agenda.manualTasks.find(t => t.id === dom.agendaTaskId.value);
    if (!task) return;
    task.clienteId = dom.agendaDialogClientSelect.value;
    task.titulo = dom.agendaDialogTitleInput.value.trim();
    task.descricao = dom.agendaDialogDescriptionInput.value.trim();
    task.text = task.titulo;
    await saveAgenda();
    closeManagedDialog(dom.agendaDialog);
    renderAgenda();
    showToast("Ação atualizada.", "success");
  });
  dom.timelineList.addEventListener("click", async e => {
    const upBtn = e.target.closest(".agenda-up"), downBtn = e.target.closest(".agenda-down"), editBtn = e.target.closest(".agenda-edit"), delBtn = e.target.closest(".agenda-del");
    if (upBtn) { moveAgendaItem(upBtn.dataset.id, "up"); return; }
    if (downBtn) { moveAgendaItem(downBtn.dataset.id, "down"); return; }
    if (editBtn) { const task = state.agenda.manualTasks.find(t => t.id === editBtn.dataset.id); if (task) openAgendaDialog(task); return; }
    if (delBtn) { const id = delBtn.dataset.id; state.agenda.manualTasks = state.agenda.manualTasks.filter(t => t.id !== id); state.agenda.order = state.agenda.order.filter(x => x !== id); await saveAgenda(); renderAgenda(); }
  });
  dom.timelineList.addEventListener("dragstart", e => { const item = e.target.closest("[data-task-id]"); if (!item) return; dragSrcId = item.dataset.taskId; e.dataTransfer.effectAllowed = "move"; setTimeout(() => item.classList.add("dragging"), 0); });
  dom.timelineList.addEventListener("dragend", () => { dom.timelineList.querySelectorAll(".dragging,.drag-over").forEach(el => el.classList.remove("dragging","drag-over")); dragSrcId = null; });
  dom.timelineList.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; const item = e.target.closest("[data-task-id]"); if (!item || item.dataset.taskId === dragSrcId) return; dom.timelineList.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over")); item.classList.add("drag-over"); });
  dom.timelineList.addEventListener("drop", e => { e.preventDefault(); const target = e.target.closest("[data-task-id]"); if (!target || !dragSrcId) return; reorderAgenda(dragSrcId, target.dataset.taskId); });
}

/* ─── Boot ──────────────────────────────────────────────────────── */

async function boot() {
  initializeApp();
  cacheDomElements();
  populateStaticFilters();
  bindEvents();
  await loadAll();
  refreshAgendaClientSelects();
  try {
    const dbPath = await window.sci.getDbPath();
    if (dom.dbPathHint) dom.dbPathHint.textContent = dbPath || "Local não identificado";
  } catch (_) {
    if (dom.dbPathHint) dom.dbPathHint.textContent = "Não foi possível carregar o local do banco.";
  }
  loadingOverlay.classList.add("hidden");
  render();
}

boot();
