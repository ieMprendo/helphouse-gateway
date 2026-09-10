import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    extractMessageContent,
    normalizeMessageContent
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'helphouse_secret_key';
let WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://coolabora.me/api/whatsapp/webhook';

app.use(cors());
app.use(express.json());

// Mapa de instancias activas en memoria
const instances = new Map();
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Mapeo persistente de JIDs/LIDs a teléfonos reales
const PHONE_MAP_FILE = path.join(SESSIONS_DIR, 'phone_mapping.json');
let phoneMap = {};
try {
    if (fs.existsSync(PHONE_MAP_FILE)) {
        phoneMap = JSON.parse(fs.readFileSync(PHONE_MAP_FILE, 'utf8'));
    }
} catch (e) {}

function recordPhoneMapping(rawKey, realPhone) {
    if (!rawKey || !realPhone) return;
    const cleanKey = String(rawKey).split('@')[0].replace(/[^0-9]/g, '');
    const cleanPhone = String(realPhone).replace(/[^0-9]/g, '');
    if (cleanKey && cleanPhone && cleanKey !== cleanPhone) {
        phoneMap[cleanKey] = cleanPhone;
        try {
            fs.writeFileSync(PHONE_MAP_FILE, JSON.stringify(phoneMap, null, 2), 'utf8');
        } catch (e) {}
    }
}

// Health check root con información de diagnóstico
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Help House WhatsApp Gateway',
        uptime: process.uptime(),
        webhookUrl: WEBHOOK_URL,
        instancesCount: instances.size,
        mappedPhones: Object.keys(phoneMap).length
    });
});

// Endpoint para consultar o actualizar la URL del Webhook
app.get('/webhook', (req, res) => {
    res.json({ webhookUrl: WEBHOOK_URL });
});

app.post('/webhook/set', (req, res) => {
    const { url } = req.body;
    if (url && typeof url === 'string') {
        WEBHOOK_URL = url.trim();
        console.log(`[Gateway] 🔗 Webhook URL dinámicamente actualizada a: ${WEBHOOK_URL}`);
        return res.json({ success: true, webhookUrl: WEBHOOK_URL });
    }
    res.status(400).json({ error: 'url es obligatoria' });
});

// Middleware simple de apikey
app.use((req, res, next) => {
    const key = req.headers['apikey'] || req.query.apikey;
    if (key && key !== API_KEY) {
        return res.status(403).json({ error: 'API Key inválida' });
    }
    next();
});

const logger = pino({ level: 'silent' });
const initializingMap = new Map();

/**
 * Resuelve un LID de WhatsApp (@lid) al número telefónico real del usuario
 * comparando las llaves de identidad Signal compartidas en la sesión.
 */
