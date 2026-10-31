-- Foto de cada grupo (opcional; si no tiene, la app enseña su emoji o el dibujo de un grupo sin foto). La pone o la
-- cambia cualquiera del grupo y la ven sus miembros y quien tiene el enlace. Como la de perfil: pequeña y con versión.
CREATE TABLE IF NOT EXISTS fotos_grupos (
  grupo_id TEXT PRIMARY KEY REFERENCES grupos(id),
  -- La imagen (JPEG o PNG) en base64.
  datos TEXT NOT NULL,
  tipo TEXT NOT NULL,
  version INTEGER NOT NULL
);
