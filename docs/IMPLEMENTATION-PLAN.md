# Plan de implementación y publicación

U1/T2 (2026-11-03): el binario GUI final pasó 606.311 s, 96 sondeos
RAM/píxeles, diez restores/diez resets y cierre de 21 stdio y su emulador.
Recursos dentro de límites. Ver `release/ui-control-soak-600-20261103-ports/validation.json`.

U1 (2026-11-03): siete herramientas de control GUI por MCP, con servicio Qt
independiente de la VM, snapshots/identidad/recibos y capturas. Pasaron 15 grupos
GUI reales y cinco del asistente inicial: campos, menús, archivos/modelos,
depurador y ediciones EE de condición/logging/max-hits con marcador intacto y
estado nativo preservado. Big Picture: F1/About y Settings por ratón verificados
visualmente; captura D3D11 después de ImGui, sin fallback al escritorio.
302 Node y 74 regresiones nativas pasaron; integración consistente en 35 archivos.
Puerto GUI independiente 21513/PCSX2_UI_PORT, sin derivarlo del debug/PINE.
Actor `mcp_qt_ui`, sin Computer Use ni SMS/Jellyfin. Sigue IOP en vuelo y
reemplazo durante source-step; no se acepta cada pantalla/renderer/hardware.
[Contrato, comandos y límites](application-ui.md). Los avisos de Computer Use
anteriores se conservan como historia, ya no son requisito para esta ruta.

Actualizado: 2026-11-03. Autorizado por el usuario: implementar las mejoras del
estudio de forks y después continuar el plan original de depuración PS2.

## Regla de entrega

Cada paso terminado debe tener su propio commit con comportamiento, evidencia
y límites, y pasar a **`main` de `https://github.com/michaaels/PCSX2-MCP`**.
Validar antes de publicar y comprobar el HEAD remoto después. No basta con dejar
el avance en una rama de trabajo. No publicar pruebas fallidas como aceptadas ni
incluir BIOS, credenciales, contenido privado o artefactos locales de ejecución.
Conservar autoría/revisiones de cualquier código adaptado de los forks.

## Prioridad actual: MCP independiente

L1R (2026-11-02): 11 grupos lifetime y 12 bindings pasaron en el binario actual
S4a/2.9.147 con el fixture/BIOS local: cargas y registro reales, re-registro,
servicio fallido, SifIopReset/Sync, reset MMIO, restore y revocación de watches.
El harness distingue ahora rechazo por identidad VM antigua y por lifetime IOP
antiguo tras restore; el primer fallo de expectativa se conserva aparte.
Runtime intacto. [Evidencia y límites](iop-lifecycle-validation.md).
S4b Qt continúa pendiente de entrada modal; otras BIOS/loaders/custom/SIF no
quedan aceptados por esta repetición acotada.

S4b-prep (2026-11-02): nueva matriz supervisada de condición/logging/max-hits
con marcador original intacto y comparación exacta de opciones. Pasaron cinco
controles nativos/MCP de preparación y tres del helper; no hay aceptación GUI.
Computer Use vuelve a listar ventanas y abrir Edit, pero el diálogo no admite
entrada verificable (geometría/caché y foco sin cambio), también tras reset.
El usuario prefiere restablecerlo de nuevo. Instancias propias cerradas;
runtime S4a/T2R intacto. Sigue S4b real, IOP y source-step.
[Guía, comandos y límites](qt-options-gui.md).

T2R (2026-11-02): repetida la aceptación sostenida con el binario actual S4a,
después de los cambios nativos F5b/S4a: 604.097 s, 96 sondeos RAM/píxeles,
481.732 s en ventanas de ejecución, diez restore/diez reset y 21 stdio cerrados.
Picos nativos 1035.06 MiB privados/594 handles, crecimiento final 102.43 MiB
dentro de límites. Control de guest pausado rechazado y cerrado. Sin cambios
de runtime/harness ni repetición local de los 295 Node de S4a. [Evidencia](sustained-validation.md).
Sigue S4b Qt real cuando se restablezca Computer Use; no retomar SMS ni hardware.

