"""
db_core.py
==========
Core PostgreSQL operations. No AI dependencies — just a clean database interface.
Use PostgresDB as a context manager or call connect()/disconnect() manually.

  with PostgresDB(DB_URL) as db:
      db.create_table("users", [...])
      db.insert_rows("users", [{"name": "Alice"}])
"""

import psycopg2
import psycopg2.extras
from typing import Any, Dict, List, Optional, Tuple
from tabulate import tabulate


class PostgresDB:
    """Comprehensive PostgreSQL interface covering schema, data, and utility operations."""

    def __init__(self, connection_url: str):
        self.connection_url = connection_url
        self.conn: Optional[psycopg2.extensions.connection] = None

    # ── Connection ────────────────────────────────────────────────────────

    def connect(self) -> None:
        self.conn = psycopg2.connect(self.connection_url)

    def disconnect(self) -> None:
        if self.conn and not self.conn.closed:
            self.conn.close()
            self.conn = None

    def __enter__(self) -> "PostgresDB":
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.disconnect()

    def _ensure_connected(self) -> None:
        if not self.conn or self.conn.closed:
            self.connect()

    def _execute(self, query: str, params: Optional[Tuple] = None, fetch: str = "none") -> Any:
        """Execute a query and optionally fetch results. Auto-commits on success."""
        self._ensure_connected()
        try:
            with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(query, params)
                if fetch == "all":
                    result = [dict(r) for r in cur.fetchall()]
                elif fetch == "one":
                    row = cur.fetchone()
                    result = dict(row) if row else None
                else:
                    result = cur.rowcount
            self.conn.commit()
            return result
        except Exception:
            self.conn.rollback()
            raise

    # ── Schema: Tables ────────────────────────────────────────────────────

    def create_table(self, table_name: str, columns: List[Dict[str, Any]]) -> str:
        """
        Create a new table.

        Each column dict accepts:
            name        str  (required) — column name
            type        str  (required) — PostgreSQL type: SERIAL, VARCHAR(255), TEXT,
                                         INTEGER, BIGINT, FLOAT, NUMERIC(p,s),
                                         BOOLEAN, DATE, TIMESTAMP, JSONB, UUID
            primary_key bool (optional, default False)
            nullable    bool (optional, default True)
            unique      bool (optional, default False)
            default     str  (optional) — raw SQL expression e.g. "NOW()", "0", "'active'"

        Example:
            db.create_table("users", [
                {"name": "id",         "type": "SERIAL",       "primary_key": True},
                {"name": "email",      "type": "TEXT",         "nullable": False, "unique": True},
                {"name": "username",   "type": "VARCHAR(80)",  "nullable": False},
                {"name": "is_active",  "type": "BOOLEAN",      "default": "TRUE"},
                {"name": "created_at", "type": "TIMESTAMP",    "default": "NOW()"},
            ])
        """
        col_defs = []
        pk_cols: List[str] = []

        for col in columns:
            parts = [f'"{col["name"]}" {col["type"]}']
            if col.get("primary_key"):
                pk_cols.append(col["name"])
            if not col.get("nullable", True) and not col.get("primary_key"):
                parts.append("NOT NULL")
            if col.get("unique"):
                parts.append("UNIQUE")
            if col.get("default") is not None:
                parts.append(f'DEFAULT {col["default"]}')
            col_defs.append(" ".join(parts))

        if pk_cols:
            pk_str = ", ".join(f'"{c}"' for c in pk_cols)
            col_defs.append(f"PRIMARY KEY ({pk_str})")

        ddl = f'CREATE TABLE "{table_name}" (\n  ' + ",\n  ".join(col_defs) + "\n);"
        self._execute(ddl)
        return f"Table '{table_name}' created."

    def drop_table(self, table_name: str, if_exists: bool = True, cascade: bool = False) -> str:
        """Drop a table permanently."""
        ie = "IF EXISTS " if if_exists else ""
        casc = " CASCADE" if cascade else ""
        self._execute(f'DROP TABLE {ie}"{table_name}"{casc};')
        return f"Table '{table_name}' dropped."

    def truncate_table(self, table_name: str, restart_identity: bool = True) -> str:
        """Remove all rows from a table, keeping its structure."""
        ri = " RESTART IDENTITY" if restart_identity else ""
        self._execute(f'TRUNCATE TABLE "{table_name}"{ri};')
        return f"Table '{table_name}' truncated."

    def rename_table(self, old_name: str, new_name: str) -> str:
        """Rename an existing table."""
        self._execute(f'ALTER TABLE "{old_name}" RENAME TO "{new_name}";')
        return f"Table '{old_name}' renamed to '{new_name}'."

    # ── Schema: Columns ───────────────────────────────────────────────────

    def add_column(
        self,
        table_name: str,
        column_name: str,
        column_type: str,
        nullable: bool = True,
        default: Optional[str] = None,
    ) -> str:
        """Add a column to an existing table."""
        nn = "" if nullable else " NOT NULL"
        dflt = f" DEFAULT {default}" if default is not None else ""
        self._execute(f'ALTER TABLE "{table_name}" ADD COLUMN "{column_name}" {column_type}{nn}{dflt};')
        return f"Column '{column_name}' ({column_type}) added to '{table_name}'."

    def drop_column(self, table_name: str, column_name: str) -> str:
        """Drop a column from a table."""
        self._execute(f'ALTER TABLE "{table_name}" DROP COLUMN IF EXISTS "{column_name}";')
        return f"Column '{column_name}' dropped from '{table_name}'."

    def rename_column(self, table_name: str, old_name: str, new_name: str) -> str:
        """Rename a column in a table."""
        self._execute(f'ALTER TABLE "{table_name}" RENAME COLUMN "{old_name}" TO "{new_name}";')
        return f"Column '{old_name}' renamed to '{new_name}' in '{table_name}'."

    # ── Introspection ─────────────────────────────────────────────────────

    def list_tables(self, schema: str = "public") -> List[str]:
        """Return all table names in the specified schema."""
        rows = self._execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = %s ORDER BY tablename;",
            (schema,), fetch="all",
        )
        return [r["tablename"] for r in rows]

    def table_exists(self, table_name: str, schema: str = "public") -> bool:
        """Return True if a table exists."""
        row = self._execute(
            "SELECT 1 FROM pg_tables WHERE schemaname = %s AND tablename = %s;",
            (schema, table_name), fetch="one",
        )
        return row is not None

    def describe_table(self, table_name: str) -> List[Dict[str, Any]]:
        """Return column metadata for a table (name, type, nullable, default)."""
        rows = self._execute(
            """
            SELECT column_name, data_type, character_maximum_length,
                   is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = %s AND table_schema = 'public'
            ORDER BY ordinal_position;
            """,
            (table_name,), fetch="all",
        )
        return rows

    def count_rows(self, table_name: str, where: Optional[str] = None) -> int:
        """Count rows in a table, optionally filtered."""
        where_clause = f" WHERE {where}" if where else ""
        row = self._execute(
            f'SELECT COUNT(*) AS cnt FROM "{table_name}"{where_clause};', fetch="one"
        )
        return int(row["cnt"])

    # ── Data: Write ───────────────────────────────────────────────────────

    def insert_rows(self, table_name: str, rows: List[Dict[str, Any]]) -> int:
        """
        Insert one or more rows. Each row is a dict of {column: value}.
        Returns the number of rows inserted.

        Example:
            db.insert_rows("users", [
                {"email": "alice@example.com", "username": "alice"},
                {"email": "bob@example.com",   "username": "bob"},
            ])
        """
        if not rows:
            return 0
        cols = list(rows[0].keys())
        col_str = ", ".join(f'"{c}"' for c in cols)
        val_str = ", ".join("%s" for _ in cols)
        query = f'INSERT INTO "{table_name}" ({col_str}) VALUES ({val_str});'
        self._ensure_connected()
        try:
            count = 0
            with self.conn.cursor() as cur:
                for row in rows:
                    cur.execute(query, [row[c] for c in cols])
                    count += cur.rowcount
            self.conn.commit()
            return count
        except Exception:
            self.conn.rollback()
            raise

    def update_rows(self, table_name: str, set_values: Dict[str, Any], where: str) -> int:
        """
        Update rows matching a WHERE clause. Returns count of updated rows.
        set_values: {column: new_value, ...}
        where: raw SQL WHERE clause WITHOUT the "WHERE" keyword.

        Example:
            db.update_rows("products", {"price": 9.99, "in_stock": True}, "id = 42")
        """
        set_parts = ", ".join(f'"{k}" = %s' for k in set_values)
        query = f'UPDATE "{table_name}" SET {set_parts} WHERE {where};'
        return self._execute(query, tuple(set_values.values()))

    def delete_rows(self, table_name: str, where: Optional[str] = None) -> int:
        """
        Delete rows from a table. Returns count deleted.
        Omit `where` to delete ALL rows (use truncate_table for better performance).

        Example:
            db.delete_rows("sessions", "expires_at < NOW()")
        """
        where_clause = f" WHERE {where}" if where else ""
        return self._execute(f'DELETE FROM "{table_name}"{where_clause};')

    def upsert_rows(
        self,
        table_name: str,
        rows: List[Dict[str, Any]],
        conflict_columns: List[str],
    ) -> int:
        """
        Insert rows; on unique-key conflict, update the non-key columns.
        conflict_columns: list of column names that form the conflict key.
        Returns count of rows affected (inserted + updated).

        Example:
            db.upsert_rows("products", [{"sku": "ABC", "price": 9.99}], ["sku"])
        """
        if not rows:
            return 0
        cols = list(rows[0].keys())
        col_str = ", ".join(f'"{c}"' for c in cols)
        val_str = ", ".join("%s" for _ in cols)
        conflict_str = ", ".join(f'"{c}"' for c in conflict_columns)
        update_cols = [c for c in cols if c not in conflict_columns]
        do_clause = (
            "DO UPDATE SET " + ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in update_cols)
            if update_cols else "DO NOTHING"
        )
        query = (
            f'INSERT INTO "{table_name}" ({col_str}) VALUES ({val_str}) '
            f"ON CONFLICT ({conflict_str}) {do_clause};"
        )
        self._ensure_connected()
        try:
            count = 0
            with self.conn.cursor() as cur:
                for row in rows:
                    cur.execute(query, [row[c] for c in cols])
                    count += cur.rowcount
            self.conn.commit()
            return count
        except Exception:
            self.conn.rollback()
            raise

    # ── Data: Read ────────────────────────────────────────────────────────

    def select_rows(
        self,
        table_name: str,
        columns: Optional[List[str]] = None,
        where: Optional[str] = None,
        order_by: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Query rows from a table.
        - columns:  specific columns to return (None = all)
        - where:    SQL WHERE clause without "WHERE"  e.g. "age > 18 AND status = 'active'"
        - order_by: sort expression                   e.g. "created_at DESC"
        - limit:    max rows to return
        - offset:   rows to skip

        NOTE: where/order_by are raw SQL — never build from untrusted user input.
        """
        col_str = ", ".join(f'"{c}"' for c in columns) if columns else "*"
        q = f'SELECT {col_str} FROM "{table_name}"'
        if where:
            q += f" WHERE {where}"
        if order_by:
            q += f" ORDER BY {order_by}"
        if limit is not None:
            q += f" LIMIT {limit}"
        if offset is not None:
            q += f" OFFSET {offset}"
        return self._execute(q + ";", fetch="all")

    # ── Raw SQL ───────────────────────────────────────────────────────────

    def execute_sql(self, sql_str: str, params: Optional[Tuple] = None) -> Dict[str, Any]:
        """
        Execute arbitrary SQL. Returns:
            rows     list[dict]  — result rows for SELECT
            rowcount int         — affected rows for DML
            columns  list[str]   — column names

        Example:
            result = db.execute_sql(
                "SELECT * FROM orders WHERE total > %s ORDER BY total DESC LIMIT 5",
                (100,)
            )
        """
        self._ensure_connected()
        try:
            with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql_str, params)
                try:
                    rows = [dict(r) for r in cur.fetchall()]
                    cols = list(rows[0].keys()) if rows else []
                except psycopg2.ProgrammingError:
                    rows = []
                    cols = []
                rowcount = cur.rowcount
            self.conn.commit()
            return {"rows": rows, "rowcount": rowcount, "columns": cols}
        except Exception:
            self.conn.rollback()
            raise

    # ── Display ───────────────────────────────────────────────────────────

    def get_table_display(self, table_name: str, limit: int = 50) -> str:
        """Return a formatted ASCII table of a table's contents."""
        rows = self.select_rows(table_name, limit=limit)
        if not rows:
            return f"Table '{table_name}' is empty."
        headers = list(rows[0].keys())
        data = [[r.get(h) for h in headers] for r in rows]
        total = self.count_rows(table_name)
        footer = (
            f"({len(rows)} of {total} rows shown — use limit to see more)"
            if total > limit else f"({total} rows total)"
        )
        return f"\nTable: {table_name}\n{tabulate(data, headers=headers, tablefmt='psql')}\n{footer}"

    def get_schema_display(self, table_name: str) -> str:
        """Return a formatted display of a table's column definitions."""
        cols = self.describe_table(table_name)
        if not cols:
            return f"Table '{table_name}' not found."
        data = [
            [c["column_name"], c["data_type"], c["is_nullable"], c.get("column_default") or ""]
            for c in cols
        ]
        return (
            f"\nSchema: {table_name}\n"
            + tabulate(data, headers=["Column", "Type", "Nullable", "Default"], tablefmt="psql")
        )

    def get_db_summary(self) -> str:
        """Return a summary of all tables with column names and row counts."""
        tables = self.list_tables()
        if not tables:
            return "Database is empty — no tables found."
        lines = ["Database Summary", "=" * 50]
        for t in tables:
            try:
                count = self.count_rows(t)
                cols = self.describe_table(t)
                col_names = ", ".join(c["column_name"] for c in cols)
                lines.append(f"\n  {t}  ({count} rows)")
                lines.append(f"     columns: {col_names}")
            except Exception as e:
                lines.append(f"\n  {t}  [error reading: {e}]")
        return "\n".join(lines)
