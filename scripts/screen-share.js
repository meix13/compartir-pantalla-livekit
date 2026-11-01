/**
 * Dorso Oscuro - Compartir Pantalla con LiveKit (Foundry VTT v12 / v13 / v14)
 *
 * Se integra directamente con `avclient-livekit` (game.webrtc.client._liveKitClient)
 * para permitir al Master compartir su pantalla, ventana o pestaña en 1080p sin
 * apagar ni sobrescribir su webcam, mostrando la transmisión a los jugadores como:
 *  - Ventana Flotante Grande (arrastrable, redimensionable, con Pan & Zoom)
 *  - Modo Escena de Foundry (sobre el lienzo #board, debajo de fichas, chat y cámaras)
 */

const MODULE_ID = "compartir-pantalla-livekit";
const SOCKET_NAME = `module.${MODULE_ID}`;

const state = {
    isSharingLocal: false,
    sharerUserId: null,
    sharerName: "Master",
    viewerMode: "floating", // "floating" | "scene" | "fullscreen"
    isMinimized: false,
    videoTrack: null,
    audioTrack: null,
    audioMutedLocal: false,
    zoom: 1,
    panX: 0,
    panY: 0,
    // Estado interactivo de arrastre (Pan de vídeo / Mover ventana / Redimensionar)
    interactionMode: null, // "pan" | "move-window" | "resize-window" | null
    dragStartX: 0,
    dragStartY: 0,
    startRect: null,
    // Posición y tamaño personalizados de la ventana flotante cuando el usuario la mueve/redimensiona
    floatingRect: null
};

/* ==========================================================================
   1. UTILIDADES Y ACCESO A LIVEKIT
   ========================================================================== */

function getLiveKitClient() {
    return game.webrtc?.client?._liveKitClient ?? null;
}

function getLiveKitRoom() {
    return getLiveKitClient()?.liveKitRoom ?? null;
}

function getDefaultViewerMode() {
    try {
        return game.settings.get(MODULE_ID, "defaultViewerMode") || "floating";
    } catch {
        return "floating";
    }
}

async function setDefaultViewerMode(mode, broadcast = true) {
    if (game.user?.isGM) {
        try {
            await game.settings.set(MODULE_ID, "defaultViewerMode", mode);
        } catch (err) {
            console.warn(`${MODULE_ID} | No se pudo guardar defaultViewerMode:`, err);
        }
        if (broadcast && game.socket) {
            game.socket.emit(SOCKET_NAME, {
                action: "setViewerMode",
                mode,
                senderId: game.user.id
            });
        }
    }
}

function getParticipantUser(participant) {
    const lkClient = getLiveKitClient();
    if (lkClient && typeof lkClient.getParticipantFVTTUser === "function") {
        try {
            const u = lkClient.getParticipantFVTTUser(participant);
            if (u) return u;
        } catch {
            // Fallback manual
        }
    }
    try {
        const meta = JSON.parse(participant?.metadata || "{}");
        if (meta.fvttUserId) return game.users?.get(meta.fvttUserId);
    } catch {
        // Ignorar
    }
    return game.users?.find(u => u.name === participant?.identity || u.name === participant?.name);
}

/* ==========================================================================
   2. PARCHEO NO INTRUSIVO DE AVCLIENT-LIVEKIT (PROTECCIÓN DE WEBCAM Y MICRO)
   ========================================================================== */

function patchLiveKitClient(lkClient) {
    if (!lkClient) return;

    if (!lkClient._doScreenSharePatched) {
        lkClient._doScreenSharePatched = true;
        console.log(`${MODULE_ID} | Enganchado a LiveKitClient para separar Webcam y Pantalla Compartida.`);

        // 1. Evitar que las cajas de cámara pequeñas de Foundry roben la pista de screen_share
        lkClient.getUserVideoTrack = function (userId) {
            if (!userId) return null;
            let videoTrack = null;
            this.liveKitParticipants.get(userId)?.videoTrackPublications.forEach((publication) => {
                if (
                    publication.kind === "video" &&
                    publication.source !== "screen_share" &&
                    publication.track
                ) {
                    videoTrack = publication.track;
                }
            });
            return videoTrack;
        };

        // 2. Evitar que el audio de cámara mezcle o robe screen_share_audio
        lkClient.getUserAudioTrack = function (userId) {
            if (!userId) return null;
            let audioTrack = null;
            this.liveKitParticipants.get(userId)?.audioTrackPublications.forEach((publication) => {
                if (
                    publication.kind === "audio" &&
                    publication.source !== "screen_share_audio" &&
                    publication.track
                ) {
                    audioTrack = publication.track;
                }
            });
            return audioTrack;
        };

        // 3. Interceptar initializeRoom por si la sala se recrea más adelante
        const origInitializeRoom = lkClient.initializeRoom?.bind(lkClient);
        if (origInitializeRoom) {
            lkClient.initializeRoom = function (...args) {
                const res = origInitializeRoom(...args);
                if (this.liveKitRoom) {
                    attachRoomListeners(this.liveKitRoom);
                }
                return res;
            };
        }
    }

    if (lkClient.liveKitRoom) {
        attachRoomListeners(lkClient.liveKitRoom);
    }
}

