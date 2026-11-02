// Dónde se descarga Checkpoint. Lo usan todas las páginas de la web, también la de las invitaciones a grupos.
// Vacío mientras la app no esté publicada en esa tienda: su botón no sale y se ve el aviso de "muy pronto".
// El día que se publique, basta con poner aquí el enlace (el del App Store es https://apps.apple.com/app/id6822368348).
const DESCARGAS = {
  appStore: "",
  googlePlay: "",
};

for (const boton of document.querySelectorAll("[data-descarga]")) {
  const enlace = DESCARGAS[boton.dataset.descarga];
  if (enlace) {
    boton.href = enlace;
    boton.hidden = false;
  }
}
if (Object.values(DESCARGAS).some(Boolean)) {
  for (const aviso of document.querySelectorAll("[data-sin-descarga]")) aviso.hidden = true;
}
