# 💬 Plantillas del CRM Bot (WhatsApp)

Estas son las plantillas que **tu bot ya usa hoy**, tal como están programadas en
`backend/src/services/rules.service.js`, más **versiones mejoradas listas para tu presentación**.

---

## 1. Cómo funciona tu bot ahora mismo

Cuando llega un mensaje, el bot lo clasifica por **palabras clave**:

| Tipo | Palabras clave que lo activan | Nivel de interés |
|---|---|---|
| **PRODUCTO** | comprar, precio, costo, cuanto cuesta, laptop, producto, stock, disponible, catalogo, modelo, garantia | ALTO |
| **SERVICIO** | servicio, soporte, reparacion, mantenimiento, instalacion, consulta, ayuda, problema, falla, reclamo | ALTO |
| **INDECISO** | (ninguna de las anteriores) | BAJO |

Las acentos no importan (el bot los ignora): "reparación" = "reparacion". ✅

---

## 2. Plantillas ACTUALES (las que están en producción)

### 🛒 PRODUCTO (cuando preguntan por comprar algo)
```
Hola, gracias por tu interes. Un asesor te contactara en breve con informacion de precios y disponibilidad.
```
*Si conocemos el nombre del cliente, dice `Hola [Nombre]` automáticamente.*

### 🔧 SERVICIO (cuando piden soporte/reparación)
```
Hola, gracias por contactarnos. Hemos registrado tu consulta de servicio y te responderemos a la brevedad.
```

### 🤷 INDECISO (mensaje genérico o saludo)
```
Hola, gracias por escribirnos. Cuentanos un poco mas: ¿buscas informacion sobre un producto o un servicio?
```

---

## 3. Comandos de alta/baja (opt-in / opt-out)

El cliente puede escribir estos mensajes **exactos** y el bot los respeta:

| Para DEJAR de recibir mensajes | Para VOLVER a recibir |
|---|---|
| `stop` · `baja` · `cancelar` · `salir` | `start` · `alta` · `suscribirme` · `suscribir` |
| `no molestar` · `dejar de recibir mensajes` | `quiero recibir mensajes` |
| `no quiero recibir mensajes` · `unsubscribe` | |

---

## 4. Plantillas MEJORADAS (listas para copiar y usar)

> Estas son más profesionales. Puedo dejarlas programadas en el bot cuando me digas
> qué vendes (ver paso 5 abajo).

### Bienvenida (primer mensaje del cliente)
```
👋 ¡Hola {nombre}! Gracias por escribirnos a {negocio}.

Soy tu asistente virtual y puedo ayudarte con:
🛍️ Información de productos y precios
🔧 Servicios técnicos y soporte
📦 Estado de tu pedido

Escríbenos lo que necesitas y te respondemos al instante.
```

### PRODUCTO — interés alto
```
🛒 ¡Hola {nombre}! Vi que te interesa {producto}.

Tenemos stock disponible ✅ y puedo ayudarte con:
• Precios y promociones del mes
• Formas de pago (efectivo, tarjeta, transferencia)
• Envío a domicilio

Un asesor te escribirá en los próximos minutos para cerrar tu compra. ¡Gracias por elegirnos!
```

### PRODUCTO — sin stock
```
Hola {nombre}, gracias por tu interés 😊

Justo ahora {producto} está agotado, pero podemos:
1️⃣ Apartarte el próximo que llegue
2️⃣ Ofrecerte una alternativa similar al mismo precio

¿Te aviso cuando entre nuevo stock?
```

### SERVICIO — solicitud recibida
```
🔧 Hola {nombre}, registramos tu solicitud de {tipo_servicio}.

📌 Detalle: {descripcion}
🎫 N° de ticket: {ticket}
⏱️ Tiempo estimado de respuesta: {tiempo}

Te avisaremos por aquí en cuanto un técnico tome tu caso. ¡Gracias por confiar en nosotros!
```

### SERVICIO — seguimiento
```
Hola {nombre} 👋, ¿cómo va todo con tu {servicio}?

Si necesitas ayuda adicional o quieres agendar mantenimiento, solo escríbenos. Estamos para ayudarte.
```

### INDECISO — guía suave
```
¡Hola {nombre}! 😊 Cuéntame un poco más para ayudarte mejor:

1️⃣ ¿Buscas comprar algo? → dime el producto
2️⃣ ¿Necesitas un servicio? → reparación, instalación o soporte
3️⃣ ¿Solo información? → te envío nuestro catálogo

Responde con 1, 2 o 3 y seguimos 🚀
```

### Fuera de horario
```
🌙 Hola {nombre}, gracias por escribir a {negocio}.

Nuestro horario de atención es:
📅 Lunes a viernes: {horario}
🥳 Sábados: {horario_sabado}

Tu mensaje quedó registrado y te respondemos primero cosa al abrir. ¡Gracias!
```

### Agradecimiento / cierre de venta
```
🎉 ¡Gracias por tu compra, {nombre}!

Tu pedido {pedido} quedó confirmado. Si necesitas soporte o tienes alguna duda, escríbenos cuando quieras.

¡Que disfrutes tu {producto}! 🛍️
```

### Campaña programada (envío masivo desde el panel)
```
¡Hola {nombre}! 👋

Tenemos una promoción especial para ti esta semana:
🔥 {oferta}

Válido hasta {fecha}. Responde QUIERO y te damos los detalles. Si prefieres no recibir más mensajes, escribe BAJA.
```

---

## 5. ¿Quieres que las deje programadas en el bot?

Solo dime:
1. **¿Qué vendes o qué servicio ofreces?** (ej: celulares, ropa, computadoras, reparaciones…)
2. **Nombre de tu negocio** (para las plantillas)
3. **Horario de atención** (si quieres la plantilla de fuera de horario)

Con eso actualizo `rules.service.js` con tus palabras clave y textos, haces push a GitHub
y Vercel redespliega solo. **El bot quedará personalizado para tu presentación.** 🚀
