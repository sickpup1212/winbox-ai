'use strict';
/**
 * db_agent_toolkit.js
 * ====================
 * PostgreSQL toolkit designed to be used BY AI agents via OpenRouter.
 *
 * PATTERN 1 — embed tools into your own agent:
 *   const toolkit = new DBAgentToolkit({ apiKey });
 *   const allTools = myTools.concat(toolkit.getToolSchemas());
 *
 *   // In your agent's tool-call handler:
 *   if (toolkit.toolNames().includes(call.function.name)) {
 *     const args = JSON.parse(call.function.arguments);
 *     const outcome = await toolkit.executeTool(call.function.name, args);
 *     // outcome: { success, result, error }
 *   }
 *
 * PATTERN 2 — autonomous sub-agent:
 *   const result = await toolkit.runTask(
 *     'Create a products table, insert 5 items, then show items priced over $10'
 *   );
 *   console.log(result.summary);
 *
 * Setup:
 *   export OPENROUTER_API_KEY="sk-or-..."
 *   npm install
 */

const OpenAI = require('openai');
const path   = require('path');
const fs     = require('fs');
const { PostgresDB, tableFormat } = require('./db_core');

// ── Configuration ──────────────────────────────────────────────────────────────

function loadDbUrl() {
    // Prefer DATABASE_URL env var; fall back to db_info.txt for backward compatibility.
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
    return fs.readFileSync(path.join(__dirname, 'db_info.txt'), 'utf8').trim();
}

const DB_URL       = loadDbUrl();
const DEFAULT_MODEL = process.env.DB_AGENT_MODEL || 'anthropic/claude-3.5-haiku';

// ── Tool Definitions ────────────────────────────────────────────────────────────
// OpenRouter / OpenAI-compatible function definitions for all DB operations.
// Export TOOL_DEFINITIONS to embed these into any agent's tool list.

