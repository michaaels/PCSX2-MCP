# Plan de implementación y publicación

Actualizado: 2026-10-21. Autorizado por el usuario: implementar las mejoras del
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
| F2 | GS dumps acotados con identidad, estados y archivos verificables | Pendiente |
| F3 | Captura vídeo/audio con propiedad, límites y finalización comprobada | Pendiente |
| F4 | Observadores de cambios de memoria EE/IOP en el hilo CPU | Pendiente |
| 5A2 | Vincular IRX exacto y fuentes con evidencia que contemple relocaciones | Pendiente; retomar tras F1–F4 |
| 5A3 | Vida de módulos e invalidación ante recarga, SifIopReset y savestates | Pendiente; requisito para F5 |
| F5 | Grabar/reproducir `.p2m2`, exclusión de entradas y parada al final | Pendiente; después de 5A2–5A3 |
| 5B–8 | Correlación del proyecto, diagnósticos medidos, regresión, DAP y validación física | Continuar el roadmap original |

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
- Siguiente entrega: F2, GS dumps. Retomar 5A2 tras F1–F4; F5 exige 5A3.
