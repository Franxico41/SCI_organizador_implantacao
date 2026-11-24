const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// ── Caminho do banco de dados ───────────────────────────────────────
const userDataPath = app.getPath("userData"); // C:\Users\Nome\AppData\Roaming\SCI Implantações
const DB_PATH = path.join(userDataPath, "implantacoes.db");

let db = null;
let mainWindow = null;

const APP_ICON_PATH = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

if (process.platform === 'win32') {
  app.setAppUserModelId('br.com.sci.implantacoes');
}

function checkpointDatabase() {
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(FULL)");
  } catch (err) {
    console.warn("Não foi possível executar WAL checkpoint:", err.message);
  }
}

function closeDatabase() {
  if (!db) return;
  try {
    checkpointDatabase();
    db.close();
  } catch (err) {
    console.warn("Não foi possível fechar o banco:", err.message);
  } finally {
    db = null;
  }
}

function removeSqliteSidecarFiles(basePath) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecarPath = `${basePath}${suffix}`;
    try {
      if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
    } catch (err) {
      console.warn(`Não foi possível remover ${sidecarPath}:`, err.message);
    }
  }
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(col => col.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ── Inicializa banco SQLite ─────────────────────────────────────────
function initDatabase() {
  try {
    const Database = require("better-sqlite3");
    db = new Database(DB_PATH);

    // WAL mode = melhor performance e segurança
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Tabela de clientes/implantações
    db.exec(`
      CREATE TABLE IF NOT EXISTS clientes (
        id                    TEXT PRIMARY KEY,
        cliente               TEXT NOT NULL DEFAULT '',
        primeiroContato       TEXT DEFAULT '',
        primeiroContatoFeito  INTEGER DEFAULT 0,
        configuracao          TEXT DEFAULT '',
        configuracaoFeita     INTEGER DEFAULT 0,
        treinamento           TEXT DEFAULT '',
        treinamentoFeito      INTEGER DEFAULT 0,
        viradaAgendamento     TEXT DEFAULT '',
        viradaFeita           INTEGER DEFAULT 0,
        apiImplantada         INTEGER DEFAULT 0,
        prioridade            TEXT DEFAULT 'Normal',
        pausado               INTEGER DEFAULT 0,
        motivoPausa           TEXT DEFAULT '',
        observacaoPausa       TEXT DEFAULT '',
        pausadoEm             TEXT DEFAULT '',
        implantacaoConcluida  INTEGER DEFAULT 0,
        implantacaoConcluidaEm TEXT DEFAULT '',
        observacoes           TEXT DEFAULT '',
        situacao              TEXT DEFAULT '',
        responsavel           TEXT DEFAULT '',
        criadoEm              TEXT DEFAULT (datetime('now')),
        atualizadoEm          TEXT DEFAULT (datetime('now'))
      );
    `);

    // Tabela de tarefas manuais da agenda
    db.exec(`
      CREATE TABLE IF NOT EXISTS agenda_tarefas (
        id          TEXT PRIMARY KEY,
        clienteId   TEXT DEFAULT '',
        titulo      TEXT NOT NULL DEFAULT '',
        descricao   TEXT DEFAULT '',
        texto       TEXT DEFAULT '',
        ordem       INTEGER DEFAULT 0,
        criadoEm    TEXT DEFAULT (datetime('now')),
        atualizadoEm TEXT DEFAULT (datetime('now'))
      );
    `);

    ensureColumn('clientes', 'apiImplantada', 'INTEGER DEFAULT 0');
    ensureColumn('clientes', 'prioridade', "TEXT DEFAULT 'Normal'");
    ensureColumn('clientes', 'pausado', 'INTEGER DEFAULT 0');
    ensureColumn('clientes', 'motivoPausa', "TEXT DEFAULT ''");
    ensureColumn('clientes', 'observacaoPausa', "TEXT DEFAULT ''");
    ensureColumn('clientes', 'pausadoEm', "TEXT DEFAULT ''");
    ensureColumn('clientes', 'implantacaoConcluida', 'INTEGER DEFAULT 0');
    ensureColumn('clientes', 'implantacaoConcluidaEm', "TEXT DEFAULT ''");
    ensureColumn('clientes', 'situacao', "TEXT DEFAULT ''");
    ensureColumn('agenda_tarefas', 'clienteId', "TEXT DEFAULT ''");
    ensureColumn('agenda_tarefas', 'titulo', "TEXT DEFAULT ''");
    ensureColumn('agenda_tarefas', 'descricao', "TEXT DEFAULT ''");
    ensureColumn('agenda_tarefas', 'atualizadoEm', "TEXT DEFAULT ''");

    db.exec(`
      UPDATE agenda_tarefas
      SET titulo = COALESCE(NULLIF(titulo, ''), texto), descricao = COALESCE(descricao, '')
      WHERE COALESCE(titulo, '') = '' AND COALESCE(texto, '') <> '';
    `);

    // Tabela de configurações/preferências (ordem da agenda etc.)
    db.exec(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        chave TEXT PRIMARY KEY,
        valor TEXT DEFAULT ''
      );
    `);

    console.log("Banco de dados inicializado em:", DB_PATH);
    return true;
  } catch (err) {
    console.error("Erro ao inicializar banco de dados:", err);
    dialog.showErrorBox(
      "Erro de Banco de Dados",
      `Não foi possível abrir o banco de dados:\n${DB_PATH}\n\nErro: ${err.message}`
    );
    return false;
  }
}

// ── Cria janela principal ───────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "SCI Implantações",
    icon: APP_ICON_PATH,
    show: false, // não mostra até estar pronto
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Abre DevTools apenas em modo dev
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

// ── IPC: Clientes ───────────────────────────────────────────────────

ipcMain.handle("clientes:listar", () => {
  try {
    const rows = db.prepare("SELECT * FROM clientes ORDER BY criadoEm DESC").all();
    return rows.map(deserializeCliente);
  } catch (err) {
    console.error("clientes:listar", err);
    return [];
  }
});

ipcMain.handle("clientes:salvar", (_, cliente) => {
  try {
    const existing = db.prepare("SELECT id FROM clientes WHERE id = ?").get(cliente.id);
    const payload = normalizeClientePayload(cliente);
    if (existing) {
      db.prepare(`
        UPDATE clientes SET
          cliente = ?, primeiroContato = ?, primeiroContatoFeito = ?,
          configuracao = ?, configuracaoFeita = ?,
          treinamento = ?, treinamentoFeito = ?,
          viradaAgendamento = ?, viradaFeita = ?,
          apiImplantada = ?, prioridade = ?, pausado = ?, motivoPausa = ?, observacaoPausa = ?, pausadoEm = ?,
          implantacaoConcluida = ?, implantacaoConcluidaEm = ?, observacoes = ?, situacao = ?, responsavel = ?,
          atualizadoEm = datetime('now')
        WHERE id = ?
      `).run(
        payload.cliente, payload.primeiroContato, payload.primeiroContatoFeito ? 1 : 0,
        payload.configuracao, payload.configuracaoFeita ? 1 : 0,
        payload.treinamento, payload.treinamentoFeito ? 1 : 0,
        payload.viradaAgendamento, payload.viradaFeita ? 1 : 0,
        payload.apiImplantada ? 1 : 0, payload.prioridade, payload.pausado ? 1 : 0,
        payload.motivoPausa, payload.observacaoPausa, payload.pausadoEm,
        payload.implantacaoConcluida ? 1 : 0, payload.implantacaoConcluidaEm,
        payload.observacoes, payload.situacao, payload.responsavel,
        payload.id
      );
    } else {
      db.prepare(`
        INSERT INTO clientes (
          id, cliente, primeiroContato, primeiroContatoFeito,
          configuracao, configuracaoFeita,
          treinamento, treinamentoFeito,
          viradaAgendamento, viradaFeita,
          apiImplantada, prioridade, pausado, motivoPausa, observacaoPausa, pausadoEm,
          implantacaoConcluida, implantacaoConcluidaEm, observacoes, situacao, responsavel
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.id, payload.cliente, payload.primeiroContato, payload.primeiroContatoFeito ? 1 : 0,
        payload.configuracao, payload.configuracaoFeita ? 1 : 0,
        payload.treinamento, payload.treinamentoFeito ? 1 : 0,
        payload.viradaAgendamento, payload.viradaFeita ? 1 : 0,
        payload.apiImplantada ? 1 : 0, payload.prioridade, payload.pausado ? 1 : 0,
        payload.motivoPausa, payload.observacaoPausa, payload.pausadoEm,
        payload.implantacaoConcluida ? 1 : 0, payload.implantacaoConcluidaEm,
        payload.observacoes, payload.situacao, payload.responsavel
      );
    }
    return { ok: true };
  } catch (err) {
    console.error("clientes:salvar", err);
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle("clientes:salvarTodos", (_, clientes) => {
  try {
    const upsert = db.prepare(`
      INSERT INTO clientes (
        id, cliente, primeiroContato, primeiroContatoFeito,
        configuracao, configuracaoFeita,
        treinamento, treinamentoFeito,
        viradaAgendamento, viradaFeita,
        apiImplantada, prioridade, pausado, motivoPausa, observacaoPausa, pausadoEm,
        implantacaoConcluida, implantacaoConcluidaEm, observacoes, situacao, responsavel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cliente = excluded.cliente,
        primeiroContato = excluded.primeiroContato,
        primeiroContatoFeito = excluded.primeiroContatoFeito,
        configuracao = excluded.configuracao,
        configuracaoFeita = excluded.configuracaoFeita,
        treinamento = excluded.treinamento,
        treinamentoFeito = excluded.treinamentoFeito,
        viradaAgendamento = excluded.viradaAgendamento,
        viradaFeita = excluded.viradaFeita,
        apiImplantada = excluded.apiImplantada,
        prioridade = excluded.prioridade,
        pausado = excluded.pausado,
        motivoPausa = excluded.motivoPausa,
        observacaoPausa = excluded.observacaoPausa,
        pausadoEm = excluded.pausadoEm,
        implantacaoConcluida = excluded.implantacaoConcluida,
        implantacaoConcluidaEm = excluded.implantacaoConcluidaEm,
        observacoes = excluded.observacoes,
        situacao = excluded.situacao,
        responsavel = excluded.responsavel,
        atualizadoEm = datetime('now')
    `);
    const runMany = db.transaction((list) => {
      for (const raw of list) {
        const c = normalizeClientePayload(raw);
        upsert.run(
          c.id, c.cliente, c.primeiroContato, c.primeiroContatoFeito ? 1 : 0,
          c.configuracao, c.configuracaoFeita ? 1 : 0,
          c.treinamento, c.treinamentoFeito ? 1 : 0,
          c.viradaAgendamento, c.viradaFeita ? 1 : 0,
          c.apiImplantada ? 1 : 0, c.prioridade, c.pausado ? 1 : 0,
          c.motivoPausa, c.observacaoPausa, c.pausadoEm,
          c.implantacaoConcluida ? 1 : 0, c.implantacaoConcluidaEm,
          c.observacoes, c.situacao, c.responsavel
        );
      }
    });
    runMany(clientes);
    return { ok: true };
  } catch (err) {
    console.error("clientes:salvarTodos", err);
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle("clientes:excluir", (_, id) => {
  try {
    db.prepare("DELETE FROM clientes WHERE id = ?").run(id);
    return { ok: true };
  } catch (err) {
    console.error("clientes:excluir", err);
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle("clientes:limparTodos", () => {
  try {
    const clearAll = db.transaction(() => {
      db.prepare("DELETE FROM clientes").run();
      db.prepare("DELETE FROM agenda_tarefas").run();
      db.prepare("DELETE FROM configuracoes WHERE chave = 'agenda_ordem'").run();
    });
    clearAll();
    return { ok: true };
  } catch (err) {
    console.error("clientes:limparTodos", err);
    return { ok: false, erro: err.message };
  }
});

// ── IPC: Agenda ─────────────────────────────────────────────────────

ipcMain.handle("agenda:listar", () => {
  try {
    const tarefas = db.prepare("SELECT * FROM agenda_tarefas ORDER BY ordem ASC, criadoEm ASC").all();
    const cfg = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'agenda_ordem'").get();
    const order = cfg ? JSON.parse(cfg.valor) : [];
    return {
      manualTasks: tarefas.map(t => ({
        id: t.id,
        clienteId: t.clienteId || '',
        titulo: t.titulo || t.texto || '',
        descricao: t.descricao || '',
        text: t.texto || t.titulo || ''
      })),
      order
    };
  } catch (err) {
    console.error("agenda:listar", err);
    return { manualTasks: [], order: [] };
  }
});

ipcMain.handle("agenda:salvar", (_, agenda) => {
  try {
    // Sincroniza tarefas manuais
    const idsNovos = new Set(agenda.manualTasks.map(t => t.id));
    const idsExistentes = db.prepare("SELECT id FROM agenda_tarefas").all().map(r => r.id);

    // Remove excluídas
    for (const id of idsExistentes) {
      if (!idsNovos.has(id)) db.prepare("DELETE FROM agenda_tarefas WHERE id = ?").run(id);
    }

    // Insere/atualiza
    const upsert = db.prepare(`
      INSERT INTO agenda_tarefas (id, clienteId, titulo, descricao, texto, ordem, atualizadoEm)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        clienteId = excluded.clienteId,
        titulo = excluded.titulo,
        descricao = excluded.descricao,
        texto = excluded.texto,
        ordem = excluded.ordem,
        atualizadoEm = datetime('now')
    `);
    agenda.manualTasks.forEach((t, i) => upsert.run(
      t.id,
      t.clienteId || '',
      t.titulo || t.text || '',
      t.descricao || '',
      t.text || t.titulo || '',
      i
    ));

    // Salva ordem
    db.prepare(`
      INSERT INTO configuracoes (chave, valor) VALUES ('agenda_ordem', ?)
      ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
    `).run(JSON.stringify(agenda.order));

    return { ok: true };
  } catch (err) {
    console.error("agenda:salvar", err);
    return { ok: false, erro: err.message };
  }
});

// ── IPC: Utilitários ────────────────────────────────────────────────

ipcMain.handle("app:getDbPath", () => DB_PATH);


ipcMain.handle("app:abrirPastaDados", async () => {
  try {
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
    await shell.openPath(userDataPath);
    return { ok: true, caminho: userDataPath };
  } catch (err) {
    console.error("app:abrirPastaDados", err);
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle("app:exportarBackup", async () => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Salvar backup do banco de dados",
    defaultPath: `SCI-backup-${new Date().toISOString().slice(0, 10)}.db`,
    filters: [{ name: "Banco de dados SQLite", extensions: ["db"] }],
  });
  if (!filePath) return { ok: false, cancelado: true };

  try {
    checkpointDatabase();

    // O backup nativo do SQLite evita cópia incompleta quando WAL está ativo.
    if (typeof db.backup === "function") {
      await db.backup(filePath);
    } else {
      fs.copyFileSync(DB_PATH, filePath);
    }

    return { ok: true, caminho: filePath };
  } catch (err) {
    console.error("app:exportarBackup", err);
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle("app:importarBackup", async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Restaurar backup",
    filters: [{ name: "Banco de dados SQLite", extensions: ["db"] }],
    properties: ["openFile"],
  });
  if (!filePaths?.length) return { ok: false, cancelado: true };

  try {
    closeDatabase();
    removeSqliteSidecarFiles(DB_PATH);

    fs.copyFileSync(filePaths[0], DB_PATH);

    const ok = initDatabase();
    if (!ok) return { ok: false, erro: "Não foi possível reabrir o banco restaurado." };

    return { ok: true };
  } catch (err) {
    console.error("app:importarBackup", err);

    try {
      if (!db) initDatabase();
    } catch (_) {}

    return { ok: false, erro: err.message };
  }
});

// ── Helper: normaliza payload de clientes ──────────────────────────

function normalizeClientePayload(cliente = {}) {
  return {
    id: cliente.id,
    cliente: cliente.cliente || '',
    primeiroContato: cliente.primeiroContato || '',
    primeiroContatoFeito: !!cliente.primeiroContatoFeito,
    configuracao: cliente.configuracao || '',
    configuracaoFeita: !!cliente.configuracaoFeita,
    treinamento: cliente.treinamento || '',
    treinamentoFeito: !!cliente.treinamentoFeito,
    viradaAgendamento: cliente.viradaAgendamento || '',
    viradaFeita: !!cliente.viradaFeita,
    apiImplantada: !!cliente.apiImplantada,
    prioridade: cliente.prioridade || 'Normal',
    pausado: !!cliente.pausado,
    motivoPausa: cliente.motivoPausa || '',
    observacaoPausa: cliente.observacaoPausa || '',
    pausadoEm: cliente.pausadoEm || '',
    implantacaoConcluida: !!cliente.implantacaoConcluida,
    implantacaoConcluidaEm: cliente.implantacaoConcluidaEm || '',
    observacoes: cliente.observacoes || '',
    situacao: cliente.situacao || '',
    responsavel: cliente.responsavel || '',
  };
}

// ── Helper: converte booleanos do SQLite (0/1 → false/true) ────────
function deserializeCliente(row) {
  return {
    ...row,
    primeiroContatoFeito: !!row.primeiroContatoFeito,
    configuracaoFeita: !!row.configuracaoFeita,
    treinamentoFeito: !!row.treinamentoFeito,
    viradaFeita: !!row.viradaFeita,
    apiImplantada: !!row.apiImplantada,
    prioridade: row.prioridade || 'Normal',
    pausado: !!row.pausado,
    motivoPausa: row.motivoPausa || '',
    observacaoPausa: row.observacaoPausa || '',
    pausadoEm: row.pausadoEm || '',
    implantacaoConcluida: !!row.implantacaoConcluida,
    implantacaoConcluidaEm: row.implantacaoConcluidaEm || '',
  };
}

// ── Ciclo de vida do Electron ───────────────────────────────────────
app.whenReady().then(() => {
  const ok = initDatabase();
  if (!ok) { app.quit(); return; }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  closeDatabase();
});