function attachRoomListeners(room) {
    if (!room || room._doScreenShareRoomPatched) return;
    room._doScreenShareRoomPatched = true;

    console.log(`${MODULE_ID} | Escuchando eventos de ScreenShare en la sala LiveKit.`);

    // Cuando nos suscribimos a una pista remota (Jugadores viendo la pantalla del Master)
    room.on("trackSubscribed", (track, publication, participant) => {
        if (publication?.source === "screen_share") {
            const user = getParticipantUser(participant);
            state.sharerUserId = user?.id || participant?.identity || "gm";
            state.sharerName = user?.name || participant?.name || participant?.identity || "Master";
            state.videoTrack = track;
            state.isMinimized = false;
            state.viewerMode = getDefaultViewerMode();
            resetZoomAndPan();
            renderScreenShareViewer();
            attachTracksToDOM();
            ui.notifications?.info(`${state.sharerName} está compartiendo su pantalla.`);
        } else if (publication?.source === "screen_share_audio") {
            state.audioTrack = track;
            renderScreenShareViewer();
            attachTracksToDOM();
        }
    });

    // Cuando un participante remoto deja de compartir pantalla
    const handleRemoteTrackRemoved = (trackOrPub, pubOrPart) => {
        const source = trackOrPub?.source || pubOrPart?.source;
        if (source === "screen_share") {
            if (state.videoTrack && typeof state.videoTrack.detach === "function") {
                try { state.videoTrack.detach(); } catch { /* ignore */ }
            }
            state.videoTrack = null;
            if (!state.isSharingLocal) {
                closeScreenShareViewer();
            }
        } else if (source === "screen_share_audio") {
            if (state.audioTrack && typeof state.audioTrack.detach === "function") {
                try { state.audioTrack.detach(); } catch { /* ignore */ }
            }
            state.audioTrack = null;
            if (document.getElementById("do-lk-screenshare-viewer")) {
                renderScreenShareViewer();
            }
        }
    };

    room.on("trackUnsubscribed", (track, publication) => handleRemoteTrackRemoved(track, publication));
    room.on("trackUnpublished", (publication) => handleRemoteTrackRemoved(publication, null));

    // Cuando el Master local publica su propia pantalla compartida
    room.on("localTrackPublished", (publication) => {
        if (publication?.source === "screen_share") {
            state.isSharingLocal = true;
            state.sharerUserId = game.user?.id || "local";
            state.sharerName = game.user?.name || "Master";
            state.videoTrack = publication.track;
            // En el navegador del propio Master NUNCA abrimos el reproductor de vídeo para evitar
            // el efecto túnel/espejo infinito; solo mostramos la píldora superior de control.
            state.isMinimized = true;
            updateCameraButtonState();
            renderScreenShareViewer();

            // Si el usuario pulsa el botón nativo del navegador "Dejar de compartir"
            const mediaTrack = publication.track?.mediaStreamTrack;
            if (mediaTrack && !mediaTrack._doEndedHooked) {
                mediaTrack._doEndedHooked = true;
                mediaTrack.addEventListener("ended", () => {
                    stopScreenShare();
                });
            }
        }
    });

    // Cuando el usuario local deja de publicar su pantalla compartida
    room.on("localTrackUnpublished", (publication) => {
        if (publication?.source === "screen_share") {
            state.isSharingLocal = false;
            state.videoTrack = null;
            updateCameraButtonState();
            closeScreenShareViewer();
        }
    });

    room.on("disconnected", () => {
        state.isSharingLocal = false;
        state.videoTrack = null;
        state.audioTrack = null;
        updateCameraButtonState();
        closeScreenShareViewer();
    });

    room.on("connected", () => {
        checkExistingRemoteScreenShares(room);
    });

    // Si la sala ya estaba conectada cuando se cargó el módulo, comprobar si hay alguien compartiendo
    if (room.state === "connected") {
        checkExistingRemoteScreenShares(room);
    }
}

function checkExistingRemoteScreenShares(room) {
    if (!room?.remoteParticipants) return;
    for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
            if (publication.source === "screen_share" && publication.track) {
                const user = getParticipantUser(participant);
                state.sharerUserId = user?.id || participant.identity || "gm";
                state.sharerName = user?.name || participant.name || participant.identity || "Master";
                state.videoTrack = publication.track;
                state.viewerMode = getDefaultViewerMode();
                renderScreenShareViewer();
                attachTracksToDOM();
            } else if (publication.source === "screen_share_audio" && publication.track) {
                state.audioTrack = publication.track;
                attachTracksToDOM();
            }
        }
    }
}

