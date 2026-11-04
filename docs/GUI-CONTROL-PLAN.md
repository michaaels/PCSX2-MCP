# Control de toda la GUI desde MCP — U1

U1/T2 (2026-11-03): el binario GUI final pasó 606.311 s, 96 sondeos
RAM/píxeles, diez restores/diez resets y cierre de 21 stdio y su emulador.
Recursos dentro de límites. Ver `release/ui-control-soak-600-20261103-ports/validation.json`.

Autorizado expresamente por el usuario el 2026-11-02. Objetivo: manejar la
interfaz Qt de PCSX2 desde el MCP sin depender de Computer Use, también antes
del arranque y después de detener una VM. Mantener el pin 2.9.147 y publicar
cada entrega validada en main de michaaels/PCSX2-MCP.

1. Servicio Qt independiente de la vida de la VM, enlazado solo a loopback,
   con puerto por instancia y datos de identidad del proceso/servicio.
2. Inspección acotada de ventanas, widgets, menús/acciones, pestañas, campos,
   botones, listas, árboles y tablas. Identificadores de snapshot y objetos
   vivos; rechazo de controles destruidos, deshabilitados o caducados.
3. Acciones semánticas y eventos Qt locales para los controles personalizados:
   activar acciones/botones, texto, checks, opciones, selección/edición de
   modelos, foco, teclas y ratón dentro del widget. Nunca entrada global al SO.
4. Acciones asíncronas con recibo consultable: abrir un diálogo modal no debe
   impedir responder ni inspeccionar/operar el diálogo nuevo. Una respuesta
   de envío no equivale a resultado visible verificado; sin reintentos ciegos.
5. Captura de cualquier ventana/diálogo Qt de la instancia sin necesitar VM.
6. Herramientas MCP con schemas, puertos e identidad explícitos; conservar las
   herramientas existentes de emulación/depuración.
7. Pruebas de protocolo, límites, identidad y acciones, integración nativa
   limpia/reaplicada/upgrade, compilación Windows, pruebas Qt reales antes y
   después de boot, regresiones y CI Windows/Ubuntu.
8. Ejecutar con el nuevo control el diálogo de breakpoints: condición, logging
   y max-hits con el marcador MCP intacto. Registrar el actor como control Qt
   por MCP; no atribuir esas acciones a Computer Use ni a una persona.

U1 implementada y validada en Windows/2.9.147: 15 grupos GUI reales, cinco
del asistente inicial, 302 Node, 74 regresiones e integración de 35 archivos.
[Contrato y evidencia](application-ui.md). La publicación y CI se registran
por SHA en el recibo local de entrega. Los controles/acciones concretos
probados se enumerarán con evidencia; no equiparar un árbol de widgets o una
compilación a soporte verificado de cada pantalla, plataforma o diálogo nativo
del sistema. SMS/Jellyfin y consola física permanecen separados.


La captura de DisplaySurface usa el buffer D3D11 RGBA8/BGRA8 después de ImGui;
otros renderers/formatos no tienen backend de captura aceptado. Los pilotos
de captura negra/región de escritorio y la colisión inicial debug+1/PINE se
conservan como fallidos, sin contarlos como aceptación. La GUI usa puerto
21513 o PCSX2_UI_PORT explícito, independiente del puerto debug.

Siguiente entrega: usar este control Qt para IOP en vuelo y source-step,
registrando el actor real. Ampliaciones de GUI aún no aceptadas: drag-and-drop,
gestión geométrica de ventanas y pruebas específicas de más pantallas/backends.