S4a (2026-11-02): condiciones de puntos validadas antes de mutar; corregido un
falso éxito reproducido que creaba/alteraba puntos con expresiones inválidas.
Las seis herramientas básicas seleccionan EE/IOP y muestran condiciones/opciones
nativas. Pasaron 295 Node, 13 grupos nuevos, cuatro de compatibilidad con el
build F5b y 74 de regresión nativa (60 autónomos/seis DAP/ocho savestate).
Tres grupos negativos reprodujeron el fallo anterior; no cuentan como aceptación.
Integración consistente en 29 archivos. [Contrato](conditional-points.md).
**Sigue S4b GUI real**: Computer Use no conecta su pipe nativo (error 2 también
tras reset); el usuario eligió restablecerlo. No hubo nuevas ediciones Qt ni se
aceptan sus condiciones/logging/max-hits/IOP a partir de estas pruebas API.

F5b (2026-11-02): grabación/replay desde savestate implementados en el pin
2.9.147. Guardado asíncrono confirmado tras cierre ZIP, espera pausada hasta
verificación, copias exclusivas con SHA nativo antes de cargar y outcome real.
Pasaron 289 Node y ocho grupos nuevos nativos/MCP: RAM restaurada, observadores,
dos mandos/EOF/un frame, errores de guardado/carga, cancelación y completion
tardía. Corregido el puntero Error nulo del reproductor en el camino fallido.
Once regresiones power-on, 60 autónomas y seis DAP pasaron en el build final
(85 checks nativos en total). Procesos propios cerrados;
publicación/CI por SHA en el recibo. [Contrato](input-state-movies.md).
Sigue auditar/ampliar las coberturas locales pendientes GUI/IOP y límites de
loader/reset/BIOS; la validación física conserva su gate de hardware separado.

F5a (2026-11-02): verificador offline `pcsx2_input_state_inspect` añadido como
requisito de películas desde savestate. TypeScript/283 Node y cinco checks MCP
con un estado real 2.9.147 pasaron: SHA, ZIP finalizado, componentes, payloads
CRC/longitud y rechazo de corrupción. No carga VM ni modifica native.
**Sigue F5b**: confirmar guardado asíncrono y conectar inicio/replay con copias
privadas, outcomes e invalidaciones reales. El modo desde estado aún se rechaza.
[Contrato y evidencia](input-state-inspection.md).

D2 (2026-11-02): etapa 7 aceptada en Windows/EE con VS Code 1.144.0. VSIX
instalado en perfil nuevo; `launch.json` con variables/mapeos y ajustes locales
del adaptador. Cuatro grupos reales de editor/MCP pasaron, 278 Node y seis
regresiones DAP. Detach sale 0 y conserva PCSX2 pausado; procesos propios cerrados.
Native intacto. CI/publicación por SHA en el recibo. [Contrato](editor-integration.md).
Sigue ampliar cobertura acotada: películas iniciadas desde savestate con
compañero validado/copiado y guardado asíncrono finalizado. Hardware queda
separado y necesita consola/transporte reales; no retomar SMS automáticamente.

D1 (2026-11-01): adaptador DAP stdio añadido sobre los backends existentes.
TypeScript/272 Node y seis grupos nativos pasaron: breakpoint/fuente, GPR/RAM/
argumento contrastados con MCP, stepping de instrucción/fuente, invalidación
por reset y preservación de ownership al desconectar. Dos adaptadores, MCP y
emulador propios cerrados. Native/MCP existentes no cambian. Sigue **D2**:
configuración reutilizable y sesión real desde VS Code; etapa 7 aún abierta.
[Contrato y evidencia](dap.md).

T2 (2026-11-01): pasaron 604.884 s con 104 sondeos de contador RAM/píxeles GS,
521.908 s en ventanas de ejecución y 20 recuperaciones: diez restore y diez
reset, con reconexión nativa/reinicio stdio mientras el guest seguía ejecutando.
Recursos dentro de presupuestos, 262 Node pasaron y el control con guest pausado
fue rechazado. Cerrados el emulador y sus 21 hijos MCP. Sin cambios del runtime.
CI y publicación se registran por SHA en el recibo. [Contrato](sustained-validation.md).
Después sigue la etapa 7 original: DAP y sesión real desde el editor, con
breakpoint/fuente/datos contrastados contra MCP y mapeos de fuentes explícitos.

