// El servidor de los grupos de Checkpoint (Cloudflare Pages Functions + base de datos D1), en /api.
//
// No hay cuentas ni contraseñas: cada instalación de la app tiene un ID de usuario y una clave secreta que se
// inventa ella misma. Con cada petición manda las dos (cabeceras X-Checkpoint-Usuario y Authorization: Bearer) y
// aquí se comprueba la clave contra su huella. Todas las reglas se comprueban aquí, aunque la app ya las cumpla:
// cada uno solo apunta lo que paga él, solo salda lo suyo (o lo que le deben a él), solo cambia o borra sus gastos
// mientras nadie haya pagado, y no puede abandonar un grupo con cuentas pendientes.

// Lo mínimo de D1 que se usa (los tipos completos están en @cloudflare/workers-types).
type Fila = Record<string, any>;
interface Sentencia {
  bind(...valores: unknown[]): Sentencia;
  first<T = Fila>(): Promise<T | null>;
  all<T = Fila>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
interface BaseDatos {
  prepare(sql: string): Sentencia;
  batch<T = Fila>(sentencias: Sentencia[]): Promise<{ results: T[]; meta: { changes: number } }[]>;
}
interface Env {
  DB: BaseDatos;
}
interface Contexto {
  request: Request;
  env: Env;
  params: { ruta?: string | string[] };
}

const WEB = "https://checkpoint.iarg.dev";
const MAX_IMPORTE = 10_000_000; // 100.000 €
const MAX_MIEMBROS = 50;
const MAX_CUERPO = 100_000;
const MAX_FOTO = 300_000;
const REPARTOS = ["iguales", "exactas", "partes"];
const NO_ABANDONAR = "No puedes abandonar el grupo hasta que tus cuentas estén saldadas.";

/** Un error que se le enseña a la persona tal cual. */
class Fallo extends Error {
  constructor(public estado: number, mensaje: string) {
    super(mensaje);
  }
}

export const onRequest = async (ctx: Contexto): Promise<Response> => {
  try {
    const ruta = Array.isArray(ctx.params.ruta) ? ctx.params.ruta : ctx.params.ruta ? [ctx.params.ruta] : [];
    return await atender(ctx.request.method, ruta, ctx);
  } catch (e) {
    if (e instanceof Fallo) return json({ error: e.message }, e.estado);
    console.error(e);
    return json({ error: "Algo ha fallado en el servidor. Prueba otra vez en un rato." }, 500);
  }
};

async function atender(metodo: string, ruta: string[], ctx: Contexto): Promise<Response> {
  const db = ctx.env.DB;
  const [a, b, c, d] = ruta;

  if (ruta.length === 0 && metodo === "GET") return json({ servicio: "checkpoint", version: 1 });
  if (a === "yo" && ruta.length === 1 && metodo === "PUT") return registrar(ctx);

  const yo = await identificar(ctx);
  // La foto va tal cual (no en JSON).
  if (a === "yo" && b === "foto" && ruta.length === 2) {
    if (metodo === "PUT") return json(await subirFoto(db, yo.id, ctx.request));
    if (metodo === "DELETE") return json(await borrarFoto(db, yo.id));
  }
  if (a === "fotos" && ruta.length === 2 && metodo === "GET") return verFoto(db, b, yo.id);
  const cuerpo = metodo === "GET" || metodo === "DELETE" ? {} : await leerJSON(ctx.request);

  if (a === "grupos") {
    if (ruta.length === 1 && metodo === "GET") return json(await misGrupos(db, yo.id));
    if (ruta.length === 1 && metodo === "POST") return json(await crearGrupo(db, yo.id, cuerpo), 201);
    if (ruta.length === 2 && metodo === "GET") return json(await grupoPara(db, b, yo.id));
    if (ruta.length === 2 && metodo === "PATCH") return json(await cambiarGrupo(db, b, yo.id, cuerpo));
    if (ruta.length === 3 && c === "invitacion" && metodo === "POST") return json(await invitacion(db, b, yo.id));
    if (ruta.length === 3 && c === "archivar" && metodo === "POST") return json(await archivar(db, b, yo.id, cuerpo));
    if (ruta.length === 3 && c === "abandonar" && metodo === "POST") return json(await abandonar(db, b, yo.id));
    if (ruta.length === 5 && c === "miembros" && ruta[4] === "quitar" && metodo === "POST") return json(await quitar(db, b, d, yo.id));
    if (ruta.length === 3 && c === "saldar" && metodo === "POST") return json(await saldar(db, b, yo.id, cuerpo));
    if (ruta.length === 3 && c === "gastos" && metodo === "POST") return json(await nuevoGasto(db, b, yo.id, cuerpo), 201);
    if (ruta.length === 4 && c === "gastos" && metodo === "PUT") return json(await cambiarGasto(db, b, d, yo.id, cuerpo));
    if (ruta.length === 4 && c === "gastos" && metodo === "DELETE") return json(await borrarGasto(db, b, d, yo.id));
  }
  if (a === "invitaciones" && ruta.length === 2) {
    if (metodo === "GET") return json(await verInvitacion(db, b, yo.id));
    if (metodo === "POST") return json(await unirse(db, b, yo.id));
  }
  if (a === "aplicados" && ruta.length === 1 && metodo === "POST") return json(await aplicados(db, yo.id, cuerpo));

  throw new Fallo(404, "No existe.");
}

// MARK: - Quién eres

/** Alta (la primera vez) o cambio de nombre. Crea el usuario con la huella de su clave; luego solo con esa clave. */
async function registrar(ctx: Contexto): Promise<Response> {
  const { id, clave } = credenciales(ctx.request);
  if (clave.length < 32) throw new Fallo(400, "La clave de la instalación no es válida.");
  const cuerpo = await leerJSON(ctx.request);
  const nombre = texto(cuerpo.nombre, "El nombre", 60);
  const apellido = texto(cuerpo.apellido ?? "", "El apellido", 60, true);
  const db = ctx.env.DB;
  const huellaClave = await huella(clave);
  const existente = await db.prepare("SELECT clave_hash FROM usuarios WHERE id = ?").bind(id).first();
  if (existente && existente.clave_hash !== huellaClave) throw new Fallo(401, "Ese usuario ya existe con otra clave.");
  if (existente) {
    await db.prepare("UPDATE usuarios SET nombre = ?, apellido = ? WHERE id = ?").bind(nombre, apellido, id).run();
  } else {
    await db.prepare("INSERT INTO usuarios (id, clave_hash, nombre, apellido, creado) VALUES (?, ?, ?, ?, ?)")
      .bind(id, huellaClave, nombre, apellido, Date.now()).run();
  }
  return json({ id, nombre, apellido });
}

async function identificar(ctx: Contexto): Promise<{ id: string; nombre: string; apellido: string }> {
  const { id, clave } = credenciales(ctx.request);
  const fila = await ctx.env.DB.prepare("SELECT id, nombre, apellido, clave_hash FROM usuarios WHERE id = ?").bind(id).first();
  if (!fila || fila.clave_hash !== (await huella(clave))) {
    throw new Fallo(401, "No te reconozco. Abre Checkpoint con conexión para volver a registrarte.");
  }
  return { id: fila.id, nombre: fila.nombre, apellido: fila.apellido };
}

function credenciales(request: Request): { id: string; clave: string } {
  const id = (request.headers.get("X-Checkpoint-Usuario") ?? "").toLowerCase();
  const autorizacion = request.headers.get("Authorization") ?? "";
  if (!esUUID(id) || !autorizacion.startsWith("Bearer ")) throw new Fallo(401, "Falta tu identificación.");
  return { id, clave: autorizacion.slice(7) };
}

// MARK: - Grupos

async function misGrupos(db: BaseDatos, yo: string): Promise<Fila[]> {
  const { results } = await db.prepare(
    "SELECT grupo_id FROM miembros WHERE usuario_id = ? AND salida IS NULL ORDER BY entrada"
  ).bind(yo).all();
  return Promise.all(results.map((f) => grupoCompleto(db, f.grupo_id, yo)));
}

async function crearGrupo(db: BaseDatos, yo: string, cuerpo: Fila): Promise<Fila> {
  const id = cuerpo.id === undefined ? crypto.randomUUID() : uuid(cuerpo.id, "El grupo");
  const nombre = texto(cuerpo.nombre, "El nombre del grupo", 60);
  const emoji = texto(cuerpo.emoji ?? "", "El emoji", 16, true);
  const ya = await db.prepare("SELECT creado_por FROM grupos WHERE id = ?").bind(id).first();
  if (ya) {
    // El mismo grupo enviado dos veces (sin conexión, reintentos): no se duplica.
    if (ya.creado_por !== yo) throw new Fallo(409, "Ese grupo ya existe.");
    return grupoCompleto(db, id, yo);
  }
  const ahora = Date.now();
  await db.batch([
    db.prepare("INSERT INTO grupos (id, nombre, emoji, creado, creado_por) VALUES (?, ?, ?, ?, ?)").bind(id, nombre, emoji, ahora, yo),
    db.prepare("INSERT INTO miembros (grupo_id, usuario_id, entrada) VALUES (?, ?, ?)").bind(id, yo, ahora),
  ]);
  return grupoCompleto(db, id, yo);
}

async function grupoPara(db: BaseDatos, grupo: string, yo: string): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  return grupoCompleto(db, grupo, yo);
}

