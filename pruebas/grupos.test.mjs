// Pruebas del servidor de los grupos, de verdad: arranca el servidor en este Mac con una base de datos de prueba
// vacía (no toca la de Cloudflare), hace de cuatro personas y comprueba cada regla. Se lanza con `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";

const PUERTO = 8790;
const API = `http://127.0.0.1:${PUERTO}/api`;
const datos = mkdtempSync(join(tmpdir(), "checkpoint-pruebas-"));
let servidor;

// Hace de Apple: guarda los avisos que le llegan. La clave .p8 es inventada, para comprobar la firma.
const APPLE = 8791;
const avisos = [];
const apple = createServer((peticion, respuesta) => {
  let cuerpo = "";
  peticion.on("data", (trozo) => (cuerpo += trozo));
  peticion.on("end", () => {
    avisos.push({ ruta: peticion.url, cabeceras: peticion.headers, cuerpo: JSON.parse(cuerpo) });
    respuesta.writeHead(200).end();
  });
});
const { privateKey: claveApple, publicKey: publicaApple } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const p8 = claveApple.export({ type: "pkcs8", format: "der" }).toString("base64");

/** Espera a que lleguen los avisos para ese dispositivo (se mandan después de responder). */
async function avisosPara(token, cuantos = 1) {
  for (let i = 0; i < 40; i++) {
    const suyos = avisos.filter((a) => a.ruta === `/3/device/${token}`);
    if (suyos.length >= cuantos) return suyos;
    await new Promise((r) => setTimeout(r, 100));
  }
  return avisos.filter((a) => a.ruta === `/3/device/${token}`);
}

before(async () => {
  await new Promise((r) => apple.listen(APPLE, "127.0.0.1", r));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "checkpoint-grupos", "--local", "--persist-to", datos],
    { stdio: "ignore", env: { ...process.env, CI: "1" } });
  servidor = spawn("npx", ["wrangler", "pages", "dev", ".", "--port", String(PUERTO), "--persist-to", datos,
    "--binding", `APNS_KEY=${p8}`, "--binding", "APNS_KEY_ID=CLAVE12345", "--binding", "APNS_TEAM_ID=EQUIPO1234",
    "--binding", `APNS_URL=http://127.0.0.1:${APPLE}`],
    { stdio: "ignore", env: { ...process.env, CI: "1" }, detached: true });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(API)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("El servidor de pruebas no ha arrancado");
});

after(() => {
  try { process.kill(-servidor.pid); } catch {}
  apple.close();
  rmSync(datos, { recursive: true, force: true });
});