const TOOL_DEFINITIONS = [
    // ── Schema: Tables ─────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'create_table',
            description:
                'Create a new table in the PostgreSQL database. ' +
                'Infer sensible types: SERIAL for auto-increment IDs, VARCHAR(255) for names, ' +
                'TEXT for long strings, INTEGER/FLOAT for numbers, NUMERIC(10,2) for money, ' +
                'BOOLEAN for flags, TIMESTAMP for timestamps, JSONB for structured JSON.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string', description: 'Table name (snake_case recommended)' },
                    columns: {
                        type: 'array',
                        description: 'Column definitions',
                        items: {
                            type: 'object',
                            properties: {
                                name:        { type: 'string' },
                                type:        { type: 'string', description: 'PostgreSQL type: SERIAL, BIGSERIAL, INTEGER, BIGINT, FLOAT, NUMERIC(p,s), VARCHAR(n), TEXT, BOOLEAN, DATE, TIMESTAMP, JSONB, UUID' },
                                primary_key: { type: 'boolean', default: false },
                                nullable:    { type: 'boolean', default: true },
                                unique:      { type: 'boolean', default: false },
                                default:     { type: 'string',  description: "SQL default expression: NOW(), TRUE, 0, 'active'" },
                            },
                            required: ['name', 'type'],
                        },
                    },
                },
                required: ['table_name', 'columns'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'drop_table',
            description: 'Permanently drop a table and all its data.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string' },
                    cascade:    { type: 'boolean', description: 'Also drop dependent objects', default: false },
                },
                required: ['table_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'truncate_table',
            description: 'Delete all rows from a table without dropping its structure. Resets identity sequences by default.',
            parameters: {
                type: 'object',
                properties: {
                    table_name:       { type: 'string' },
                    restart_identity: { type: 'boolean', default: true },
                },
                required: ['table_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'rename_table',
            description: 'Rename an existing table.',
            parameters: {
                type: 'object',
                properties: {
                    old_name: { type: 'string' },
                    new_name: { type: 'string' },
                },
                required: ['old_name', 'new_name'],
            },
        },
    },
    // ── Schema: Columns ────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'add_column',
            description: 'Add a new column to an existing table.',
            parameters: {
                type: 'object',
                properties: {
                    table_name:  { type: 'string' },
                    column_name: { type: 'string' },
                    column_type: { type: 'string', description: 'PostgreSQL data type' },
                    nullable:    { type: 'boolean', default: true },
                    default:     { type: 'string',  description: 'SQL default expression' },
                },
                required: ['table_name', 'column_name', 'column_type'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'drop_column',
            description: 'Remove a column from a table.',
            parameters: {
                type: 'object',
                properties: {
                    table_name:  { type: 'string' },
                    column_name: { type: 'string' },
                },
                required: ['table_name', 'column_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'rename_column',
            description: 'Rename a column in a table.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string' },
                    old_name:   { type: 'string' },
                    new_name:   { type: 'string' },
                },
                required: ['table_name', 'old_name', 'new_name'],
            },
        },
    },
    // ── Introspection ──────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'list_tables',
            description: 'List all tables currently in the database.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'describe_table',
            description: 'Get the column schema (names, types, nullable, defaults) for a table.',
            parameters: {
                type: 'object',
                properties: { table_name: { type: 'string' } },
                required: ['table_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'count_rows',
            description: 'Count rows in a table with optional filtering.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string' },
                    where:      { type: 'string', description: 'SQL WHERE clause without the WHERE keyword' },
                },
                required: ['table_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_table_display',
            description: 'Return a formatted ASCII grid of a table\'s contents. Use when asked to show, view, or display a table.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string' },
                    limit:      { type: 'integer', description: 'Max rows to display', default: 50 },
                },
                required: ['table_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_db_summary',
            description: 'Return a summary of all tables with their column names and row counts.',
            parameters: { type: 'object', properties: {} },
        },
    },
    // ── Data: Write ────────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'insert_rows',
            description: 'Insert one or more rows into a table. Each row maps column names to values.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string' },
                    rows: {
                        type: 'array',
                        items: { type: 'object' },
                        description: 'Array of row objects e.g. [{"name": "Alice", "age": 30}]',
                    },
                },
                required: ['table_name', 'rows'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_rows',
            description: 'Update column values for rows matching a WHERE clause. Always provide a WHERE clause.',
            parameters: {
                type: 'object',
                properties: {
                    table_name:  { type: 'string' },
                    set_values:  { type: 'object', description: 'Column-to-value map e.g. {"status": "active", "score": 100}' },
                    where:       { type: 'string',  description: "SQL WHERE clause e.g. \"id = 5\" or \"status = 'pending'\"" },
                },
                required: ['table_name', 'set_values', 'where'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_rows',
            description: 'Delete rows from a table. Omit where to delete ALL rows.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string' },
                    where:      { type: 'string', description: 'SQL WHERE clause. Omit to delete everything.' },
                },
                required: ['table_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'upsert_rows',
            description: 'Insert rows; on unique/primary key conflict, update the non-key columns instead.',
            parameters: {
                type: 'object',
                properties: {
                    table_name:       { type: 'string' },
                    rows:             { type: 'array', items: { type: 'object' }, description: 'Rows to insert or update' },
                    conflict_columns: { type: 'array', items: { type: 'string' }, description: 'Column(s) forming the conflict key e.g. ["sku"] or ["user_id", "date"]' },
                },
                required: ['table_name', 'rows', 'conflict_columns'],
            },
        },
    },
    // ── Data: Read ─────────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'select_rows',
            description: 'Query rows from a table with optional column selection, filtering, sorting, and pagination.',
            parameters: {
                type: 'object',
                properties: {
                    table_name: { type: 'string' },
                    columns:    { type: 'array', items: { type: 'string' }, description: 'Columns to return. Omit for all.' },
                    where:      { type: 'string', description: "SQL WHERE clause e.g. \"price > 10 AND in_stock = true\"" },
                    order_by:   { type: 'string', description: "ORDER BY expression e.g. \"created_at DESC\"" },
                    limit:      { type: 'integer', description: 'Max rows to return' },
                    offset:     { type: 'integer', description: 'Rows to skip' },
                },
                required: ['table_name'],
            },
        },
    },
    // ── Raw SQL ────────────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'execute_sql',
            description: 'Execute arbitrary PostgreSQL SQL. Use for JOINs, aggregations, CTEs, or operations not covered by other tools.',
            parameters: {
                type: 'object',
                properties: {
                    sql: { type: 'string', description: 'Valid PostgreSQL statement. Use single quotes for string literals.' },
                },
                required: ['sql'],
            },
        },
    },
];

// ── Dispatcher ─────────────────────────────────────────────────────────────────

/**
 * Execute a named tool against a PostgresDB instance.
 * Returns structured data — callers serialize to string as needed.
 *
 * @param {PostgresDB} db
 * @param {string}     name  Tool name from TOOL_DEFINITIONS
 * @param {object}     args  Tool arguments
 */