async function cambiarGrupo(db: BaseDatos, grupo: string, yo: string, cuerpo: Fila): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  if (cuerpo.nombre !== undefined) {
    await db.prepare("UPDATE grupos SET nombre = ? WHERE id = ?").bind(texto(cuerpo.nombre, "El nombre del grupo", 60), grupo).run();
  }
  if (cuerpo.emoji !== undefined) {
    await db.prepare("UPDATE grupos SET emoji = ? WHERE id = ?").bind(texto(cuerpo.emoji, "El emoji", 16, true), grupo).run();
  }
  return grupoCompleto(db, grupo, yo);
}

/** Archivar o desarchivar: solo para ti, y siempre a mano (nunca se archiva solo). */
async function archivar(db: BaseDatos, grupo: string, yo: string, cuerpo: Fila): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  await db.prepare("UPDATE miembros SET archivado = ? WHERE grupo_id = ? AND usuario_id = ?")
    .bind(cuerpo.archivado === false ? 0 : 1, grupo, yo).run();
  return grupoCompleto(db, grupo, yo);
}

/** Solo sin nada pendiente en ningún sentido: ni lo que debes ni lo que te deben. */
async function abandonar(db: BaseDatos, grupo: string, yo: string): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  if (await tienePendiente(db, grupo, yo)) throw new Fallo(409, NO_ABANDONAR);
  await db.prepare("UPDATE miembros SET salida = ? WHERE grupo_id = ? AND usuario_id = ?").bind(Date.now(), grupo, yo).run();
  return { abandonado: grupo };
}

