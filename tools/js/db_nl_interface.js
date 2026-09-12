'use strict';
/**
 * db_nl_interface.js
 * ==================
 * Natural language interface to PostgreSQL. Type commands in plain English;
 * an LLM (via OpenRouter) interprets your intent and calls the right database tool.
 *
 * Maintains conversation history so follow-up commands work naturally:
 * "now add a column to that table", "delete those rows", etc.
 *
 * Setup:
 *   export OPENROUTER_API_KEY="sk-or-..."
 *   npm install
 *
 * Run:
 *   node db_nl_interface.js
 *
 * Example session:
 *   > create a table called products with id, name, price, and in_stock columns
 *   > insert 3 sample products — a laptop, a phone, some headphones
 *   > show me all products where price is over 500
 *   > update the phone's price to 999
 *   > describe the products table
 *   > show a summary of the whole database
 *   > drop the products table
 */

const readline = require('readline');
const OpenAI   = require('openai');
const path     = require('path');
const fs       = require('fs');

const { PostgresDB }                         = require('./db_core');
const { TOOL_DEFINITIONS, dispatchTool }     = require('./db_agent_toolkit');

// ── Configuration ────────────────────────────────────────────────────────────

function loadDbUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
    try {
        return fs.readFileSync(path.join(__dirname, 'db_info.txt'), 'utf8').trim();
    } catch (_) {
        return '';
    }
}

const DB_URL        = loadDbUrl();
const DEFAULT_MODEL = process.env.DB_NL_MODEL || 'anthropic/claude-3.5-haiku';

const SYSTEM_PROMPT = `You are a helpful database assistant. The user interacts with a live PostgreSQL database
using plain English. Interpret their request and call the appropriate database tool.

Guidelines:
- Choose the single most appropriate tool for each request.
- For CREATE TABLE, infer sensible types from context:
    IDs           → SERIAL
    Short names   → VARCHAR(255)
    Long text     → TEXT
    Numbers       → INTEGER or FLOAT
    Prices        → NUMERIC(10,2)
    Yes/No        → BOOLEAN
    Timestamps    → TIMESTAMP with default NOW()
- Write WHERE clauses as valid PostgreSQL SQL. String literals need single quotes:
    ✓ status = 'active'    ✗ status = "active"
- After each operation, give a concise, friendly summary of what was done.
- If the request is ambiguous, make a reasonable inference and proceed.
- Remember previous commands — "that table" or "those rows" refers to what was last discussed.`;

// ── Result formatter ─────────────────────────────────────────────────────────

function formatResult(name, result) {
    if (typeof result === 'string') return result;
    if (result && typeof result.display === 'string') return result.display;
    return JSON.stringify(result, null, 2);
}

// ── NaturalLanguageDB ─────────────────────────────────────────────────────────