/* ==========================================================================
   3. INICIAR Y DETENER LA COMPARTICIÓN DE PANTALLA (MASTER)
   ========================================================================== */

async function startScreenShare(chosenMode = "floating", includeAudio = false) {
    const room = getLiveKitRoom();
    if (!room || room.state !== "connected") {
        ui.notifications?.warn("No estás conectado a la sala de LiveKit. Conéctate primero al audio/vídeo.");
        return;
    }

    try {
        state.viewerMode = chosenMode;
        await setDefaultViewerMode(chosenMode, true);

        const captureOptions = {
            // Por defecto NO compartimos audio (includeAudio = false) salvo que el Master lo marque expresamente
            audio: includeAudio
                ? {
                      autoGainControl: false,
                      echoCancellation: false,
                      noiseSuppression: false,
                      channelCount: { ideal: 2 }
                  }
                : false,
            resolution: {
                width: 1920,
                height: 1080,
                frameRate: 30
            },
            contentHint: "detail",
            // Sugerir al navegador no capturar superficies propias ni espejos si el navegador lo soporta
            selfBrowserSurface: "include",
            surfaceSwitching: "include"
        };

        const publishOptions = {
            simulcast: false,
            videoCodec: "vp8",
            screenShareEncoding: {
                maxBitrate: 4_000_000,
                maxFramerate: 30
            }
        };

        const publication = await room.localParticipant.setScreenShareEnabled(
            true,
            captureOptions,
            publishOptions
        );

        if (publication) {
            state.isSharingLocal = true;
            state.videoTrack = publication.track;
            state.isMinimized = true; // En el Master solo se muestra la barra de control superior (sin vídeo propio)
            updateCameraButtonState();
            renderScreenShareViewer();

            if (game.socket) {
                game.socket.emit(SOCKET_NAME, {
                    action: "screenShareStarted",
                    mode: chosenMode,
                    sharerName: game.user?.name || "Master"
                });
            }
            ui.notifications?.info("Compartiendo pantalla en alta definición (1080p) a través de LiveKit.");
        }
    } catch (err) {
        // Si el usuario cancela la ventana del navegador (NotAllowedError), no alarmar
        if (err?.name === "NotAllowedError" || String(err?.message).includes("Permission denied")) {
            console.log(`${MODULE_ID} | Selección de pantalla cancelada por el usuario.`);
            return;
        }
        console.error(`${MODULE_ID} | Error al iniciar compartición de pantalla:`, err);
        ui.notifications?.error(`No se pudo compartir la pantalla: ${err?.message || err}`);
    }
}

async function stopScreenShare() {
    const room = getLiveKitRoom();
    try {
        if (room?.localParticipant) {
            await room.localParticipant.setScreenShareEnabled(false);
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | Aviso al detener setScreenShareEnabled:`, err);
    }

    state.isSharingLocal = false;
    state.videoTrack = null;
    state.audioTrack = null;
    updateCameraButtonState();
    closeScreenShareViewer();

    if (game.socket) {
        game.socket.emit(SOCKET_NAME, {
            action: "screenShareStopped"
        });
    }
}

/* ==========================================================================
   4. MODAL DE INICIO RÁPIDO PARA EL MASTER
   ========================================================================== */

function openStartScreenShareModal() {
    const existing = document.getElementById("do-lk-start-modal-backdrop");
    if (existing) existing.remove();

    let selectedMode = getDefaultViewerMode();
    if (selectedMode !== "floating" && selectedMode !== "scene") {
        selectedMode = "floating";
    }

    const backdrop = document.createElement("div");
    backdrop.id = "do-lk-start-modal-backdrop";
    backdrop.innerHTML = `
        <div class="do-lk-start-modal">
            <h3>
                <i class="fa-solid fa-desktop"></i>
                Compartir Pantalla con los Jugadores (LiveKit)
            </h3>
            <p class="do-lk-desc">
                Elige cómo quieres que se abra en los jugadores. <br/>
                <strong style="color:#38bdf8;">Consejo anti-espejo:</strong> En el selector del navegador elige la <strong>Pestaña</strong> de Foundry (o la <strong>Ventana</strong> concreta) en lugar de "Toda la pantalla" si tienes otra ventana de jugador abierta en el mismo monitor.
            </p>
            <div class="do-lk-mode-cards">
                <div class="do-lk-mode-card ${selectedMode === "floating" ? "selected" : ""}" data-mode="floating">
                    <div class="card-title">
                        <i class="fa-solid fa-window-restore"></i>
                        Ventana Flotante Grande
                    </div>
                    <div class="card-sub">
                        Se abre centrada (74% de pantalla) por encima de todo. Los jugadores pueden moverla, redimensionarla o minimizarla.
                    </div>
                </div>
                <div class="do-lk-mode-card ${selectedMode === "scene" ? "selected" : ""}" data-mode="scene">
                    <div class="card-title">
                        <i class="fa-solid fa-map"></i>
                        Como Escena de Foundry
                    </div>
                    <div class="card-sub">
                        Ocupa el lienzo del mapa dejando las cámaras, el chat y las fichas que abran los jugadores flotando por encima.
                    </div>
                </div>
            </div>
            <div class="do-lk-start-options">
                <label>
                    <input type="checkbox" id="do-lk-include-audio" />
                    <span>Compartir también el audio de la pestaña / ventana (desactivado por defecto)</span>
                </label>
                <span style="color:#38bdf8; font-size:11px; font-family:monospace;">1080p · 30 FPS</span>
            </div>
            <div class="do-lk-start-actions">
                <button type="button" class="do-lk-btn" id="do-lk-cancel-btn">
                    <i class="fa-solid fa-xmark"></i> Cancelar
                </button>
                <button type="button" class="do-lk-btn do-lk-btn-primary" id="do-lk-confirm-btn">
                    <i class="fa-solid fa-tower-broadcast"></i> Elegir Pestaña / Ventana y Transmitir
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(backdrop);

    const cards = backdrop.querySelectorAll(".do-lk-mode-card");
    cards.forEach((card) => {
        card.addEventListener("click", () => {
            cards.forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
            selectedMode = card.dataset.mode || "floating";
        });
    });

    backdrop.querySelector("#do-lk-cancel-btn")?.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (ev) => {
        if (ev.target === backdrop) backdrop.remove();
    });

    backdrop.querySelector("#do-lk-confirm-btn")?.addEventListener("click", () => {
        const includeAudio = Boolean(backdrop.querySelector("#do-lk-include-audio")?.checked);
        backdrop.remove();
        startScreenShare(selectedMode, includeAudio);
    });
}

/* ==========================================================================
   5. VISOR DE PANTALLA COMPARTIDA (JUGADORES Y BARRA DE CONTROL DEL MASTER)
   ========================================================================== */

function resetZoomAndPan() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyVideoTransform();
}

