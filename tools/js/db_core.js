'use strict';
/**
 * db_core.js
 * ==========
 * Core PostgreSQL operations. No AI dependencies — just a clean async database interface.
 *
 * Usage:
 *   const db = new PostgresDB(DB_URL);
 *   await db.connect();
 *   await db.createTable('users', [{ name: 'id', type: 'SERIAL', primary_key: true }, ...]);
 *   await db.disconnect();
 *
 *   // Or with the static helper:
 *   await PostgresDB.withDB(DB_URL, async (db) => {
 *     await db.insertRows('users', [{ name: 'Alice' }]);
 *   });
 */

const { Client } = require('pg');

// ── Display helper ─────────────────────────────────────────────────────────────

/**
 * Format an array of row objects as a psql-style ASCII table.
 * @param {object[]} rows
 * @param {string[]} headers
 * @returns {string}
 */
function tableFormat(rows, headers) {
    if (!rows || rows.length === 0) return '(empty)';
    const allCells = [headers, ...rows.map(r => headers.map(h => String(r[h] ?? '')))];
    const widths = headers.map((_, i) =>
        Math.max(...allCells.map(row => String(row[i] ?? '').length))
    );
    const hr = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    const line = row =>
        '|' + row.map((cell, i) => ` ${String(cell ?? '').padEnd(widths[i])} `).join('|') + '|';
    return [hr, line(headers), hr, ...rows.map(r => line(headers.map(h => r[h]))), hr].join('\n');
}

// ── PostgresDB ─────────────────────────────────────────────────────────────────

class PostgresDB {
    /**
     * @param {string} connectionUrl  Full postgres:// URL (sslmode=require supported)
     */
    constructor(connectionUrl) {
        this.connectionUrl = connectionUrl;
        this.client = null;
    }

    // ── Connection ─────────────────────────────────────────────────────────

    async connect() {
        this.client = new Client({
            connectionString: this.connectionUrl,
            ssl: { rejectUnauthorized: false },
        });
        await this.client.connect();
    }

    async disconnect() {
        if (this.client) {
            await this.client.end();
            this.client = null;
        }
    }

    async _ensureConnected() {
        if (!this.client) await this.connect();
    }

    /**
     * Static helper — connects, runs fn(db), then disconnects.
     * @param {string} connectionUrl
     * @param {(db: PostgresDB) => Promise<any>} fn
     */
    static async withDB(connectionUrl, fn) {
        const db = new PostgresDB(connectionUrl);
        await db.connect();
        try {
            return await fn(db);
        } finally {
            await db.disconnect();
        }
    }

    // ── Internal executor ──────────────────────────────────────────────────

    /**
     * @param {string}   query
     * @param {any[]}    params
     * @param {'none'|'one'|'all'} fetchMode
     */
    async _execute(query, params = [], fetchMode = 'none') {
        await this._ensureConnected();
        const result = await this.client.query(query, params);
        if (fetchMode === 'all') return result.rows;
        if (fetchMode === 'one') return result.rows[0] || null;
        return result.rowCount || 0;
    }

    // ── Schema: Tables ─────────────────────────────────────────────────────

    /**
     * Create a new table.
     *
     * Each column object accepts:
     *   name        string  (required)
     *   type        string  (required) — SERIAL, VARCHAR(n), TEXT, INTEGER, BIGINT,
     *                                    FLOAT, NUMERIC(p,s), BOOLEAN, DATE, TIMESTAMP,
     *                                    JSONB, UUID, BIGSERIAL
     *   primary_key bool    (optional, default false)
     *   nullable    bool    (optional, default true)
     *   unique      bool    (optional, default false)
     *   default     string  (optional) — raw SQL e.g. "NOW()", "TRUE", "0"
     *
     * @example
     *   await db.createTable('users', [
     *     { name: 'id',         type: 'SERIAL',       primary_key: true },
     *     { name: 'email',      type: 'TEXT',         nullable: false, unique: true },
     *     { name: 'username',   type: 'VARCHAR(80)',  nullable: false },
     *     { name: 'is_active',  type: 'BOOLEAN',      default: 'TRUE' },
     *     { name: 'created_at', type: 'TIMESTAMP',    default: 'NOW()' },
     *   ]);
     */
    async createTable(tableName, columns) {
        const colDefs = [];
        const pkCols = [];

        for (const col of columns) {
            const parts = [`"${col.name}" ${col.type}`];
            if (col.primary_key) pkCols.push(col.name);
            if (col.nullable === false && !col.primary_key) parts.push('NOT NULL');
            if (col.unique) parts.push('UNIQUE');
            if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);
            colDefs.push(parts.join(' '));
        }