/** Quien creó el grupo saca a otro, si no tiene nada pendiente (lo suyo sigue en el historial, como al abandonar). */
async function quitar(db: BaseDatos, grupo: string, otro: string, yo: string): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  const fila = await db.prepare("SELECT creado_por FROM grupos WHERE id = ?").bind(grupo).first();
  if (fila?.creado_por !== yo) throw new Fallo(403, "Solo quien creó el grupo puede quitar a alguien.");
  if (otro === yo) throw new Fallo(400, "Para salir tú, abandona el grupo.");
  const suyo = await db.prepare("SELECT salida FROM miembros WHERE grupo_id = ? AND usuario_id = ?").bind(grupo, otro).first();
  if (!suyo || suyo.salida !== null) throw new Fallo(404, "No está en el grupo.");
  if (await tienePendiente(db, grupo, otro)) throw new Fallo(409, "No se puede quitar a alguien con cuentas pendientes en el grupo.");
  await db.prepare("UPDATE miembros SET salida = ? WHERE grupo_id = ? AND usuario_id = ?").bind(Date.now(), grupo, otro).run();
  return grupoCompleto(db, grupo, yo);
}

/** Si alguien debe o le deben algo en el grupo. */
async function tienePendiente(db: BaseDatos, grupo: string, quien: string): Promise<boolean> {
  const pendientes = await db.prepare(
    `SELECT COUNT(*) AS n FROM partes p JOIN gastos g ON g.id = p.gasto_id
     WHERE g.grupo_id = ? AND p.saldada_en IS NULL AND p.deudor != g.pagador AND (p.deudor = ? OR g.pagador = ?)`
  ).bind(grupo, quien, quien).first();
  return (pendientes?.n ?? 0) > 0;
}

