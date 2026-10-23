# MiCierro CRM para WhatsApp Web

Extensión Chrome Manifest V3 independiente. Inyecta una interfaz CRM lateral en `web.whatsapp.com` y deja WhatsApp Web como la superficie principal de mensajería.

## Instalar en Chrome

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar extensión sin empaquetar** y selecciona esta carpeta `chrome-extension`.
4. Pulsa el icono de MiCierro y luego **Conectar WhatsApp**. Si WhatsApp Web no tiene sesión, la página oficial mostrará su QR; escanéalo desde WhatsApp en el teléfono.
5. Abre una conversación. Pulsa el botón flotante verde con la **M** para abrir la ficha CRM.

## Funciones disponibles

- Panel lateral integrado con acceso a la conversación actual y a la lista de fichas guardadas.
- Estados de cliente: Nuevo, Interesado, Cliente y Seguimiento.
- Etiquetas, notas privadas y fecha del siguiente seguimiento.
- Búsqueda local por nombre, teléfono o etiqueta.
- Almacenamiento privado del navegador mediante `chrome.storage.local`.
- Respuestas automáticas opcionales mediante el backend autenticado del proyecto. Permanecen apagadas hasta que el usuario las active en la pestaña **Respuestas**.

## Arquitectura y límites actuales

- `popup.*` abre o enfoca WhatsApp Web y permite conectar la URL del backend con el inicio de sesión del panel. La contraseña se usa solo para iniciar sesión y se descarta; la extensión guarda el token de sesión temporal. `background.js` solicita respuestas a la API autenticada, y `content.js` monta el CRM en un Shadow DOM y puede enviar la respuesta en la conversación abierta cuando la automatización está activada.
- Antes de enviar una respuesta, la extensión comparte el historial visible reciente con el backend configurado. No se transmiten mensajes cuando la opción de respuesta automática está apagada.
- Para conectar la API se necesita un backend en ejecución o desplegado, acceso de administrador al panel y una base de datos configurada. Define `AI_PROVIDER` y su clave en el servidor para respuestas generativas; con `AI_PROVIDER=none` el backend devuelve respuestas breves basadas en reglas. Nunca pongas la clave de IA en la extensión.
- La extensión no lee ni automatiza el contenido de los mensajes y no altera el compositor de WhatsApp. El título y teléfono se detectan desde el encabezado visible de la conversación; WhatsApp puede no exponer el número para todos los contactos.
- El QR de WhatsApp Web debe ser generado y validado por la propia página oficial. El endpoint QR del backend actual pertenece a Evolution API/Baileys y vincula una sesión de servidor separada; no sirve para iniciar la sesión de WhatsApp Web del navegador. El panel web existente y la extensión, por tanto, no comparten ese QR ni la sesión.
- Los datos CRM aún no se sincronizan con la API/PostgreSQL existente. Son locales a este perfil Chrome; sincronización multiusuario, etiquetas en el backend y seguimiento persistente en el servidor quedan para una integración posterior con autenticación y endpoints específicos.
- El envío usa el cuadro de composición de WhatsApp Web y sus controles de página; una actualización de WhatsApp puede cambiar los selectores. Revisa el envío con un chat de prueba antes de activar respuestas en producción.

## Desarrollo

No requiere dependencias ni proceso de compilación. Después de editar los archivos, pulsa **Recargar** en `chrome://extensions` y recarga WhatsApp Web.