function resolveLidToPhone(sessionDir, lid) {
    if (!sessionDir || !lid || !fs.existsSync(sessionDir)) return null;
    try {
        const files = fs.readdirSync(sessionDir);
        let targetIdentityKey = null;
        let targetRegId = null;

        for (const file of files) {
            if (file.startsWith(`session-${lid}.`)) {
                try {
                    const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
                    const data = JSON.parse(raw);
                    for (const s of Object.values(data._sessions || {})) {
                        if (s?.indexInfo?.remoteIdentityKey) {
                            targetIdentityKey = s.indexInfo.remoteIdentityKey;
                            targetRegId = s.registrationId;
                            break;
                        }
                    }
                } catch (e) {}
                if (targetIdentityKey) break;
            }
        }

        if (!targetIdentityKey) return null;

        for (const file of files) {
            if (file.startsWith('session-') && !file.startsWith(`session-${lid}`) && !file.includes('@')) {
                const match = file.match(/^session-(\d+)\./);
                if (match) {
                    try {
                        const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
                        if (raw.includes(targetIdentityKey) || (targetRegId && raw.includes(String(targetRegId)))) {
                            return match[1];
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (err) {
        console.error('Error resolviendo LID:', err.message);
    }
    return null;
}

/**
 * Extrae de forma exhaustiva el texto de cualquier mensaje de WhatsApp
 * soportando mensajes extendidos, editados, efímeros, respuestas y botones.
 */
function getMessageBody(msg) {
    if (!msg) return '';
    let m = null;
    try {
        m = extractMessageContent(msg.message) || normalizeMessageContent(msg.message) || msg.message;
    } catch (e) {
        m = msg.message;
    }
    if (!m) return '';

    // Desempaquetar capas recursivas si están anidadas
    for (let i = 0; i < 5; i++) {
        if (m?.deviceSentMessage?.message) {
            m = extractMessageContent(m.deviceSentMessage.message) || m.deviceSentMessage.message;
        } else if (m?.editedMessage?.message?.protocolMessage?.editedMessage) {
            m = extractMessageContent(m.editedMessage.message.protocolMessage.editedMessage) || m.editedMessage.message.protocolMessage.editedMessage;
        } else if (m?.ephemeralMessage?.message) {
            m = extractMessageContent(m.ephemeralMessage.message) || m.ephemeralMessage.message;
        } else if (m?.viewOnceMessage?.message) {
            m = extractMessageContent(m.viewOnceMessage.message) || m.viewOnceMessage.message;
        } else if (m?.viewOnceMessageV2?.message) {
            m = extractMessageContent(m.viewOnceMessageV2.message) || m.viewOnceMessageV2.message;
        } else if (m?.documentWithCaptionMessage?.message) {
            m = extractMessageContent(m.documentWithCaptionMessage.message) || m.documentWithCaptionMessage.message;
        } else {
            break;
        }
    }

    if (typeof m?.conversation === 'string' && m.conversation.trim()) {
        return m.conversation.trim();
    }
    if (typeof m?.extendedTextMessage?.text === 'string' && m.extendedTextMessage.text.trim()) {
        return m.extendedTextMessage.text.trim();
    }
    if (typeof m?.imageMessage?.caption === 'string' && m.imageMessage.caption.trim()) {
        return m.imageMessage.caption.trim();
    }
    if (typeof m?.videoMessage?.caption === 'string' && m.videoMessage.caption.trim()) {
        return m.videoMessage.caption.trim();
    }
    if (typeof m?.documentMessage?.caption === 'string' && m.documentMessage.caption.trim()) {
        return m.documentMessage.caption.trim();
    }
    if (typeof m?.buttonsResponseMessage?.selectedDisplayText === 'string') {
        return m.buttonsResponseMessage.selectedDisplayText.trim();
    }
    if (typeof m?.listResponseMessage?.title === 'string') {
        return m.listResponseMessage.title.trim();
    }
    if (typeof m?.templateButtonReplyMessage?.selectedDisplayText === 'string') {
        return m.templateButtonReplyMessage.selectedDisplayText.trim();
    }

    // Búsqueda exhaustiva recursiva de cualquier propiedad con texto
    function deepText(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 4) return '';
        if (typeof obj.conversation === 'string' && obj.conversation) return obj.conversation;
        if (typeof obj.text === 'string' && obj.text && typeof obj.text !== 'object') return obj.text;
        if (typeof obj.caption === 'string' && obj.caption) return obj.caption;
        if (typeof obj.selectedDisplayText === 'string' && obj.selectedDisplayText) return obj.selectedDisplayText;

        for (const k of Object.keys(obj)) {
            if (k === 'contextInfo' || k === 'key' || k === 'senderKeyDistributionMessage') continue;
            if (typeof obj[k] === 'object' && obj[k] !== null) {
                const res = deepText(obj[k], depth + 1);
                if (res) return res;
            }
        }
        return '';
    }

    return deepText(m).trim();
}

/**
 * Detecta si el mensaje contiene contenido multimedia
 */
function hasMedia(msg) {
    let m = null;
    try {
        m = extractMessageContent(msg.message) || normalizeMessageContent(msg.message) || msg.message;
    } catch (e) {
        m = msg.message;
    }
    if (!m) return false;
    return !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage);
}

/**
 * Identifica si es un mensaje de señalización o protocolo interno de WhatsApp
 * que NO representa un mensaje de usuario a mostrar en chat.
 */
function isSignalingOrProtocolMessage(msg) {
    const m = msg?.message;
    if (!m) return true;
    const keys = Object.keys(m);
    if (keys.length === 0) return true;
    const nonProtocolKeys = keys.filter(k => 
        k !== 'senderKeyDistributionMessage' && 
        k !== 'messageContextInfo' && 
        k !== 'protocolMessage' &&
        k !== 'appStateSyncKeyShare' &&
        k !== 'appStateSyncKeyFingerprint' &&
        k !== 'reactionMessage'
    );
    return nonProtocolKeys.length === 0;
}

async function initSession(instanceName, forceRefresh = false) {
    if (!forceRefresh && instances.has(instanceName)) {
        const existing = instances.get(instanceName);
        if (existing.state === 'open' || existing.state === 'connecting') {
            return existing;
        }
    }

    if (initializingMap.get(instanceName)) {
        return instances.get(instanceName);
    }
    initializingMap.set(instanceName, true);

    // Si forzamos refresh o existía sesión previa desconectada, cerrar socket previo si lo hubiera
    if (instances.has(instanceName)) {
        try {
            const oldInst = instances.get(instanceName);
            if (oldInst?.sock) {
                oldInst.sock.ev.removeAllListeners();
                oldInst.sock.end(undefined);
            }
        } catch (e) {}
    }

    const sessionPath = path.join(SESSIONS_DIR, instanceName);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    let waVersion = [2, 3000, 1015901307];
    try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
    } catch (e) {}

    // Almacén de mensajes en memoria para responder reintentos de cifrado E2EE de WhatsApp
    const messageStore = new Map();

    const sock = makeWASocket({
        version: waVersion,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: undefined,
        getMessage: async (key) => {
            if (key?.id && messageStore.has(key.id)) {
                return messageStore.get(key.id);
            }
            return undefined;
        }
    });

    const instData = {
        name: instanceName,
        sock,
        messageStore,
        state: 'connecting',
        qrBase64: null,
        qrRaw: null,
        qrTimestamp: 0,
        phone: null,
        pushName: null,
    };

    instances.set(instanceName, instData);
    initializingMap.delete(instanceName);

    sock.ev.on('creds.update', async () => {
        try {
            await saveCreds();
        } catch (e) {
            console.error(`[${instanceName}] Error guardando credenciales:`, e);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                instData.qrRaw = qr;
                instData.qrTimestamp = Date.now();
                instData.qrBase64 = await QRCode.toDataURL(qr, {
                    margin: 4,
                    scale: 10,
                    errorCorrectionLevel: 'M',
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });
                instData.state = 'connecting';
                console.log(`[${instanceName}] ✅ Nuevo código QR generado (${qr.substring(0, 18)}...).`);
            } catch (err) {
                console.error(`[${instanceName}] Error generando QR base64:`, err);
            }
        }

        if (connection === 'open') {
            instData.state = 'open';
            instData.qrBase64 = null;
            instData.qrRaw = null;
            const user = sock.user;
            if (user) {
                instData.phone = user.id ? user.id.split(':')[0].split('@')[0] : null;
                instData.pushName = user.name || 'Operador Help House';
            }
            console.log(`[${instanceName}] 🎉 ¡WhatsApp CONECTADO EXITOSAMENTE! Teléfono: ${instData.phone}`);
        } else if (connection === 'close') {
            instData.state = 'close';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isRestart = statusCode === DisconnectReason.restartRequired; // 515
            const isLoggedOut = statusCode === DisconnectReason.loggedOut; // 401
            const shouldReconnect = !isLoggedOut;

            console.log(`[${instanceName}] Conexión cerrada. Código: ${statusCode} (${isRestart ? 'restartRequired 515 -> reconectando sesión autenticada' : 'close'}). Reconectar: ${shouldReconnect}`);

            if (shouldReconnect) {
                const delay = isRestart ? 400 : 1500;
                setTimeout(() => {
                    console.log(`[${instanceName}] 🔄 Reconectando socket tras código ${statusCode}...`);
                    initSession(instanceName, true);
                }, delay);
            } else {
                try {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                } catch (e) {}
                instances.delete(instanceName);
            }
        }
    });

    // Sincronización continua de contactos y chats para asociar LIDs a teléfonos reales
    sock.ev.on('contacts.upsert', (contacts) => {
        try {
            for (const c of contacts) {
                if (c.id && c.lid) recordPhoneMapping(c.lid, c.id);
                if (c.id && c.phoneNumber) recordPhoneMapping(c.id, c.phoneNumber);
            }
        } catch (e) {}
    });

    sock.ev.on('contacts.update', (updates) => {
        try {
            for (const c of updates) {
                if (c.id && c.lid) recordPhoneMapping(c.lid, c.id);
                if (c.id && c.phoneNumber) recordPhoneMapping(c.id, c.phoneNumber);
            }
        } catch (e) {}
    });

    sock.ev.on('chats.upsert', (chats) => {
        try {
            for (const chat of chats) {
                if (chat.id && chat.lid) recordPhoneMapping(chat.lid, chat.id);
            }
        } catch (e) {}
    });

    // Escuchador de Mensajes Entrantes (Inbound Webhook)
    sock.ev.on('messages.upsert', async (mUpsert) => {
        try {
            const { messages } = mUpsert;
            if (!messages || messages.length === 0) return;

            for (const msg of messages) {
                // Registrar siempre en el almacén de mensajes para responder reintentos de cifrado E2EE
                if (msg.key?.id && msg.message) {
                    messageStore.set(msg.key.id, msg.message);
                }

                // Ignorar mensajes enviados por nosotros mismos en este evento
                if (msg.key && msg.key.fromMe) continue;

                const remoteJid = msg.key?.remoteJid || '';
                // Ignorar estados de WhatsApp, canales (newsletters) y grupos
                if (!remoteJid || 
                    remoteJid.includes('@g.us') || 
                    remoteJid.includes('@newsletter') || 
                    remoteJid.includes('broadcast') || 
                    remoteJid === 'status@broadcast') {
                    continue;
                }

                // Filtrar eventos internos de WhatsApp que NO son mensajes de usuario (protocolos, sincronización de claves, etc.)
                if (isSignalingOrProtocolMessage(msg)) {
                    continue;
                }

                let senderPhone = remoteJid.split('@')[0].replace(/[^0-9]/g, '');
                const rawLid = remoteJid.endsWith('@lid') ? senderPhone : null;

                // 1. Revisar si WhatsApp incluyó el número telefónico real (senderPn / participantPn)
                const senderPn = msg.key?.senderPn || msg.key?.participantPn || msg.participant;
                if (senderPn) {
                    const cleanPn = String(senderPn).split('@')[0].replace(/[^0-9]/g, '');
                    if (cleanPn && cleanPn !== senderPhone) {
                        recordPhoneMapping(remoteJid, cleanPn);
                        if (rawLid) recordPhoneMapping(rawLid, cleanPn);
                        senderPhone = cleanPn;
                    }
                }

                // 2. Revisar si tenemos mapeo registrado previo en memoria o disco
                if (phoneMap[senderPhone]) {
                    console.log(`[${instanceName}] 🔄 JID/LID ${senderPhone} resuelto por mapeo a: ${phoneMap[senderPhone]}`);
                    senderPhone = phoneMap[senderPhone];
                }
                // 3. Si sigue siendo un LID (@lid), intentar resolver con Signal keys o último contacto de la instancia
                else if (rawLid) {
                    const resolved = resolveLidToPhone(sessionPath, rawLid);
                    if (resolved) {
                        console.log(`[${instanceName}] 🔄 LID ${rawLid} resuelto en sesión a teléfono: ${resolved}`);
                        recordPhoneMapping(rawLid, resolved);
                        senderPhone = resolved;
                    } else if (instData.lastContactPhone) {
                        console.log(`[${instanceName}] 🔄 LID ${rawLid} asociado al último contacto activo: ${instData.lastContactPhone}`);
                        recordPhoneMapping(rawLid, instData.lastContactPhone);
                        senderPhone = instData.lastContactPhone;
                    } else {
                        console.log(`[${instanceName}] ℹ️ LID ${rawLid} detectado (se enviará con lid para resolución en backend).`);
                    }
                }

                // Confirmar recibo/lectura para sincronizar la sesión criptográfica en el móvil
                try {
                    await sock.readMessages([msg.key]);
                } catch (e) {}

                // Extraer el texto real del mensaje de manera exhaustiva
                const bodyText = getMessageBody(msg);
                const isMedia = hasMedia(msg);

                // Si no hay texto ni multimedia (mensaje vacío o protocolo residual), no enviar al webhook
                if (!bodyText && !isMedia) {
                    continue;
                }

                const finalMessage = bodyText || (isMedia ? '[Archivo adjunto / Multimedia]' : '');

                console.log(`[${instanceName}] 📩 Mensaje entrante de ${senderPhone}: "${finalMessage.substring(0, 60)}"`);

                // Enviar payload al Webhook de Help House
                if (WEBHOOK_URL) {
                    try {
                        const payload = {
                            event: 'messages.upsert',
                            instanceName: instanceName,
                            messageId: msg.key?.id,
                            from: senderPhone,
                            lid: rawLid || null,
                            pushName: msg.pushName || null,
                            message: finalMessage,
                            timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000)
                        };

                        const targetUrl = WEBHOOK_URL.includes('?')
                            ? `${WEBHOOK_URL}&api_key=${encodeURIComponent(API_KEY)}`
                            : `${WEBHOOK_URL}?api_key=${encodeURIComponent(API_KEY)}`;

                        console.log(`[${instanceName}] 🚀 Despachando webhook entrante a ${targetUrl}`);

                        const response = await fetch(targetUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'apikey': API_KEY,
                                'X-Help-House-Secret': API_KEY
                            },
                            body: JSON.stringify(payload)
                        });

                        const resData = await response.json().catch(() => null);
                        if (response.ok) {
                            console.log(`[${instanceName}] 🚀 Webhook despachado con éxito a Help House:`, resData);
                        } else {
                            console.warn(`[${instanceName}] ⚠️ Webhook respondió con código ${response.status}:`, resData);
                        }
                    } catch (webhookErr) {
                        console.error(`[${instanceName}] Error notificando al Webhook de Help House (${WEBHOOK_URL}):`, webhookErr.message);
                    }
                }
            }
        } catch (err) {
            console.error(`[${instanceName}] Error procesando evento messages.upsert:`, err);
        }
    });

    return instData;
}