function applyVideoTransform() {
    const viewer = document.getElementById("do-lk-screenshare-viewer");
    if (!viewer) return;
    const video = viewer.querySelector(".do-lk-video-Element");
    const zoomLabel = viewer.querySelector(".do-lk-zoom-label");
    if (video) {
        video.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    }
    if (zoomLabel) {
        zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }
}

function attachTracksToDOM() {
    // Nunca adjuntar el vídeo en el propio navegador del Master que está transmitiendo
    if (state.isSharingLocal) return;

    const viewer = document.getElementById("do-lk-screenshare-viewer");
    if (!viewer) return;

    const videoEl = viewer.querySelector("video.do-lk-video-Element");
    if (videoEl && state.videoTrack) {
        try {
            if (!state.videoTrack.attachedElements?.includes(videoEl)) {
                state.videoTrack.attach(videoEl);
            }
            videoEl.play().catch(() => { /* Autoplay fallback */ });
        } catch (err) {
            console.warn(`${MODULE_ID} | Error adjuntando pista de vídeo:`, err);
        }
    }

    const audioEl = viewer.querySelector("audio.do-lk-audio-element");
    if (audioEl && state.audioTrack && !state.isSharingLocal) {
        try {
            if (!state.audioTrack.attachedElements?.includes(audioEl)) {
                state.audioTrack.attach(audioEl);
            }
            audioEl.muted = state.audioMutedLocal;
        } catch (err) {
            console.warn(`${MODULE_ID} | Error adjuntando pista de audio:`, err);
        }
    }
}

function closeScreenShareViewer() {
    state.interactionMode = null;
    const viewer = document.getElementById("do-lk-screenshare-viewer");
    if (viewer) viewer.remove();
}

