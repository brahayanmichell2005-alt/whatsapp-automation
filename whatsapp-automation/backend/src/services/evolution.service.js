const axios = require('axios');

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function extractErrorMessage(error) {
  const data = error?.response?.data;

  if (typeof data === 'string' && data.trim()) {
    return data.trim();
  }

  if (Array.isArray(data?.message)) {
    return data.message.join(', ');
  }

  if (typeof data?.message === 'string') {
    return data.message;
  }

  if (typeof data?.error === 'string') {
    return data.error;
  }

  return error?.message || 'Error desconocido en Evolution API';
}

function normalizeQr(data) {
  const root = data?.data ?? data?.response ?? data ?? {};

  const qrData =
    root?.qrcode ??
    root?.qrCode ??
    {};

  return {
    base64:
      qrData?.base64 ??
      root?.base64 ??
      null,

    code:
      qrData?.code ??
      root?.code ??
      null,

    pairingCode:
      qrData?.pairingCode ??
      root?.pairingCode ??
      null
  };
}

function extractStatus(data) {
  const root = data?.data ?? data?.response ?? data ?? {};

  return (
    root?.instance?.state ??
    root?.instance?.status ??
    root?.state ??
    root?.status ??
    null
  );
}

class EvolutionService {
  constructor() {
    this.baseUrl = normalizeBaseUrl(process.env.EVOLUTION_API_URL);
    this.apiKey = String(process.env.EVOLUTION_API_KEY || '').trim();
    this.instance = String(process.env.EVOLUTION_INSTANCE || '').trim();

    if (!this.baseUrl) {
      throw new Error('EVOLUTION_API_URL no esta configurado');
    }

    if (!this.apiKey) {
      throw new Error('EVOLUTION_API_KEY no esta configurado');
    }

    if (!this.instance) {
      throw new Error('EVOLUTION_INSTANCE no esta configurado');
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 20000,
      headers: {
        apikey: this.apiKey,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Genera/obtiene el QR de la instancia.
   *
   * Flujo:
   * 1. Intenta GET /instance/connect/{instance}
   * 2. Si la instancia no existe:
   *    - POST /instance/create
   *    - integration = WHATSAPP-BAILEYS
   *    - qrcode = true
   * 3. Si create devuelve el QR, lo retorna.
   * 4. Si no devuelve QR, vuelve a GET /instance/connect/{instance}
   */
  async getQrCode() {
    const encodedInstance = encodeURIComponent(this.instance);

    // PRIMER INTENTO:
    // Ruta correcta para Evolution API 2.3.7.
    try {
      const response = await this.client.get(
        `/instance/connect/${encodedInstance}`
      );

      return this.buildQrResult(response.data, false);
    } catch (error) {
      const status = error?.response?.status;
      const message = extractErrorMessage(error);

      const instanceMissing =
        status === 404 ||
        (
          status === 400 &&
          /instance.*does not exist|does not exist.*instance|instancia.*no existe/i.test(
            message
          )
        );

      // No ocultar errores de autenticación, servidor,
      // configuración o problemas de red.
      if (!instanceMissing) {
        throw this.createServiceError(
          error,
          'No se pudo solicitar el QR a Evolution API'
        );
      }
    }

    // SEGUNDO PASO:
    // La instancia no existe → crearla automáticamente.
    const createResult = await this.createInstance();

    const directQr = normalizeQr(createResult);

    // En Evolution API con qrcode=true,
    // el QR puede venir directamente en la respuesta de creación.
    if (
      directQr.base64 ||
      directQr.code ||
      directQr.pairingCode
    ) {
      return {
        success: true,
        instance: this.instance,
        created: true,
        status: extractStatus(createResult) || 'connecting',
        qrcode: directQr,
        base64: directQr.base64,
        code: directQr.code,
        pairingCode: directQr.pairingCode
      };
    }

    // TERCER PASO:
    // Si la creación no devolvió QR, solicitarlo mediante connect.
    try {
      const response = await this.client.get(
        `/instance/connect/${encodedInstance}`
      );

      return this.buildQrResult(response.data, true);
    } catch (error) {
      throw this.createServiceError(
        error,
        'La instancia fue creada, pero Evolution API no devolvio el QR'
      );
    }
  }

  /**
   * Crea la instancia automáticamente.
   */
  async createInstance() {
    try {
      const response = await this.client.post(
        '/instance/create',
        {
          instanceName: this.instance,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true
        }
      );

      return response.data;
    } catch (error) {
      const status = error?.response?.status;
      const message = extractErrorMessage(error);

      // Otro proceso pudo haberla creado entre
      // el primer GET y este POST.
      if (
        status === 409 ||
        /already exists|ya existe|existe/i.test(message)
      ) {
        return {
          instance: {
            instanceName: this.instance,
            status: 'already_exists'
          }
        };
      }

      throw this.createServiceError(
        error,
        'No se pudo crear la instancia en Evolution API'
      );
    }
  }

  /**
   * Consulta el estado de la instancia.
   */
  async getInstanceStatus() {
    const encodedInstance = encodeURIComponent(this.instance);

    try {
      const response = await this.client.get(
        `/instance/connectionState/${encodedInstance}`
      );

      return {
        success: true,
        instance: this.instance,
        status: extractStatus(response.data) || 'unknown',
        data: response.data
      };
    } catch (error) {
      throw this.createServiceError(
        error,
        'No se pudo consultar el estado de Evolution API'
      );
    }
  }

  /**
   * Lista las instancias.
   */
  async fetchInstances() {
    try {
      const response = await this.client.get(
        '/instance/fetchInstances'
      );

      return response.data;
    } catch (error) {
      throw this.createServiceError(
        error,
        'No se pudieron consultar las instancias de Evolution API'
      );
    }
  }

  /**
   * Convierte la respuesta de Evolution
   * en una respuesta estable para tu backend.
   */
  buildQrResult(data, created) {
    const qr = normalizeQr(data);

    return {
      success: true,
      instance: this.instance,
      created,
      status:
        extractStatus(data) ||
        (qr.base64 ? 'connecting' : 'unknown'),

      qrcode: qr,

      // Compatibilidad con frontend existentes
      base64: qr.base64,
      code: qr.code,
      pairingCode: qr.pairingCode
    };
  }

  /**
   * Error controlado sin exponer credenciales.
   */
  createServiceError(error, fallbackMessage) {
    const serviceError = new Error(fallbackMessage);

    serviceError.status =
      error?.response?.status || 502;

    serviceError.code =
      error?.code || 'EVOLUTION_API_ERROR';

    serviceError.details =
      extractErrorMessage(error);

    return serviceError;
  }
}

module.exports = new EvolutionService();
module.exports.EvolutionService = EvolutionService;