T1 (2026-10-30): repetición acotada y CI de fuentes. Pasaron 100 y 500 ciclos
en instancias nuevas: 600 reemplazos de socket, 60 rondas de timeout/punto
ajeno/reinicio stdio/captura PNG, 62 servidores stdio y dos emuladores cerrados.
Build TypeScript y 260 Node pasaron; fixture alterado rechazado antes de lanzar.
Workflow Node 22 Windows/Ubuntu con `npm ci`/`npm test`, permisos de lectura y
acciones fijadas por SHA. Runtime sin cambios; CI nativa/BIOS no incluida.
Los bucles midieron 13.117 y 71.345 s, sin aceptación de soak prolongado ni
ausencia de fugas. [Comandos, evidencia y siguiente T2](stability-ci.md).
La primera CI pasó Ubuntu y detectó dos expectativas de ruta temporal 8.3 en
Windows; se canonicalizan los directorios de esos fixtures sin relajar asserts.
Acciones v6 fijadas por SHA usan Node 24; el proyecto se prueba con Node 22.
El cierre CI del 2026-11-01 conserva la validación local de 260 pruebas y
registra los resultados remotos del commit final en el recibo de entrega.
Sigue T2: duración sostenida, progreso renderizado, recursos y límites de
fallo/artefactos; después reset/restore bajo carga y DAP sobre lo acreditado.

S2b2c2 (2026-10-30): repetida y aceptada la sustitución real desde Qt del
breakpoint privado durante `step_over` EE. Tres checks guiados pasaron:
control sin edición, preservación con error de ownership y confirmación del
actor Computer Use. Misma sesión/epoch/CPU pausada, captura del depurador
revisada y proceso propio cerrado. Native/Node no cambian. Se aceptan este
caso y el grupo de fuente pausado S2b2c1; opciones GUI/IOP/source-step más
amplias conservan cobertura pendiente. Sigue estabilidad/CI sobre capacidades
acreditadas, antes de DAP. [Reproducción y límites](inflight-gui-ownership.md).
Los apartados anteriores por entrega conservan su estado histórico.

Cambio autorizado el 2026-10-28: adaptar el MCP a **PCSX2 v2.9.147**, revisión
`4c3f2eaacbd181f201c094781a79b1d0f996f954`. Esta migración M1 precede a la
prueba GUI S2b2c. Mantener checkout/build/ejecutable separados de la instalación
oficial; validar integración, compilación y suites antes de aceptar/publicar.
Estado M1: compilado y probado en Windows. Pasaron 255 Node, 60 live autónomos,
53 regresiones adicionales y 27 archivos de integración. Replay GS aceptado con
software; D3D11 replay y prueba GUI conservan su gate pendiente.
[Contrato, comandos, evidencia y límites](pcsx2-2.9-migration.md).

M2 (2026-10-28): replay GS D3D11 acreditado con un fixture nuevo de dibujo
continuo y adaptadores Intel/NVIDIA explícitos. Pasaron 18 checks live; native y
runtime Node no cambian. El dump estático sin transferencias sigue sin frame
D3D11 y conserva la aceptación software. GUI se reintentó dos veces, con reset
del controlador, y falló antes de cualquier interacción. Sigue S2b2c;
estabilidad/CI/DAP permanecen después. [Evidencia y reproducción](gs-replay-validation.md).

S2b2c-prep (2026-10-29): prueba guiada estable por grupo de breakpoints de
fuente, con instancia privada `-debugger`, control explícito del operador y
resultado GUI separado del preflight. Pasaron cinco checks de preparación y
rechazo de confirmación sin cambio observado; **GUI no aceptada**. El módulo
de control ya importa, pero el pipe nativo no conecta (error 2), también tras
reset/reinicio. La edición manual puede seguir la [guía](gui-ownership-test.md).
No se ha probado el reemplazo GUI durante el paso acotado ni cerrado S2b2c.

S2b2c1 (2026-10-29): el usuario hizo la edición Qt real. Pasaron los cinco
checks guiados: se conservó `GUI-OWNED` en `0x00100220`, cleanup incompleto
explícito y segundo borrado rechazado con la CPU/identidad intactas. La instancia
propia se cerró. Solo se acepta el grupo de fuente pausado; reemplazo durante
step y otras opciones GUI siguen pendientes. Nueva prioridad del usuario:
añadir captura de la ventana de la aplicación/depurador al MCP.