class NaturalLanguageDB {
    /**
     * @param {object} opts
     * @param {string} [opts.dbUrl]   Postgres connection URL
     * @param {string} [opts.apiKey]  OpenRouter API key
     * @param {string} [opts.model]   OpenRouter model ID
     */
    constructor({ dbUrl = DB_URL, apiKey = '', model = DEFAULT_MODEL } = {}) {
        const key = apiKey || process.env.OPENROUTER_API_KEY || '';
        if (!key) throw new Error('apiKey required or set OPENROUTER_API_KEY environment variable.');

        this.db = new PostgresDB(dbUrl);
        this.openai = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey:  key,
            defaultHeaders: { 'X-Title': 'Natural Language DB Interface' },
        });
        this.model    = model;
        this._history = [];
    }

    async connect()    { await this.db.connect(); }
    async disconnect() { await this.db.disconnect(); }

    /** Clear conversation history. */
    resetHistory() { this._history = []; }

    // ── Core chat ─────────────────────────────────────────────────────────

    /**
     * Send a natural language message and return the assistant's response.
     * The LLM will call database tools as needed, then return a friendly summary.
     *
     * @param {string}  userMessage
     * @param {boolean} [showTools=true]  Print [tool: name] as calls are made
     * @returns {Promise<string>}
     */
    async chat(userMessage, showTools = true) {
        this._history.push({ role: 'user', content: userMessage });
        const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...this._history];

        for (;;) {
            const response = await this.openai.chat.completions.create({
                model:       this.model,
                messages,
                tools:       TOOL_DEFINITIONS,
                tool_choice: 'auto',
            });

            const choice = response.choices[0];
            const msg    = choice.message;
            messages.push(msg);

            if (!msg.tool_calls || choice.finish_reason === 'stop') {
                const reply = msg.content || '';
                this._history.push({ role: 'assistant', content: reply });
                return reply;
            }

            for (const tc of msg.tool_calls) {
                const name = tc.function.name;
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch (_) {}

                if (showTools) process.stdout.write(`  [tool: ${name}]\n`);

                let resultStr;
                try {
                    const raw = await dispatchTool(this.db, name, args);
                    resultStr = formatResult(name, raw);
                } catch (e) {
                    resultStr = `ERROR: ${e.message}`;
                }

                messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
            }
        }
    }

    // ── REPL ──────────────────────────────────────────────────────────────

    /**
     * Start an interactive REPL. Type database commands in plain English.
     *
     * Built-in shortcuts (no LLM round-trip):
     *   /reset            — clear conversation history
     *   /tables           — quick table list
     *   /schema <table>   — quick column schema
     *   /history          — show how many turns are in history
     *   help              — show example commands
     *   quit / exit / q   — exit
     */
    async runRepl() {
        const dbHost = this.db.connectionUrl.split('@')[1]?.split('/')[0] || 'unknown';

        console.log('\nNatural Language Database Interface');
        console.log('='.repeat(45));
        console.log(`  Database : ${dbHost}`);
        console.log(`  Model    : ${this.model}`);
        console.log("  Type commands in plain English. 'help' for tips, 'quit' to exit.");
        console.log('='.repeat(45) + '\n');

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        // Ctrl+C exits cleanly
        rl.on('SIGINT', () => {
            console.log('\nGoodbye!');
            rl.close();
            process.exit(0);
        });

        const ask = () => new Promise(resolve => rl.question('> ', resolve));

        for (;;) {
            let input;
            try {
                input = (await ask()).trim();
            } catch (_) {
                console.log('\nGoodbye!');
                break;
            }

            if (!input) continue;

            // Exit
            if (['quit', 'exit', 'q'].includes(input.toLowerCase())) {
                console.log('Goodbye!');
                break;
            }

            // /reset
            if (input.toLowerCase() === '/reset') {
                this.resetHistory();
                console.log('Conversation history cleared.\n');
                continue;
            }

            // /tables
            if (input.toLowerCase() === '/tables') {
                const tables = await this.db.listTables();
                console.log('Tables:', tables.length ? tables.join(', ') : '(none)');
                console.log();
                continue;
            }

            // /schema <table>
            if (input.toLowerCase().startsWith('/schema ')) {
                const table = input.slice(8).trim();
                console.log(await this.db.getSchemaDisplay(table));
                console.log();
                continue;
            }

            // /history
            if (input.toLowerCase() === '/history') {
                const turns = this._history.filter(m => m.role === 'user').length;
                console.log(`Conversation: ${turns} user turn(s) in history.\n`);
                continue;
            }

            // help
            if (['help', '/help'].includes(input.toLowerCase())) {
                console.log(`
Example commands:
  create a table called orders with id, customer name, total, and status
  insert 3 sample orders into the orders table
  show me all orders where total is over 100
  update order 2's status to 'shipped'
  delete all cancelled orders
  describe the orders table
  show me a summary of the whole database
  drop the orders table
  run raw sql: select count(*) from orders

Shortcuts: /reset  /tables  /schema <table>  /history
`);
                continue;
            }

            // Normal NL command → LLM
            try {
                const reply = await this.chat(input, true);
                console.log(`\n${reply}\n`);
            } catch (e) {
                console.error(`\nError: ${e.message}\n`);
            }
        }

        rl.close();
    }
}

// ── One-shot helper ───────────────────────────────────────────────────────────

/**
 * Execute a single natural language DB query without a REPL or history.
 * Useful for embedding NL DB access in scripts or other agents.
 *
 * @param {string} message
 * @param {object} [opts]  Same options as NaturalLanguageDB constructor
 * @returns {Promise<string>}
 *
 * @example
 *   const answer = await quickQuery('How many users signed up in the last 7 days?');
 *   console.log(answer);
 */
async function quickQuery(message, opts = {}) {
    const nldb = new NaturalLanguageDB(opts);
    await nldb.connect();
    try {
        return await nldb.chat(message, false);
    } finally {
        await nldb.disconnect();
    }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
    (async () => {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            console.error('Error: OPENROUTER_API_KEY environment variable not set.');
            console.error("  export OPENROUTER_API_KEY='sk-or-...'");
            process.exit(1);
        }

        const nldb = new NaturalLanguageDB({ apiKey });
        await nldb.connect();
        try {
            await nldb.runRepl();
        } finally {
            await nldb.disconnect();
        }
    })();
}

module.exports = { NaturalLanguageDB, quickQuery };
