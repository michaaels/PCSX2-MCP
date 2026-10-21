# Revisión de forks de PCSX2-MCP

Fecha: 2026-10-21. Estado: **revisión de código; ninguna función importada**.

## Alcance y revisiones

Se compararon los cambios de cada fork respecto a `origin/main` (`8f9bf45`)
y las capacidades de nuestra rama `feat/screenshot-tool` en
`26b5d0636339a91cb71381ca866aeba73a0b006c`. Se revisaron cliente TypeScript,
servidor nativo, hooks de integración y scripts. El grafo de código se indexó
para los tres forks y se contrastaron las APIs pertinentes con nuestro PCSX2
v2.6.3 (`bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`).

| Fork | Revisión fijada | Cambios propios sobre la base | Evaluación |
|---|---|---|---|
| [christhepimp](https://github.com/christhepimp/PCSX2-MCP/tree/6d8163b9150166f578c3965e6ed12f57db4642d0) | `6d8163b` | 4 commits | Interfaces de mando/captura con stubs nativos. No aporta una implementación que sustituya a la nuestra. |
| [FastestMolasses](https://github.com/FastestMolasses/PCSX2-MCP/tree/fe9056c3f93207d1e3e18e60847b3d8271c3cedf) | `fe9056c` | 2 commits | Observación de cambios de memoria por sondeo, mando y registro de clientes Unix/macOS. Aprovechar la observación con otro manejo de hilos. |
| [Ryubara](https://github.com/Ryubara/PCSX2-MCP/tree/3fb80b89bf7fca22bfb2d5c3cddabe915745dec1) | `3fb80b8` | 8 commits | Puertos por instancia, vídeo/audio, GS dumps y grabación/reproducción de entradas. Principal fuente de mejoras. |

Las revisiones quedaron disponibles en refs locales `review-<autor>/*` y
worktrees ignorados bajo `release/fork-review/`. No se cambió `origin`, no se
ejecutaron instaladores de los forks y no se compilaron ni probaron sus binarios.
Las pruebas anteriores de nuestra rama no validan estas funciones nuevas.

## christhepimp: no incorporar los stubs

El [DebugServer.cpp publicado](https://github.com/christhepimp/PCSX2-MCP/blob/6d8163b9150166f578c3965e6ed12f57db4642d0/pcsx2-plugin/DebugServer.cpp)
contiene un `#error` que exige ejecutar un generador. Este descarga el
`DebugServer.cpp` de `hkmodd/main` sin fijar revisión e inserta ramas que devuelven
`ok:false`: no conectan con el mando ni con el renderer. Los nuevos tools se
inyectan con otro script; no están integrados directamente en `src/index.ts`.

Nuestra captura PNG y las entradas acotadas ya tienen implementación nativa y
validación propia. Copiar este servidor o sus scripts haría retroceder esas
capacidades. Decisión: conservar nuestras funciones y no importar este cambio.

## FastestMolasses: observar cambios de memoria

`watch_change`, `watch_list` y `watch_clear` mantienen valor anterior/nuevo,
contador y ciclo observado para EE/IOP, con tamaños de 1, 2 o 4 bytes. Hay límites
de 64 observadores e intervalos entre 1 y 1000 ms.

Es útil para flags SIF/RPC, contadores de red o estados del cliente. Complementa
nuestro detector de heartbeat estancado y los memchecks; **no identifica la
instrucción exacta que escribió**. Un cambio que ocurre y se revierte entre dos
muestras puede pasar inadvertido.

El [bucle del fork](https://github.com/FastestMolasses/PCSX2-MCP/blob/fe9056c3f93207d1e3e18e60847b3d8271c3cedf/pcsx2-plugin/DebugServer.cpp#L1190-L1243)
lee memoria y pausa directamente desde un hilo separado. No adoptarlo tal cual:
muestrear en el hilo CPU, validar RAM y alineación, ligar cada observador a la
identidad VM/ELF/reset, añadir caducidad/cancelación y conservar evidencia de la
observación sin atribuirle el PC de escritura.

Los cambios asociados a macOS usan APIs `Read8`/`Read32` y otra firma de
stackwalk; nuestra versión fijada emplea las firmas anteriores. El instalador
Unix y las instrucciones manuales no establecen compatibilidad de toda nuestra
extensión con macOS. El mando es mayormente redundante; conservar nuestro hook
posterior al sondeo de entradas y la restauración del estado.

## Ryubara: funciones aprovechables

Su preparación apunta a **PCSX2 v2.9.129**. Adaptar cada función a v2.6.3,
manteniendo nuestros contratos, en lugar de reemplazar `DebugServer.cpp` o
aplicar todos los commits sobre nuestra rama.

### Puertos por instancia

Los commits `c010c72` y `3fb80b8` añaden configuración nativa del puerto y defaults
`PCSX2_DEBUG_PORT`/`PCSX2_PINE_PORT`. El socket Windows usa `SO_EXCLUSIVEADDRUSE`.
Nuestra conexión ya acepta puertos explícitos, pero el lanzamiento y la
configuración nativa requieren coordinación para aislar varias instancias.

Adaptar configuración, cliente y launcher juntos. Invalidar las conexiones
viejas al cambiar de servidor; no reutilizar solo una bandera global de arranque
para clientes separados. Preservar localhost y la comprobación de identidad/PID.
Referencia: [configuración y hooks](https://github.com/Ryubara/PCSX2-MCP/blob/3fb80b89bf7fca22bfb2d5c3cddabe915745dec1/pcsx2-plugin/pcsx2-integration.patch),
[defaults](https://github.com/Ryubara/PCSX2-MCP/blob/3fb80b89bf7fca22bfb2d5c3cddabe915745dec1/pcsx2-mcp-server/src/index.ts#L32-L43).

### GS dumps

`pcsx2_gs_dump` (`3779165`) solicita de 1 a 300 frames con `GSQueueSnapshot` y
expone estados de cola/grabación/finalización. Esa API ya existe en v2.6.3.
Permite adjuntar un caso gráfico reproducible a un informe de error.

Usar un ID de operación, presupuesto temporal y estados terminales verificables.
Comprobar que el archivo terminó de escribirse y puede reproducirse. Evitar
depender de miembros internos del renderer para declarar éxito. Un GS dump no
demuestra el estado de audio, la causa de un fallo EE/IOP ni reproducción física.

La rama adicional `gs-dump` (`834bd041d333c85e11990f1930ea08cd1403b859`) no añade
otra función independiente: `main` ya contiene GS dumps y mejoras posteriores.

### Captura de vídeo/audio

`pcsx2_capture` (`81708a0`) llama a `GSBeginCapture`/`GSEndCapture` y consulta
estado, tiempo y pistas. Las APIs también existen en nuestro upstream fijado.
Es útil para incidencias visuales y de sincronía del cliente SMS.

Añadir límites de duración/tamaño, carpeta de salida, rechazo de sobrescritura,
propiedad de la captura y finalización verificable. No detener una captura
iniciada por la interfaz del usuario. Verificar el archivo, sus pistas y duración;
un flag de audio activo no acredita sonido audible ni sincronización correcta.

### Grabación/reproducción de entradas `.p2m2`

Los commits `6148044` y `974cf22` integran el sistema nativo de input recording,
incluyendo detener replay al final para evitar que PCSX2 pase a grabación.
`InputRecording::create/play/stop` existen en v2.6.3: la idea es adaptable.

El arranque puede resetear la VM o guardar/cargar savestates. Antes de adoptarlo
hay que completar la invalidación de módulos, fuentes, variables y observadores
en esos cambios de estado. Resolver exclusión con entradas MCP y grabaciones
de la GUI, identidad del ELF/build, límites, rutas y propiedad del archivo. La
reproducción de entradas no asegura determinismo de red, temporización o vídeo.

Referencia de las tres funciones:
[servidor nativo](https://github.com/Ryubara/PCSX2-MCP/blob/3fb80b89bf7fca22bfb2d5c3cddabe915745dec1/pcsx2-plugin/DebugServer.cpp#L1275-L1648).

### Conservar nuestras garantías al adaptar

El helper `runOnCpuThread` del fork puede devolver timeout mientras su callback
sigue en cola. Las nuevas operaciones deben usar cancelación antes de comenzar
y declarar incertidumbre si ya comenzaron, como nuestro `onCPU`.

Capturas PNG, mando, pausa y avance por frames ya existen en nuestra rama. No
reemplazar sus respuestas MCP, límites ni propiedad por interfaces distintas.
El script `prepare.ps1` usa una descarga mutable de dependencias y solo avisa
ante un SHA256 distinto. Si se reutiliza la idea, fijar versiones/artefactos y
abortar ante discrepancia; no actualizar automáticamente nuestro PCSX2.

## Incorporación propuesta y aceptación

Esta lista prioriza candidatos del estudio. **No cambia la siguiente etapa
5A2 del roadmap**, ni marca funciones como implementadas.

| Orden | Entrega candidata | Validación necesaria antes de anunciarla |
|---|---|---|
| 1 | Puertos configurables y aislamiento Windows | Dos instancias con directorios/configuración separados; colisión rechazada; cada cliente controla y captura su VM; parada/reinicio no deja clientes asociados a otra generación. |
| 2 | GS dumps acotados | Dump real válido y reproducible; VM pausada, renderer ausente, timeout y cancelación; ningún archivo parcial declarado finalizado. |
| 3 | Captura de vídeo/audio | Archivo real cerrado con pistas/duración comprobadas; límites y errores de encoder/disco; captura GUI preservada; criterio de audio/sincronía separado. |
| 4 | Observación de cambios EE/IOP | Cambios conocidos y ausencia de cambio; identidad invalidada al reset/recarga; lecturas en hilo CPU; cancelación y coste medidos. |
| 5 | Grabación/replay `.p2m2` | Después de resolver vida de módulos/savestates: grabar un recorrido, reproducir y detener en su fin, preservar el original y limpiar ante interrupción/reset. |

Para cada entrega: cambios TypeScript y parche nativo coherentes, pruebas de
contrato pertinentes, compilación Windows de v2.6.3 y aceptación live aislada.
Las pruebas sin BIOS deben seguir separadas de las pruebas de emulador. Ninguna
de estas incorporaciones acredita funcionamiento en una PS2 física.

Conservar licencias y atribución de commits al adaptar código; los tres forks
mantienen el archivo LICENSE de la base. No se propone un merge global.

## Resultado de esta revisión

Implementado: este análisis y sus referencias reproducibles.
Comprobado: diferencias Git, fuentes e interfaces del upstream fijado.
Pendiente: portar, compilar y probar las funciones candidatas. No se cambiaron
el servidor, el protocolo ni los binarios; no se repitieron pruebas de runtime
por una entrega exclusivamente documental.
