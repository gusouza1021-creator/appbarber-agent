/**
 * Servidor Integrado: BIA CRM + AppBarber + WhatsApp
 * Agente IA que gerencia agendamentos entre os sistemas
 */

const express = require('express');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const uuid = require('uuid');
const path = require('path');
const AppBarberAgent = require('./appbarber-agent');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configurações
const BIA_API_URL = process.env.BIA_API_URL || 'https://api.biacrm.com.br';
const BIA_API_TOKEN = process.env.BIA_API_TOKEN || 'seu-token-aqui';
const APPBARBER_EMAIL = process.env.APPBARBER_EMAIL || 'novvabarbearia@hotmail.com';
const APPBARBER_SENHA = process.env.APPBARBER_SENHA || 'Novv@24';

// Banco de dados
const db = new sqlite3.Database('./barbearia.db');

// Agente AppBarber
let agente = null;

/**
 * Inicializar banco de dados
 */
function inicializarBD() {
  db.serialize(() => {
    // Tabela de agendamentos sincronizados
    db.run(`CREATE TABLE IF NOT EXISTS agendamentos (
      id TEXT PRIMARY KEY,
      telefone TEXT NOT NULL,
      cliente_nome TEXT NOT NULL,
      servico TEXT NOT NULL,
      data TEXT NOT NULL,
      hora TEXT NOT NULL,
      status TEXT DEFAULT 'pendente',
      id_appbarber TEXT,
      id_bia TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de conversas
    db.run(`CREATE TABLE IF NOT EXISTS conversas (
      id TEXT PRIMARY KEY,
      telefone TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      tipo TEXT DEFAULT 'entrada',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de sincronização
    db.run(`CREATE TABLE IF NOT EXISTS sincronizacao (
      id TEXT PRIMARY KEY,
      tipo TEXT,
      dados TEXT,
      status TEXT DEFAULT 'pendente',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de serviços
    db.run(`CREATE TABLE IF NOT EXISTS servicos (
      id TEXT PRIMARY KEY,
      nome TEXT UNIQUE NOT NULL,
      descricao TEXT,
      duracao INTEGER,
      preco DECIMAL(10,2)
    )`);

    // Inserir serviços padrão
    const servicos = [
      { nome: 'Corte de Cabelo', descricao: 'Corte completo', duracao: 30, preco: 50 },
      { nome: 'Barba', descricao: 'Aparagem e alinhamento', duracao: 20, preco: 30 },
      { nome: 'Corte + Barba', descricao: 'Combo completo', duracao: 50, preco: 70 },
      { nome: 'Design de Barba', descricao: 'Design personalizado', duracao: 25, preco: 40 },
    ];

    servicos.forEach((s) => {
      db.run(
        'INSERT OR IGNORE INTO servicos (id, nome, descricao, duracao, preco) VALUES (?, ?, ?, ?, ?)',
        [uuid.v4(), s.nome, s.descricao, s.duracao, s.preco]
      );
    });

    console.log('✓ Banco de dados inicializado');
  });
}

/**
 * Enviar mensagem via BIA CRM
 */
async function enviarMensagemBIA(telefone, mensagem) {
  try {
    const response = await axios.post(
      `${BIA_API_URL}/api/messages/send`,
      {
        number: telefone,
        body: mensagem,
      },
      {
        headers: {
          'Authorization': `Bearer ${BIA_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✓ Mensagem enviada via BIA para ${telefone}`);
    return response.data;
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem via BIA:', error.message);
    return null;
  }
}

/**
 * Receber mensagem do BIA CRM (webhook)
 */
app.post('/webhook/bia', async (req, res) => {
  try {
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'Dados não encontrados' });
    }

    const telefone = data.contact?.phone || data.from || data.sender;
    const mensagem = data.message?.text || data.body || data.text;

    if (!telefone || !mensagem) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    console.log(`\n📱 Mensagem recebida via BIA de ${telefone}: ${mensagem}`);

    // Registrar conversa
    const conversaId = uuid.v4();
    db.run(
      'INSERT INTO conversas (id, telefone, mensagem, tipo) VALUES (?, ?, ?, ?)',
      [conversaId, telefone, mensagem, 'entrada']
    );

    // Processar intenção
    const intencao = processarIntencao(mensagem);
    console.log('Intenção detectada:', intencao);

    // Gerar resposta
    let resposta = '';

    if (intencao.tipo === 'agendar') {
      // Criar agendamento
      const agendamentoId = uuid.v4();
      db.run(
        'INSERT INTO agendamentos (id, telefone, cliente_nome, servico, data, hora, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          agendamentoId,
          telefone,
          intencao.cliente || 'Cliente',
          intencao.servico || 'Corte de Cabelo',
          intencao.data || new Date().toISOString().split('T')[0],
          intencao.hora || '14:00',
          'pendente',
        ]
      );

      resposta = `✅ Agendamento confirmado!\n\n📅 ${intencao.data}\n⏰ ${intencao.hora}\n💇 ${intencao.servico}\n\nVocê receberá uma confirmação em breve.`;
    } else if (intencao.tipo === 'cancelar') {
      resposta = '❌ Agendamento cancelado com sucesso. Você pode agendar novamente quando quiser!';
    } else if (intencao.tipo === 'consultar') {
      resposta = '📅 Você tem agendamento em breve. Deseja confirmar ou cancelar?';
    } else {
      resposta = 'Olá! 👋 Bem-vindo à nossa barbearia. Como posso ajudá-lo?\n\n1️⃣ Agendar\n2️⃣ Cancelar\n3️⃣ Consultar agendamento\n4️⃣ Informações';
    }

    // Enviar resposta via BIA
    await enviarMensagemBIA(telefone, resposta);

    // Registrar resposta
    const respostaId = uuid.v4();
    db.run(
      'INSERT INTO conversas (id, telefone, mensagem, tipo) VALUES (?, ?, ?, ?)',
      [respostaId, telefone, resposta, 'saida']
    );

    res.json({ success: true, resposta });
  } catch (error) {
    console.error('❌ Erro ao processar webhook BIA:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Processar intenção da mensagem
 */
function processarIntencao(mensagem) {
  const msg = mensagem.toLowerCase();

  // Agendar
  if (msg.includes('agendar') || msg.includes('marcar') || msg.includes('horário')) {
    return {
      tipo: 'agendar',
      servico: msg.includes('barba') ? 'Barba' : 'Corte de Cabelo',
      data: extrairData(msg),
      hora: extrairHora(msg),
      cliente: null,
    };
  }

  // Cancelar
  if (msg.includes('cancelar') || msg.includes('desmarcar')) {
    return { tipo: 'cancelar' };
  }

  // Consultar
  if (msg.includes('consultar') || msg.includes('meu agendamento') || msg.includes('quando')) {
    return { tipo: 'consultar' };
  }

  // Informações
  if (msg.includes('horário') || msg.includes('endereço') || msg.includes('preço')) {
    return { tipo: 'informacoes' };
  }

  return { tipo: 'outro' };
}

/**
 * Extrair data da mensagem
 */
function extrairData(mensagem) {
  const hoje = new Date();
  
  if (mensagem.includes('hoje')) {
    return hoje.toISOString().split('T')[0];
  }
  
  if (mensagem.includes('amanhã')) {
    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);
    return amanha.toISOString().split('T')[0];
  }

  // Tentar extrair data no formato DD/MM
  const match = mensagem.match(/(\d{1,2})\/(\d{1,2})/);
  if (match) {
    const dia = match[1].padStart(2, '0');
    const mes = match[2].padStart(2, '0');
    return `${hoje.getFullYear()}-${mes}-${dia}`;
  }

  return hoje.toISOString().split('T')[0];
}

/**
 * Extrair hora da mensagem
 */
function extrairHora(mensagem) {
  const match = mensagem.match(/(\d{1,2}):?(\d{2})?/);
  if (match) {
    const hora = match[1].padStart(2, '0');
    const minuto = (match[2] || '00').padStart(2, '0');
    return `${hora}:${minuto}`;
  }
  return '14:00';
}

/**
 * Servir página inicial
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * API: Health Check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', versao: '2.0.0', sistema: 'BIA + AppBarber' });
});

/**
 * API: Listar serviços
 */
app.get('/api/servicos', (req, res) => {
  db.all('SELECT * FROM servicos', (err, rows) => {
    res.json(rows || []);
  });
});

/**
 * API: Horários disponíveis
 */
app.get('/api/horarios/:data/:servico', (req, res) => {
  const horarios = [
    '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
    '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'
  ];

  db.all(
    'SELECT hora FROM agendamentos WHERE data = ? AND status IN (?, ?)',
    [req.params.data, 'confirmado', 'pendente'],
    (err, rows) => {
      const ocupados = (rows || []).map(r => r.hora);
      const resultado = horarios.map(h => ({
        hora: h,
        disponivel: !ocupados.includes(h),
      }));
      res.json(resultado);
    }
  );
});

/**
 * API: Agendar
 */
app.post('/api/agendar', (req, res) => {
  const { cliente_nome, telefone, servico, data, hora } = req.body;

  if (!cliente_nome || !telefone || !servico || !data || !hora) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const id = uuid.v4();
  db.run(
    'INSERT INTO agendamentos (id, telefone, cliente_nome, servico, data, hora) VALUES (?, ?, ?, ?, ?, ?)',
    [id, telefone, cliente_nome, servico, data, hora],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      // Enviar confirmação via BIA
      const mensagem = `✅ Agendamento confirmado!\n📅 ${data}\n⏰ ${hora}\n💇 ${servico}`;
      enviarMensagemBIA(telefone, mensagem);

      res.json({ success: true, agendamentoId: id });
    }
  );
});

/**
 * API: Listar agendamentos
 */
app.get('/api/agendamentos', (req, res) => {
  const { telefone, data, status } = req.query;
  let query = 'SELECT * FROM agendamentos WHERE 1=1';
  const params = [];

  if (telefone) {
    query += ' AND telefone = ?';
    params.push(telefone);
  }
  if (data) {
    query += ' AND data = ?';
    params.push(data);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY data DESC';

  db.all(query, params, (err, rows) => {
    res.json(rows || []);
  });
});

/**
 * API: Cancelar agendamento
 */
app.post('/api/agendamentos/:id/cancelar', (req, res) => {
  db.run(
    'UPDATE agendamentos SET status = ? WHERE id = ?',
    ['cancelado', req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

/**
 * API: Conversas
 */
app.get('/api/conversas/:telefone', (req, res) => {
  db.all(
    'SELECT * FROM conversas WHERE telefone = ? ORDER BY timestamp',
    [req.params.telefone],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

/**
 * API: Exportar dados
 */
app.get('/api/exportar-dados', (req, res) => {
  db.all('SELECT * FROM agendamentos ORDER BY timestamp DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const csv = [
      ['ID', 'Telefone', 'Cliente', 'Serviço', 'Data', 'Hora', 'Status', 'Data/Hora'],
      ...(rows || []).map(r => [r.id, r.telefone, r.cliente_nome, r.servico, r.data, r.hora, r.status, r.timestamp])
    ].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');

    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', 'attachment; filename="agendamentos.csv"');
    res.send(csv);
  });
});

/**
 * Webhook para mensagens
 */
app.post('/webhook/mensagens', (req, res) => {
  const { telefone, mensagem } = req.body;

  if (!telefone || !mensagem) {
    return res.status(400).json({ error: 'Telefone e mensagem obrigatórios' });
  }

  const id = uuid.v4();
  db.run(
    'INSERT INTO conversas (id, telefone, mensagem, tipo) VALUES (?, ?, ?, ?)',
    [id, telefone, mensagem, 'entrada'],
    (err) => {
      if (err) console.error('Erro:', err);
      res.json({ success: true, conversaId: id });
    }
  );
});

/**
 * Iniciar servidor
 */
const PORT = process.env.PORT || 3000;

// Inicializar banco de dados
inicializarBD();

// Iniciar servidor
setTimeout(() => {
  app.listen(PORT, () => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 Servidor BIA + AppBarber rodando na porta ${PORT}`);
    console.log(`${'='.repeat(70)}\n`);
    console.log('📝 Endpoints disponíveis:');
    console.log(`   GET  http://localhost:${PORT}/health`);
    console.log(`   GET  http://localhost:${PORT}/api/servicos`);
    console.log(`   GET  http://localhost:${PORT}/api/horarios/:data/:servico`);
    console.log(`   POST http://localhost:${PORT}/api/agendar`);
    console.log(`   GET  http://localhost:${PORT}/api/agendamentos`);
    console.log(`   POST http://localhost:${PORT}/api/agendamentos/:id/cancelar`);
    console.log(`   GET  http://localhost:${PORT}/api/conversas/:telefone`);
    console.log(`   GET  http://localhost:${PORT}/api/exportar-dados`);
    console.log(`   POST http://localhost:${PORT}/webhook/bia`);
    console.log(`   POST http://localhost:${PORT}/webhook/mensagens\n`);
  });
}, 1000);

module.exports = app;
