-- Para entrar en un grupo con su enlace hay que pedirlo: quien lo administra (quien lo creó o, si se fue, el miembro
-- más antiguo) acepta o rechaza. Mientras, quien lo pidió no ve nada del grupo.
CREATE TABLE IF NOT EXISTS solicitudes (
  grupo_id TEXT NOT NULL REFERENCES grupos(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  creada INTEGER NOT NULL,
  PRIMARY KEY (grupo_id, usuario_id)
);

-- Los dispositivos de cada uno a los que mandar avisos (notificaciones de Apple): su token y si es de pruebas
-- (sandbox, lo que se instala desde Xcode) o de verdad (TestFlight y App Store).
CREATE TABLE IF NOT EXISTS dispositivos (
  token TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  entorno TEXT NOT NULL,
  actualizado INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dispositivos_por_usuario ON dispositivos(usuario_id);