async function dispatchTool(db, name, args) {
    switch (name) {
        case 'create_table':
            return db.createTable(args.table_name, args.columns);

        case 'drop_table':
            return db.dropTable(args.table_name, { cascade: args.cascade || false });

        case 'truncate_table':
            return db.truncateTable(args.table_name, args.restart_identity !== false);

        case 'rename_table':
            return db.renameTable(args.old_name, args.new_name);

        case 'add_column':
            return db.addColumn(args.table_name, args.column_name, args.column_type, {
                nullable: args.nullable !== false,
                default:  args.default,
            });

        case 'drop_column':
            return db.dropColumn(args.table_name, args.column_name);

        case 'rename_column':
            return db.renameColumn(args.table_name, args.old_name, args.new_name);

        case 'list_tables': {
            const tables = await db.listTables();
            return { tables, count: tables.length };
        }

        case 'describe_table':
            return db.describeTable(args.table_name);

        case 'count_rows': {
            const count = await db.countRows(args.table_name, args.where);
            return { count };
        }

        case 'get_table_display':
            return db.getTableDisplay(args.table_name, args.limit || 50);

        case 'get_db_summary':
            return db.getDbSummary();

        case 'insert_rows': {
            const inserted = await db.insertRows(args.table_name, args.rows);
            return { inserted };
        }

        case 'update_rows': {
            const updated = await db.updateRows(args.table_name, args.set_values, args.where);
            return { updated };
        }

        case 'delete_rows': {
            const deleted = await db.deleteRows(args.table_name, args.where);
            return { deleted };
        }

        case 'upsert_rows': {
            const upserted = await db.upsertRows(args.table_name, args.rows, args.conflict_columns);
            return { upserted };
        }

        case 'select_rows': {
            const rows = await db.selectRows(args.table_name, {
                columns: args.columns,
                where:   args.where,
                orderBy: args.order_by,
                limit:   args.limit,
                offset:  args.offset,
            });
            const display = rows.length
                ? tableFormat(rows, Object.keys(rows[0]))
                : 'No rows found.';
            return { rows, count: rows.length, display };
        }

        case 'execute_sql': {
            const result = await db.executeSql(args.sql);
            if (result.rows.length) {
                result.display = tableFormat(result.rows, Object.keys(result.rows[0]));
            }
            return result;
        }

        default:
            throw new Error(`Unknown tool: '${name}'`);
    }
}

// ── DBAgentToolkit ─────────────────────────────────────────────────────────────

const AGENT_SYSTEM = `You are a specialized PostgreSQL database agent with access to a live Neon database.
Use the provided tools to complete the requested task.

Principles:
- Check what tables exist before querying them (use list_tables or describe_table).
- Use specific WHERE clauses — avoid full-table deletes/updates unless explicitly requested.
- For multi-step tasks, execute steps in logical order and verify each succeeds.
- Report results clearly: counts affected, schemas returned, data retrieved.
- If a step fails, read the error and try an alternative approach.
- SQL string literals use single quotes: status = 'active', not status = "active".`;

