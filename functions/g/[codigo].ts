// La página de una invitación a un grupo: checkpoint.iarg.dev/g/<código>.
// Con Checkpoint instalada, el enlace abre directamente la app (es un enlace universal) y esta página no se ve.
// Sin la app: dice a qué grupo te invitan y cómo descargarla (App Store y Google Play).

interface BaseDatos {
  prepare(sql: string): { bind(...v: unknown[]): { first<T = Record<string, any>>(): Promise<T | null> } };
}
interface Contexto {
  env: { DB: BaseDatos };
  params: { codigo?: string };
}

// Dónde se descarga la app. Vacío: aún no está publicada en esa tienda.
const APP_STORE = "";
const GOOGLE_PLAY = "";

export const onRequest = async (ctx: Contexto): Promise<Response> => {
  const codigo = String(ctx.params.codigo ?? "");
  let grupo: Record<string, any> | null = null;
  if (/^[A-Za-z0-9]{6,32}$/.test(codigo)) {
    grupo = await ctx.env.DB.prepare(
      `SELECT g.nombre, g.emoji, (SELECT COUNT(*) FROM miembros m WHERE m.grupo_id = g.id AND m.salida IS NULL) AS miembros
       FROM grupos g WHERE g.invitacion = ?`
    ).bind(codigo).first();
  }
  return new Response(pagina(codigo, grupo), {
    status: grupo ? 200 : 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
};

function pagina(codigo: string, grupo: Record<string, any> | null): string {
  const titulo = grupo
    ? `Te han invitado a «${escapar(grupo.nombre)}»`
    : "Esta invitación no es válida";
  const detalle = grupo
    ? `${grupo.emoji ? escapar(grupo.emoji) + " " : ""}Un grupo de Checkpoint con ${grupo.miembros} ${grupo.miembros === 1 ? "persona" : "personas"}. Para entrar, ábrelo con la app.`
    : "Puede que el grupo ya no exista o que el enlace esté incompleto. Pide que te lo vuelvan a enviar.";
  const tiendas = [
    APP_STORE ? `<a class="boton" href="${APP_STORE}">Descargar en el App Store</a>` : "",
    GOOGLE_PLAY ? `<a class="boton" href="${GOOGLE_PLAY}">Descargar en Google Play</a>` : "",
  ].join("\n      ");
  const sinTiendas = !APP_STORE && !GOOGLE_PLAY
    ? `<p>Checkpoint llegará muy pronto al App Store y a Google Play.</p>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Checkpoint · ${titulo}</title>
  <meta name="robots" content="noindex">
  <link rel="icon" href="/icono.png">
  <link rel="apple-touch-icon" href="/icono.png">
  <link rel="stylesheet" href="/estilos.css">
</head>
<body>
  <header class="cabecera">
    <img src="/icono.png" alt="Icono de Checkpoint">
    <h1>Checkpoint</h1>
    <p>Tus cuentas, sin sumar a mano.</p>
  </header>
  <main>
    <section class="tarjeta">
      <h2>${titulo}</h2>
      <p>${detalle}</p>
      ${grupo ? `<h3>¿Ya tienes Checkpoint?</h3>
      <p>Si el enlace te ha traído aquí en vez de a la app, entra desde este botón.</p>
      <a class="boton" href="checkpoint://grupo/${escapar(codigo)}">Abrir en Checkpoint</a>
      <h3>¿Aún no la tienes?</h3>
      ${sinTiendas}${tiendas}` : ""}
    </section>
  </main>
  <footer>
    <a href="/">Ayuda</a> · <a href="/privacidad">Política de privacidad</a> · <span>© 2026 Ismael Arco González</span>
  </footer>
</body>
</html>`;
}

function escapar(texto: unknown): string {
  return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