function renderScreenShareViewer() {
    let viewer = document.getElementById("do-lk-screenshare-viewer");
    if (!viewer) {
        viewer = document.createElement("div");
        viewer.id = "do-lk-screenshare-viewer";
        document.body.appendChild(viewer);
    }

    viewer.classList.remove("mode-floating", "mode-scene", "mode-fullscreen", "mode-minimized");

    // CASO 1: Es el propio Master que está transmitiendo -> Mostrar SOLO la píldora de control superior
    // (sin reproductor de vídeo propio para que jamás ocurra el efecto espejo infinito)
    if (state.isSharingLocal) {
        viewer.classList.add("mode-minimized");
        viewer.style.top = "";
        viewer.style.left = "";
        viewer.style.width = "";
        viewer.style.height = "";

        viewer.innerHTML = `
            <div class="do-lk-topbar">
                <div class="do-lk-topbar-left">
                    <span class="do-lk-live-dot" title="Transmitiendo pantalla por LiveKit"></span>
                    <span class="do-lk-badge">
                        <i class="fa-solid fa-tower-broadcast"></i>
                        TRANSMITIENDO PANTALLA
                    </span>
                </div>
                <div class="do-lk-topbar-actions">
                    <div class="do-lk-group" title="Elige cómo lo ven los jugadores en sus pantallas">
                        <span style="color:#94a3b8; font-size:11px; padding:0 4px;">Vista Jugadores:</span>
                        <button type="button" class="do-lk-btn ${state.viewerMode === "floating" ? "active" : ""}" data-action="gm-set-floating" title="Abrir como Ventana Flotante Grande en los jugadores">
                            <i class="fa-solid fa-window-restore"></i> Ventana Flotante
                        </button>
                        <button type="button" class="do-lk-btn ${state.viewerMode === "scene" ? "active" : ""}" data-action="gm-set-scene" title="Colocar como Escena de fondo sobre el lienzo en los jugadores">
                            <i class="fa-solid fa-map"></i> Como Escena
                        </button>
                    </div>
                    <button type="button" class="do-lk-btn do-lk-btn-danger" data-action="stop-share" title="Detener la compartición de pantalla">
                        <i class="fa-solid fa-stop"></i> Dejar de compartir
                    </button>
                </div>
            </div>
        `;

        bindViewerEvents(viewer);
        return;
    }

    // CASO 2: Es un Jugador (o espectador) recibiendo la pantalla del Master
    if (state.isMinimized) {
        viewer.classList.add("mode-minimized");
        viewer.style.top = "";
        viewer.style.left = "";
        viewer.style.width = "";
        viewer.style.height = "";
    } else if (state.viewerMode === "scene") {
        viewer.classList.add("mode-scene");
        viewer.style.top = "";
        viewer.style.left = "";
        viewer.style.width = "";
        viewer.style.height = "";
    } else if (state.viewerMode === "fullscreen") {
        viewer.classList.add("mode-fullscreen");
        viewer.style.top = "";
        viewer.style.left = "";
        viewer.style.width = "";
        viewer.style.height = "";
    } else {
        viewer.classList.add("mode-floating");
        if (state.floatingRect) {
            viewer.style.top = `${state.floatingRect.top}px`;
            viewer.style.left = `${state.floatingRect.left}px`;
            viewer.style.width = `${state.floatingRect.width}px`;
            viewer.style.height = `${state.floatingRect.height}px`;
        }
    }

    const hasAudio = Boolean(state.audioTrack);

    viewer.innerHTML = `
        <div class="do-lk-topbar" id="do-lk-topbar-drag">
            <div class="do-lk-topbar-left">
                <span class="do-lk-live-dot" title="Transmisión LiveKit en directo"></span>
                <span class="do-lk-badge">
                    <i class="fa-solid fa-desktop"></i>
                    PANTALLA DE ${state.sharerName.toUpperCase()}
                </span>
            </div>

            <div class="do-lk-topbar-actions">
                ${!state.isMinimized ? `
                    <div class="do-lk-group" title="Zoom con la rueda del ratón sobre el vídeo">
                        <button type="button" class="do-lk-btn" data-action="zoom-out" title="Alejar">
                            <i class="fa-solid fa-magnifying-glass-minus"></i>
                        </button>
                        <span class="do-lk-zoom-label" data-action="zoom-reset" title="Clic para restablecer al 100%">
                            ${Math.round(state.zoom * 100)}%
                        </span>
                        <button type="button" class="do-lk-btn" data-action="zoom-in" title="Acercar">
                            <i class="fa-solid fa-magnifying-glass-plus"></i>
                        </button>
                    </div>
                ` : ""}

                <div class="do-lk-group" title="Cambia tu modo de visualización">
                    <button type="button" class="do-lk-btn ${!state.isMinimized && state.viewerMode === "floating" ? "active" : ""}" data-action="mode-floating" title="Modo Ventana Flotante Grande (arrastrable y redimensionable)">
                        <i class="fa-solid fa-window-restore"></i> Flotante
                    </button>
                    <button type="button" class="do-lk-btn ${!state.isMinimized && state.viewerMode === "scene" ? "active" : ""}" data-action="mode-scene" title="Modo Escena de Foundry (en el fondo del lienzo, debajo de fichas y chat)">
                        <i class="fa-solid fa-map"></i> Como Escena
                    </button>
                    <button type="button" class="do-lk-btn ${!state.isMinimized && state.viewerMode === "fullscreen" ? "active" : ""}" data-action="mode-fullscreen" title="Pantalla Completa">
                        <i class="fa-solid fa-expand"></i>
                    </button>
                </div>

                ${hasAudio ? `
                    <button type="button" class="do-lk-btn ${state.audioMutedLocal ? "" : "active"}" data-action="toggle-audio" title="Silenciar / Activar audio de la pantalla compartida">
                        <i class="fa-solid ${state.audioMutedLocal ? "fa-volume-xmark" : "fa-volume-high"}"></i>
                    </button>
                ` : ""}

                <button type="button" class="do-lk-btn" data-action="toggle-minimize" title="${state.isMinimized ? "Desplegar vídeo" : "Minimizar a píldora superior"}">
                    <i class="fa-solid ${state.isMinimized ? "fa-eye" : "fa-window-minimize"}"></i>
                    ${state.isMinimized ? "Mostrar Pantalla" : "Minimizar"}
                </button>
            </div>
        </div>

        <div class="do-lk-video-stage" id="do-lk-stage">
            <video class="do-lk-video-Element" autoplay playsinline muted></video>
            <audio class="do-lk-audio-element" autoplay></audio>
            <div class="do-lk-stage-hint">
                <i class="fa-solid fa-mouse"></i> Rueda: Zoom · Arrastrar: Mover · Doble clic: 100%
            </div>
        </div>

        <div class="do-lk-resize-handle" id="do-lk-resize-grip" title="Arrastra para redimensionar la ventana"></div>
    `;

    bindViewerEvents(viewer);
    attachTracksToDOM();
    applyVideoTransform();
}

