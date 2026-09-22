Las pruebas automatizadas del backend viven en `backend/tests/`
(Jest + Supertest), para poder ejecutarse con `npm test` desde esa carpeta
o con `docker compose exec backend npm test`. Esta carpeta en la raiz se
deja reservada por si en el futuro se agregan pruebas end-to-end que
abarquen varios servicios a la vez.
