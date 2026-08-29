'use strict';
require('dotenv').config(); // load .env (DATABASE_URL, AUTH_TOKEN, HOST, PORT)
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const OpenAI  = require('openai');

const { PostgresDB, tableFormat } = require('./dbsys/workarea/db_core');
const { TOOL_DEFINITIONS, dispatchTool } = require('./dbsys/workarea/db_agent_toolkit');

const PORT   = process.env.PORT || 3300;
const HOST   = process.env.HOST || '127.0.0.1'; // bind loopback by default — override with HOST=0.0.0.0 to expose
// Connection URL resolution order:
//   1. db_config.json (written by the app's Settings menu — takes precedence)
//   2. DATABASE_URL env var
//   3. dbsys/workarea/db_info.txt (legacy fallback, bootstrapping only)
const fs = require('fs');
const DB_CONFIG_PATH = path.join(__dirname, 'db_config.json');
function loadDbUrl() {
    try {
        const cfg = JSON.parse(fs.readFileSync(DB_CONFIG_PATH, 'utf8'));
        if (cfg && typeof cfg.dbUrl === 'string' && cfg.dbUrl.trim()) return cfg.dbUrl.trim();
    } catch (_) { /* no config file yet */ }
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
    try {
        return fs.readFileSync(path.join(__dirname, 'dbsys', 'workarea', 'db_info.txt'), 'utf8').trim();
    } catch (_) {
        return '';
    }
}
let DB_URL = loadDbUrl();

// Swap the shared DB connection to a new URL (used by POST /api/db-config).
function setDbUrl(newUrl) {
    DB_URL = newUrl;
    try { fs.writeFileSync(DB_CONFIG_PATH, JSON.stringify({ dbUrl: newUrl }, null, 2)); }
    catch (e) { console.error('Failed to persist db_config.json:', e.message); }
    if (db) {
        // Drop the old connection; the next request reconnects with the new URL.
        const old = db;
        old.client = null; // prevent further use
    }
    db = new PostgresDB(DB_URL);
    connectPromise = null;
    fileTableReady = false;
    skillsTableReady = false;
    toolsTableReady = false;
    charactersTableReady = false;
}

const DESTRUCTIVE = new Set(['drop_table', 'truncate_table', 'delete_rows', 'drop_column']);
// Statements that can destroy or broadly mutate data — require explicit confirm:true
const DESTRUCTIVE_SQL = /\b(DROP|TRUNCATE|DELETE|ALTER|UPDATE|GRANT|REVOKE)\b/i;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ── Optional auth ─────────────────────────────────────────────────────────────
// Set AUTH_TOKEN to require a token on every /api/* route. The frontend sends it
// as the `X-Auth-Token` header (or `Authorization: Bearer <token>`).
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
if (AUTH_TOKEN) {
    app.use('/api', (req, res, next) => {
        const provided = req.headers['x-auth-token']
            || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (provided !== AUTH_TOKEN) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });
}

// ── Shared DB connection ─────────────────────────────────────────────────────
let db = new PostgresDB(DB_URL);

let connectPromise = null; // single-flight guard so concurrent requests share one connect

async function ensureConnected() {
    // If a connect is already in flight, share it instead of racing a second one.
    if (connectPromise) return connectPromise;

    // Always create a fresh client if not connected or if the previous one errored
    if (!db.client) {
        connectPromise = db.connect().finally(() => { connectPromise = null; });
        return connectPromise;
    }
    // Ping to verify the connection is still alive
    try {
        await db.client.query('SELECT 1');
    } catch {
        // Connection dropped (e.g. Neon idle timeout) — reconnect
        db.client = null;
        connectPromise = db.connect().finally(() => { connectPromise = null; });
        return connectPromise;
    }
}

// ── File store ────────────────────────────────────────────────────────────────
let fileTableReady = false;

async function ensureFileTable() {
    await ensureConnected();
    if (!fileTableReady) {
        await db.client.query(`
            CREATE TABLE IF NOT EXISTS app_files (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL,
                folder     TEXT NOT NULL DEFAULT '/',
                content    TEXT NOT NULL DEFAULT '',
                language   TEXT NOT NULL DEFAULT 'plain',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(folder, name)
            )
        `);
        fileTableReady = true;
    }
}

// ── Skills store ──────────────────────────────────────────────────────────────
let skillsTableReady = false;