function bindViewerEvents(viewer) {
    // Botones de la barra superior
    viewer.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            const action = btn.dataset.action;

            if (action === "zoom-in") {
                state.zoom = Math.min(4, +(state.zoom + 0.25).toFixed(2));
                applyVideoTransform();
            } else if (action === "zoom-out") {
                state.zoom = Math.max(0.5, +(state.zoom - 0.25).toFixed(2));
                if (state.zoom <= 1) { state.panX = 0; state.panY = 0; }
                applyVideoTransform();
            } else if (action === "zoom-reset") {
                resetZoomAndPan();
            } else if (action === "gm-set-floating") {
                state.viewerMode = "floating";
                await setDefaultViewerMode("floating", true);
                ui.notifications?.info("Vista de jugadores cambiada a Ventana Flotante.");
                renderScreenShareViewer();
            } else if (action === "gm-set-scene") {
                state.viewerMode = "scene";
                await setDefaultViewerMode("scene", true);
                ui.notifications?.info("Vista de jugadores cambiada a Modo Escena.");
                renderScreenShareViewer();
            } else if (action === "mode-floating") {
                state.isMinimized = false;
                state.viewerMode = "floating";
                renderScreenShareViewer();
            } else if (action === "mode-scene") {
                state.isMinimized = false;
                state.viewerMode = "scene";
                renderScreenShareViewer();
            } else if (action === "mode-fullscreen") {
                state.isMinimized = false;
                state.viewerMode = state.viewerMode === "fullscreen" ? "floating" : "fullscreen";
                renderScreenShareViewer();
            } else if (action === "toggle-minimize") {
                state.isMinimized = !state.isMinimized;
                renderScreenShareViewer();
            } else if (action === "toggle-audio") {
                state.audioMutedLocal = !state.audioMutedLocal;
                renderScreenShareViewer();
            } else if (action === "stop-share") {
                await stopScreenShare();
            }
        });
    });

    // Zoom con rueda del ratón y Pan (arrastrar) sobre el escenario de vídeo
    const stage = viewer.querySelector("#do-lk-stage");
    if (stage) {
        stage.addEventListener("wheel", (ev) => {
            ev.preventDefault();
            const delta = ev.deltaY < 0 ? 0.18 : -0.18;
            state.zoom = Math.min(4, Math.max(0.5, +(state.zoom + delta).toFixed(2)));
            if (state.zoom <= 1) {
                state.panX = 0;
                state.panY = 0;
            }
            applyVideoTransform();
        }, { passive: false });

        stage.addEventListener("dblclick", () => {
            resetZoomAndPan();
        });

        stage.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0) return;
            state.interactionMode = "pan";
            state.dragStartX = ev.clientX - state.panX;
            state.dragStartY = ev.clientY - state.panY;
            stage.classList.add("is-dragging");
        });
    }

    // Arrastrar la ventana flotante desde la barra superior
    const topbar = viewer.querySelector("#do-lk-topbar-drag");
    if (topbar) {
        topbar.addEventListener("mousedown", (ev) => {
            if (state.viewerMode !== "floating" || state.isMinimized) return;
            if (ev.target.closest("button") || ev.target.closest(".do-lk-group")) return;
            state.interactionMode = "move-window";
            const rect = viewer.getBoundingClientRect();
            state.dragStartX = ev.clientX - rect.left;
            state.dragStartY = ev.clientY - rect.top;
            state.startRect = rect;
            ev.preventDefault();
        });
    }

    // Redimensionar la ventana flotante desde la esquina inferior derecha
    const resizeGrip = viewer.querySelector("#do-lk-resize-grip");
    if (resizeGrip) {
        resizeGrip.addEventListener("mousedown", (ev) => {
            if (state.viewerMode !== "floating" || state.isMinimized) return;
            state.interactionMode = "resize-window";
            const rect = viewer.getBoundingClientRect();
            state.dragStartX = ev.clientX;
            state.dragStartY = ev.clientY;
            state.startRect = rect;
            ev.preventDefault();
            ev.stopPropagation();
        });
    }
}

