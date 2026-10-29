-- Grupos de Checkpoint: quién es cada uno (su ID de usuario), los grupos, sus miembros, los gastos y la parte de
-- cada uno. Las deudas no se guardan: se calculan siempre de las partes sin saldar.
-- Fechas en milisegundos desde 1970. Importes en céntimos.

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  -- Huella (SHA-256) de la clave secreta de su instalación: con ella se comprueba que es él.
  clave_hash TEXT NOT NULL,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL DEFAULT '',
  creado INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grupos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  creado INTEGER NOT NULL,
  creado_por TEXT NOT NULL REFERENCES usuarios(id),
  -- Código del enlace de invitación (checkpoint.iarg.dev/g/<código>).
  invitacion TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS miembros (
  grupo_id TEXT NOT NULL REFERENCES grupos(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  entrada INTEGER NOT NULL,
  -- Cuándo lo abandonó (NULL = sigue dentro).
  salida INTEGER,
  -- Archivado por él (cada uno el suyo, a mano).
  archivado INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (grupo_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS gastos (
  id TEXT PRIMARY KEY,
  grupo_id TEXT NOT NULL REFERENCES grupos(id),
  -- Siempre quien lo apunta: cada uno solo apunta lo que paga él.
  pagador TEXT NOT NULL REFERENCES usuarios(id),
  concepto TEXT NOT NULL,
  centimos INTEGER NOT NULL CHECK (centimos > 0),
  reparto TEXT NOT NULL CHECK (reparto IN ('iguales', 'exactas', 'partes')),
  fecha INTEGER NOT NULL,
  editado INTEGER
);
CREATE INDEX IF NOT EXISTS gastos_por_grupo ON gastos(grupo_id);

CREATE TABLE IF NOT EXISTS partes (
  id TEXT PRIMARY KEY,
  gasto_id TEXT NOT NULL REFERENCES gastos(id) ON DELETE CASCADE,
  deudor TEXT NOT NULL REFERENCES usuarios(id),
  centimos INTEGER NOT NULL CHECK (centimos >= 0),
  peso INTEGER,
  -- Quién la marcó como pagada (el que debía o el que cobró) y cuándo.
  saldada_por TEXT REFERENCES usuarios(id),
  saldada_en INTEGER
);
CREATE INDEX IF NOT EXISTS partes_por_gasto ON partes(gasto_id);

-- Partes saldadas cuyo dinero ya movió la app de cada uno a su bolsillo (para no moverlo dos veces si tiene
-- iPhone y Mac).
CREATE TABLE IF NOT EXISTS aplicados (
  parte_id TEXT NOT NULL REFERENCES partes(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  PRIMARY KEY (parte_id, usuario_id)
);
