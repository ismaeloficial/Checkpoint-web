# Checkpoint · web y servidor de los grupos

La web de [Checkpoint](https://checkpoint.iarg.dev), la app para llevar las cuentas sin sumar a mano (iPhone y Mac),
y el servidor de sus **Grupos**. Todo se publica en Cloudflare Pages: las páginas son archivos estáticos y el servidor
son Pages Functions con una base de datos D1.

La app es *local-first*: las cuentas de cada persona se quedan en su dispositivo y en su iCloud. Aquí solo llega lo que
se comparte en los grupos (ver la [política de privacidad](https://checkpoint.iarg.dev/privacidad)).

## Qué hay

```
├── index.html          Inicio: qué es Checkpoint, ayuda y preguntas frecuentes
├── privacidad.html     Política de privacidad
├── c.html              Cuentas recibidas (/c#…): las cuentas van en el enlace y la página no las ve
├── descarga.js         Los enlaces de descarga (App Store, Google Play) que usan todas las páginas
├── app-store.svg       La insignia oficial de Apple, en español: no se modifica
├── estilos.css         Estilos de toda la web (claro y oscuro)
├── functions/
│   ├── api/[[ruta]].ts El servidor de los grupos, en /api
│   └── g/[codigo].ts   La página de una invitación a un grupo (/g/<código>)
├── migrations/         La base de datos, paso a paso (SQL)
├── pruebas/            Pruebas del servidor
├── .well-known/        apple-app-site-association: los enlaces /c y /g abren la app
└── wrangler.toml       Configuración de Cloudflare (la base de datos D1)
```

## El servidor de los grupos

- **Sin cuentas:** cada instalación de la app se inventa un ID y una clave secreta, y las manda en cada petición
  (cabeceras `X-Checkpoint-Usuario` y `Authorization: Bearer`). El servidor guarda solo una huella de la clave.
- **Las reglas se comprueban aquí,** aunque la app ya las cumpla: cada uno apunta solo lo que paga, salda solo lo suyo
  (o lo que le deben), no abandona un grupo con cuentas pendientes, y con el enlace de un grupo no se entra: se pide
  entrar y quien lo administra acepta.
- **Avisos push** (APNs) a quien le toca: alguien pide entrar, te aceptan, un gasto en el que tienes parte, un pago.
- **Fotos** de perfil y de grupo, pequeñas. Solo las ven los del grupo (la del grupo, también quien tiene su enlace).
- **Borrar tus datos** (`DELETE /api/yo`): sales de tus grupos y tu nombre deja de aparecer.

## Probarlo en tu ordenador

Hace falta Node.js. La primera vez:

```bash
npm install
```

Para arrancar la web y el servidor en `http://127.0.0.1:8788` (con una base de datos local, no la de Cloudflare):

```bash
npx wrangler d1 migrations apply checkpoint-grupos --local
```

```bash
npm run servidor
```

Las pruebas arrancan su propio servidor con una base de datos vacía y hacen de varias personas:

```bash
npm test
```

## Publicar

- Cada push a `main` lo publica Cloudflare Pages solo.
- **Si hay un cambio en la base de datos** (un archivo nuevo en `migrations/`), su SQL se pega en la consola de D1
  **antes** de publicar el código que lo usa. Si no, el servidor falla al buscar lo que aún no existe.
- **Secretos** (en Cloudflare → Workers y Pages → el proyecto → Configuración → Variables y secretos, en Producción):
  `APNS_KEY` (el contenido de la clave `.p8`), `APNS_KEY_ID` y `APNS_TEAM_ID`. Sin ellos, todo funciona menos los avisos.
- **Cuando la app salga en una tienda,** su enlace va en `descarga.js` y los botones de descarga aparecen en toda la web.

## Contacto

Ismael Arco González · [ismaelarco.oficial@gmail.com](mailto:ismaelarco.oficial@gmail.com)
