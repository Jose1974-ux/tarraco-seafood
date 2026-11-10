 git init
    git add .
    git commit -m "Primera versión"
    git branch -M main
    git remote add origin https://github.com/TU_USUARIO/pescaderia-web.git
    git push -u origin main

## Avisos push de administración

La rama de pruebas no despliega automáticamente a producción. Para validar el
flujo completo en un entorno aislado existente, aplicar la migración
`tarraco_admin_push` y desplegar `tarraco-push` con su configuración de
`supabase/config.toml`. La migración usa las extensiones Vault, pg_cron,
pg_net y pgcrypto. Las claves VAPID se crean en el primer uso autorizado:
Vault conserva la clave privada y el portal recibe solo la pública. El cron
usa un secreto propio de Vault para llamar a la función. Los accesos desde el
portal comprueban que la sesión siga activa y que el perfil sea administrador.
El botón de prueba encola un aviso sintético para ese dispositivo, sin generar
pedidos ni enviar mensajes por Telegram.

### Prueba en Chrome para Android

1. En la vista de pruebas por HTTPS, inicia sesión como administrador. En
   **Notificaciones**, pulsa **Activar avisos en este dispositivo** y acepta
   el permiso de Chrome.
2. Pulsa **Enviar aviso de prueba** y bloquea el móvil. El primer envío se
   habilita a los 30 segundos y el cron recoge los envíos cada 15 segundos.
   Comprueba que se muestra un único aviso y que suena según los ajustes de
   Android.
3. Deja el aviso sin abrir durante cinco minutos. Comprueba que se repite
   sobre el mismo aviso. Tócalo y verifica que abre **Notificaciones** y que
   no se vuelve a emitir durante el siguiente intervalo.
4. Con el portal visible y tras tocar la pantalla, repite la prueba y
   comprueba los tres pitidos. Pulsa **Silenciar sonidos** y vuelve a probar:
   el aviso debe aparecer sin sonido. Restablece el sonido con el mismo botón.

Chrome y Android controlan el tono, la vibración y la entrega en segundo plano.
Los tres pitidos personalizados se reproducen en el portal visible tras una
interacción con la página. La entrega puede variar según la conexión, el modo
No molestar y los permisos del dispositivo.

### Preparar la importación de clientes

Los datos del PDF se procesan fuera del repositorio. Se necesita Python 3.11 o posterior y Poppler.

```sh
python scripts/extract-tarraco-clients.py /ruta/privada/clientes.pdf /ruta/privada/clientes.json
```

Aplica la migración de CLIENTES en la base de pruebas. Usa una conexión privada con permisos de escritura y valida primero la operación con reversión automática.

```sh
set -o pipefail
python scripts/prepare-tarraco-client-import.py /ruta/privada/clientes.json |
  psql --no-psqlrc --set ON_ERROR_STOP=1
```

Configura la conexión en el entorno de PostgreSQL o en un servicio de conexión privado. Añade `--apply` al comando de Python para confirmar la transacción después de revisar los totales y verificar una copia de seguridad. Una ejecución repetida conserva los cambios hechos en las fichas. Los posibles duplicados y los cruces con empresas existentes quedan fuera de la escritura. Cada ficha nueva empieza sin acceso al portal.

Conserva el PDF y el JSON en una ubicación privada. La salida de `prepare-tarraco-client-import.py` contiene datos personales codificados y debe ir directamente a `psql`.
