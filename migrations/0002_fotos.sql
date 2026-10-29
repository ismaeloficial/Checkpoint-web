-- Foto de perfil de cada uno (opcional): la que quiera, no tiene que ser suya. La app la manda pequeña (256 px) y
-- solo la ven los de sus grupos. `version` cambia con cada foto nueva, para que la app sepa cuándo volver a bajarla.
CREATE TABLE IF NOT EXISTS fotos (
  usuario_id TEXT PRIMARY KEY REFERENCES usuarios(id),
  -- La imagen (JPEG o PNG) en base64.
  datos TEXT NOT NULL,
  tipo TEXT NOT NULL,
  version INTEGER NOT NULL
);