class DBAgentToolkit {
    /**
     * @param {object} opts
     * @param {string} [opts.dbUrl]    Postgres connection URL (defaults to db_info.txt)
     * @param {string} [opts.apiKey]   OpenRouter API key (defaults to OPENROUTER_API_KEY env)
     * @param {string} [opts.model]    OpenRouter model ID (defaults to DB_AGENT_MODEL env or claude-3.5-haiku)
     */
    constructor({ dbUrl = DB_URL, apiKey = '', model = DEFAULT_MODEL } = {}) {
        const key = apiKey || process.env.OPENROUTER_API_KEY || '';
        if (!key) throw new Error('apiKey required or set OPENROUTER_API_KEY environment variable.');

        this.db = new PostgresDB(dbUrl);
        this.client = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: key,
            defaultHeaders: { 'X-Title': 'DB Agent Toolkit' },
        });
        this.model = model;
    }

    async connect()    { await this.db.connect(); }
    async disconnect() { await this.db.disconnect(); }

    // ── Library mode ────────────────────────────────────────────────────────

    /**
     * Return OpenRouter/OpenAI-compatible tool schemas for all DB operations.
     * Concatenate with your own tools to add DB capabilities to any agent:
     *
     *   const allTools = myTools.concat(toolkit.getToolSchemas());
     */
    getToolSchemas() { return TOOL_DEFINITIONS; }

    /** Return the names of all tools this toolkit handles. */
    toolNames() { return TOOL_DEFINITIONS.map(t => t.function.name); }

    /**
     * Execute a DB tool by name. Returns:
     *   { success: true,  result: <data>,  error: null }
     *   { success: false, result: null,    error: '<message>' }
     *
     * Use in your agent's tool-call handler:
     *   if (toolkit.toolNames().includes(callName)) {
     *     const outcome = await toolkit.executeTool(callName, args);
     *   }
     */
    async executeTool(toolName, args) {
        try {
            const result = await dispatchTool(this.db, toolName, args);
            return { success: true, result, error: null };
        } catch (e) {
            return { success: false, result: null, error: e.message };
        }
    }

    // ── Autonomous agent mode ───────────────────────────────────────────────

    /**
     * Run an autonomous agentic loop to accomplish a database task.
     *
     * The agent plans and executes multi-step operations, iterating until the
     * task is complete or maxIterations is reached.
     *
     * @param {string}  task           Natural language description of what to accomplish
     * @param {object}  [opts]
     * @param {number}  [opts.maxIterations=25]  Safety cap on LLM + tool-call rounds
     * @param {boolean} [opts.verbose=true]       Print tool calls and results
     * @returns {Promise<{success, summary, toolCallsMade, iterations}>}
     *
     * @example
     *   const result = await toolkit.runTask(
     *     'Create an inventory table with id, sku, name, price, quantity. ' +
     *     'Insert 5 products. Show items where quantity < 10.'
     *   );
     *   console.log(result.summary);
     */
    async runTask(task, { maxIterations = 25, verbose = true } = {}) {
        await this._ensureConnected();

        const messages = [
            { role: 'system', content: AGENT_SYSTEM },
            { role: 'user',   content: task },
        ];
        const callLog = [];
        let iterations = 0;

        if (verbose) {
            console.log(`\nTask: ${task}`);
            console.log('─'.repeat(60));
        }

        while (iterations < maxIterations) {
            iterations++;

            const response = await this.client.chat.completions.create({
                model:       this.model,
                messages,
                tools:       TOOL_DEFINITIONS,
                tool_choice: 'auto',
            });

            const choice = response.choices[0];
            const msg    = choice.message;
            messages.push(msg);

            if (!msg.tool_calls || choice.finish_reason === 'stop') {
                const final = msg.content || 'Task complete.';
                if (verbose) console.log(`\n${final}`);
                return { success: true, summary: final, toolCallsMade: callLog, iterations };
            }

            for (const tc of msg.tool_calls) {
                const name = tc.function.name;
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch (_) {}

                if (verbose) {
                    const preview = JSON.stringify(args).slice(0, 100);
                    console.log(`  → ${name}(${preview}${preview.length >= 100 ? '...' : ''})`);
                }

                const outcome = await this.executeTool(name, args);
                callLog.push({
                    tool:    name,
                    args,
                    success: outcome.success,
                    result:  String(outcome.result ?? '').slice(0, 500),
                    error:   outcome.error,
                });

                const resultStr = outcome.success
                    ? JSON.stringify(outcome.result, null, 0)
                    : `ERROR: ${outcome.error}`;

                if (verbose) {
                    const status  = outcome.success ? 'OK' : 'ERROR';
                    const preview = resultStr.slice(0, 300);
                    console.log(`     [${status}] ${preview}`);
                }

                messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
            }
        }

        return {
            success: false,
            summary: `Reached maxIterations (${maxIterations}) without completing task.`,
            toolCallsMade: callLog,
            iterations,
        };
    }

    async _ensureConnected() {
        if (!this.db.client) await this.db.connect();
    }
}

// ── CLI demo ───────────────────────────────────────────────────────────────────

if (require.main === module) {
    (async () => {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            console.error('Error: OPENROUTER_API_KEY environment variable not set.');
            process.exit(1);
        }
        const task = process.argv.slice(2).join(' ') ||
            'List all tables in the database and give me a summary of what is there.';

        const toolkit = new DBAgentToolkit({ apiKey });
        try {
            const result = await toolkit.runTask(task, { verbose: true });
            if (!result.success) {
                console.error(`\nTask did not complete: ${result.summary}`);
                process.exit(1);
            }
        } finally {
            await toolkit.disconnect();
        }
    })();
}

module.exports = { TOOL_DEFINITIONS, dispatchTool, DBAgentToolkit };