        if (pkCols.length > 0) {
            colDefs.push(`PRIMARY KEY (${pkCols.map(c => `"${c}"`).join(', ')})`);
        }

        const ddl = `CREATE TABLE "${tableName}" (\n  ${colDefs.join(',\n  ')}\n)`;
        await this._execute(ddl);
        return `Table '${tableName}' created.`;
    }

    /**
     * Drop a table permanently.
     * @param {string}  tableName
     * @param {object}  [opts]
     * @param {boolean} [opts.ifExists=true]
     * @param {boolean} [opts.cascade=false]
     */
    async dropTable(tableName, { ifExists = true, cascade = false } = {}) {
        const ie = ifExists ? 'IF EXISTS ' : '';
        const casc = cascade ? ' CASCADE' : '';
        await this._execute(`DROP TABLE ${ie}"${tableName}"${casc}`);
        return `Table '${tableName}' dropped.`;
    }

    /**
     * Remove all rows from a table without dropping its structure.
     * @param {string}  tableName
     * @param {boolean} [restartIdentity=true]
     */
    async truncateTable(tableName, restartIdentity = true) {
        const ri = restartIdentity ? ' RESTART IDENTITY' : '';
        await this._execute(`TRUNCATE TABLE "${tableName}"${ri}`);
        return `Table '${tableName}' truncated.`;
    }

    /** Rename a table. */
    async renameTable(oldName, newName) {
        await this._execute(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
        return `Table '${oldName}' renamed to '${newName}'.`;
    }

    // ── Schema: Columns ────────────────────────────────────────────────────

    /**
     * Add a column to an existing table.
     * @param {string}  tableName
     * @param {string}  columnName
     * @param {string}  columnType  PostgreSQL type
     * @param {object}  [opts]
     * @param {boolean} [opts.nullable=true]
     * @param {string}  [opts.default]  Raw SQL default expression
     */
    async addColumn(tableName, columnName, columnType, { nullable = true, default: dflt } = {}) {
        const nn = nullable ? '' : ' NOT NULL';
        const def = dflt !== undefined ? ` DEFAULT ${dflt}` : '';
        await this._execute(
            `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType}${nn}${def}`
        );
        return `Column '${columnName}' (${columnType}) added to '${tableName}'.`;
    }

    /** Drop a column from a table. */
    async dropColumn(tableName, columnName) {
        await this._execute(
            `ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${columnName}"`
        );
        return `Column '${columnName}' dropped from '${tableName}'.`;
    }

    /** Rename a column. */
    async renameColumn(tableName, oldName, newName) {
        await this._execute(
            `ALTER TABLE "${tableName}" RENAME COLUMN "${oldName}" TO "${newName}"`
        );
        return `Column '${oldName}' renamed to '${newName}' in '${tableName}'.`;
    }

    // ── Introspection ──────────────────────────────────────────────────────

    /**
     * Return all table names in the given schema.
     * @param {string} [schema='public']
     * @returns {Promise<string[]>}
     */
    async listTables(schema = 'public') {
        const rows = await this._execute(
            'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
            [schema],
            'all'
        );
        return rows.map(r => r.tablename);
    }

    /** Return true if a table exists. */
    async tableExists(tableName, schema = 'public') {
        const row = await this._execute(
            'SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
            [schema, tableName],
            'one'
        );
        return row !== null;
    }

    /**
     * Return column metadata for a table.
     * @param {string} tableName
     * @returns {Promise<object[]>} Array of { column_name, data_type, is_nullable, column_default }
     */
    async describeTable(tableName) {
        return this._execute(
            `SELECT column_name, data_type, character_maximum_length,
                    is_nullable, column_default
             FROM information_schema.columns
             WHERE table_name = $1 AND table_schema = 'public'
             ORDER BY ordinal_position`,
            [tableName],
            'all'
        );
    }

    /**
     * Count rows in a table with optional raw SQL WHERE clause.
     * @param {string}  tableName
     * @param {string}  [where]  Raw SQL without "WHERE"
     * @returns {Promise<number>}
     */
    async countRows(tableName, where) {
        const whereClause = where ? ` WHERE ${where}` : '';
        const row = await this._execute(
            `SELECT COUNT(*) AS cnt FROM "${tableName}"${whereClause}`,
            [],
            'one'
        );
        return parseInt(row.cnt, 10);
    }

    // ── Data: Write ────────────────────────────────────────────────────────

    /**
     * Insert one or more rows. Each row is an object mapping column names to values.
     * Returns the number of rows inserted.
     *
     * @example
     *   await db.insertRows('users', [
     *     { email: 'alice@example.com', username: 'alice' },
     *     { email: 'bob@example.com',   username: 'bob' },
     *   ]);
     */
    async insertRows(tableName, rows) {
        if (!rows.length) return 0;
        const cols = Object.keys(rows[0]);
        const colStr = cols.map(c => `"${c}"`).join(', ');
        const values = [];
        const rowPlaceholders = rows.map((row, ri) =>
            '(' + cols.map((col, ci) => {
                values.push(row[col]);
                return `$${ri * cols.length + ci + 1}`;
            }).join(', ') + ')'
        ).join(', ');
        const result = await this.client.query(
            `INSERT INTO "${tableName}" (${colStr}) VALUES ${rowPlaceholders}`,
            values
        );
        return result.rowCount;
    }

    /**
     * Update rows matching a WHERE clause. Returns count of updated rows.
     *
     * NOTE: where is raw SQL — never build from untrusted user input.
     *
     * @example
     *   await db.updateRows('products', { price: 9.99, in_stock: true }, "id = 42");
     */
    async updateRows(tableName, setValues, where) {
        const cols = Object.keys(setValues);
        const params = Object.values(setValues);
        const setClause = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
        const result = await this.client.query(
            `UPDATE "${tableName}" SET ${setClause} WHERE ${where}`,
            params
        );
        return result.rowCount;
    }

    /**
     * Delete rows from a table. Omit `where` to delete ALL rows.
     * Returns count of deleted rows.
     *
     * @example
     *   await db.deleteRows('sessions', "expires_at < NOW()");
     */
    async deleteRows(tableName, where) {
        const whereClause = where ? ` WHERE ${where}` : '';
        const result = await this.client.query(
            `DELETE FROM "${tableName}"${whereClause}`
        );
        return result.rowCount;
    }

    /**
     * Insert rows; on unique-key conflict, update the non-key columns.
     *
     * @param {string}   tableName
     * @param {object[]} rows
     * @param {string[]} conflictColumns  Column(s) forming the conflict key
     *
     * @example
     *   await db.upsertRows('products', [{ sku: 'ABC', price: 9.99 }], ['sku']);
     */
    async upsertRows(tableName, rows, conflictColumns) {
        if (!rows.length) return 0;
        const cols = Object.keys(rows[0]);
        const colStr = cols.map(c => `"${c}"`).join(', ');
        const conflictStr = conflictColumns.map(c => `"${c}"`).join(', ');
        const updateCols = cols.filter(c => !conflictColumns.includes(c));
        const doClause = updateCols.length > 0
            ? 'DO UPDATE SET ' + updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')
            : 'DO NOTHING';

        const values = [];
        const rowPlaceholders = rows.map((row, ri) =>
            '(' + cols.map((col, ci) => {
                values.push(row[col]);
                return `$${ri * cols.length + ci + 1}`;
            }).join(', ') + ')'
        ).join(', ');

        const result = await this.client.query(
            `INSERT INTO "${tableName}" (${colStr}) VALUES ${rowPlaceholders} ON CONFLICT (${conflictStr}) ${doClause}`,
            values
        );
        return result.rowCount;
    }

    // ── Data: Read ─────────────────────────────────────────────────────────

    /**
     * Query rows from a table.
     *
     * NOTE: where and orderBy are raw SQL — never build from untrusted user input.
     *
     * @param {string}   tableName
     * @param {object}   [opts]
     * @param {string[]} [opts.columns]   Specific columns to return (omit = all)
     * @param {string}   [opts.where]     SQL WHERE clause without "WHERE"
     * @param {string}   [opts.orderBy]   ORDER BY expression e.g. "created_at DESC"
     * @param {number}   [opts.limit]     Max rows to return
     * @param {number}   [opts.offset]    Rows to skip
     * @returns {Promise<object[]>}
     *
     * @example
     *   await db.selectRows('orders', {
     *     where: "status = 'pending' AND total > 100",
     *     orderBy: 'total DESC',
     *     limit: 10,
     *   });
     */
    async selectRows(tableName, { columns, where, orderBy, limit, offset } = {}) {
        const colStr = columns ? columns.map(c => `"${c}"`).join(', ') : '*';
        let q = `SELECT ${colStr} FROM "${tableName}"`;
        if (where)   q += ` WHERE ${where}`;
        if (orderBy) q += ` ORDER BY ${orderBy}`;
        if (limit)   q += ` LIMIT ${limit}`;
        if (offset)  q += ` OFFSET ${offset}`;
        return this._execute(q, [], 'all');
    }

    // ── Raw SQL ────────────────────────────────────────────────────────────

    /**
     * Execute arbitrary SQL. Returns:
     *   { rows: object[], rowCount: number, columns: string[] }
     *
     * @example
     *   const r = await db.executeSql(
     *     'SELECT status, COUNT(*) AS n FROM orders GROUP BY status'
     *   );
     *   console.log(r.rows);
     */
    async executeSql(sqlStr, params = []) {
        await this._ensureConnected();
        const result = await this.client.query(sqlStr, params);
        const rows = result.rows || [];
        const columns = result.fields ? result.fields.map(f => f.name) : [];
        return { rows, rowCount: result.rowCount || 0, columns };
    }

    // ── Display ────────────────────────────────────────────────────────────

    /** Return a formatted ASCII table of a table's contents. */
    async getTableDisplay(tableName, limit = 50) {
        const rows = await this.selectRows(tableName, { limit });
        if (!rows.length) return `Table '${tableName}' is empty.`;
        const headers = Object.keys(rows[0]);
        const total = await this.countRows(tableName);
        const footer = total > limit
            ? `(${rows.length} of ${total} rows shown)`
            : `(${total} rows total)`;
        return `\nTable: ${tableName}\n${tableFormat(rows, headers)}\n${footer}`;
    }

    /** Return a formatted display of a table's column schema. */
    async getSchemaDisplay(tableName) {
        const cols = await this.describeTable(tableName);
        if (!cols.length) return `Table '${tableName}' not found.`;
        const rows = cols.map(c => ({
            Column:   c.column_name,
            Type:     c.data_type,
            Nullable: c.is_nullable,
            Default:  c.column_default || '',
        }));
        return `\nSchema: ${tableName}\n${tableFormat(rows, ['Column', 'Type', 'Nullable', 'Default'])}`;
    }

    /** Return a summary of all tables with column names and row counts. */
    async getDbSummary() {
        const tables = await this.listTables();
        if (!tables.length) return 'Database is empty — no tables found.';
        const lines = ['Database Summary', '='.repeat(50)];
        for (const t of tables) {
            try {
                const count = await this.countRows(t);
                const cols = await this.describeTable(t);
                const colNames = cols.map(c => c.column_name).join(', ');
                lines.push(`\n  ${t}  (${count} rows)`);
                lines.push(`     columns: ${colNames}`);
            } catch (e) {
                lines.push(`\n  ${t}  [error: ${e.message}]`);
            }
        }
        return lines.join('\n');
    }
}

module.exports = { PostgresDB, tableFormat };