// Listeners globales únicos para arrastrar/redimensionar con fluidez sin duplicarse
window.addEventListener("mousemove", (ev) => {
    if (!state.interactionMode) return;
    const viewer = document.getElementById("do-lk-screenshare-viewer");
    if (!viewer) {
        state.interactionMode = null;
        return;
    }

    if (state.interactionMode === "pan") {
        state.panX = ev.clientX - state.dragStartX;
        state.panY = ev.clientY - state.dragStartY;
        applyVideoTransform();
    } else if (state.interactionMode === "move-window") {
        const rect = viewer.getBoundingClientRect();
        const left = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - state.dragStartX));
        const top = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - state.dragStartY));
        viewer.style.left = `${left}px`;
        viewer.style.top = `${top}px`;
        state.floatingRect = {
            left,
            top,
            width: rect.width,
            height: rect.height
        };
    } else if (state.interactionMode === "resize-window" && state.startRect) {
        const rect = viewer.getBoundingClientRect();
        const newW = Math.max(420, Math.min(window.innerWidth - rect.left, state.startRect.width + (ev.clientX - state.dragStartX)));
        const newH = Math.max(280, Math.min(window.innerHeight - rect.top, state.startRect.height + (ev.clientY - state.dragStartY)));
        viewer.style.width = `${newW}px`;
        viewer.style.height = `${newH}px`;
        state.floatingRect = {
            left: rect.left,
            top: rect.top,
            width: newW,
            height: newH
        };
    }
});

window.addEventListener("mouseup", () => {
    if (!state.interactionMode) return;
    state.interactionMode = null;
    const stage = document.getElementById("do-lk-stage");
    stage?.classList.remove("is-dragging");
});

/* ==========================================================================
   6. BOTÓN EN LA CAJA DE CÁMARA DE LIVEKIT DEL MASTER (Y CONTROLES)
   ========================================================================== */

function updateCameraButtonState() {
    const btns = document.querySelectorAll(".livekit-screenshare-btn");
    btns.forEach((btn) => {
        btn.classList.toggle("is-sharing", state.isSharingLocal);
        btn.dataset.tooltip = state.isSharingLocal
            ? "Dejar de compartir pantalla (LiveKit)"
            : "Compartir pantalla con jugadores (LiveKit)";
        btn.title = btn.dataset.tooltip;
    });
}

function injectCameraShareButton(html) {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0] || document;
    const userId = game.user.id;
    const cameraControls = root.querySelector(`[data-user="${userId}"].user-controls`);
    if (!cameraControls) return;

    if (cameraControls.querySelector(".livekit-screenshare-btn")) {
        updateCameraButtonState();
        return;
    }

    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = `av-control inline-control toggle icon fa-solid fa-fw fa-desktop livekit-screenshare-btn ${
        state.isSharingLocal ? "is-sharing" : ""
    }`;
    shareBtn.dataset.tooltip = state.isSharingLocal
        ? "Dejar de compartir pantalla (LiveKit)"
        : "Compartir pantalla con jugadores (LiveKit)";
    shareBtn.title = shareBtn.dataset.tooltip;
    shareBtn.ariaLabel = shareBtn.dataset.tooltip;

    shareBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.isSharingLocal) {
            stopScreenShare();
        } else if (ev.shiftKey) {
            // Shift + Clic comparte directamente con el último modo usado (y sin audio por defecto)
            startScreenShare(getDefaultViewerMode(), false);
        } else {
            openStartScreenShareModal();
        }
    });

    const configBtn = cameraControls.querySelector('[data-action="configure"]');
    if (configBtn) {
        configBtn.before(shareBtn);
    } else {
        cameraControls.appendChild(shareBtn);
    }
}

/* ==========================================================================
   7. HOOKS DE FOUNDRY VTT Y SOCKETS
   ========================================================================== */