S3 (2026-10-29), petición explícita del usuario: `pcsx2_application_screenshot`
captura ventana Qt principal/depurador del mismo proceso. Compilado en Windows,
260 Node, siete checks live nuevos, 60 regresiones autónomas y 29 archivos de
integración pasaron. PNG reales revisados; no depende del controlador externo
de ventanas ni modifica pausa/foco. [Contrato y límites](application-screenshots.md).

Petición del usuario (2026-10-24): probar el MCP sin depender de SMS; depurar el
proyecto en otro chat. **S1** entrega fixtures homebrew autónomos, un comando de
validación, 18 checks live y 223 Node, y corrige la fuga del breakpoint temporal
de `step`/`step_over`. [Contrato](standalone-validation.md) y [traspaso](MCP-HANDOFF.md).

S2a entrega selección EE/IOP, presupuesto nativo de ejecución y resultados
parciales de `step`/`step_over`: 231 Node y 32 live pasaron, sin SMS/Jellyfin.
El fixture IOP aísla IRQ; no acredita cualquier flujo de juego.
[Contrato](instruction-control.md).

S2b1 separa colas/respuestas/continuaciones por conexión y prueba reset y restore
reales: 247 Node y 37 live pasaron. Native permanece sin cambios.
[Contrato](connection-recovery.md).

S2b2a corrige el falso `Loaded` de PINE: carga nativa con resultado real,
identidad guardada y último recibo consultable; PINE solo confirma envío.
Windows/TypeScript, 255 Node, 45 live y 26 archivos de integración pasaron.
[Contrato y límites](state-load-outcomes.md).

S2b2b reproduce y corrige el despacho IRQ posterior a una pausa IOP y añade
cancelación tras envío real/recuperación de una respuesta de restore perdida.
Windows/TypeScript, 255 Node, 53 live, 13 regresiones IOP adicionales y
26 archivos de integración pasaron. [Contrato](irq-pause-boundary.md).

El gate GUI tiene ahora dos casos aceptados: grupo de fuente pausado y
reemplazo durante `step_over` EE, descritos arriba. La
cancelación después de enviar ya tiene prueba real de resultado/consulta,
pero no interrumpe ni revierte el cargador nativo síncrono: esa capacidad se
mantiene diferida y requiere un límite de cancelación soportado por el core.
Después siguen estabilidad/CI y DAP sobre capacidades acreditadas. La
corrección SIF2/audio del cliente queda como backlog de aplicación, sin aceptación
nueva ni cambio del transporte DMA. No retomarla automáticamente al continuar MCP.

## Secuencia

Contexto del proyecto, aclarado por el usuario (2026-10-24): Jellyfin remoto
en Atom con 1 GB de RAM puede sufrir cortes por capacidad; no es causa probada.
La suite autónoma no lo usa ni lo mide. El Bridge del PC recibe el original estático y realiza
FFmpeg localmente. Mantener pruebas cortas y seriales; no asumir capacidad de
transcodificación ni métricas CPU/RAM del servidor que no se hayan medido.