// MARK: - Fotos

/** La foto de perfil, tal cual (JPEG o PNG, pequeña). Devuelve su versión nueva. */
async function subirFoto(db: BaseDatos, yo: string, request: Request): Promise<Fila> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_FOTO) throw new Fallo(413, "La foto es demasiado grande.");
  const esJPEG = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const esPNG = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!esJPEG && !esPNG) throw new Fallo(415, "La foto tiene que ser JPEG o PNG.");
  let binario = "";
  for (let k = 0; k < bytes.length; k += 0x8000) binario += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  const version = Date.now();
  await db.prepare(
    `INSERT INTO fotos (usuario_id, datos, tipo, version) VALUES (?, ?, ?, ?)
     ON CONFLICT(usuario_id) DO UPDATE SET datos = excluded.datos, tipo = excluded.tipo, version = excluded.version`
  ).bind(yo, btoa(binario), esJPEG ? "image/jpeg" : "image/png", version).run();
  return { version };
}

async function borrarFoto(db: BaseDatos, yo: string): Promise<Fila> {
  await db.prepare("DELETE FROM fotos WHERE usuario_id = ?").bind(yo).run();
  return { version: null };
}

/** La foto de alguien: solo para él mismo y para quien comparte (o compartió) algún grupo con él. */
async function verFoto(db: BaseDatos, usuario: string, yo: string): Promise<Response> {
  if (usuario !== yo) {
    const comparten = await db.prepare(
      `SELECT 1 FROM miembros a JOIN miembros b ON a.grupo_id = b.grupo_id WHERE a.usuario_id = ? AND b.usuario_id = ? LIMIT 1`
    ).bind(yo, usuario).first();
    if (!comparten) throw new Fallo(404, "No existe.");
  }
  const foto = await db.prepare("SELECT datos, tipo, version FROM fotos WHERE usuario_id = ?").bind(usuario).first();
  if (!foto) throw new Fallo(404, "No tiene foto.");
  const binario = atob(foto.datos);
  const bytes = new Uint8Array(binario.length);
  for (let k = 0; k < binario.length; k++) bytes[k] = binario.charCodeAt(k);
  return new Response(bytes, {
    headers: { "Content-Type": foto.tipo, "Cache-Control": "private, max-age=31536000", ETag: `"${foto.version}"` },
  });
}

// MARK: - Invitaciones

async function invitacion(db: BaseDatos, grupo: string, yo: string): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  let fila = await db.prepare("SELECT invitacion FROM grupos WHERE id = ?").bind(grupo).first();
  let codigo: string = fila?.invitacion;
  if (!codigo) {
    codigo = codigoAleatorio(12);
    await db.prepare("UPDATE grupos SET invitacion = ? WHERE id = ? AND invitacion IS NULL").bind(codigo, grupo).run();
    fila = await db.prepare("SELECT invitacion FROM grupos WHERE id = ?").bind(grupo).first();
    codigo = fila?.invitacion;
  }
  return { codigo, enlace: `${WEB}/g/${codigo}` };
}

