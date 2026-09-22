// Pruebas del servicio de intake (Seccion 6, pasos 9-13) con los modelos
// mockeados: no requieren base de datos real, se enfocan en la logica de
// orquestacion (identificar/crear cliente, conversacion, deduplicar,
// clasificar y encolar respuesta).

jest.mock('../src/models/customer.model');
jest.mock('../src/models/conversation.model');
jest.mock('../src/models/message.model');
jest.mock('../src/models/communicationPreference.model');
jest.mock('../src/models/automationLog.model');
jest.mock('../src/models/messageQueue.model');
jest.mock('../src/services/ai.service');

const customerModel = require('../src/models/customer.model');
const conversationModel = require('../src/models/conversation.model');
const messageModel = require('../src/models/message.model');
const prefsModel = require('../src/models/communicationPreference.model');
const queueModel = require('../src/models/messageQueue.model');
const aiService = require('../src/services/ai.service');
const { handleInboundMessage } = require('../src/services/messageIntake.service');

const CUSTOMER = { id: 1, phone: '51999000111', name: 'Cliente Prueba' };
const CONVERSATION = { id: 10, customer_id: 1, status: 'OPEN' };
const MESSAGE = { id: 100, conversation_id: 10, customer_id: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  customerModel.findOrCreateByPhone.mockResolvedValue(CUSTOMER);
  customerModel.touchLastMessage.mockResolvedValue();
  customerModel.updateClassification.mockResolvedValue();
  conversationModel.findOrCreateOpenByCustomer.mockResolvedValue(CONVERSATION);
  conversationModel.touchLastMessage.mockResolvedValue();
  messageModel.findByExternalId.mockResolvedValue(null);
  messageModel.create.mockResolvedValue(MESSAGE);
  prefsModel.ensureForCustomer.mockResolvedValue({ opted_out: false, opted_in: true });
  prefsModel.optIn.mockResolvedValue();
  prefsModel.optOut.mockResolvedValue();
  queueModel.enqueue.mockResolvedValue({ id: 200 });
  queueModel.cancelPendingByCustomer.mockResolvedValue();
  aiService.classifyIntent.mockResolvedValue(null); // fuerza fallback a reglas
});

describe('messageIntake.service - handleInboundMessage', () => {
  test('ignora mensajes de grupo', async () => {
    const result = await handleInboundMessage({ isGroup: true, phone: '123', fromMe: false });
    expect(result).toEqual({ skipped: true, reason: 'group_message' });
    expect(customerModel.findOrCreateByPhone).not.toHaveBeenCalled();
  });

  test('ignora mensajes marcados como fromMe', async () => {
    const result = await handleInboundMessage({ isGroup: false, phone: '123', fromMe: true });
    expect(result).toEqual({ skipped: true, reason: 'from_me' });
  });

  test('ignora eventos sin telefono', async () => {
    const result = await handleInboundMessage({ isGroup: false, phone: null, fromMe: false });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('missing_phone');
  });

  test('evita procesar dos veces el mismo external_message_id', async () => {
    messageModel.findByExternalId.mockResolvedValueOnce({ id: 999 });
    const result = await handleInboundMessage({
      isGroup: false,
      fromMe: false,
      phone: '51999000111',
      externalMessageId: 'DUPLICATE-1',
      content: 'hola',
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('duplicate_message');
    expect(customerModel.findOrCreateByPhone).not.toHaveBeenCalled();
  });

  test('registra cliente, conversacion y mensaje para un evento valido', async () => {
    const result = await handleInboundMessage({
      isGroup: false,
      fromMe: false,
      phone: '51999000111',
      pushName: 'Cliente Prueba',
      externalMessageId: 'MSG-1',
      messageType: 'TEXT',
      content: 'Quiero comprar una laptop',
    });

    expect(result.skipped).toBe(false);
    expect(customerModel.findOrCreateByPhone).toHaveBeenCalledWith('51999000111', 'Cliente Prueba');
    expect(conversationModel.findOrCreateOpenByCustomer).toHaveBeenCalledWith(CUSTOMER.id);
    expect(messageModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'INBOUND', customerId: CUSTOMER.id })
    );
    // Debe clasificar y encolar una respuesta automatica (Entrega 5)
    expect(customerModel.updateClassification).toHaveBeenCalledWith(
      CUSTOMER.id,
      expect.objectContaining({ interestType: 'PRODUCTO' })
    );
    expect(queueModel.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER.id, phone: CUSTOMER.phone })
    );
  });

  test('procesa el comando de opt-out sin encolar respuesta', async () => {
    await handleInboundMessage({
      isGroup: false,
      fromMe: false,
      phone: '51999000111',
      externalMessageId: 'MSG-2',
      content: 'DEJAR DE RECIBIR MENSAJES',
    });

    expect(prefsModel.optOut).toHaveBeenCalledWith(CUSTOMER.id);
    expect(queueModel.cancelPendingByCustomer).toHaveBeenCalledWith(CUSTOMER.id);
    expect(queueModel.enqueue).not.toHaveBeenCalled();
  });

  test('no encola respuesta si el cliente esta en opt-out', async () => {
    prefsModel.ensureForCustomer.mockResolvedValueOnce({ opted_out: true, opted_in: false });

    await handleInboundMessage({
      isGroup: false,
      fromMe: false,
      phone: '51999000111',
      externalMessageId: 'MSG-3',
      content: 'Hola de nuevo',
    });

    expect(queueModel.enqueue).not.toHaveBeenCalled();
  });
});
