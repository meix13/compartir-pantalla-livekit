# Dorso Oscuro - Compartir Pantalla (LiveKit)

Módulo para **Foundry VTT (v12 / v13 / v14)** que se integra con `avclient-livekit` para permitir al Master compartir su pantalla, ventana o pestaña en alta definición (**1080p · 30 FPS**) a través del servidor LiveKit existente, **sin apagar ni sustituir su webcam**.

## Características principales

- **Botón integrado en la caja de cámara de LiveKit del Master** (y acceso secundario en los controles de Tokens).
- **Dos modos de visualización para los jugadores** (cambiables en directo sin cortar la transmisión):
  - **Ventana Flotante Grande:** Ventana centrada al 74% de pantalla (`z-index: 125`), arrastrable desde la barra superior, redimensionable y minimizable.
  - **Como Escena de Foundry:** Se sitúa sobre el lienzo `#board` (`z-index: 25`), dejando visibles por encima las cámaras de LiveKit, el sidebar derecho y las fichas de personaje que abran los jugadores.
- **Sin efecto espejo infinito:** En el navegador del Master que transmite solo se muestra una píldora de control superior compacta sin renderizar el propio `<video>`.
- **Pan & Zoom interactivo:** Los jugadores pueden hacer zoom con la rueda del ratón (hasta 400%) y arrastrar para leer textos pequeños de fichas o manuales.
- **Audio desactivado por defecto:** No transmite el audio del sistema salvo que se marque expresamente la casilla antes de iniciar.

## Instalación por Manifiesto

```text
https://raw.githubusercontent.com/meix13/compartir-pantalla-livekit/main/module.json
```