/** Una persona con su instalación: su ID y su clave. */
function persona(nombre) {
  const id = randomUUID();
  const clave = randomBytes(32).toString("hex");
  const pedir = async (metodo, ruta, cuerpo, otraClave) => {
    const r = await fetch(API + ruta, {
      method: metodo,
      headers: { "X-Checkpoint-Usuario": id, Authorization: `Bearer ${otraClave ?? clave}`, "Content-Type": "application/json" },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return { estado: r.status, datos: await r.json() };
  };
  /** Sin JSON: para la foto (bytes tal cual) y para leerla. */
  const crudo = async (metodo, ruta, bytes, tipo = "image/jpeg") => {
    const r = await fetch(API + ruta, {
      method: metodo,
      headers: { "X-Checkpoint-Usuario": id, Authorization: `Bearer ${clave}`, "Content-Type": tipo },
      body: bytes,
    });
    return { estado: r.status, tipo: r.headers.get("content-type"), bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  return { id, nombre, pedir, crudo };
}

/** Entrar con el enlace: se pide y quien administra el grupo acepta. */
async function entrar(admin, quien, codigo, grupoId) {
  const pedida = await quien.pedir("POST", `/invitaciones/${codigo}`);
  assert.equal(pedida.datos.estado, "pendiente");
  const aceptada = await admin.pedir("POST", `/grupos/${grupoId}/solicitudes/${quien.id}/aceptar`);
  assert.equal(aceptada.estado, 200);
}

const yo = persona("Ismael"), paco = persona("Paco"), juanma = persona("Juanma"), pablo = persona("Pablo");
let grupo, comida, codigoInvitacion;

test("cada uno se registra con su ID y su clave, sin cuentas", async () => {
  for (const p of [yo, paco, juanma, pablo]) {
    const r = await p.pedir("PUT", "/yo", { nombre: p.nombre, apellido: "Prueba" });
    assert.equal(r.estado, 200);
  }
  // Con otra clave no se puede hacer pasar por él.
  assert.equal((await yo.pedir("GET", "/grupos", undefined, "f".repeat(64))).estado, 401);
  assert.equal((await yo.pedir("PUT", "/yo", { nombre: "Otro" }, "f".repeat(64))).estado, 401);
  const anonimo = await fetch(API + "/grupos");
  assert.equal(anonimo.status, 401);
});

test("Paco crea el grupo y los demás entran con el enlace", async () => {
  const creado = await paco.pedir("POST", "/grupos", { nombre: "Casa rural", emoji: "🏡" });
  assert.equal(creado.estado, 201);
  grupo = creado.datos;
  const inv = await paco.pedir("POST", `/grupos/${grupo.id}/invitacion`);
  assert.match(inv.datos.enlace, /^https:\/\/checkpoint\.iarg\.dev\/g\/[A-Za-z0-9]{12}$/);
  codigoInvitacion = inv.datos.codigo;
  const vista = await yo.pedir("GET", `/invitaciones/${inv.datos.codigo}`);
  assert.equal(vista.datos.nombre, "Casa rural");
  assert.equal(vista.datos.yaEstas, false);
  for (const p of [yo, juanma, pablo]) await entrar(paco, p, inv.datos.codigo, grupo.id);
  const visto = await yo.pedir("GET", `/grupos/${grupo.id}`);
  assert.deepEqual(visto.datos.miembros.map((m) => m.nombre), ["Paco", "Ismael", "Juanma", "Pablo"]);
  // Alguien de fuera no lo ve.
  const fuera = persona("Fuera");
  await fuera.pedir("PUT", "/yo", { nombre: "Fuera" });
  assert.equal((await fuera.pedir("GET", `/grupos/${grupo.id}`)).estado, 404);
});

test("Paco apunta 60 € de comida entre Juanma, Ismael y Pablo (lo apunta siempre quien paga)", async () => {
  const id = randomUUID();
  const cuerpo = { id, concepto: "Comida", centimos: 6000, reparto: "iguales",
    partes: [juanma, yo, pablo].map((p) => ({ deudor: p.id, centimos: 2000 })) };
  const r = await paco.pedir("POST", `/grupos/${grupo.id}/gastos`, cuerpo);
  assert.equal(r.estado, 201);
  comida = r.datos.gastos.find((g) => g.id === id);
  assert.equal(comida.pagador, paco.id);
  assert.equal(comida.partes.length, 3);
  // Enviado dos veces (reintento): no se duplica.
  const otra = await paco.pedir("POST", `/grupos/${grupo.id}/gastos`, cuerpo);
  assert.equal(otra.datos.gastos.length, 1);
});

test("un gasto que no cuadra o con gente de fuera no se apunta", async () => {
  const base = { concepto: "Taxi", centimos: 3000, reparto: "exactas" };
  const noCuadra = await yo.pedir("POST", `/grupos/${grupo.id}/gastos`,
    { ...base, id: randomUUID(), partes: [{ deudor: paco.id, centimos: 1000 }] });
  assert.equal(noCuadra.estado, 400);
  assert.equal(noCuadra.datos.error, "Las partes no suman el importe del gasto.");
  const deFuera = await yo.pedir("POST", `/grupos/${grupo.id}/gastos`,
    { ...base, id: randomUUID(), partes: [{ deudor: randomUUID(), centimos: 3000 }] });
  assert.equal(deFuera.estado, 400);
  const soloYo = await yo.pedir("POST", `/grupos/${grupo.id}/gastos`,
    { ...base, id: randomUUID(), partes: [{ deudor: yo.id, centimos: 3000 }] });
  assert.equal(soloYo.datos.error, "El gasto tiene que ser con alguien más del grupo.");
});

test("solo quien lo apuntó lo cambia o lo borra", async () => {
  assert.equal((await yo.pedir("DELETE", `/grupos/${grupo.id}/gastos/${comida.id}`)).estado, 403);
  const cambio = await paco.pedir("PUT", `/grupos/${grupo.id}/gastos/${comida.id}`, {
    concepto: "Comida del sábado", centimos: 7500, reparto: "iguales",
    partes: [juanma, yo, pablo].map((p) => ({ deudor: p.id, centimos: 2500 })),
  });
  assert.equal(cambio.estado, 200);
  comida = cambio.datos.gastos.find((g) => g.id === comida.id);
  assert.equal(comida.centimos, 7500);
  assert.ok(comida.editado);
});

test("no se puede abandonar con cuentas pendientes, ni debiendo ni con lo que te deben", async () => {
  for (const p of [yo, paco]) {
    const r = await p.pedir("POST", `/grupos/${grupo.id}/abandonar`);
    assert.equal(r.estado, 409);
    assert.equal(r.datos.error, "No puedes abandonar el grupo hasta que tus cuentas estén saldadas.");
  }
});

test("saldar: solo lo tuyo o lo que te deben, y queda quién lo marcó", async () => {
  const mia = comida.partes.find((p) => p.deudor === yo.id);
  const deJuanma = comida.partes.find((p) => p.deudor === juanma.id);
  assert.equal((await yo.pedir("POST", `/grupos/${grupo.id}/saldar`, { partes: [deJuanma.id] })).estado, 403);
  const saldo = await yo.pedir("POST", `/grupos/${grupo.id}/saldar`, { partes: [mia.id] });
  assert.equal(saldo.estado, 200);
  // Paco marca que Juanma le ha pagado.
  const deCobro = await paco.pedir("POST", `/grupos/${grupo.id}/saldar`, { partes: [deJuanma.id] });
  const partes = deCobro.datos.gastos.find((g) => g.id === comida.id).partes;
  assert.equal(partes.find((p) => p.deudor === yo.id).saldadaPor, yo.id);
  assert.equal(partes.find((p) => p.deudor === juanma.id).saldadaPor, paco.id);
  assert.ok(partes.find((p) => p.deudor === yo.id).saldadaEn > 0);
  assert.equal(partes.find((p) => p.deudor === pablo.id).saldadaEn, undefined);
  // Ya hay partes pagadas: Paco ya no puede cambiar ni borrar el gasto.
  const borrar = await paco.pedir("DELETE", `/grupos/${grupo.id}/gastos/${comida.id}`);
  assert.equal(borrar.estado, 409);
});

test("el dinero de cada parte saldada se mueve una sola vez aunque tengas iPhone y Mac", async () => {
  const mia = comida.partes.find((p) => p.deudor === yo.id);
  assert.deepEqual((await yo.pedir("POST", "/aplicados", { partes: [mia.id] })).datos.nuevas, [mia.id]);
  assert.deepEqual((await yo.pedir("POST", "/aplicados", { partes: [mia.id] })).datos.nuevas, []);
  // Paco (a quien se le pagó) también lo mueve en lo suyo; Juanma, que no tiene nada que ver, no.
  assert.deepEqual((await paco.pedir("POST", "/aplicados", { partes: [mia.id] })).datos.nuevas, [mia.id]);
  assert.deepEqual((await juanma.pedir("POST", "/aplicados", { partes: [mia.id] })).datos.nuevas, []);
});

test("saldado lo tuyo puedes abandonar; quien aún debe, no", async () => {
  assert.equal((await pablo.pedir("POST", `/grupos/${grupo.id}/abandonar`)).estado, 409);
  assert.equal((await yo.pedir("POST", `/grupos/${grupo.id}/abandonar`)).estado, 200);
  assert.equal((await yo.pedir("GET", `/grupos/${grupo.id}`)).estado, 404);
  const dePaco = await paco.pedir("GET", `/grupos/${grupo.id}`);
  assert.equal(dePaco.datos.miembros.find((m) => m.id === yo.id).dentro, false);
  // Y ya no se le puede poner en un gasto nuevo.
  const sinMi = await paco.pedir("POST", `/grupos/${grupo.id}/gastos`, { id: randomUUID(), concepto: "Pan", centimos: 300,
    reparto: "iguales", partes: [{ deudor: yo.id, centimos: 300 }] });
  assert.equal(sinMi.estado, 400);
});

test("archivar es solo para ti y a mano", async () => {
  const archivado = await paco.pedir("POST", `/grupos/${grupo.id}/archivar`, { archivado: true });
  assert.equal(archivado.datos.archivado, true);
  assert.equal((await juanma.pedir("GET", `/grupos/${grupo.id}`)).datos.archivado, false);
  const lista = await paco.pedir("GET", "/grupos");
  assert.equal(lista.datos.length, 1);
});

test("la página de una invitación, y la web de siempre sigue igual", async () => {
  const web = `http://127.0.0.1:${PUERTO}`;
  const pagina = await fetch(`${web}/g/${codigoInvitacion}`);
  assert.equal(pagina.status, 200);
  const html = await pagina.text();
  assert.match(html, /Te han invitado a «Casa rural»/);
  assert.match(html, /checkpoint:\/\/grupo\//);
  // Si se pega el enlace suelto, se ve el nombre del grupo y la imagen de la invitación.
  assert.match(html, /<meta property="og:title" content="Únete a «Casa rural» en Checkpoint">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/checkpoint\.iarg\.dev\/invitacion\.jpg">/);
  const imagen = await fetch(`${web}/invitacion.jpg`);
  assert.equal(imagen.status, 200);
  assert.match(imagen.headers.get("content-type") ?? "", /image\/jpeg/);
  assert.equal((await fetch(`${web}/g/noexiste123`)).status, 404);
  // Lo de antes no cambia: la página de las cuentas y el archivo de enlaces de Apple (ahora también con /g/).
  assert.equal((await fetch(`${web}/c`)).status, 200);
  const aasa = await fetch(`${web}/.well-known/apple-app-site-association`);
  assert.match(aasa.headers.get("content-type") ?? "", /application\/json/);
  assert.ok((await aasa.json()).applinks.details[0].components.some((c) => c["/"] === "/g/*"));
});

test("foto de perfil: la que quieras, pequeña, y solo la ven los de tus grupos", async () => {
  const ana = persona("Ana"), luis = persona("Luis"), extrano = persona("Extraño");
  for (const p of [ana, luis, extrano]) await p.pedir("PUT", "/yo", { nombre: p.nombre });
  const g = (await ana.pedir("POST", "/grupos", { nombre: "Fotos", emoji: "" })).datos;
  const inv = (await ana.pedir("POST", `/grupos/${g.id}/invitacion`)).datos;
  await entrar(ana, luis, inv.codigo, g.id);

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(2000)]);
  const subida = await ana.crudo("PUT", "/yo/foto", jpeg);
  assert.equal(subida.estado, 200);
  // Ni algo que no sea una imagen ni una enorme.
  assert.equal((await ana.crudo("PUT", "/yo/foto", new Uint8Array([1, 2, 3, 4]))).estado, 415);
  assert.equal((await ana.crudo("PUT", "/yo/foto", new Uint8Array(400_000).fill(0xff))).estado, 413);

  // En el grupo sale la versión de su foto (y quién lo creó); Luis no tiene.
  const visto = (await luis.pedir("GET", `/grupos/${g.id}`)).datos;
  assert.equal(visto.creadoPor, ana.id);
  assert.ok(visto.miembros.find((m) => m.id === ana.id).foto > 0);
  assert.equal(visto.miembros.find((m) => m.id === luis.id).foto, undefined);

  // Luis la ve tal cual; alguien que no comparte grupo con ella, no.
  const vista = await luis.crudo("GET", `/fotos/${ana.id}`);
  assert.equal(vista.estado, 200);
  assert.equal(vista.tipo, "image/jpeg");
  assert.deepEqual(vista.bytes, jpeg);
  assert.equal((await extrano.crudo("GET", `/fotos/${ana.id}`)).estado, 404);

  // Y se puede quitar.
  assert.equal((await ana.crudo("DELETE", "/yo/foto")).estado, 200);
  assert.equal((await luis.crudo("GET", `/fotos/${ana.id}`)).estado, 404);
});

test("quien creó el grupo puede quitar a alguien sin nada pendiente", async () => {
  const marta = persona("Marta"), dani = persona("Dani"), sara = persona("Sara");
  for (const p of [marta, dani, sara]) await p.pedir("PUT", "/yo", { nombre: p.nombre });
  const g = (await marta.pedir("POST", "/grupos", { nombre: "Piso", emoji: "" })).datos;
  const inv = (await marta.pedir("POST", `/grupos/${g.id}/invitacion`)).datos;
  await entrar(marta, dani, inv.codigo, g.id);
  await entrar(marta, sara, inv.codigo, g.id);
  // Sara le debe algo a Marta.
  await marta.pedir("POST", `/grupos/${g.id}/gastos`, { id: randomUUID(), concepto: "Luz", centimos: 2000, reparto: "iguales",
    partes: [{ deudor: marta.id, centimos: 1000 }, { deudor: sara.id, centimos: 1000 }] });

  // Solo quien lo creó, y a quien no tiene nada pendiente.
  assert.equal((await dani.pedir("POST", `/grupos/${g.id}/miembros/${sara.id}/quitar`)).estado, 403);
  const conDeuda = await marta.pedir("POST", `/grupos/${g.id}/miembros/${sara.id}/quitar`);
  assert.equal(conDeuda.estado, 409);
  assert.match(conDeuda.datos.error, /cuentas pendientes/);
  assert.equal((await marta.pedir("POST", `/grupos/${g.id}/miembros/${marta.id}/quitar`)).estado, 400);

  const quitado = await marta.pedir("POST", `/grupos/${g.id}/miembros/${dani.id}/quitar`);
  assert.equal(quitado.estado, 200);
  assert.equal(quitado.datos.miembros.find((m) => m.id === dani.id).dentro, false);
  assert.equal((await dani.pedir("GET", `/grupos/${g.id}`)).estado, 404);
  // Con el enlace puede volver, si lo aceptan otra vez.
  await entrar(marta, dani, inv.codigo, g.id);
  assert.equal((await dani.pedir("GET", `/grupos/${g.id}`)).estado, 200);
});

test("con el enlace se pide entrar: quien administra el grupo acepta o rechaza, y mientras no se ve nada", async () => {
  const eva = persona("Eva"), leo = persona("Leo"), mia = persona("Mía"), raul = persona("Raúl");
  for (const p of [eva, leo, mia, raul]) await p.pedir("PUT", "/yo", { nombre: p.nombre, apellido: "Prueba" });
  const g = (await eva.pedir("POST", "/grupos", { nombre: "Viaje", emoji: "✈️" })).datos;
  const inv = (await eva.pedir("POST", `/grupos/${g.id}/invitacion`)).datos;

  // Leo pide entrar: queda pendiente y no ve el grupo.
  const pedida = await leo.pedir("POST", `/invitaciones/${inv.codigo}`);
  assert.deepEqual(pedida.datos, { estado: "pendiente", grupo: { id: g.id, nombre: "Viaje", emoji: "✈️" } });
  assert.equal((await leo.pedir("GET", `/grupos/${g.id}`)).estado, 404);
  assert.equal((await leo.pedir("GET", `/invitaciones/${inv.codigo}`)).datos.pendiente, true);
  assert.deepEqual((await leo.pedir("GET", "/solicitudes")).datos.map((s) => s.nombre), ["Viaje"]);
  // Pedirlo dos veces no hace dos solicitudes.
  await leo.pedir("POST", `/invitaciones/${inv.codigo}`);

  // Eva (lo creó) ve quién pide entrar; los demás miembros, no, y no pueden aceptar.
  await entrar(eva, mia, inv.codigo, g.id);
  const deEva = (await eva.pedir("GET", `/grupos/${g.id}`)).datos;
  assert.equal(deEva.admin, eva.id);
  assert.deepEqual(deEva.solicitudes.map((u) => u.nombre), ["Leo"]);
  assert.equal((await mia.pedir("GET", `/grupos/${g.id}`)).datos.solicitudes, undefined);
  assert.equal((await mia.pedir("POST", `/grupos/${g.id}/solicitudes/${leo.id}/aceptar`)).estado, 403);

  // Eva lo acepta: Leo ya está dentro.
  const aceptada = await eva.pedir("POST", `/grupos/${g.id}/solicitudes/${leo.id}/aceptar`);
  assert.deepEqual(aceptada.datos.solicitudes, []);
  assert.ok(aceptada.datos.miembros.some((m) => m.id === leo.id && m.dentro));
  assert.deepEqual((await leo.pedir("GET", "/solicitudes")).datos, []);

  // Raúl pide y Eva lo rechaza; o lo cancela él mismo.
  await raul.pedir("POST", `/invitaciones/${inv.codigo}`);
  await eva.pedir("POST", `/grupos/${g.id}/solicitudes/${raul.id}/rechazar`);
  assert.equal((await raul.pedir("GET", `/grupos/${g.id}`)).estado, 404);
  assert.deepEqual((await raul.pedir("GET", "/solicitudes")).datos, []);
  await raul.pedir("POST", `/invitaciones/${inv.codigo}`);
  await raul.pedir("DELETE", `/solicitudes/${g.id}`);
  assert.deepEqual((await eva.pedir("GET", `/grupos/${g.id}`)).datos.solicitudes, []);
});

test("restablecer el enlace: el viejo deja de valer (solo quien administra)", async () => {
  const ana = persona("Ana"), ben = persona("Ben"), carla = persona("Carla");
  for (const p of [ana, ben, carla]) await p.pedir("PUT", "/yo", { nombre: p.nombre });
  const g = (await ana.pedir("POST", "/grupos", { nombre: "Piso", emoji: "" })).datos;
  const viejo = (await ana.pedir("POST", `/grupos/${g.id}/invitacion`)).datos.codigo;
  await entrar(ana, ben, viejo, g.id);
  assert.equal((await ben.pedir("POST", `/grupos/${g.id}/invitacion/nueva`)).estado, 403);
  const nuevo = (await ana.pedir("POST", `/grupos/${g.id}/invitacion/nueva`)).datos;
  assert.notEqual(nuevo.codigo, viejo);
  assert.equal((await carla.pedir("GET", `/invitaciones/${viejo}`)).estado, 404);
  assert.equal((await carla.pedir("POST", `/invitaciones/${viejo}`)).estado, 404);
  assert.equal((await carla.pedir("POST", `/invitaciones/${nuevo.codigo}`)).datos.estado, "pendiente");
  // Y desde ahora el enlace del grupo es el nuevo.
  assert.equal((await ben.pedir("POST", `/grupos/${g.id}/invitacion`)).datos.codigo, nuevo.codigo);
});

test("si quien lo creó se va, administra el que más tiempo lleva", async () => {
  const ola = persona("Ola"), pepe = persona("Pepe"), quim = persona("Quim"), rita = persona("Rita");
  for (const p of [ola, pepe, quim, rita]) await p.pedir("PUT", "/yo", { nombre: p.nombre });
  const g = (await ola.pedir("POST", "/grupos", { nombre: "Fútbol", emoji: "" })).datos;
  const inv = (await ola.pedir("POST", `/grupos/${g.id}/invitacion`)).datos;
  await entrar(ola, pepe, inv.codigo, g.id);
  await entrar(ola, quim, inv.codigo, g.id);
  await rita.pedir("POST", `/invitaciones/${inv.codigo}`);
  assert.equal((await ola.pedir("POST", `/grupos/${g.id}/abandonar`)).estado, 200);
  const dePepe = (await pepe.pedir("GET", `/grupos/${g.id}`)).datos;
  assert.equal(dePepe.admin, pepe.id);
  assert.deepEqual(dePepe.solicitudes.map((u) => u.nombre), ["Rita"]);
  assert.equal((await quim.pedir("POST", `/grupos/${g.id}/solicitudes/${rita.id}/aceptar`)).estado, 403);
  assert.equal((await pepe.pedir("POST", `/grupos/${g.id}/solicitudes/${rita.id}/aceptar`)).estado, 200);
});

test("avisos: a quien le toca, en sus dispositivos, firmados con la clave de Apple", async () => {
  const sol = persona("Sol"), tom = persona("Tom"), uma = persona("Uma");
  for (const p of [sol, tom, uma]) await p.pedir("PUT", "/yo", { nombre: p.nombre, apellido: "Prueba" });
  const deSol = randomBytes(32).toString("hex"), deTom = randomBytes(32).toString("hex"), deUma = randomBytes(32).toString("hex");
  assert.equal((await sol.pedir("PUT", "/dispositivos", { token: deSol, entorno: "sandbox" })).estado, 200);
  await tom.pedir("PUT", "/dispositivos", { token: deTom, entorno: "produccion" });
  await uma.pedir("PUT", "/dispositivos", { token: deUma, entorno: "produccion" });
  assert.equal((await sol.pedir("PUT", "/dispositivos", { token: "nada" })).estado, 400);

  const g = (await sol.pedir("POST", "/grupos", { nombre: "Cumple", emoji: "" })).datos;
  const inv = (await sol.pedir("POST", `/grupos/${g.id}/invitacion`)).datos;

  // Tom pide entrar: se avisa a Sol, que administra.
  await tom.pedir("POST", `/invitaciones/${inv.codigo}`);
  const [pide] = await avisosPara(deSol);
  assert.equal(pide.cuerpo.aps.alert.title, "Cumple");
  assert.equal(pide.cuerpo.aps.alert.body, "Tom Prueba quiere unirse al grupo.");
  assert.equal(pide.cuerpo.grupo, g.id);
  assert.equal(pide.cabeceras["apns-topic"], "com.ismaelarco.checkpoint");
  assert.equal(pide.cabeceras["apns-push-type"], "alert");
  // La firma es un JWT ES256 hecho con la clave .p8: Apple lo comprobaría con la pública.
  const [cabecera, datos, firma] = pide.cabeceras.authorization.replace("bearer ", "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(cabecera, "base64url")), { alg: "ES256", kid: "CLAVE12345" });
  assert.equal(JSON.parse(Buffer.from(datos, "base64url")).iss, "EQUIPO1234");
  assert.ok(verify("sha256", Buffer.from(`${cabecera}.${datos}`), { key: publicaApple, dsaEncoding: "ieee-p1363" }, Buffer.from(firma, "base64url")));

  // Sol lo acepta: se avisa a Tom.
  await sol.pedir("POST", `/grupos/${g.id}/solicitudes/${tom.id}/aceptar`);
  assert.equal((await avisosPara(deTom))[0].cuerpo.aps.alert.body, "Ya estás dentro de «Cumple».");
  await entrar(sol, uma, inv.codigo, g.id);

  // Sol apunta una tarta entre los tres: Tom y Uma reciben su parte; Sol (que lo apuntó), no.
  const antesSol = (await avisosPara(deSol, 2)).length;
  await sol.pedir("POST", `/grupos/${g.id}/gastos`, { id: randomUUID(), concepto: "Tarta", centimos: 3000, reparto: "iguales",
    partes: [sol, tom, uma].map((p) => ({ deudor: p.id, centimos: 1000 })) });
  assert.equal((await avisosPara(deTom, 2))[1].cuerpo.aps.alert.body, "Sol apuntó «Tarta»: tu parte, 10,00 €.");
  assert.equal((await avisosPara(deUma, 2))[1].cuerpo.aps.alert.body, "Sol apuntó «Tarta»: tu parte, 10,00 €.");

  // Tom paga lo suyo: se avisa a Sol.
  const grupoTom = (await tom.pedir("GET", `/grupos/${g.id}`)).datos;
  const parteTom = grupoTom.gastos[0].partes.find((p) => p.deudor === tom.id);
  await tom.pedir("POST", `/grupos/${g.id}/saldar`, { partes: [parteTom.id] });
  const deSolAhora = await avisosPara(deSol, antesSol + 1);
  assert.equal(deSolAhora[deSolAhora.length - 1].cuerpo.aps.alert.body, "Tom te ha pagado 10,00 € (Tarta).");

  // Sol marca que Uma le pagó: se avisa a Uma.
  const parteUma = grupoTom.gastos[0].partes.find((p) => p.deudor === uma.id);
  await sol.pedir("POST", `/grupos/${g.id}/saldar`, { partes: [parteUma.id] });
  assert.equal((await avisosPara(deUma, 3))[2].cuerpo.aps.alert.body, "Sol ha marcado que le pagaste 10,00 € (Tarta).");
});
