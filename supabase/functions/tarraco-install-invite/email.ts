export const installationUrl = "https://tarraco-pedidos-portal.vercel.app/instalar.html";
export const subject = "Instala TARRACO y accede a tus pedidos";
const brand = "TARRACO SEA FOOD 2002 SL";
const introduction = "Ya puedes instalar el portal de pedidos de TARRACO en tu móvil, tableta u ordenador. Tendrás el icono de TARRACO a mano para entrar y hacer tus pedidos.";
const instructions = "Pulsa el botón y sigue los pasos que aparezcan en tu dispositivo. Una vez instalada, abre TARRACO desde su icono e inicia sesión con tu cuenta. Si todavía no tienes acceso, puedes solicitar el alta de tu empresa desde el portal.";
const logo = new URL("./tarraco-app/icono-192.png", installationUrl).href;

export const text = [
  "Hola,", introduction, "INSTALAR APLICACIÓN TARRACO\n" + installationUrl,
  instructions, "Un saludo,\n" + brand,
].join("\n\n");

export const html = `<!doctype html>
<html lang="es-ES">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;background:#eef4f4;color:#102c3a;font:16px/1.55 Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4f4"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:570px;background:white;border:1px solid #d6e4e5;border-radius:16px">
      <tr><td align="center" style="padding:24px 16px 14px;border-bottom:1px solid #d6e4e5">
        <img src="${logo}" width="76" height="76" alt="Logotipo de TARRACO" style="display:block;margin:0 auto 8px">
        <strong style="color:#246859;font-size:14px">${brand}</strong>
      </td></tr>
      <tr><td style="padding:22px">
        <h1 style="margin:0 0 16px;font-size:25px;line-height:1.2">Tu portal de pedidos, siempre a mano</h1>
        <p>Hola,</p><p>${introduction}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#17634f" style="border-radius:10px">
          <a href="${installationUrl}" style="display:block;padding:16px 12px;color:#fff;font-size:16px;font-weight:bold;text-decoration:none">INSTALAR APLICACIÓN TARRACO</a>
        </td></tr></table>
        <p>${instructions}</p>
        <p style="color:#405b60;font-size:13px">Si el botón no se abre, copia este enlace en tu navegador.<br><a href="${installationUrl}" style="color:#11584e;word-break:break-all">${installationUrl}</a></p>
        <p>Un saludo,<br><strong>${brand}</strong></p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