Hooks.once("init", () => {
    console.log(`${MODULE_ID} | Inicializando Compartir Pantalla con LiveKit...`);

    game.settings.register(MODULE_ID, "defaultViewerMode", {
        name: "Modo de visualización por defecto para los jugadores",
        hint: "Elige si al compartir pantalla se abre en los jugadores como Ventana Flotante Grande o como Escena de Foundry sobre el lienzo.",
        scope: "world",
        config: true,
        type: String,
        choices: {
            floating: "Ventana Flotante Grande (Recomendado)",
            scene: "Como Escena de Foundry (Sobre el lienzo #board)"
        },
        default: "floating"
    });

    // 1. Protección anti-bloqueo al 98%: posponer la conexión inicial de WebRTC/LiveKit hasta que el Canvas termine de cargar (100%)
    const AVMasterCls = foundry?.av?.AVMaster || window.AVMaster;
    if (AVMasterCls?.prototype?.connect && !AVMasterCls.prototype._doDeferredInitPatched) {
        AVMasterCls.prototype._doDeferredInitPatched = true;
        const origAVConnect = AVMasterCls.prototype.connect;
        AVMasterCls.prototype.connect = async function (...args) {
            if (!game.ready) {
                console.log(`${MODULE_ID} | Posponiendo conexión inicial de LiveKit hasta que la escena termine de cargar al 100%...`);
                return new Promise((resolve) => {
                    Hooks.once("ready", () => {
                        setTimeout(async () => {
                            try {
                                const res = await origAVConnect.apply(this, args);
                                resolve(res);
                            } catch (err) {
                                console.warn(`${MODULE_ID} | Error en conexión diferida de LiveKit:`, err);
                                resolve(false);
                            }
                        }, 350);
                    });
                });
            }
            return origAVConnect.apply(this, args);
        };
    }

    // 2. Salvavidas contra texturas/vídeos colgados al 98% en TextureLoader.loadTexture en la primera carga en frío
    const TexLoaderCls = foundry?.canvas?.TextureLoader || window.TextureLoader;
    if (TexLoaderCls?.prototype?.loadTexture && !TexLoaderCls.prototype._doTimeoutPatched) {
        TexLoaderCls.prototype._doTimeoutPatched = true;
        const origLoadTexture = TexLoaderCls.prototype.loadTexture;
        TexLoaderCls.prototype.loadTexture = async function (src, ...rest) {
            const timeoutMs = 12000;
            let timer = null;
            try {
                return await Promise.race([
                    origLoadTexture.call(this, src, ...rest),
                    new Promise((resolve) => {
                        timer = setTimeout(() => {
                            console.warn(`${MODULE_ID} | [Anti-98%] El recurso tardó más de ${timeoutMs / 1000}s en responder en frío, desbloqueando carga:`, src);
                            resolve(null);
                        }, timeoutMs);
                    })
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        };
    }
});

// Engancharse a LiveKit tan pronto como esté disponible
Hooks.on("liveKitClientAvailable", (lkClient) => {
    patchLiveKitClient(lkClient);
});

Hooks.on("liveKitClientInitialized", (lkClient) => {
    patchLiveKitClient(lkClient);
});

// Añadir el botón de Compartir Pantalla en la caja de cámara del Master
Hooks.on("renderCameraViews", (_cameraViews, html) => {
    if (game.webrtc?.client?._liveKitClient) {
        patchLiveKitClient(game.webrtc.client._liveKitClient);
    }
    injectCameraShareButton(html);
});

// También añadir botón de respaldo en la barra de herramientas de escena por si las cámaras están ocultas
Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user?.isGM) return;
    const tokenControls =
        controls.tokens ||
        (Array.isArray(controls) ? controls.find(c => c.name === "token" || c.name === "tokens") : null);
    if (!tokenControls || !tokenControls.tools) return;

    const tool = {
        name: "livekit-screenshare-tool",
        title: "Compartir Pantalla (LiveKit)",
        icon: "fa-solid fa-desktop",
        button: true,
        onClick: () => {
            if (state.isSharingLocal) {
                stopScreenShare();
            } else {
                openStartScreenShareModal();
            }
        }
    };

    if (Array.isArray(tokenControls.tools)) {
        if (!tokenControls.tools.find(t => t.name === "livekit-screenshare-tool")) {
            tokenControls.tools.push(tool);
        }
    } else {
        tokenControls.tools["livekit-screenshare-tool"] = tool;
    }
});

Hooks.once("ready", () => {
    if (game.webrtc?.client?._liveKitClient) {
        patchLiveKitClient(game.webrtc.client._liveKitClient);
    }
    injectCameraShareButton(document);

    if (game.socket) {
        game.socket.on(SOCKET_NAME, (payload) => {
            if (!payload) return;
            if (payload.action === "setViewerMode" && payload.mode) {
                state.viewerMode = payload.mode;
                if (document.getElementById("do-lk-screenshare-viewer") && !state.isSharingLocal) {
                    state.isMinimized = false;
                    renderScreenShareViewer();
                }
            } else if (payload.action === "screenShareStarted" && payload.mode) {
                state.viewerMode = payload.mode;
                if (payload.sharerName) state.sharerName = payload.sharerName;
            } else if (payload.action === "screenShareStopped" && !state.isSharingLocal) {
                closeScreenShareViewer();
            }
        });
    }
});

// API global para macros o consola
window.DorsoScreenShare = {
    start: (mode = "floating", audio = false) => startScreenShare(mode, audio),
    stop: () => stopScreenShare(),
    openDialog: () => openStartScreenShareModal(),
    setModeForAll: (mode) => setDefaultViewerMode(mode, true)
};