async function verInvitacion(db: BaseDatos, codigo: string, yo: string): Promise<Fila> {
  const grupo = await grupoDeInvitacion(db, codigo);
  const { results } = await db.prepare(
    `SELECT u.id, u.nombre, u.apellido, f.version AS foto FROM miembros m JOIN usuarios u ON u.id = m.usuario_id
     LEFT JOIN fotos f ON f.usuario_id = u.id WHERE m.grupo_id = ? AND m.salida IS NULL ORDER BY m.entrada`
  ).bind(grupo.id).all();
  return {
    id: grupo.id,
    nombre: grupo.nombre,
    emoji: grupo.emoji,
    miembros: results.map((u) => ({
      id: u.id, nombre: u.nombre, apellido: u.apellido, dentro: true, ...(u.foto === null ? {} : { foto: u.foto }),
    })),
    yaEstas: results.some((u) => u.id === yo),
  };
}

async function unirse(db: BaseDatos, codigo: string, yo: string): Promise<Fila> {
  const grupo = await grupoDeInvitacion(db, codigo);
  const yaDentro = await db.prepare("SELECT salida FROM miembros WHERE grupo_id = ? AND usuario_id = ?").bind(grupo.id, yo).first();
  if (yaDentro && yaDentro.salida === null) return grupoCompleto(db, grupo.id, yo);
  const activos = await db.prepare("SELECT COUNT(*) AS n FROM miembros WHERE grupo_id = ? AND salida IS NULL").bind(grupo.id).first();
  if ((activos?.n ?? 0) >= MAX_MIEMBROS) throw new Fallo(409, "El grupo está completo.");
  if (yaDentro) {
    // Vuelve alguien que lo había abandonado.
    await db.prepare("UPDATE miembros SET salida = NULL, archivado = 0, entrada = ? WHERE grupo_id = ? AND usuario_id = ?")
      .bind(Date.now(), grupo.id, yo).run();
  } else {
    await db.prepare("INSERT INTO miembros (grupo_id, usuario_id, entrada) VALUES (?, ?, ?)").bind(grupo.id, yo, Date.now()).run();
  }
  return grupoCompleto(db, grupo.id, yo);
}

async function grupoDeInvitacion(db: BaseDatos, codigo: string): Promise<Fila> {
  if (!/^[A-Za-z0-9]{6,32}$/.test(codigo ?? "")) throw new Fallo(404, "La invitación no es válida.");
  const grupo = await db.prepare("SELECT id, nombre, emoji FROM grupos WHERE invitacion = ?").bind(codigo).first();
  if (!grupo) throw new Fallo(404, "La invitación no es válida o el grupo ya no existe.");
  return grupo;
}

// MARK: - Gastos

/** Lo apunta siempre quien lo paga. */
async function nuevoGasto(db: BaseDatos, grupo: string, yo: string, cuerpo: Fila): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  const id = uuid(cuerpo.id, "El gasto");
  const ya = await db.prepare("SELECT grupo_id FROM gastos WHERE id = ?").bind(id).first();
  if (ya) {
    // El mismo gasto enviado dos veces: no se duplica.
    if (ya.grupo_id !== grupo) throw new Fallo(409, "Ese gasto ya existe.");
    return grupoCompleto(db, grupo, yo);
  }
  const gasto = await validarGasto(db, grupo, yo, cuerpo);
  await db.batch([
    db.prepare("INSERT INTO gastos (id, grupo_id, pagador, concepto, centimos, reparto, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, grupo, yo, gasto.concepto, gasto.centimos, gasto.reparto, Date.now()),
    ...insertarPartes(db, id, gasto.partes),
  ]);
  return grupoCompleto(db, grupo, yo);
}

/** Solo quien lo apuntó, y solo si nadie ha saldado aún su parte. */
async function cambiarGasto(db: BaseDatos, grupo: string, idGasto: string, yo: string, cuerpo: Fila): Promise<Fila> {
  const id = uuid(idGasto, "El gasto");
  await miembroActivo(db, grupo, yo);
  await gastoCambiable(db, grupo, id, yo);
  const gasto = await validarGasto(db, grupo, yo, cuerpo);
  await db.batch([
    db.prepare("UPDATE gastos SET concepto = ?, centimos = ?, reparto = ?, editado = ? WHERE id = ?")
      .bind(gasto.concepto, gasto.centimos, gasto.reparto, Date.now(), id),
    db.prepare("DELETE FROM partes WHERE gasto_id = ?").bind(id),
    ...insertarPartes(db, id, gasto.partes),
  ]);
  return grupoCompleto(db, grupo, yo);
}

