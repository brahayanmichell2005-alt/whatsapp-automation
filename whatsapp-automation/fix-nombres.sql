-- Opcional: limpia nombres de relleno para que el bot los complete en el proximo mensaje
UPDATE customers SET name = NULL WHERE name IS NOT NULL AND name !~ '[[:alpha:]]';
