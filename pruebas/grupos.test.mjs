// Pruebas del servidor de los grupos, de verdad: arranca el servidor en este Mac con una base de datos de prueba
// vacía (no toca la de Cloudflare), hace de cuatro personas y comprueba cada regla. Se lanza con `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const PUERTO = 8790;
const API = `http://127.0.0.1:${PUERTO}/api`;
const datos = mkdtempSync(join(tmpdir(), "checkpoint-pruebas-"));
let servidor;

before(async () => {
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "checkpoint-grupos", "--local", "--persist-to", datos],
    { stdio: "ignore", env: { ...process.env, CI: "1" } });
  servidor = spawn("npx", ["wrangler", "pages", "dev", ".", "--port", String(PUERTO), "--persist-to", datos],
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
  return { id, nombre, pedir };
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
  for (const p of [yo, juanma, pablo]) assert.equal((await p.pedir("POST", `/invitaciones/${inv.datos.codigo}`)).estado, 200);
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
  assert.equal((await fetch(`${web}/g/noexiste123`)).status, 404);
  // Lo de antes no cambia: la página de las cuentas y el archivo de enlaces de Apple (ahora también con /g/).
  assert.equal((await fetch(`${web}/c`)).status, 200);
  const aasa = await fetch(`${web}/.well-known/apple-app-site-association`);
  assert.match(aasa.headers.get("content-type") ?? "", /application\/json/);
  assert.ok((await aasa.json()).applinks.details[0].components.some((c) => c["/"] === "/g/*"));
});
