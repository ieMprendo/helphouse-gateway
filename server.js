import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Baileys import
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
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

                let senderPhone = remoteJid.split('@')[0];

                // 1. Revisar si tenemos mapeo registrado previo en memoria o disco
                if (phoneMap[senderPhone]) {
                    console.log(`[${instanceName}] 🔄 JID ${senderPhone} resuelto por mapeo registrado a: ${phoneMap[senderPhone]}`);
                    senderPhone = phoneMap[senderPhone];
                }
                // 2. Si viene como LID (@lid), resolver al número telefónico real del usuario
                else if (remoteJid.endsWith('@lid')) {
                    const resolved = resolveLidToPhone(sessionPath, senderPhone);
                    if (resolved) {
                        console.log(`[${instanceName}] 🔄 LID ${senderPhone} resuelto exitosamente a teléfono: ${resolved}`);
                        recordPhoneMapping(senderPhone, resolved);
                        senderPhone = resolved;
                    } else if (msg.key?.participant) {
                        const partPhone = msg.key.participant.split('@')[0].replace(/[^0-9]/g, '');
                        if (partPhone) {
                            console.log(`[${instanceName}] 🔄 Participante resuelto a teléfono: ${partPhone}`);
                            recordPhoneMapping(senderPhone, partPhone);
                            senderPhone = partPhone;
                        }
                    } else {
                        console.log(`[${instanceName}] ℹ️ LID ${senderPhone} detectado sin sesión vinculada aún.`);
                    }
                }

                // Confirmar recibo/lectura para sincronizar la sesión criptográfica en el móvil
                try {
                    await sock.readMessages([msg.key]);
                } catch (e) {}

                let bodyText = '';
                let m = msg.message;

                // Desenvolver envoltorios efímeros (mensajes temporales), vista única o adjuntos con texto
                while (m && (m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.documentWithCaptionMessage)) {
                    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
                }

                if (m?.conversation) {
                    bodyText = m.conversation;
                } else if (m?.extendedTextMessage?.text) {
                    bodyText = m.extendedTextMessage.text;
                } else if (m?.imageMessage?.caption) {
                    bodyText = m.imageMessage.caption;
                } else if (m?.documentMessage?.caption) {
                    bodyText = m.documentMessage.caption;
                } else if (m?.videoMessage?.caption) {
                    bodyText = m.videoMessage.caption;
                } else if (m?.buttonsResponseMessage?.selectedDisplayText) {
                    bodyText = m.buttonsResponseMessage.selectedDisplayText;
                } else if (m?.listResponseMessage?.title) {
                    bodyText = m.listResponseMessage.title;
                } else if (m?.templateButtonReplyMessage?.selectedDisplayText) {
                    bodyText = m.templateButtonReplyMessage.selectedDisplayText;
                }

                console.log(`[${instanceName}] 📩 Mensaje entrante de ${senderPhone}: "${(bodyText || '').substring(0, 60)}"`);

                // Enviar payload al Webhook de Help House
                if (WEBHOOK_URL) {
                    try {
                        const payload = {
                            event: 'messages.upsert',
                            instanceName: instanceName,
                            messageId: msg.key?.id,
                            from: senderPhone,
                            pushName: msg.pushName || null,
                            message: bodyText || '[Mensaje o elemento multimedia]',
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
