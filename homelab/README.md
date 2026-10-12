# openGym en el homelab

Proxmox → LXC Debian sin privilegios (12 en Proxmox 8, 13 en Proxmox 9) → Docker → openGym + sidecar de Tailscale.
Acceso en `https://opengym.<tailnet>.ts.net`: HTTPS real (las passkeys funcionan), sin dominio y
sin abrir puertos. Fuera de casa, el móvil entra por la VPN de Tailscale.

| Fichero | Para qué |
|---|---|
| `compose.homelab.yml` | Overlay del `docker-compose.yml` original: añade Tailscale y fija la versión de las imágenes |
| `env.homelab.example` | Plantilla del `.env` (se copia a la raíz del repo) |
| `tailscale.env.example` | Auth key de Tailscale, opcional (`homelab/tailscale.env`, ignorado por git) |
| `tailscale/serve.json` | `tailscale serve`: HTTPS :443 → nginx en 127.0.0.1:80 |
| `proxmox/create-lxc.sh` | En el host Proxmox: crea el LXC y lanza `bootstrap.sh` |
| `proxmox/bootstrap.sh` | Dentro del LXC: Docker, clon del fork, `.env`, cron de backup |
| `backup.sh` | `tar` diario de `data/`, guarda los 14 últimos |
| `check-strong-csv.mjs` | Ensayo del import de Strong con el importador real de la app |

## 1. Tailscale (una sola vez)

Tailnet: **`tailff2e2.ts.net`**, con MagicDNS y HTTPS Certificates ya activados (comprobado el
2026-10-12). URL de openGym: **`https://opengym.tailff2e2.ts.net`**. No cambies el nombre del
tailnet a partir de ahora: forma parte del hostname y las passkeys quedan atadas a él.

1. En el iPhone, vuelve a iniciar sesión en la app de Tailscale (la clave de ese dispositivo
   caducó) y activa **VPN On Demand**, para que esté siempre activa al salir de casa.
2. En el Mac, instala Tailscale si quieres probar desde ahí.
3. No hace falta auth key: en el primer arranque el contenedor muestra un enlace de inicio de sesión (paso 4).

## 2. Fork

Haz el fork en GitHub, sube esta carpeta y añade el original como `upstream`:

```bash
git remote rename origin upstream
git remote add origin https://github.com/<tú>/openGym.git
git push -u origin main
```

GitHub deja las Actions desactivadas en un fork. Si las activas, deja fuera `mirror.yml`, que
empuja al GitLab del autor y necesita sus secretos.

## 3. Crear el LXC en Proxmox

```bash
scp -r homelab/proxmox root@<pve>:/root/opengym-proxmox
ssh root@<pve> 'REPO_URL=https://github.com/<tú>/openGym.git /root/opengym-proxmox/create-lxc.sh'
```

Variables opcionales: `CTID`, `ROOTFS_STORAGE` (por defecto `local-lvm`), `BRIDGE` (`vmbr0`),
`BACKUP_HOST_DIR` (carpeta del host, por ejemplo un NAS montado, donde caen los backups; tiene que
poder escribirla el uid 100000 del host).

## 4. Arrancar

Dentro del LXC (`pct enter <CTID>`):

```bash
cd /opt/opengym
docker compose pull && docker compose up -d
docker compose logs -f tailscale    # muestra "To authenticate, visit: https://login.tailscale.com/a/…"
```

1. Abre ese enlace con tu cuenta y aprueba la máquina `opengym` **antes de un minuto**. Pasado
   ese tiempo, el arranque del contenedor reinicia y genera un enlace nuevo. Un enlace aprobado
   tarde deja una máquina `opengym` huérfana: bórrala en el admin antes de reintentar, o la buena
   se registrará como `opengym-1`. Para reintentar:
   `docker compose up -d --force-recreate tailscale web`.
2. En el admin de Tailscale, en la máquina `opengym`: **⋯ → Disable key expiry**. Sin esto, a los
   180 días se desconecta.

Comprobación desde un dispositivo con Tailscale (la primera petición tarda unos segundos mientras
se emite el certificado):

```bash
curl https://opengym.tailff2e2.ts.net/api/health
```

## 5. Perfil

1. En el iPhone, con Tailscale activo, abre la URL en Safari y **crea el perfil con passkey**. Al
   ser el primero, queda como admin.
2. Ajustes: comprueba que la unidad es **kg** y pon una **contraseña**, que sirve de respaldo.
3. Cierra la instancia: descomenta `INVITE_ONLY=1` y `ALLOW_GUEST=0` en `.env` y ejecuta
   `docker compose up -d`.
4. Safari → Compartir → **Añadir a pantalla de inicio**, y activa los recordatorios (en iOS la
   push solo funciona desde la app de la pantalla de inicio).

## 6. Migrar desde Strong

1. En Strong: **Settings → Export Data** y guarda el CSV en el Mac.
2. Ensayo, sin tocar nada:
   ```bash
   node homelab/check-strong-csv.mjs ~/Downloads/strong.csv kg
   ```
   Revisa los emparejamientos: la búsqueda es aproximada y alguno puede caer en una variante que
   no es. Lo que no reconoce se crea como ejercicio personalizado.
3. Importa en **Ajustes → Datos y copia → Importar desde otra app** (más cómodo desde el Mac).
4. Las **rutinas no se importan**: créalas en **Plan** y asigna a cada ejercicio su regla de progresión.
5. Durante la transición puedes repetir la exportación y la importación. Los días que ya tienen
   entreno en openGym se saltan, así que no se duplica nada.

## 7. Backups y restauración

- El cron `/etc/cron.d/opengym-backup` ejecuta `backup.sh` a las 03:30 y lo deja en
  `/var/backups/opengym`.
- Añade el LXC a los backups de Proxmox (vzdump o PBS). Así quedan cubiertos también
  `tailscale-state/` (la identidad del nodo) y `.env`.
- Prueba a restaurar al menos una vez:
  ```bash
  docker compose down
  tar xzf /var/backups/opengym/opengym-<fecha>.tar.gz
  docker compose up -d
  ```
- Lo crítico es `data/secret`: si se pierde, se cierran todas las sesiones.

## 8. Actualizar

```bash
git pull upstream main && git push         # o fusiona upstream en tu rama
# sube OPENGYM_VERSION en .env tras leer las release notes
docker compose pull && docker compose up -d
```

## Problemas conocidos

- **El hostname cambia a `opengym-1`**: el nodo se registró dos veces porque `tailscale-state/`
  se perdió. Borra la máquina antigua en el admin, renombra la nueva a `opengym` y reinicia.
  Si el nombre no coincide con `RP_ID`, las passkeys no funcionan; entra con la contraseña.
- **Docker no arranca contenedores en el LXC**
  (`open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied`): el runc
  de noviembre de 2025 choca con el AppArmor de `lxc-pve` antiguo. Se corrige con `lxc-pve`
  ≥ 6.0.0-2 en Proxmox 8 (fix #7006):
  `apt install --only-upgrade lxc-pve` en el host y `pct reboot <CTID>`.
  Ocurrió en `bombahouse` el 2026-10-12.
- **`tailscale serve` no responde en modo userspace**: pon `TS_USERSPACE=false` en el overlay,
  añade `devices: [/dev/net/tun]` y `cap_add: [NET_ADMIN]`, y pasa el tun al LXC
  (`lxc.cgroup2.devices.allow: c 10:200 rwm` y `lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file`).