async function ensureSkillsTable() {
    await ensureConnected();
    if (!skillsTableReady) {
        await db.client.query(`
            CREATE TABLE IF NOT EXISTS app_skills (
                id           SERIAL PRIMARY KEY,
                name         TEXT NOT NULL UNIQUE,
                description  TEXT NOT NULL DEFAULT '',
                instructions TEXT NOT NULL DEFAULT '',
                resources    JSONB NOT NULL DEFAULT '[]',
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        skillsTableReady = true;
    }
}

// ── Custom tools store ─────────────────────────────────────────────────────────
let toolsTableReady = false;

async function ensureToolsTable() {
    await ensureConnected();
    if (!toolsTableReady) {
        await db.client.query(`
            CREATE TABLE IF NOT EXISTS app_tools (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                parameters  JSONB NOT NULL DEFAULT '{}',
                body        TEXT NOT NULL DEFAULT '',
                language    TEXT NOT NULL DEFAULT 'python',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        // Backfill language for any rows created before the column existed.
        try { await db.client.query(`ALTER TABLE app_tools ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'python'`); } catch (_) {}
        toolsTableReady = true;
    }
}

// ── Character cards store ──────────────────────────────────────────────────────
let charactersTableReady = false;

async function ensureCharactersTable() {
    await ensureConnected();
    if (!charactersTableReady) {
        await db.client.query(`
            CREATE TABLE IF NOT EXISTS app_characters (
                id                   SERIAL PRIMARY KEY,
                name                 TEXT NOT NULL UNIQUE,
                description          TEXT NOT NULL DEFAULT '',
                personality          TEXT NOT NULL DEFAULT '',
                scenario             TEXT NOT NULL DEFAULT '',
                first_mes            TEXT NOT NULL DEFAULT '',
                mes_example          TEXT NOT NULL DEFAULT '',
                system_prompt        TEXT NOT NULL DEFAULT '',
                post_history         TEXT NOT NULL DEFAULT '',
                alternate_greetings  JSONB NOT NULL DEFAULT '[]',
                character_book       JSONB NOT NULL DEFAULT '{}',
                tags                 JSONB NOT NULL DEFAULT '[]',
                creator              TEXT NOT NULL DEFAULT '',
                character_version    TEXT NOT NULL DEFAULT '',
                avatar               TEXT NOT NULL DEFAULT '',
                created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        charactersTableReady = true;
    }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/status
app.get('/api/status', async (req, res) => {
    try {
        await ensureConnected();
        const masked = DB_URL.replace(/:\/\/[^@]+@/, '://*****@');
        res.json({ connected: true, dbUrl: masked });
    } catch (e) {
        res.json({ connected: false, error: e.message });
    }
});

// GET /api/db-config — current connection URL for the Settings menu
app.get('/api/db-config', (_req, res) => {
    res.json({ dbUrl: DB_URL, configured: Boolean(DB_URL) });
});

// POST /api/db-config { dbUrl } — set a new Postgres endpoint from the Settings
// menu, persist it to db_config.json, and reconnect immediately.
app.post('/api/db-config', async (req, res) => {
    const dbUrl = (req.body && typeof req.body.dbUrl === 'string') ? req.body.dbUrl.trim() : '';
    if (!dbUrl) return res.status(400).json({ success: false, error: 'Missing dbUrl' });
    if (!/^postgres(ql)?:\/\//i.test(dbUrl)) {
        return res.status(400).json({ success: false, error: 'URL must start with postgres:// or postgresql://' });
    }
    try {
        setDbUrl(dbUrl);
        await ensureConnected();
        const masked = dbUrl.replace(/:\/\/[^@]+@/, '://*****@');
        res.json({ success: true, dbUrl: masked });
    } catch (e) {
        // URL was saved and will be retried; surface the connect error so the
        // user can fix a bad endpoint without restarting the server.
        res.json({ success: true, warning: e.message });
    }
});

// GET /api/tools
app.get('/api/tools', (_req, res) => {
    res.json(TOOL_DEFINITIONS);
});

// GET /api/models  — proxy to any OpenAI-compatible provider, cache for 5 min
const https = require('https');
const modelsCache = new Map(); // key -> { at, data }
const MODELS_TTL = 5 * 60 * 1000;

// Normalize a provider's /models response into the shape the frontend picker
// expects (OpenRouter-style): { id, name, context_length, pricing:{prompt,completion}, architecture:{input_modalities,output_modalities} }.
// Handles OpenRouter, Venice, and generic OpenAI-compatible providers.
function normalizeModels(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
    return list.map(m => {
        const spec = m.model_spec || {};
        const pricing = m.pricing || spec.pricing || {};
        const caps = spec.capabilities || {};
        const inMods  = [];
        const outMods = [];
        if (m.architecture?.input_modalities)  inMods.push(...m.architecture.input_modalities);
        if (m.architecture?.output_modalities) outMods.push(...m.architecture.output_modalities);
        if (caps.supportsAudioInput) inMods.push('audio');
        if (caps.supportsMultipleImages || caps.supportsImageInput) inMods.push('image');
        if (caps.supportsFileInput) inMods.push('file');
        if (caps.supportsAudioOutput) outMods.push('audio');
        if (caps.supportsImageOutput) outMods.push('image');
        if (!inMods.length)  inMods.push('text');
        if (!outMods.length) outMods.push('text');
        return {
            id: m.id,
            name: m.name || spec.name || m.id,
            context_length: m.context_length || spec.availableContextTokens || 0,
            pricing: {
                prompt:     m.pricing?.prompt     ?? pricing.input?.usd     ?? pricing.prompt ?? 0,
                completion: m.pricing?.completion ?? pricing.output?.usd    ?? pricing.completion ?? 0,
            },
            architecture: { input_modalities: inMods, output_modalities: outMods },
        };
    });
}

app.get('/api/models', (req, res) => {
    const key = req.query.key || '';
    // base_url is the provider root (e.g. https://api.venice.ai/api/v1). Parse it
    // into hostname + path so we can proxy to any OpenAI-compatible provider.
    const baseUrl = (req.query.base_url || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    let hostname, pathPrefix;
    try {
        const u = new URL(baseUrl);
        hostname = u.hostname;
        pathPrefix = u.pathname.replace(/\/+$/, '');
    } catch {
        return res.status(400).json({ error: 'Invalid base_url' });
    }
    const cacheKey = `${key}|${baseUrl}`;
    const entry = modelsCache.get(cacheKey);
    if (entry && Date.now() - entry.at < MODELS_TTL) {
        return res.json({ data: entry.data });
    }
    const opts = {
        hostname,
        path: `${pathPrefix}/models`,
        headers: {
            'Accept': 'application/json',
            ...(key ? { 'Authorization': `Bearer ${key}` } : {}),
        },
    };
    const proxyReq = https.get(opts, proxyRes => {
        let raw = '';
        proxyRes.on('data', c => raw += c);
        proxyRes.on('end', () => {
            try {
                const parsed = JSON.parse(raw);
                const normalized = normalizeModels(parsed);
                // Only cache successful responses — never cache an error body.
                if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
                    modelsCache.set(cacheKey, { at: Date.now(), data: normalized });
                }
                res.status(proxyRes.statusCode || 200).json({ data: normalized });
            } catch {
                res.status(502).json({ error: 'Bad response from provider' });
            }
        });
    });
    proxyReq.on('error', e => res.status(500).json({ error: e.message }));
});

// POST /api/db  { tool, args }
app.post('/api/db', async (req, res) => {
    const { tool, args = {} } = req.body || {};
    if (!tool) return res.status(400).json({ success: false, error: 'Missing tool name' });

    // Guard: destructive operations require explicit confirmation
    if (DESTRUCTIVE.has(tool) && args.confirm !== true) {
        return res.status(400).json({ success: false, error: `Destructive operation '${tool}' requires confirm: true` });
    }
    if (tool === 'execute_sql' && typeof args.sql === 'string'
        && DESTRUCTIVE_SQL.test(args.sql) && args.confirm !== true) {
        return res.status(400).json({ success: false, error: 'Destructive SQL requires confirm: true' });
    }

    try {
        await ensureConnected();
        const result = await dispatchTool(db, tool, args);
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── File store routes ─────────────────────────────────────────────────────────

// GET /api/files — list all (no content payload)
app.get('/api/files', async (req, res) => {
    try {
        await ensureFileTable();
        const { folder } = req.query;
        const params = [];
        let sql = `SELECT id, name, folder, language,
                          length(content) AS size, created_at, updated_at
                   FROM app_files`;
        if (folder) { sql += ` WHERE folder = $1`; params.push(folder); }
        sql += ` ORDER BY folder, name`;
        const { rows } = await db.client.query(sql, params);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/files/:id — get single file with content
app.get('/api/files/:id', async (req, res) => {
    try {
        await ensureFileTable();
        const { rows } = await db.client.query(
            `SELECT * FROM app_files WHERE id = $1`, [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'File not found' });
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/files — create or upsert
app.post('/api/files', async (req, res) => {
    const { name, folder = '/', content = '', language = 'plain' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        await ensureFileTable();
        const { rows } = await db.client.query(
            `INSERT INTO app_files (name, folder, content, language)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (folder, name) DO UPDATE
               SET content = EXCLUDED.content,
                   language = EXCLUDED.language,
                   updated_at = NOW()
             RETURNING id, name, folder, language, length(content) AS size, created_at, updated_at`,
            [name, folder, content, language]
        );
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/files/:id — partial update
app.put('/api/files/:id', async (req, res) => {
    const { name, folder, content, language } = req.body || {};
    const sets = []; const vals = []; let p = 1;
    if (name     !== undefined) { sets.push(`name = $${p++}`);     vals.push(name); }
    if (folder   !== undefined) { sets.push(`folder = $${p++}`);   vals.push(folder); }
    if (content  !== undefined) { sets.push(`content = $${p++}`);  vals.push(content); }
    if (language !== undefined) { sets.push(`language = $${p++}`); vals.push(language); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    try {
        await ensureFileTable();
        const { rows } = await db.client.query(
            `UPDATE app_files SET ${sets.join(', ')} WHERE id = $${p}
             RETURNING id, name, folder, language, length(content) AS size, updated_at`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'File not found' });
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/files/:id
app.delete('/api/files/:id', async (req, res) => {
    try {
        await ensureFileTable();
        const { rowCount } = await db.client.query(
            `DELETE FROM app_files WHERE id = $1`, [req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Skills routes ─────────────────────────────────────────────────────────────

// GET /api/skills — list metadata only (no instructions/resources payload)
app.get('/api/skills', async (req, res) => {
    try {
        await ensureSkillsTable();
        const { rows } = await db.client.query(`
            SELECT id, name, description,
                   jsonb_array_length(resources) AS resource_count,
                   created_at, updated_at
            FROM app_skills ORDER BY name
        `);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/skills/:id — full skill with instructions + resources
app.get('/api/skills/:id', async (req, res) => {
    try {
        await ensureSkillsTable();
        const { rows } = await db.client.query(
            `SELECT * FROM app_skills WHERE id = $1`, [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Skill not found' });
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/skills — create
app.post('/api/skills', async (req, res) => {
    const { name, description = '', instructions = '', resources = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        await ensureSkillsTable();
        const { rows } = await db.client.query(
            `INSERT INTO app_skills (name, description, instructions, resources)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING id, name, description, jsonb_array_length(resources) AS resource_count, created_at, updated_at`,
            [name, description, instructions, JSON.stringify(resources)]
        );
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/skills/:id — update
app.put('/api/skills/:id', async (req, res) => {
    const { name, description, instructions, resources } = req.body || {};
    const sets = []; const vals = []; let p = 1;
    if (name         !== undefined) { sets.push(`name = $${p++}`);         vals.push(name); }
    if (description  !== undefined) { sets.push(`description = $${p++}`);  vals.push(description); }
    if (instructions !== undefined) { sets.push(`instructions = $${p++}`); vals.push(instructions); }
    if (resources    !== undefined) { sets.push(`resources = $${p++}::jsonb`); vals.push(JSON.stringify(resources)); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    try {
        await ensureSkillsTable();
        const { rows } = await db.client.query(
            `UPDATE app_skills SET ${sets.join(', ')} WHERE id = $${p}
             RETURNING id, name, description, jsonb_array_length(resources) AS resource_count, updated_at`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'Skill not found' });
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/skills/:id
app.delete('/api/skills/:id', async (req, res) => {
    try {
        await ensureSkillsTable();
        const { rowCount } = await db.client.query(
            `DELETE FROM app_skills WHERE id = $1`, [req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Skill not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Custom tools routes ────────────────────────────────────────────────────────

// GET /api/custom-tools — list all custom tools
app.get('/api/custom-tools', async (req, res) => {
    try {
        await ensureToolsTable();
        const { rows } = await db.client.query(
            `SELECT id, name, description, parameters, body, language, created_at, updated_at
             FROM app_tools ORDER BY name`
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/custom-tools — create or upsert by name
app.post('/api/custom-tools', async (req, res) => {
    const { name, description = '', parameters = {}, body = '', language = 'python' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        await ensureToolsTable();
        const { rows } = await db.client.query(
            `INSERT INTO app_tools (name, description, parameters, body, language)
             VALUES ($1, $2, $3::jsonb, $4, $5)
             ON CONFLICT (name) DO UPDATE
               SET description = EXCLUDED.description,
                   parameters  = EXCLUDED.parameters,
                   body        = EXCLUDED.body,
                   language    = EXCLUDED.language,
                   updated_at  = NOW()
             RETURNING id, name, description, parameters, body, language, updated_at`,
            [name, description, JSON.stringify(parameters), body, language]
        );
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/custom-tools/:id — update
app.put('/api/custom-tools/:id', async (req, res) => {
    const { name, description, parameters, body, language } = req.body || {};
    const sets = []; const vals = []; let p = 1;
    if (name         !== undefined) { sets.push(`name = $${p++}`);         vals.push(name); }
    if (description  !== undefined) { sets.push(`description = $${p++}`);  vals.push(description); }
    if (parameters   !== undefined) { sets.push(`parameters = $${p++}::jsonb`); vals.push(JSON.stringify(parameters)); }
    if (body         !== undefined) { sets.push(`body = $${p++}`);         vals.push(body); }
    if (language     !== undefined) { sets.push(`language = $${p++}`);     vals.push(language); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    try {
        await ensureToolsTable();
        const { rows } = await db.client.query(
            `UPDATE app_tools SET ${sets.join(', ')} WHERE id = $${p}
             RETURNING id, name, description, parameters, body, language, updated_at`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'Tool not found' });
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/custom-tools/:id
app.delete('/api/custom-tools/:id', async (req, res) => {
    try {
        await ensureToolsTable();
        const { rowCount } = await db.client.query(
            `DELETE FROM app_tools WHERE id = $1`, [req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Tool not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Character cards ───────────────────────────────────────────────────────────
// v2 character cards are PNG images with a `chara` tEXt chunk containing
// base64-encoded JSON. Helpers to parse a card PNG and to build one.

function pngChunks(buf) {
    // PNG signature is 8 bytes; then repeated [len(4) type(4) data crc(4)].
    const chunks = [];
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.slice(off + 8, off + 8 + len);
        chunks.push({ type, data });
        off += 12 + len;
    }
    return chunks;
}

// Extract the chara card JSON from a v2 character-card PNG buffer.
function parseCharacterCard(buf) {
    for (const c of pngChunks(buf)) {
        if (c.type === 'tEXt') {
            // tEXt data: <keyword>\0<text>
            const nul = c.data.indexOf(0);
            if (nul < 0) continue;
            const keyword = c.data.toString('latin1', 0, nul);
            if (keyword === 'chara' || keyword === 'ccv3') {
                const b64 = c.data.toString('latin1', nul + 1);
                try {
                    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
                } catch { return null; }
            }
        }
    }
    return null;
}

// Build a minimal valid PNG carrying a `chara` tEXt chunk with the card JSON.
// If `avatar` (a data URL / base64 PNG) is provided, use it as the image so the
// card has a real thumbnail; otherwise emit a tiny 1x1 transparent PNG.
function buildCharacterCardPNG(cardJson, avatar) {
    const zlib = require('zlib');
    const crcTable = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(buf) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function chunk(type, data) {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const typeBuf = Buffer.from(type, 'ascii');
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
        return Buffer.concat([len, typeBuf, data, crcBuf]);
    }
    const text = Buffer.from('chara\0' + Buffer.from(JSON.stringify(cardJson), 'utf8').toString('base64'), 'latin1');

    let imgBuf = null;
    if (avatar) {
        // avatar may be a data URL (data:image/png;base64,...) or raw base64.
        const m = /^data:image\/png;base64,(.+)$/i.exec(avatar);
        const b64 = m ? m[1] : avatar;
        try { imgBuf = Buffer.from(b64, 'base64'); } catch { imgBuf = null; }
        if (imgBuf && imgBuf.slice(1, 4).toString('ascii') !== 'PNG') imgBuf = null;
    }
    if (!imgBuf) {
        // 1x1 transparent PNG
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
        ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type 6 (RGBA)
        const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
        imgBuf = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
        ]);
    }
    // Inject the chara tEXt chunk right after IHDR so it survives most tools.
    const ihdrEnd = 8 + 4 + 4 + 13 + 4;
    return Buffer.concat([imgBuf.slice(0, ihdrEnd), chunk('tEXt', text), imgBuf.slice(ihdrEnd)]);
}

// GET /api/characters — list metadata
app.get('/api/characters', async (req, res) => {
    try {
        await ensureCharactersTable();
        const { rows } = await db.client.query(
            `SELECT id, name, description, tags, creator, character_version, created_at, updated_at
             FROM app_characters ORDER BY name`
        );
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/characters/:id — full card
app.get('/api/characters/:id', async (req, res) => {
    try {
        await ensureCharactersTable();
        const { rows } = await db.client.query(`SELECT * FROM app_characters WHERE id = $1`, [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Character not found' });
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/characters — create or upsert by name
app.post('/api/characters', async (req, res) => {
    const c = req.body || {};
    if (!c.name) return res.status(400).json({ error: 'name is required' });
    try {
        await ensureCharactersTable();
        const { rows } = await db.client.query(
            `INSERT INTO app_characters
                (name, description, personality, scenario, first_mes, mes_example,
                 system_prompt, post_history, alternate_greetings, character_book,
                 tags, creator, character_version, avatar)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)
             ON CONFLICT (name) DO UPDATE SET
                description=$2, personality=$3, scenario=$4, first_mes=$5, mes_example=$6,
                system_prompt=$7, post_history=$8, alternate_greetings=$9::jsonb,
                character_book=$10::jsonb, tags=$11::jsonb, creator=$12, character_version=$13,
                avatar=$14, updated_at=NOW()
             RETURNING id, name, updated_at`,
            [c.name, c.description||'', c.personality||'', c.scenario||'', c.first_mes||'',
             c.mes_example||'', c.system_prompt||'', c.post_history||'',
             JSON.stringify(c.alternate_greetings||[]), JSON.stringify(c.character_book||{}),
             JSON.stringify(c.tags||[]), c.creator||'', c.character_version||'', c.avatar||'']
        );
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/characters/:id — update
app.put('/api/characters/:id', async (req, res) => {
    const c = req.body || {};
    const sets = []; const vals = []; let p = 1;
    const textCols = ['name','description','personality','scenario','first_mes','mes_example','system_prompt','post_history','creator','character_version','avatar'];
    const jsonCols = ['alternate_greetings','character_book','tags'];
    for (const col of textCols) {
        if (c[col] !== undefined) { sets.push(`${col} = $${p++}`); vals.push(c[col]); }
    }
    for (const col of jsonCols) {
        if (c[col] !== undefined) { sets.push(`${col} = $${p++}::jsonb`); vals.push(JSON.stringify(c[col])); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    try {
        await ensureCharactersTable();
        const { rows } = await db.client.query(
            `UPDATE app_characters SET ${sets.join(', ')} WHERE id = $${p} RETURNING id, name, updated_at`, vals
        );
        if (!rows.length) return res.status(404).json({ error: 'Character not found' });
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/characters/:id
app.delete('/api/characters/:id', async (req, res) => {
    try {
        await ensureCharactersTable();
        const { rowCount } = await db.client.query(`DELETE FROM app_characters WHERE id = $1`, [req.params.id]);
        if (!rowCount) return res.status(404).json({ error: 'Character not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/characters/import — accept a v2 card PNG (base64 or raw buffer), parse it
app.post('/api/characters/import', (req, res) => {
    const { png } = req.body || {};
    if (!png) return res.status(400).json({ error: 'Missing png' });
    let buf;
    const m = /^data:image\/png;base64,(.+)$/i.exec(png);
    try { buf = Buffer.from(m ? m[1] : png, 'base64'); }
    catch { return res.status(400).json({ error: 'Invalid PNG data' }); }
    const card = parseCharacterCard(buf);
    if (!card) return res.status(400).json({ error: 'No valid character card found in PNG' });
    const d = card.data || card;
    // The imported PNG itself is the character's avatar image.
    const avatar = `data:image/png;base64,${buf.toString('base64')}`;
    res.json({
        spec: card.spec || 'chara_card_v2',
        name: d.name || 'Imported Character',
        description: d.description || '',
        personality: d.personality || '',
        scenario: d.scenario || '',
        first_mes: d.first_mes || '',
        mes_example: d.mes_example || '',
        system_prompt: d.system_prompt || '',
        post_history: d.post_history_instructions || '',
        alternate_greetings: d.alternate_greetings || [],
        character_book: d.character_book || {},
        tags: d.tags || [],
        creator: d.creator || '',
        character_version: d.character_version || '',
        avatar,
    });
});

// GET /api/characters/:id/export — return the character as a v2 card PNG
app.get('/api/characters/:id/export', async (req, res) => {
    try {
        await ensureCharactersTable();
        const { rows } = await db.client.query(`SELECT * FROM app_characters WHERE id = $1`, [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Character not found' });
        const c = rows[0];
        const card = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: c.name,
                description: c.description,
                personality: c.personality,
                scenario: c.scenario,
                first_mes: c.first_mes,
                mes_example: c.mes_example,
                creator_notes: '',
                system_prompt: c.system_prompt,
                post_history_instructions: c.post_history,
                alternate_greetings: c.alternate_greetings || [],
                character_book: c.character_book || {},
                tags: c.tags || [],
                creator: c.creator,
                character_version: c.character_version,
                extensions: {},
            },
        };
        const png = buildCharacterCardPNG(card, c.avatar);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(c.name)}.png"`);
        res.send(png);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/extract  { url }  — extract article text from a web page.
// Runs the Python extractor (requests + bs4) server-side so the browser never
// hits the target site directly (avoids CORS). Returns { url, title, text, charCount }.
app.post('/api/extract', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const { execFile } = require('child_process');
    const script = path.join(__dirname, 'tools', 'python', 'extract_article.py');
    execFile('python3', [script, url], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
            return res.status(502).json({ error: stderr.trim() || err.message });
        }
        try {
            const parsed = JSON.parse(stdout);
            if (parsed.error) return res.status(422).json({ error: parsed.error });
            res.json(parsed);
        } catch {
            res.status(502).json({ error: 'Bad output from extractor' });
        }
    });
});