// 1. Crear instancia
app.post('/instance/create', async (req, res) => {
    const { instanceName, webhookUrl } = req.body;
    if (!instanceName) {
        return res.status(400).json({ error: 'instanceName es obligatorio' });
    }

    if (webhookUrl && typeof webhookUrl === 'string') {
        WEBHOOK_URL = webhookUrl.trim();
        console.log(`[Gateway] 🔗 Webhook URL configurada en create: ${WEBHOOK_URL}`);
    }

    try {
        await initSession(instanceName);
        res.json({ success: true, instanceName, status: 'created', webhookUrl: WEBHOOK_URL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Conectar y obtener código QR
app.get('/instance/connect/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    if (req.query.webhookUrl) {
        WEBHOOK_URL = String(req.query.webhookUrl).trim();
        console.log(`[Gateway] 🔗 Webhook URL configurada en connect: ${WEBHOOK_URL}`);
    }

    try {
        let inst = instances.get(instanceName);
        if (!inst) {
            inst = await initSession(instanceName);
        }

        // Si aún no tiene QR y está conectando, esperar unos segundos
        if (!inst.qrBase64 && inst.state === 'connecting') {
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 500));
                inst = instances.get(instanceName);
                if (inst?.qrBase64 || inst?.state === 'open') break;
            }
        }

        if (inst.state === 'open') {
            return res.json({
                success: true,
                state: 'open',
                phone: inst.phone,
                pushName: inst.pushName
            });
        }

        if (inst.qrBase64) {
            return res.json({
                success: true,
                base64: inst.qrBase64,
                code: 'QR_ACTIVE',
                state: 'connecting'
            });
        }

        res.json({
            success: false,
            error: 'Generando código QR, por favor reintenta en un momento...',
            state: inst.state
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Consultar estado de conexión (incluye QR activo si está conectando)
app.get('/instance/connectionState/:instanceName', (req, res) => {
    const { instanceName } = req.params;
    const inst = instances.get(instanceName);

    if (!inst) {
        return res.json({
            instance: { state: 'close' },
            qr: null,
            phone: null,
            pushName: null
        });
    }

    res.json({
        instance: { state: inst.state },
        qr: inst.qrBase64,
        phone: inst.phone,
        pushName: inst.pushName
    });
});

// 3.1 Reiniciar instancia para forzar nuevo QR fresco
app.post('/instance/restart/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    try {
        const inst = await initSession(instanceName, true);
        res.json({ success: true, instanceName, status: 'restarted', state: inst.state });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Enviar mensaje de texto
app.post('/message/sendText/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const { number, text } = req.body;

    const inst = instances.get(instanceName);
    if (!inst || inst.state !== 'open') {
        return res.status(400).json({ error: 'La sesión de WhatsApp no está conectada' });
    }

    if (!number || !text) {
        return res.status(400).json({ error: 'Número y texto son obligatorios' });
    }

    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        let jid = `${cleanNumber}@s.whatsapp.net`;

        // Sincronizar llaves y verificar JID registrado en WhatsApp antes de enviar
        try {
            const onWa = await inst.sock.onWhatsApp(cleanNumber);
            if (Array.isArray(onWa) && onWa.length > 0 && onWa[0]?.exists && onWa[0]?.jid) {
                jid = onWa[0].jid;
            }
        } catch (e) {}

        const sent = await inst.sock.sendMessage(jid, { text });

        // Mapear JID y remoteJid al número telefónico real del destinatario
        inst.lastContactPhone = cleanNumber;
        recordPhoneMapping(jid, cleanNumber);
        if (sent?.key?.remoteJid) {
            recordPhoneMapping(sent.key.remoteJid, cleanNumber);
        }

        // Guardar mensaje en store para resolver solicitudes de reintento de descifrado E2EE
        if (sent?.key?.id && sent?.message && inst.messageStore) {
            inst.messageStore.set(sent.key.id, sent.message);
        }

        res.json({
            success: true,
            key: sent.key,
            messageId: sent.key.id
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Enviar mensaje multimedia / documento
app.post('/message/sendMedia/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const { number, mediaMessage } = req.body;

    const inst = instances.get(instanceName);
    if (!inst || inst.state !== 'open') {
        return res.status(400).json({ error: 'La sesión de WhatsApp no está conectada' });
    }

    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        let jid = `${cleanNumber}@s.whatsapp.net`;

        try {
            const onWa = await inst.sock.onWhatsApp(cleanNumber);
            if (Array.isArray(onWa) && onWa.length > 0 && onWa[0]?.exists && onWa[0]?.jid) {
                jid = onWa[0].jid;
            }
        } catch (e) {}

        const { media, caption, fileName } = mediaMessage || {};

        let msgOptions = {};
        if (media && (media.startsWith('http://') || media.startsWith('https://'))) {
            msgOptions = {
                document: { url: media },
                mimetype: 'application/pdf',
                fileName: fileName || 'documento.pdf',
                caption: caption || ''
            };
        } else {
            msgOptions = { text: caption || '' };
        }

        const sent = await inst.sock.sendMessage(jid, msgOptions);

        // Mapear JID y remoteJid al número telefónico real del destinatario
        inst.lastContactPhone = cleanNumber;
        recordPhoneMapping(jid, cleanNumber);
        if (sent?.key?.remoteJid) {
            recordPhoneMapping(sent.key.remoteJid, cleanNumber);
        }

        if (sent?.key?.id && sent?.message && inst.messageStore) {
            inst.messageStore.set(sent.key.id, sent.message);
        }

        res.json({
            success: true,
            key: sent.key,
            messageId: sent.key.id
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Cerrar sesión
app.delete('/instance/logout/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const inst = instances.get(instanceName);

    if (inst) {
        try {
            await inst.sock.logout();
        } catch (e) {}
        instances.delete(instanceName);
    }

    const sessionPath = path.join(SESSIONS_DIR, instanceName);
    try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (e) {}

    res.json({ success: true, message: 'Sesión cerrada exitosamente' });
});

// 7. Ping / Health
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Help House WhatsApp Gateway activo en puerto ${PORT}`);
    console.log(`====================================================`);
});