async function borrarGasto(db: BaseDatos, grupo: string, idGasto: string, yo: string): Promise<Fila> {
  const id = uuid(idGasto, "El gasto");
  await miembroActivo(db, grupo, yo);
  await gastoCambiable(db, grupo, id, yo);
  await db.batch([
    db.prepare("DELETE FROM partes WHERE gasto_id = ?").bind(id),
    db.prepare("DELETE FROM gastos WHERE id = ?").bind(id),
  ]);
  return grupoCompleto(db, grupo, yo);
}

async function gastoCambiable(db: BaseDatos, grupo: string, id: string, yo: string): Promise<void> {
  const gasto = await db.prepare("SELECT pagador FROM gastos WHERE id = ? AND grupo_id = ?").bind(id, grupo).first();
  if (!gasto) throw new Fallo(404, "Ese gasto ya no existe.");
  if (gasto.pagador !== yo) throw new Fallo(403, "Solo quien apuntó el gasto puede cambiarlo o borrarlo.");
  const saldadas = await db.prepare(
    "SELECT COUNT(*) AS n FROM partes WHERE gasto_id = ? AND saldada_en IS NOT NULL AND deudor != ?"
  ).bind(id, yo).first();
  if ((saldadas?.n ?? 0) > 0) throw new Fallo(409, "Alguien ya ha saldado su parte de este gasto: ya no se puede cambiar ni borrar.");
}

interface GastoValido {
  concepto: string;
  centimos: number;
  reparto: string;
  partes: { deudor: string; centimos: number; peso: number | null }[];
}

async function validarGasto(db: BaseDatos, grupo: string, yo: string, cuerpo: Fila): Promise<GastoValido> {
  const concepto = texto(cuerpo.concepto, "El concepto", 100);
  const centimos = entero(cuerpo.centimos, "El importe", 1, MAX_IMPORTE);
  const reparto = String(cuerpo.reparto ?? "");
  if (!REPARTOS.includes(reparto)) throw new Fallo(400, "La forma de repartir no es válida.");
  if (!Array.isArray(cuerpo.partes) || cuerpo.partes.length === 0 || cuerpo.partes.length > MAX_MIEMBROS) {
    throw new Fallo(400, "Elige entre quiénes se reparte.");
  }
  const { results } = await db.prepare("SELECT usuario_id FROM miembros WHERE grupo_id = ? AND salida IS NULL").bind(grupo).all();
  const activos = new Set(results.map((f) => f.usuario_id as string));
  const vistos = new Set<string>();
  const partes = cuerpo.partes.map((p: Fila) => {
    const deudor = String(p?.deudor ?? "").toLowerCase();
    if (!activos.has(deudor)) throw new Fallo(400, "Alguien del reparto ya no está en el grupo.");
    if (vistos.has(deudor)) throw new Fallo(400, "Alguien aparece dos veces en el reparto.");
    vistos.add(deudor);
    const peso = p.peso === undefined || p.peso === null ? null : entero(p.peso, "El peso", 1, 1000);
    return { deudor, centimos: entero(p.centimos, "La parte", 0, MAX_IMPORTE), peso };
  });
  const suma = partes.reduce((s: number, p: { centimos: number }) => s + p.centimos, 0);
  if (suma !== centimos) throw new Fallo(400, "Las partes no suman el importe del gasto.");
  if (!partes.some((p: { deudor: string; centimos: number }) => p.deudor !== yo && p.centimos > 0)) {
    throw new Fallo(400, "El gasto tiene que ser con alguien más del grupo.");
  }
  return { concepto, centimos, reparto, partes };
}