// ── Custom tool execution (Python, server-side) ─────────────────────────────
// Custom tools are Python `run(args)` functions. The body is written to a temp
// file, run with python3, and its JSON stdout is returned. `args` is passed via
// stdin. This runs server-side so tools can use Python libs (requests, bs4) and
// hit external sites without CORS.

function runPythonTool(body, args) {
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const os = require('os');
        const tmp = path.join(os.tmpdir(), `winbox_tool_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
        // Wrap the body: inject `args` from stdin, call run(args), print JSON.
        const wrapper = `import json, sys\nargs = json.loads(sys.stdin.read())\n${body}\nprint(json.dumps(run(args)))\n`;
        fs.writeFileSync(tmp, wrapper);
        const child = spawn('python3', [tmp]);
        let out = '', err = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => err += d);
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 30000);
        child.on('error', e => { clearTimeout(timer); fs.unlink(tmp, () => {}); reject(e); });
        child.on('close', code => {
            clearTimeout(timer);
            fs.unlink(tmp, () => {});
            if (code !== 0) return reject(new Error(err.trim() || `Tool exited with code ${code}`));
            try { resolve(JSON.parse(out)); }
            catch { reject(new Error('Tool did not return valid JSON.')); }
        });
        child.stdin.write(JSON.stringify(args));
        child.stdin.end();
    });
}

// POST /api/run-tool  { name, args }  or  { body, args }
// Runs a custom tool. If `body` is given use it directly (for the editor TEST
// button); otherwise look up the tool body by `name` in the DB.
app.post('/api/run-tool', async (req, res) => {
    const { name, body, args = {} } = req.body || {};
    if (!name && !body) return res.status(400).json({ success: false, error: 'Missing tool name or body' });
    try {
        let toolBody = body;
        if (!toolBody) {
            await ensureToolsTable();
            const { rows } = await db.client.query('SELECT body FROM app_tools WHERE name = $1', [name]);
            if (!rows.length) return res.status(404).json({ success: false, error: `Tool '${name}' not found` });
            toolBody = rows[0].body;
        }
        const result = await runPythonTool(toolBody, args);
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/chat  { model, messages, stream, tools, tool_choice, apiKey, baseUrl }
// Server-side proxy for chat completions. The browser calls this same-origin
// endpoint instead of the provider directly, which sidesteps CORS (some providers
// like Venice don't allow the Authorization header via Access-Control-Allow-Headers:*).
// The provider's SSE stream is piped back verbatim so the frontend parser is unchanged.
app.post('/api/chat', async (req, res) => {
    const { model, messages, stream = true, tools, tool_choice, response_format, apiKey, baseUrl = 'https://openrouter.ai/api/v1' } = req.body || {};
    if (!model)    return res.status(400).json({ error: 'Missing model' });
    if (!messages) return res.status(400).json({ error: 'Missing messages' });
    if (!apiKey)   return res.status(400).json({ error: 'Missing apiKey' });

    const target = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload = { model, messages, stream };
    if (tools && tools.length) { payload.tools = tools; payload.tool_choice = tool_choice || 'auto'; }
    // JSON mode (used by prompt-based tool calling, e.g. Featherless)
    if (response_format) payload.response_format = response_format;

    try {
        const upstream = await fetch(target, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': req.headers.referer || '',
                'X-Title': 'WinBox AI Chat',
            },
            body: JSON.stringify(payload),
        });

        // Pass through the upstream status + content type, then pipe the body.
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        if (!upstream.ok) {
            const text = await upstream.text();
            return res.end(text);
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
        }
        res.end();
    } catch (e) {
        if (!res.headersSent) res.status(502).json({ error: e.message });
        else res.end();
    }
});

// POST /api/generate-image  { prompt, apiKey, baseUrl, model, size }
// Proxies to an OpenAI-compatible image-generation endpoint (POST /images/generations).
// Matches the Venice `client.images.generate` API used in ven_image_gen_function.py.
// Returns { image: "data:image/png;base64,..." }.
app.post('/api/generate-image', async (req, res) => {
    const { prompt, apiKey, baseUrl = 'https://api.venice.ai/api/v1', model = process.env.IMAGE_MODEL || 'ideogram-v4', size = '1024x1024' } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
    const target = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
        // Venice-specific: pass moderation level in the request body (extra_body in the SDK).
        const isVenice = /venice\.ai/i.test(baseUrl);
        const body = { model, prompt, size, response_format: 'b64_json' };
        if (isVenice) body.moderation = 'low';
        try {
            const upstream = await fetch(target, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
        const raw = await upstream.text().catch(() => '');
                let data = {};
                try { data = JSON.parse(raw); } catch { data = {}; }
                if (!upstream.ok) {
                    return res.status(upstream.status).json({ error: data?.error?.message || data?.error || raw || `HTTP ${upstream.status}` });
                }
                const b64 = data.data?.[0]?.b64_json;
                if (!b64) return res.status(502).json({ error: 'No image returned by provider' });
                res.json({ image: `data:image/png;base64,${b64}` });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// GET /api/image-config — expose server-side image model defaults so the
// frontend can show accurate predictions (env vars aren't visible in the browser).
app.get('/api/image-config', (req, res) => {
    res.json({
        imageModel: process.env.IMAGE_MODEL || 'ideogram-v4',
        imageEditModel: process.env.IMAGE_EDIT_MODEL || 'firered-image-edit',
    });
});

// POST /api/auto-imagine  { character, recentMessages, apiKey, chatBaseUrl, chatModel, imageBaseUrl, imageModel }
// Two-step: (1) ask the chat model to craft a detailed "reverse image prompt" from
// the character description + the most recent scene in the conversation, then
// (2) send that prompt to the image-generation model. Returns { image, prompt }.
app.post('/api/auto-imagine', async (req, res) => {
    const {
        character, recentMessages = [], apiKey,
        chatBaseUrl = 'https://openrouter.ai/api/v1', chatModel = 'anthropic/claude-3.5-haiku',
        imageBaseUrl = 'https://api.venice.ai/api/v1', imageModel = process.env.IMAGE_MODEL || 'ideogram-v4',
        imageApiKey,
    } = req.body || {};
    const imgKey = imageApiKey || apiKey; // dedicated image key, else fall back to the chat key
    if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });

    // Build the reverse-prompt request to the chat model.
    const charDesc = character?.description || character?.personality || character?.name || 'a character';
    const lastMsgs = recentMessages.slice(-6).map(m =>
        `${m.role === 'user' ? 'User' : 'Character'}: ${typeof m.content === 'string' ? m.content : ''}`
    ).join('\n');
    const sysPrompt = `You are a cinematic image-prompt writer. Given a character description and the most recent scene of a roleplay conversation, write a single detailed image-generation prompt (in English) that depicts the MOST RECENT scene. Include the character's appearance, the setting, lighting, mood, and composition. Output ONLY the prompt text — no preamble, no quotes, no markdown.`;
        const userPrompt = `${sysPrompt}\n\nCharacter:\n${charDesc}\n\nRecent conversation:\n${lastMsgs}\n\nWrite the image prompt for the most recent scene:`;

        try {
            const chatResp = await fetch(`${chatBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: chatModel,
                    messages: [
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                }),
            });
        const chatRaw = await chatResp.text().catch(() => '');
                let chatData = {};
                try { chatData = JSON.parse(chatRaw); } catch { chatData = {}; }
                if (!chatResp.ok) {
                    return res.status(chatResp.status).json({ error: chatData?.error?.message || chatData?.error || chatRaw || `Chat model error HTTP ${chatResp.status}` });
                }
        const prompt = (chatData.choices?.[0]?.message?.content || '').trim();
                if (!prompt) return res.status(502).json({ error: 'Chat model returned no prompt' });

                // If the character has an avatar, use Venice's image-edit endpoint to
                // transform the avatar into the scene. Otherwise generate from scratch.
                const avatar = character?.avatar || '';
                const isVenice = /venice\.ai/i.test(imageBaseUrl);
                let image;
                let imageModelUsed;
                if (avatar && isVenice) {
                    imageModelUsed = process.env.IMAGE_EDIT_MODEL || 'firered-image-edit';
                    // Venice /image/edit: JSON body with base64 image, returns raw PNG binary.
                    const m = /^data:image\/([a-z]+);base64,(.+)$/i.exec(avatar);
                    const b64 = m ? m[2] : avatar.replace(/^data:image\/[a-z]+;base64,/, '');
                    // NOTE: /image/edit schema forbids unknown fields
                    // (additionalProperties:false) — do NOT send `moderation` here;
                    // that parameter only exists on /images/generations.
                    const editBody = {
                        model: process.env.IMAGE_EDIT_MODEL || 'firered-image-edit',
                        prompt,
                        image: b64,
                        safe_mode: false,
                        output_format: 'png',
                    };
                    const editResp = await fetch(`${imageBaseUrl.replace(/\/+$/, '')}/image/edit`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${imgKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(editBody),
                    });
                    const editRaw = await editResp.arrayBuffer().catch(() => null);
                    if (!editResp.ok) {
                        let editData = {};
                        try { editData = JSON.parse(editRaw); } catch { editData = {}; }
                        return res.status(editResp.status).json({ error: editData?.error?.message || editData?.error || Buffer.from(editRaw || []).toString('utf8') || `Image edit error HTTP ${editResp.status}` });
                    }
                    // Response is raw PNG binary — encode the bytes directly
                    // (never .text(): UTF-8 decoding corrupts binary data).
                    image = `data:image/png;base64,${Buffer.from(editRaw).toString('base64')}`;
                } else {
                    imageModelUsed = imageModel;
                    const imgBody = { model: imageModel, prompt, size: '1024x1024', response_format: 'b64_json' };
                    if (isVenice) imgBody.moderation = 'low';
                    const imgResp = await fetch(`${imageBaseUrl.replace(/\/+$/, '')}/images/generations`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${imgKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(imgBody),
                    });
                    const raw = await imgResp.text().catch(() => '');
                    let imgData = {};
                    try { imgData = JSON.parse(raw); } catch { imgData = {}; }
                    if (!imgResp.ok) {
                        return res.status(imgResp.status).json({ error: imgData?.error?.message || imgData?.error || raw || `Image model error HTTP ${imgResp.status}` });
                    }
                    const b64 = imgData.data?.[0]?.b64_json;
                    if (!b64) return res.status(502).json({ error: 'No image returned by provider' });
                    image = `data:image/png;base64,${b64}`;
                }
                res.json({ image, prompt, chatModel, imageModel: imageModelUsed });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// POST /api/agent  { task, apiKey, model }  — SSE stream
app.post('/api/agent', async (req, res) => {
    const { task, apiKey, model = 'anthropic/claude-3.5-haiku', allowDestructive = false, baseUrl = 'https://openrouter.ai/api/v1' } = req.body || {};
    if (!task)   return res.status(400).json({ error: 'Missing task' });
    if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (type, payload) =>
        res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);

    try {
        await ensureConnected();

        const client = new OpenAI({
                    baseURL: baseUrl.replace(/\/+$/, ''),
                    apiKey,
                    defaultHeaders: { 'X-Title': 'WinBox AI Chat' },
                });

        const SYSTEM = `You are a PostgreSQL database agent with access to a live database.
Use the provided tools to complete tasks. SQL string literals use single quotes.
After all steps are done, give a concise summary of what was accomplished.`;

        const messages = [
            { role: 'system', content: SYSTEM },
            { role: 'user',   content: task },
        ];

        const MAX = 25;
        let iter = 0;

        while (iter < MAX) {
            iter++;
            const response = await client.chat.completions.create({
                model,
                messages,
                tools:       TOOL_DEFINITIONS,
                tool_choice: 'auto',
            });

            const choice = response.choices[0];
            const msg    = choice.message;
            messages.push(msg);

            if (!msg.tool_calls || choice.finish_reason === 'stop') {
                send('done', { summary: msg.content || 'Task complete.' });
                break;
            }

            for (const tc of msg.tool_calls) {
                const name = tc.function.name;
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch (_) {}

                send('tool_call', { name, args });

                // Destructive guard: block unless the caller explicitly opted in.
                const isDestructive = DESTRUCTIVE.has(name)
                    || (name === 'execute_sql' && typeof args.sql === 'string' && DESTRUCTIVE_SQL.test(args.sql));
                if (isDestructive && !allowDestructive) {
                    const outcome = {
                        success: false,
                        result: null,
                        error: `Destructive operation '${name}' is blocked. Re-run with allowDestructive: true to permit it.`,
                    };
                    const resultStr = `ERROR: ${outcome.error}`;
                    send('tool_result', { name, success: false, result: '', error: outcome.error });
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
                    continue;
                }

                let outcome;
                try {
                    const result = await dispatchTool(db, name, args);
                    outcome = { success: true, result, error: null };
                } catch (e) {
                    outcome = { success: false, result: null, error: e.message };
                }

                const resultStr = outcome.success
                    ? JSON.stringify(outcome.result, null, 0)
                    : `ERROR: ${outcome.error}`;

                send('tool_result', {
                    name,
                    success: outcome.success,
                    result:  resultStr.slice(0, 800),
                    error:   outcome.error,
                });

                messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
            }
        }

        if (iter >= MAX) send('done', { summary: `Reached max iterations (${MAX}).` });

    } catch (e) {
        send('error', { message: e.message });
    } finally {
        res.end();
    }
});

// ── Start ──────────────────────────────────────────────────────────────────────
(async () => {
    try {
        await db.connect();
        console.log('✓ Database connected');
    } catch (e) {
        console.warn(`⚠  Database connect failed at startup: ${e.message}`);
        console.warn('   Will retry automatically on first request.');
    }
    app.listen(PORT, HOST, () =>
        console.log('✓ WinBox AI server running at http://' + HOST + ':' + PORT)
    );
})();
