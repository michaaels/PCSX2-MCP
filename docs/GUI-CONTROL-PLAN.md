# Control de toda la GUI desde MCP — U1

U3c (2026-11-03): arrastre Big Picture/ImGui acreditado en el mismo runtime U3b.
Cuatro grupos reales pasaron sin VM: capturas del volumen de 100% a 158%, lectura
independiente Qt=158 y restauración a 100, identidad/INI/exe intactos y procesos
propios cerrados. Runtime/DLLs/dist sin cambios por SHA; no se repitieron los 302
Node/47 live locales anteriores. [Contrato](imgui-drag-validation.md).
Sigue ampliar arrastre entre límites de controles/dock handles y backends de
captura; no se acepta toda configuración/renderer ni drag-and-drop del SO.

U3b (2026-11-03): arrastre Qt local asíncrono mediante `pcsx2_ui_action`, con
recibo en ejecución hasta liberar, exclusión de otra mutación y limpieza al
desconectar. Pasaron seis grupos nuevos y 41 de regresión (47 live), incluidos
arrastre de volumen con ambas CPU/RAM/identidad pausadas intactas. 302 Node,
Windows/TypeScript e integración de 36 archivos pasaron. [Contrato](ui-local-drag.md).
Quedan coberturas específicas de ImGui/backends/pantallas; drag-and-drop del SO
y acoplamiento entre ventanas no están implementados por el arrastre local.

U3a (2026-11-03): gestión de ventanas desde MCP: mover/redimensionar con límites
y maximizar/minimizar/restaurar. Snapshots incluyen geometría, pantallas y estado.
Seis grupos nuevos sin VM y 34 regresiones GUI/wizard/IOP/source pasaron; la VM
pausada conserva CPU/RAM/identidad durante cada transición. 302 Node y build
Windows/TypeScript pasaron; integración 36 archivos. [Contrato](ui-window-management.md).
Sigue U3b: arrastre acotado dentro de la aplicación. No se acepta entrada global,
cualquier política de foco/juego en ejecución ni hardware/SMS/Jellyfin.

S4b2/U2 (2026-11-03): source-step into/over/out con reemplazo Qt real aceptado
bajo retardo explícito de una respuesta nativa (65–76 ms medidos, tope programado
700 ms). Se conservan el punto GUI y el control IOP con cleanup incompleto
explícito. Corregida una fila privada obsoleta en Qt: notificación/coalescing
después de mutaciones, sin crear modelos ni reanudar, con edición inline
preservada y reconciliación tras Escape. Pasaron 18 grupos source/Qt, 20 GUI/
wizard, siete IOP, 74 regresiones y 100 ciclos de estabilidad; 91.731 s/16 sondeos/
tres recuperaciones con recursos en límites. Integración de 36 archivos; Node y
DLLs intactos (302 pruebas fuente). [Contrato y límites](source-step-qt-ownership.md).
Siguen ampliar el control GUI con drag/geometría y otras pantallas/backends;
no se aceptan carreras naturales universales ni hardware/SMS/Jellyfin.

S4b1 (2026-11-03): aceptado el reemplazo Qt real de un breakpoint IOP durante
step-over, actor `mcp_qt_ui`, con IRQ aislada por el fixture. Siete grupos nuevos
pasaron, incluidos controles EE/IOP con la misma dirección numérica. Se reprodujo
y corrigió el retorno global de GetBreakpoints(cpu, true) del pin 2.9.147: las
siete consultas/guardas MCP filtran ahora la CPU sin perder temporales.
Pasaron 74 regresiones nativas y 93.826 s con 15 sondeos RAM/píxeles, dos restores,
un reset y cuatro stdio/emulador cerrados; recursos dentro de límites. Node/dist
intactos respecto de U1 (302 pruebas fuente). La duración U1 de 606 s pertenece
al binario anterior; no se atribuye a éste. Sigue reemplazo GUI de source-step.
[Contrato y evidencia](iop-qt-ownership.md). Sin SMS/Jellyfin ni hardware físico.

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

U3a y U3b completan geometría/estado y arrastre local de controles. Próxima
cobertura: arrastre entre límites de controles/dock handles y auditoría por pantalla/backend.
Siguen fuera del alcance probado drag-and-drop del SO y docking entre ventanas.