function insertarPartes(db: BaseDatos, gasto: string, partes: GastoValido["partes"]): Sentencia[] {
  return partes.map((p) =>
    db.prepare("INSERT INTO partes (id, gasto_id, deudor, centimos, peso) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), gasto, p.deudor, p.centimos, p.peso)
  );
}

// MARK: - Saldar

/** Marca como pagadas unas partes: cada una la puede marcar quien la debe o a quien se le debe, y queda quién fue. */
async function saldar(db: BaseDatos, grupo: string, yo: string, cuerpo: Fila): Promise<Fila> {
  await miembroActivo(db, grupo, yo);
  const ids = listaDeIds(cuerpo.partes);
  const marcas = "?,".repeat(ids.length).slice(0, -1);
  const { results } = await db.prepare(
    `SELECT p.id, p.deudor, p.saldada_en, g.pagador FROM partes p JOIN gastos g ON g.id = p.gasto_id
     WHERE g.grupo_id = ? AND p.id IN (${marcas})`
  ).bind(grupo, ...ids).all();
  if (results.length !== ids.length) throw new Fallo(404, "Alguna de esas cuentas ya no existe.");
  for (const p of results) {
    if (p.deudor === p.pagador) throw new Fallo(400, "Tu parte de lo que pagas tú no se salda.");
    if (p.deudor !== yo && p.pagador !== yo) throw new Fallo(403, "Solo puedes saldar lo que debes tú o lo que te deben a ti.");
  }
  const ahora = Date.now();
  const abiertas = results.filter((p) => p.saldada_en === null);
  if (abiertas.length > 0) {
    await db.batch(abiertas.map((p) =>
      db.prepare("UPDATE partes SET saldada_por = ?, saldada_en = ? WHERE id = ? AND saldada_en IS NULL").bind(yo, ahora, p.id)
    ));
  }
  return grupoCompleto(db, grupo, yo);
}

/** Partes saldadas cuyo dinero vas a mover a tu bolsillo: devuelve las que nadie (otro dispositivo tuyo) movió ya. */
async function aplicados(db: BaseDatos, yo: string, cuerpo: Fila): Promise<Fila> {
  const ids = listaDeIds(cuerpo.partes);
  const marcas = "?,".repeat(ids.length).slice(0, -1);
  const { results } = await db.prepare(
    `SELECT p.id FROM partes p JOIN gastos g ON g.id = p.gasto_id
     WHERE p.id IN (${marcas}) AND p.saldada_en IS NOT NULL AND p.deudor != g.pagador AND (p.deudor = ? OR g.pagador = ?)`
  ).bind(...ids, yo, yo).all();
  if (results.length === 0) return { nuevas: [] };
  const hechos = await db.batch(results.map((p) =>
    db.prepare("INSERT OR IGNORE INTO aplicados (parte_id, usuario_id) VALUES (?, ?)").bind(p.id, yo)
  ));
  return { nuevas: results.filter((_, k) => hechos[k].meta.changes > 0).map((p) => p.id) };
}

// MARK: - Leer un grupo entero

async function miembroActivo(db: BaseDatos, grupo: string, yo: string): Promise<void> {
  const fila = await db.prepare("SELECT salida FROM miembros WHERE grupo_id = ? AND usuario_id = ?").bind(grupo ?? "", yo).first();
  if (!fila || fila.salida !== null) throw new Fallo(404, "No estás en ese grupo.");
}

/** El grupo como lo lee la app (Grupo en CheckpointCore): miembros, gastos con sus partes y si lo tienes archivado. */
async function grupoCompleto(db: BaseDatos, grupo: string, yo: string): Promise<Fila> {
  const [grupos, miembros, gastos, partes] = await db.batch([
    db.prepare(
      "SELECT g.id, g.nombre, g.emoji, g.creado, g.creado_por, m.archivado FROM grupos g JOIN miembros m ON m.grupo_id = g.id AND m.usuario_id = ? WHERE g.id = ?"
    ).bind(yo, grupo),
    db.prepare(
      `SELECT u.id, u.nombre, u.apellido, m.salida, f.version AS foto FROM miembros m JOIN usuarios u ON u.id = m.usuario_id
       LEFT JOIN fotos f ON f.usuario_id = u.id WHERE m.grupo_id = ? ORDER BY m.entrada`
    ).bind(grupo),
    db.prepare("SELECT id, pagador, concepto, centimos, reparto, fecha, editado FROM gastos WHERE grupo_id = ? ORDER BY fecha").bind(grupo),
    db.prepare(
      "SELECT p.id, p.gasto_id, p.deudor, p.centimos, p.peso, p.saldada_por, p.saldada_en FROM partes p JOIN gastos g ON g.id = p.gasto_id WHERE g.grupo_id = ? ORDER BY p.rowid"
    ).bind(grupo),
  ]);
  const g = grupos.results[0];
  if (!g) throw new Fallo(404, "Ese grupo no existe.");
  return {
    id: g.id,
    nombre: g.nombre,
    emoji: g.emoji,
    creado: g.creado,
    archivado: g.archivado === 1,
    creadoPor: g.creado_por,
    miembros: miembros.results.map((m) => ({
      id: m.id, nombre: m.nombre, apellido: m.apellido, dentro: m.salida === null, ...(m.foto === null ? {} : { foto: m.foto }),
    })),
    gastos: gastos.results.map((x) => ({
      id: x.id,
      pagador: x.pagador,
      concepto: x.concepto,
      centimos: x.centimos,
      reparto: x.reparto,
      fecha: x.fecha,
      ...(x.editado === null ? {} : { editado: x.editado }),
      partes: partes.results.filter((p) => p.gasto_id === x.id).map((p) => ({
        id: p.id,
        deudor: p.deudor,
        centimos: p.centimos,
        ...(p.peso === null ? {} : { peso: p.peso }),
        ...(p.saldada_en === null ? {} : { saldadaPor: p.saldada_por, saldadaEn: p.saldada_en }),
      })),
    })),
  };
}

// MARK: - Utilidades

function json(datos: unknown, estado = 200): Response {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function leerJSON(request: Request): Promise<Fila> {
  const textoCuerpo = await request.text();
  if (textoCuerpo.length > MAX_CUERPO) throw new Fallo(413, "Demasiados datos de una vez.");
  if (textoCuerpo.trim() === "") return {};
  try {
    const valor = JSON.parse(textoCuerpo);
    if (typeof valor !== "object" || valor === null || Array.isArray(valor)) throw new Error();
    return valor;
  } catch {
    throw new Fallo(400, "Los datos no se entienden.");
  }
}

function texto(valor: unknown, que: string, maximo: number, puedeVacio = false): string {
  if (typeof valor !== "string") throw new Fallo(400, `${que} no es válido.`);
  const limpio = valor.trim();
  if (!puedeVacio && limpio === "") throw new Fallo(400, `${que} no puede estar vacío.`);
  if ([...limpio].length > maximo) throw new Fallo(400, `${que} es demasiado largo.`);
  return limpio;
}

function entero(valor: unknown, que: string, minimo: number, maximo: number): number {
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < minimo || valor > maximo) {
    throw new Fallo(400, `${que} no es válido.`);
  }
  return valor;
}

function esUUID(valor: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(valor);
}

function uuid(valor: unknown, que: string): string {
  const v = String(valor ?? "").toLowerCase();
  if (!esUUID(v)) throw new Fallo(400, `${que} no tiene un identificador válido.`);
  return v;
}

function listaDeIds(valor: unknown): string[] {
  if (!Array.isArray(valor) || valor.length === 0 || valor.length > 200) throw new Fallo(400, "Elige qué cuentas saldar.");
  return [...new Set(valor.map((v) => uuid(v, "La cuenta")))];
}

function codigoAleatorio(largo: number): string {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(largo));
  return [...bytes].map((b) => letras[b % letras.length]).join("");
}

async function huella(clave: string): Promise<string> {
  const datos = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clave));
  return [...new Uint8Array(datos)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
