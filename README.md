# SCI Implantações

Aplicativo desktop local para controle de clientes em processo de implantação.

## O que faz

- Cadastra implantações de clientes.
- Controla etapas: primeiro contato, configuração, treinamento e virada.
- Calcula automaticamente a fase de cada cliente.
- Permite edição direta na tabela.
- Importa e exporta CSV.
- Faz backup e restaura o banco local.
- Abre a pasta onde os dados ficam salvos.

## Tecnologias

- HTML
- CSS
- JavaScript
- Electron
- SQLite com better-sqlite3
- electron-builder

## Dados locais

Os dados ficam no AppData do usuário do Windows, em um arquivo SQLite chamado `implantacoes.db`.

Exemplo aproximado:

```txt
C:\Users\Nome\AppData\Roaming\SCI Implantações\implantacoes.db
```

O executável pode ser substituído por uma versão nova sem apagar os dados locais.

## Desenvolvimento

```bash
npm install
npm start
```

## Gerar executável Windows

```bash
npm run build:win
```

O arquivo gerado fica na pasta `dist-build`.

## Distribuição

Para outra máquina, envie o `.exe` gerado. Para levar dados junto, gere um backup no sistema e restaure esse backup na outra máquina.
