# Plan de implementación y publicación

Actualizado: 2026-10-24. Autorizado por el usuario: implementar las mejoras del
estudio de forks y después continuar el plan original de depuración PS2.

## Regla de entrega

Cada paso terminado debe tener su propio commit con comportamiento, evidencia
y límites, y pasar a **`main` de `https://github.com/michaaels/PCSX2-MCP`**.
Validar antes de publicar y comprobar el HEAD remoto después. No basta con dejar
el avance en una rama de trabajo. No publicar pruebas fallidas como aceptadas ni
incluir BIOS, credenciales, contenido privado o artefactos locales de ejecución.
Conservar autoría/revisiones de cualquier código adaptado de los forks.

## Secuencia

| Paso | Trabajo | Estado |
|---|---|---|
| F1 | Puertos por proceso, directorios de datos independientes y aislamiento de sockets/sesiones; dos instancias Windows | Implementado y probado; incluido en main con esta entrega |
| F2 | GS dumps acotados con identidad, estados y archivos verificables | Implementado y probado; incluido en main con esta entrega |
| F3 | Captura vídeo/audio con propiedad, límites y finalización comprobada | Implementado y probado; incluido en main con esta entrega |
| F4 | Observadores de cambios de memoria EE/IOP en el hilo CPU | Implementado y probado; incluido en main con esta entrega |
| 5A2a | Asociar candidato IRX/fuentes por imagen relocada inmutable en pausa | Implementado y probado en 0xff80; no prueba archivo original completo ni generación |
| 5A2b | Procedencia del archivo realmente cargado y cobertura adicional IRX/imports/exports | Implementado y probado para HostFs/0xff80 y exports acotados; otros dispositivos/dialectos pendientes |
| 5A3 | Vida de módulos e invalidación ante recarga, SifIopReset y savestates | 5A3a/5A3b implementados y probados en caminos observados; generaciones acotadas, revalidación y corte de watches IOP; cobertura directa/custom pendiente |
| F5 | Grabar/reproducir `.p2m2`, exclusión de entradas y parada al final | Implementado y probado desde power-on; inicio desde savestate pendiente |
| 5B | Correlación del proyecto | 5B1 y 5B2a probados: captura/asociación y cuatro eventos reales SMS/UDPFS/Bridge contra Jellyfin; sigue 5B2b con contexto de incidencia |
| 5C–8 | Diagnósticos medidos, regresión, DAP y validación física | Continuar el roadmap original |

La dependencia de F5 evita invalidar silenciosamente la depuración existente al
resetear/cargar estados. No es necesario cambiar de versión PCSX2 para comenzar:
se mantiene v2.6.3 fijado. El detalle técnico de candidatos y aceptación está en
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
- Siguiente entrega del plan original: **5B2b**, contexto CPU/fuentes/módulos de
  una incidencia seleccionada en el mismo build/boot. La observación de ERROR
  no diagnostica E11, audio ni reproducción; mantiene causa desconocida.
  Mantener límites del replay y de loaders/reboots/BIOS observados. Cada paso
  requiere publicación validada en main.
