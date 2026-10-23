const aiService = require('../services/ai.service');
const rulesService = require('../services/rules.service');

async function generateReply(req, res, next) {
  try {
    const { customerName = '', messages } = req.body || {};
    if (typeof customerName !== 'string' || customerName.length > 100 || !Array.isArray(messages) || messages.length < 1 || messages.length > 20) {
      return res.status(400).json({ error: 'Se requiere customerName y un historial de 1 a 20 mensajes' });
    }

    const history = [];
    for (const item of messages) {
      if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000) {
        return res.status(400).json({ error: 'Cada mensaje debe tener role válido y texto de hasta 2000 caracteres' });
      }
      const last = history[history.length - 1];
      if (last?.role === item.role) last.content += `\n${item.content.trim()}`;
      else history.push({ role: item.role, content: item.content.trim() });
    }

    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'El último mensaje debe ser del cliente' });
    }

    const lastMessage = history[history.length - 1].content;
    if (rulesService.detectOptCommand(lastMessage) === 'OPT_OUT') {
      return res.json({ reply: null, source: 'RULES', reason: 'opt_out' });
    }

    let reply = await aiService.generateReply({ customerName: customerName.trim(), history });
    let source = 'AI';
    if (!reply) {
      reply = rulesService.generateReply(rulesService.classify(lastMessage), customerName.trim());
      source = 'RULES';
    }

    return res.json({ reply, source });
  } catch (err) {
    return next(err);
  }
}

module.exports = { generateReply };
