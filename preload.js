const { contextBridge, ipcRenderer } = require("electron");

// Expõe API segura para o renderer (sem acesso direto ao Node.js)
contextBridge.exposeInMainWorld("sci", {
  // Clientes
  listarClientes:    ()         => ipcRenderer.invoke("clientes:listar"),
  salvarCliente:     (cliente)  => ipcRenderer.invoke("clientes:salvar", cliente),
  salvarTodosClientes: (lista)  => ipcRenderer.invoke("clientes:salvarTodos", lista),
  excluirCliente:    (id)       => ipcRenderer.invoke("clientes:excluir", id),
  limparTodosClientes: ()       => ipcRenderer.invoke("clientes:limparTodos"),

  // Agenda
  listarAgenda:      ()         => ipcRenderer.invoke("agenda:listar"),
  salvarAgenda:      (agenda)   => ipcRenderer.invoke("agenda:salvar", agenda),

  // Utilitários
  getDbPath:         ()         => ipcRenderer.invoke("app:getDbPath"),
  abrirPastaDados:   ()         => ipcRenderer.invoke("app:abrirPastaDados"),
  exportarBackup:    ()         => ipcRenderer.invoke("app:exportarBackup"),
  importarBackup:    ()         => ipcRenderer.invoke("app:importarBackup"),
});