| Paso | Trabajo | Estado |
|---|---|---|
| U1 | Control de la GUI desde MCP, incluida captura ImGui D3D11 | Siete herramientas; 15 grupos GUI/cinco wizard, 302 Node/74 regresiones; EE Qt options aceptadas, siguen IOP en vuelo/source-step y mayor cobertura de pantallas/renderers |
| L1R | Vida de módulos IOP en el runtime 2.9.147 actual | 11 lifetime/12 bindings pasaron; guardas VM/lifetime independientes tras restore; cobertura observada, otras BIOS/custom/SIF pendientes |
| S4b-prep | Matriz Qt de opciones con marcador intacto | Cinco controles nativos/MCP y tres del helper; GUI no aceptada, entrada modal de Computer Use pendiente |
| T2R | Revalidar duración/recuperación con native F5b/S4a | 604.097 s/96 sondeos/20 recuperaciones, recursos en límites y 21 stdio cerrados; runtime idéntico a S4a. GUI sigue S4b |
| S4a | Condiciones atómicas y selección EE/IOP en puntos MCP | 295 Node; 13 grupos nuevos, cuatro de compatibilidad y 74 regresiones; fallo previo reproducido. Sigue S4b con ediciones Qt reales, controlador sin conexión |
| F5b | Guardado confirmado y películas desde savestate | 289 Node/ocho grupos nativos/MCP y once power-on pasaron; SHA antes de cargar, RAM/outcomes/EOF y fallos reales. Sin rollback, determinismo ni asociación ELF embebida |
| F5a | Verificación offline de compañero savestate | 283 Node/cinco checks MCP con estado real; ZIP/payloads/SHA verificados. No habilita inicio desde estado; sigue F5b nativo |
| D2 | Integración reutilizable y sesión real VS Code | Cuatro grupos editor/MCP, 278 Node, seis regresiones nativas DAP y VSIX instalado. Etapa 7 aceptada solo en Windows/EE; sigue savestate-start input movies |
| D1 | Adaptador DAP sobre capacidades acreditadas | 272 Node, seis grupos con DAP/MCP/PCSX2 reales y empaquetado comprobados. Falta D2 editor real; etapa 7 no cerrada |
| T2 | Duración, progreso renderizado, recursos y recuperación bajo carga | 604.884 s, 104 sondeos, diez restore/diez reset y 21 stdio cerrados; 262 Node y control de stall. Sin aceptación multi-hora/fugas. Sigue DAP/editor |
| T1 | Repetición acotada y CI de fuentes | 100+500 ciclos live, 60 rondas de recuperación/captura y 260 Node; runtime intacto. Workflow Windows/Ubuntu; estado remoto por SHA. Sigue T2 de duración/recursos |
| S2b2c2 | Reemplazo Qt durante `step_over` EE en fixture autónomo | Tres checks guiados y captura real verificados; sesión/pausa preservadas; runtime sin cambios. Otras opciones/IOP/source-step pendientes; sigue estabilidad/CI acotada |
| S3 | Captura de ventana principal/depurador con widgets Qt | Windows/TypeScript, 260 Node, siete checks live, 60 regresiones y 29 archivos probados |
| S2b2c1 | Edición GUI real de grupo de fuente pausado | Cinco checks guiados pasaron con confirmación del usuario; caso EE durante step aceptado después en S2b2c2; otras opciones pendientes |
| S2b2c-prep | Harness guiado para preservar un grupo modificado manualmente en Qt | Cinco checks de preparación/negativos probados; edición GUI y reemplazo durante step pendientes |
| M2 | Fixture de dibujo continuo y comparación GS replay con dispositivo D3D11 explícito | 18 live probados en Intel/NVIDIA; binarios sin cambios; limitación estática y gate GUI pendientes |
| M1 | Migrar a PCSX2 v2.9.147 fijado y adaptar memoria, watchpoints, backtrace, identidad ELF y FFmpeg | Windows/TypeScript, 255 Node, 60 live, 53 regresiones y 27 archivos probados; GS replay software; GUI y replay D3D11 pendientes |
| S2b2b | Pausa IOP con IRQ activa y reconciliación tras cancelar/perder respuesta de restore | Windows/TypeScript, 255 Node, 53 live, 13 regresiones IOP y 26 archivos probados; GUI pendiente por fallo del runtime; interrupción/rollback nativos diferidos |
| S2b2a | Resultado real de carga de estado y último recibo consultable | Windows/TypeScript, 255 Node, 45 live y 26 archivos probados; GUI e interrupción nativa pendientes |
| S2b1 | Generaciones de conexión, reset y restore reales | 247 Node y 37 live probados; native sin cambios; GUI/restore fallido/IRQ IOP pendientes |
| S2a | Avance EE/IOP con deadline, guardas nativas y resultados parciales | Windows/TypeScript, 231 Node, 32 live y 26 archivos de integración probados; IRQ IOP aislada en fixture |
| S1 | Validación del MCP con homebrew independiente; cleanup propio de step/step-over | Windows/TypeScript, 223 Node, 18 live y 26 archivos de integración probados; sin SMS/Jellyfin |
| F1 | Puertos por proceso, directorios de datos independientes y aislamiento de sockets/sesiones; dos instancias Windows | Implementado y probado; incluido en main con esta entrega |
| F2 | GS dumps acotados con identidad, estados y archivos verificables | Implementado y probado; incluido en main con esta entrega |
| F3 | Captura vídeo/audio con propiedad, límites y finalización comprobada | Implementado y probado; incluido en main con esta entrega |
| F4 | Observadores de cambios de memoria EE/IOP en el hilo CPU | Implementado y probado; incluido en main con esta entrega |
| 5A2a | Asociar candidato IRX/fuentes por imagen relocada inmutable en pausa | Implementado y probado en 0xff80; no prueba archivo original completo ni generación |
| 5A2b | Procedencia del archivo realmente cargado y cobertura adicional IRX/imports/exports | Implementado y probado para HostFs/0xff80 y exports acotados; otros dispositivos/dialectos pendientes |
| 5A3 | Vida de módulos e invalidación ante recarga, SifIopReset y savestates | 5A3a/5A3b implementados y probados en caminos observados; generaciones acotadas, revalidación y corte de watches IOP; cobertura directa/custom pendiente |
| F5 | Grabar/reproducir `.p2m2`, exclusión de entradas y parada al final | Power-on y, mediante F5a/F5b, inicio desde savestate probados en Windows/2.9.147; otros formatos/multitap/determinismo no aceptados |
| 5B | Correlación del proyecto | 5B1, 5B2a y 5B2b probados: transporte real y contexto CPU/fuentes del error del actualizador en HostFs; E11/audio pendientes |
| 6–8 | Regresión, DAP y validación física | 6A/6B1 probadas; 6B2a reproduce silencio/bloqueo y localiza espera SIF2. 6B2b1 observa SIF/PGIF y la escritura BCR sin efecto; sigue 6B2b2: investigar/corregir ACK y aceptar reproducción; después estabilidad/CI/DAP/hardware |

