// Servidor estatico minimo para previsualizar el panel localmente
// (solo sirve archivos, sin backend: las llamadas a /api fallan y se ve
// el layout con placeholders — suficiente para revisar el CSS).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"preview"}');
    return;
  }
  if (urlPath === '/') {
    // Inyecta token demo + simulador de API antes de que cargue app.js:
    // asi las vistas se renderizan completas sin backend real.
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(
      '<head>',
      `<head><script>
        try { localStorage.setItem('wa_admin_token', 'preview-token'); } catch (e) {}
        (function () {
          var realFetch = window.fetch;
          var LIST_RE = '(customers|conversations|messages|queue|scheduled-messages|reservations|logs|products|campaigns|bot-rules|instances|follow-ups|automation($|\\?))';
          function fakeBody(u) {
            var coord = u + ' ';
            if (coord.indexOf('/api/dashboard/stats') !== -1) {
              return {
                totals: { sent: 1284, received: 964, responseRate: 92 },
                activeChats24h: 37,
                contactsActive: 642,
                queuePending: 0,
                week: [
                  { day: '2026-11-02', sent: 41, received: 30 },
                  { day: '2026-11-03', sent: 55, received: 48 },
                  { day: '2026-11-04', sent: 38, received: 66 },
                  { day: '2026-11-05', sent: 72, received: 51 }
                ]
              };
            }
            if (coord.indexOf('/api/reservations') !== -1) {
              return [
                { id: 1, customer_id: 7, customer_name: 'María García', phone: '521999000111', date_text: 'jueves 5 de noviembre de 2026', time_text: '5:00 p. m.', start_at: '2026-11-05T22:00:00.000Z', status: 'CONFIRMED' },
                { id: 2, customer_id: 8, customer_name: 'Joel Ramírez', phone: '521999000112', date_text: 'viernes 6 de noviembre de 2026', time_text: '10:00 a. m.', start_at: '2026-11-06T16:00:00.000Z', status: 'CONFIRMED' },
                { id: 3, customer_id: 9, customer_name: 'Ana Paredes', phone: '521999000113', date_text: 'lunes 9 de noviembre de 2026', time_text: '3:30 p. m.', start_at: '2026-11-09T20:30:00.000Z', status: 'CANCELLED' }
              ];
            }
            return new RegExp('(' + LIST_RE + ')').test(coord) ? [] : {};
          }
          window.fetch = function (url, opts) {
            var u = String(url || '');
            if (u.indexOf('/api/') !== -1) {
              return Promise.resolve(new Response(JSON.stringify(fakeBody(u)), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }));
            }
            return realFetch(url, opts);
          };
        })();
      </` + `script>`
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(urlPath).replace(/^\/+/, ''));
  if (file.includes('..') || !fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(8090, () => console.log('preview http://localhost:8090'));