La dependencia de F5 evita invalidar silenciosamente la depuración existente al
resetear/cargar estados. No es necesario cambiar de versión PCSX2 para comenzar:
M1 cambia el pin a v2.9.147 por petición explícita del usuario; los resultados
v2.6.3 se conservan como históricos. El detalle técnico de candidatos y aceptación está en
[la revisión de forks](fork-review-2026-10-21.md); el plan original vive en
`D:\dev\PS2\ps2_multinet\docs\DEBUG-ROADMAP.md`.

## Registro

- Base recibida: `26b5d06`, con las extensiones y la validación descritas en
  [development-status](development-status.md) y [debug-validation](debug-validation.md).
- Revisión de forks: documentación previa, sin cambios de runtime.
- F1: TypeScript y Windows v2.6.3 compilados; 94 pruebas Node, 7 comprobaciones
  live de instancias y 11 de regresión de automatización pasaron. Integración
  limpia/upgrade/reaplicada y checkout de build coinciden en 15 archivos.
  Contrato, límites y reproducción en [automation](automation.md#independent-instances).
- F2: Windows v2.6.3 compilado, 102 pruebas Node, 8 comprobaciones live de
  captura/propiedad/límites/reset y replay nativo con PNG; 11 de regresión de
  automatización. Integración limpia/upgrade/reaplicada/build coincide en 18
  archivos. [Contrato y reproducción](gs-dumps.md).
- F3: compilación Windows y TypeScript, 110 pruebas Node y 8 comprobaciones live
  de vídeo/audio, límites, propiedad y reset. ffprobe decodificó 60 frames H.264
  y audio AAC estéreo; audibilidad/sincronía no medidas. Pasaron 8 checks GS y
  11 de automatización como regresión. Integración consistente en 20 archivos;
  runtime oficial FFmpeg 8 fijado y verificado. [Contrato](media-capture.md).
- F4: Windows y TypeScript compilados, 117 pruebas Node, 10 comprobaciones live
  de cambios reales EE/IOP, identidad, máscaras, propiedad, límites y reinicios.
  Pasaron 10 checks de progreso y 13 de excepciones/módulos IOP como regresión.
  Integración consistente en 20 archivos. Hasta 16 observadores en hilo CPU,
  TTL, pausa opcional y pares inmutables; PC del escritor desconocido. Medición
  acotada de coste, sin garantía general de rendimiento. [Contrato](memory-change-watches.md).
- 5A2a: Windows/TypeScript compilados, 127 pruebas Node, 10 checks live de
  asociación por código y fuentes DWARF2 IOP, más 13 de excepciones/módulos y
  10 de observadores como regresión. Integración consistente en 20 archivos.
  No se guardan bindings reutilizables. [Contrato y límites](irx-source-association.md).
- 5A2b: Windows/TypeScript compilados, 136 pruebas Node y 11 checks live de
  procedencia HostFs, buffer completo loadcore, registro, exports, fuentes,
  propiedad e invalidación. Pasaron 10 checks IRX, 13 de excepciones/módulos IOP
  y 10 de observadores como regresión. Integración consistente en 20 archivos.
  `load_watch_id` permite comprobar imagen inicial completa y SHA del archivo
  observado; solo sirve en la primera pausa posterior, sin generación reutilizable.
  Otros dispositivos/dialectos permanecen pendientes. [Contrato](iop-load-provenance.md).
- 5A3a: época conservadora `iop_lifetime_epoch` e historial de 64 límites
  observados en hilo CPU, herramienta `pcsx2_iop_lifetime` y guardas para
  módulos/imágenes/inicio de procedencia. Registro/retiro, paquetes estándar
  SIF de reset, restore y mutaciones no se convierten en generaciones de módulo.
  Windows/TypeScript compilados, 142 pruebas Node, 11 checks nuevos y 44 de
  regresión; integración consistente en 21 archivos. [Contrato](iop-lifetime.md).
- 5A3b (2026-10-23): generaciones de registro observado con namespace nativo,
  secuencia, ID y metadatos sellados; vínculos explícitos con procedencia inicial
  y revalidación completa de archivo/código/fuentes en cada uso. Modload y otras
  fronteras revocan tracking; watches IOP pendientes terminan como
  `lifetime_changed`. Windows/TypeScript compilados, 152 pruebas Node, 12 checks
  nuevos y 55 de regresión; integración consistente en 21 archivos.
  [Contrato y límites](iop-bindings.md). No se anuncia tracking universal.
- F5 (2026-10-23): grabación/replay `.p2m2` power-on con ID, límites, copia
  privada de solo lectura, parada en EOF y exclusión de entradas/stepping y
  mutaciones. Reset/restore invalidan película, inspección EE y observadores;
  guardas IOP mantienen el alcance observado. Windows/TypeScript compilados,
  163 pruebas Node, 11 checks nuevos y 33 de regresión; integración consistente
  en 25 archivos. [Contrato](input-movies.md). Inicio desde savestate, otros
  formatos y determinismo de red permanecen pendientes.
- 5B1 (2026-10-23): inventario verificado de identidades/relojes SMS, relay
  UDPFS, Bridge y MCP; captura nativa de solo lectura y asociación offline por
  build/boot/sesión/secuencia/campos exactos, sin logs arbitrarios ni secretos.
  Hashes de manifiesto/ELF/captura/JSONL, pérdidas/ambigüedad explícitas y relojes
  separados con incertidumbre no acotada. TypeScript y 174 pruebas Node pasaron;
  7 checks nuevos con SMS real/recibo Bridge sintético/journal histórico y 11 de
  replay como regresión. Native/Bridge no cambiaron ni se recompilaron.
  [Contrato y evidencia](project-diagnostics.md).
- 5B2a (cierre 2026-10-24): harness de transporte real con journal nuevo,
  copia privada del ELF, Ethernet/HostFs aislados y limpieza de instancia propia.
  Jellyfin 12.2.0 y usuario dedicado verificados; cuatro eventos del mismo
  build/boot asociados, incluido ERROR `update_path_failed`. Cuatro checks live,
  ausencia de Bridge con fallo esperado y rechazo previo de journal histórico.
  No cambia runtime; no se repiten builds/suites anteriores. El proyecto añade
  un comando de orquestación con `.env` local y recibo de servicios.
  [Contrato, evidencia y límites](project-diagnostics.md#5b2a-fresh-sms-transport-acceptance).
- Revalidación 5B2a en Linux (2026-10-24): endpoint activo indicado por el usuario,
  Jellyfin 12.2.0 y credenciales locales verificadas. El mismo harness pasó
  cuatro checks con otros cuatro recibos reales y boot nuevo; servidor externo
  conservado en ejecución. Solo cambió la URL del `.env` local del proyecto;
  sin cambios de runtime ni nueva aceptación A/V/hardware.
  [Evidencia y reproducción](project-diagnostics.md#revalidation-against-the-users-linux-jellyfin).
- 5B2b (2026-10-24): receta opcional `--incident` en el comando del proyecto.
  Breakpoints por fuente, estáticas por DWARF contrastado con symtab, lectura
  efectiva de la guarda, llamada JAL/argumento real y contexto EE/IOP se unieron
  al ERROR posterior del mismo build/boot contra Jellyfin Linux. Ocho checks
  live, cuatro de transporte como regresión y cuatro rechazos de metadatos.
  No cambia runtime ni modifica código/registros/datos guest; la ejecución se
  pausa y reanuda explícitamente. [Contrato y evidencia](project-incidents.md).
- 6A (2026-10-24): `pcsx2_compare_screenshots` offline y acción de escenario
  `assert_screenshot`, con SHA de referencia/ELF, tolerancias por canal/fracción,
  regiones/máscaras, diff e informe conservados. Guardas de época y diagnóstico
  de fallo; codec PNG fijado con límites de formato/tamaño/descompresión.
  TypeScript, 193 pruebas Node, diez checks visuales live y siete regresiones
  workflow pasaron. El fallo controlado altera una referencia PNG, no el guest.
  Native/Bridge sin cambios ni recompilación. [Contrato](visual-regression.md).
- 6B1 (2026-10-24): `pcsx2_analyze_capture_audio` offline con SHA del MP4,
  snapshot/PCM/JSON conservados y RMS/pico/DC/ventanas de silencio por canal.
  Sin normalización/downmix/conversión de frecuencia; diez segundos decodificados
  y un análisis concurrente. Build TypeScript, 208 pruebas Node, diez checks
  AAC/MCP y diez checks nativos de captura/medición/regresión pasaron. El menú
  SMS capturado tiene PCM cero; no valida sonido de reproducción. Criterios y
  límites en [medición de audio](audio-measurement.md). Native/Bridge sin cambios.
- 6B2a (2026-10-24): receta real con selección por mando, IDs/estáticos DWARF,
  fuente/ELF/clip exactos, captura temprana/tardía y relojes del reproductor.
  El clip preparado por Jellyfin Linux coincide por SHA; ambas capturas dan
  PCM cero y los relojes dejan de cambiar. Otra ejecución verifica la llamada
  a WaitSema y no alcanza el marcador siguiente a la primera espera SIF2 en diez
  segundos. Las pruebas de reproducción conservan fallo; siete checks aceptan
  solamente integridad de evidencia. Build TypeScript, 215 Node, ocho controles
  DWARF y cuatro regresiones de transporte pasaron. [Contrato](sms-playback-audio.md).
- 6B2b1 (2026-10-24): `pcsx2_sif_snapshot`, estado pausado SIF0/1/2/SBUS/PGIF
  e historial de 64 escrituras DMA reales con ancho y palabras antes/después.
  Dos ejecuciones SMS observan escritura alta BCR de 16 bits sin cambio del
  backing; SIF2/PGIF queda detenido y el PCM continúa cero. No se modifica
  transporte DMA ni SMS/Bridge/decodificadores. Windows y TypeScript compilan;
  223 Node, integración de 26 archivos, cinco checks live y 12 de evidencia
  pasan. La reproducción sigue fallida. [Contrato y límites](sif-diagnostics.md).
- S1 (2026-10-24): suite independiente y corrección de `step`/`step_over`, sin
  tocar SMS/Bridge/DMA. Los fixtures de EE/IOP distinguen límite del emulador de
  observación correcta del MCP. Build Windows, 223 Node, 18 live y 26 archivos
  de integración pasaron. El helper IRX conserva bytes del modo previo.
  [Evidencia y límites](standalone-validation.md).
- Backlog de aplicación, para el otro chat: **6B2b2**, investigar la confirmación de
  cabecera SIF2 con evidencia IOP/PCSX2, después aceptar el clip reproducido con
  audio y repeticiones. Escucha/sincronía/hardware siguen pendientes.
  El recorrido del ERROR en HostFs queda probado;
  E11/audio/hardware y causas de otras incidencias conservan aceptación propia.
  Mantener límites del replay y de loaders/reboots/BIOS observados. Cada paso
  requiere publicación validada en main.
