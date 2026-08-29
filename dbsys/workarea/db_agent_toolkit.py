"""
db_agent_toolkit.py
===================
PostgreSQL toolkit designed to be used BY AI agents via OpenRouter.

Two usage patterns:

  PATTERN 1 — embed into your own agent
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      toolkit = DBAgentToolkit(DB_URL, api_key)
      my_tools = my_other_tools + toolkit.get_tool_schemas()

      # When your agent receives a DB tool_call:
      if call.function.name in toolkit.tool_names():
          result = toolkit.execute_tool(call.function.name, json.loads(call.function.arguments))
          # result -> {"success": bool, "result": ..., "error": str|None}

  PATTERN 2 — autonomous sub-agent
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      toolkit = DBAgentToolkit(DB_URL, api_key)
      outcome = toolkit.run_task(
          "Create a products table, add 5 sample items, then show me everything priced over $10"
      )
      print(outcome["summary"])

Setup:
    export OPENROUTER_API_KEY="sk-or-..."
    pip install psycopg2-binary tabulate openai
"""

import os
import json
from typing import Any, Dict, List, Optional
from openai import OpenAI
from db_core import PostgresDB


# ── Configuration ────────────────────────────────────────────────────────────

def _load_db_url() -> str:
    path = os.path.join(os.path.dirname(__file__), "db_info.txt")
    return open(path).read().strip()

DB_URL = _load_db_url()
DEFAULT_MODEL = os.environ.get("DB_AGENT_MODEL", "anthropic/claude-3.5-haiku")


# ── Tool Schemas ─────────────────────────────────────────────────────────────
# OpenRouter / OpenAI-compatible function definitions for all DB operations.
# Import TOOL_DEFINITIONS to embed these into any agent's tool list.

TOOL_DEFINITIONS: List[Dict] = [
    # ── Schema: Tables ───────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "create_table",
            "description": (
                "Create a new table in the PostgreSQL database. "
                "Infer sensible types: SERIAL for auto-increment IDs, VARCHAR(255) for names, "
                "TEXT for long strings, INTEGER/FLOAT for numbers, BOOLEAN for flags, "
                "TIMESTAMP for timestamps, JSONB for structured JSON."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {
                        "type": "string",
                        "description": "Table name (snake_case recommended)",
                    },
                    "columns": {
                        "type": "array",
                        "description": "Column definitions",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "type": {
                                    "type": "string",
                                    "description": (
                                        "PostgreSQL type: SERIAL, BIGSERIAL, INTEGER, BIGINT, "
                                        "FLOAT, NUMERIC(p,s), VARCHAR(n), TEXT, BOOLEAN, "
                                        "DATE, TIMESTAMP, JSONB, UUID"
                                    ),
                                },
                                "primary_key": {"type": "boolean", "default": False},
                                "nullable": {"type": "boolean", "default": True},
                                "unique": {"type": "boolean", "default": False},
                                "default": {
                                    "type": "string",
                                    "description": "SQL default expression: NOW(), TRUE, 0, 'active'",
                                },
                            },
                            "required": ["name", "type"],
                        },
                    },
                },
                "required": ["table_name", "columns"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "drop_table",
            "description": "Permanently drop a table and all its data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "cascade": {
                        "type": "boolean",
                        "description": "Also drop dependent objects (views, foreign keys)",
                        "default": False,
                    },
                },
                "required": ["table_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "truncate_table",
            "description": "Delete all rows from a table without dropping its structure. Resets identity sequences by default.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "restart_identity": {"type": "boolean", "default": True},
                },
                "required": ["table_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rename_table",
            "description": "Rename an existing table.",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_name": {"type": "string"},
                    "new_name": {"type": "string"},
                },
                "required": ["old_name", "new_name"],
            },
        },
    },
    # ── Schema: Columns ──────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "add_column",
            "description": "Add a new column to an existing table.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "column_name": {"type": "string"},
                    "column_type": {"type": "string", "description": "PostgreSQL data type"},
                    "nullable": {"type": "boolean", "default": True},
                    "default": {"type": "string", "description": "SQL default expression"},
                },
                "required": ["table_name", "column_name", "column_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "drop_column",
            "description": "Remove a column from a table.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "column_name": {"type": "string"},
                },
                "required": ["table_name", "column_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rename_column",
            "description": "Rename a column in a table.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "old_name": {"type": "string"},
                    "new_name": {"type": "string"},
                },
                "required": ["table_name", "old_name", "new_name"],
            },
        },
    },
    # ── Introspection ────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "list_tables",
            "description": "List all tables currently in the database.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "describe_table",
            "description": "Get the column schema (names, types, nullable, defaults) for a table.",
            "parameters": {
                "type": "object",
                "properties": {"table_name": {"type": "string"}},
                "required": ["table_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "count_rows",
            "description": "Count the number of rows in a table, with optional filtering.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "where": {
                        "type": "string",
                        "description": "SQL WHERE clause without the WHERE keyword",
                    },
                },
                "required": ["table_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_table_display",
            "description": "Return a formatted ASCII grid of a table's contents. Use when asked to show, view, or display a table.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "limit": {"type": "integer", "description": "Max rows to display", "default": 50},
                },
                "required": ["table_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_db_summary",
            "description": "Return a summary of all tables in the database with their column names and row counts.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    # ── Data: Write ──────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "insert_rows",
            "description": "Insert one or more rows into a table. Each row is an object mapping column names to values.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "rows": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "Array of row objects e.g. [{\"name\": \"Alice\", \"age\": 30}]",
                    },
                },
                "required": ["table_name", "rows"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_rows",
            "description": (
                "Update column values for rows matching a WHERE clause. "
                "Always provide a WHERE clause — omitting it updates every row."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "set_values": {
                        "type": "object",
                        "description": "Column-to-value mapping e.g. {\"status\": \"active\", \"score\": 100}",
                    },
                    "where": {
                        "type": "string",
                        "description": "SQL WHERE clause without WHERE e.g. \"id = 5\" or \"status = 'pending'\"",
                    },
                },
                "required": ["table_name", "set_values", "where"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_rows",
            "description": "Delete rows from a table. Omit where to delete ALL rows.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "where": {
                        "type": "string",
                        "description": "SQL WHERE clause without WHERE. Omit to delete everything.",
                    },
                },
                "required": ["table_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "upsert_rows",
            "description": "Insert rows; on unique/primary key conflict, update the non-key columns instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "rows": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "Rows to insert or update",
                    },
                    "conflict_columns": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Column name(s) forming the conflict key e.g. [\"sku\"] or [\"user_id\", \"date\"]",
                    },
                },
                "required": ["table_name", "rows", "conflict_columns"],
            },
        },
    },
    # ── Data: Read ───────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "select_rows",
            "description": "Query rows from a table with optional column selection, filtering, sorting, and pagination.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {"type": "string"},
                    "columns": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Columns to return. Omit for all.",
                    },
                    "where": {
                        "type": "string",
                        "description": "SQL WHERE clause without WHERE e.g. \"price > 10 AND in_stock = true\"",
                    },
                    "order_by": {
                        "type": "string",
                        "description": "ORDER BY expression e.g. \"created_at DESC\"",
                    },
                    "limit": {"type": "integer", "description": "Max rows to return"},
                    "offset": {"type": "integer", "description": "Number of rows to skip"},
                },
                "required": ["table_name"],
            },
        },
    },
    # ── Raw SQL ──────────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "execute_sql",
            "description": (
                "Execute arbitrary PostgreSQL SQL. Use for complex queries, JOINs, aggregations, "
                "or operations not covered by other tools."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "Valid PostgreSQL statement. Use single quotes for string literals.",
                    },
                },
                "required": ["sql"],
            },
        },
    },
]


# ── Dispatcher ───────────────────────────────────────────────────────────────

def dispatch_tool(db: PostgresDB, name: str, args: Dict[str, Any]) -> Any:
    """
    Execute a named tool against a PostgresDB instance. Raises on unknown tool name.
    Returns structured data (dicts/lists) — callers serialize to string as needed.
    """
    from tabulate import tabulate

    if name == "create_table":
        return db.create_table(args["table_name"], args["columns"])

    elif name == "drop_table":
        return db.drop_table(args["table_name"], cascade=args.get("cascade", False))

    elif name == "truncate_table":
        return db.truncate_table(args["table_name"], args.get("restart_identity", True))

    elif name == "rename_table":
        return db.rename_table(args["old_name"], args["new_name"])

    elif name == "add_column":
        return db.add_column(
            args["table_name"], args["column_name"], args["column_type"],
            nullable=args.get("nullable", True), default=args.get("default"),
        )

    elif name == "drop_column":
        return db.drop_column(args["table_name"], args["column_name"])

    elif name == "rename_column":
        return db.rename_column(args["table_name"], args["old_name"], args["new_name"])

    elif name == "list_tables":
        tables = db.list_tables()
        return {"tables": tables, "count": len(tables)}

    elif name == "describe_table":
        return db.describe_table(args["table_name"])

    elif name == "count_rows":
        count = db.count_rows(args["table_name"], args.get("where"))
        return {"count": count}

    elif name == "get_table_display":
        return db.get_table_display(args["table_name"], args.get("limit", 50))

    elif name == "get_db_summary":
        return db.get_db_summary()

    elif name == "insert_rows":
        count = db.insert_rows(args["table_name"], args["rows"])
        return {"inserted": count}

    elif name == "update_rows":
        count = db.update_rows(args["table_name"], args["set_values"], args["where"])
        return {"updated": count}

    elif name == "delete_rows":
        count = db.delete_rows(args["table_name"], args.get("where"))
        return {"deleted": count}

    elif name == "upsert_rows":
        count = db.upsert_rows(args["table_name"], args["rows"], args["conflict_columns"])
        return {"upserted": count}

    elif name == "select_rows":
        rows = db.select_rows(
            args["table_name"],
            columns=args.get("columns"),
            where=args.get("where"),
            order_by=args.get("order_by"),
            limit=args.get("limit"),
            offset=args.get("offset"),
        )
        if rows:
            headers = list(rows[0].keys())
            data = [[r.get(h) for h in headers] for r in rows]
            table_str = tabulate(data, headers=headers, tablefmt="psql")
            return {"rows": rows, "count": len(rows), "display": table_str}
        return {"rows": [], "count": 0, "display": "No rows found."}

    elif name == "execute_sql":
        result = db.execute_sql(args["sql"])
        if result["rows"]:
            headers = list(result["rows"][0].keys())
            data = [[r.get(h) for h in headers] for r in result["rows"]]
            result["display"] = tabulate(data, headers=headers, tablefmt="psql")
        return result

    else:
        raise ValueError(f"Unknown tool: '{name}'")


# ── DBAgentToolkit ───────────────────────────────────────────────────────────

_AGENT_SYSTEM = """\
You are a specialized PostgreSQL database agent with access to a live Neon database.
Use the provided tools to complete the requested task.

Principles:
- Check what tables exist before querying them (use list_tables or describe_table).
- Use specific WHERE clauses — avoid full-table deletes/updates unless explicitly requested.
- For multi-step tasks, execute steps in logical order and verify each one succeeds.
- Report results clearly: counts affected, schemas returned, data retrieved.
- If a step fails, analyze the error message and try an alternative approach.
- SQL string literals use single quotes: status = 'active', not status = "active".
"""


class DBAgentToolkit:
    """
    PostgreSQL toolkit for AI agents. Wraps all DB operations as OpenRouter tool calls.

    Can also run as an autonomous sub-agent via run_task().
    """

    def __init__(
        self,
        db_url: str = DB_URL,
        api_key: str = "",
        model: str = DEFAULT_MODEL,
    ):
        if not api_key:
            api_key = os.environ.get("OPENROUTER_API_KEY", "")
        self.db = PostgresDB(db_url)
        self.db.connect()
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
            default_headers={"X-Title": "DB Agent Toolkit"},
        )
        self.model = model

    def close(self) -> None:
        self.db.disconnect()

    def __enter__(self) -> "DBAgentToolkit":
        return self

    def __exit__(self, *_) -> None:
        self.close()

    # ── Library mode ──────────────────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict]:
        """
        Return the list of OpenRouter/OpenAI tool definitions.
        Concatenate with your own tools to add DB capabilities to any agent.

            all_tools = my_tools + toolkit.get_tool_schemas()
        """
        return TOOL_DEFINITIONS

    def tool_names(self) -> List[str]:
        """Return the names of all tools this toolkit handles."""
        return [t["function"]["name"] for t in TOOL_DEFINITIONS]

    def execute_tool(self, tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute a DB tool by name. Returns:
            {"success": True,  "result": <data>,       "error": None}
            {"success": False, "result": None,          "error": "<message>"}

        Use this in your agent's tool-call handler:
            if call.function.name in toolkit.tool_names():
                outcome = toolkit.execute_tool(call.function.name, args)
        """
        try:
            result = dispatch_tool(self.db, tool_name, args)
            return {"success": True, "result": result, "error": None}
        except Exception as e:
            return {"success": False, "result": None, "error": str(e)}

    # ── Autonomous agent mode ─────────────────────────────────────────────

    def run_task(
        self,
        task: str,
        max_iterations: int = 25,
        verbose: bool = True,
    ) -> Dict[str, Any]:
        """
        Run an autonomous agentic loop to accomplish a database task.

        The agent plans and executes multi-step operations, iterating until the task
        is complete or max_iterations is reached.

        Args:
            task:           Natural language description of what to accomplish.
            max_iterations: Safety cap on LLM + tool-call rounds.
            verbose:        Print tool calls and results as they happen.

        Returns a dict with:
            success         bool
            summary         str  — agent's final response
            tool_calls_made list — log of each tool call + result
            iterations      int

        Example:
            result = toolkit.run_task(
                "Create an inventory table with id, sku, name, price, and quantity. "
                "Insert 5 sample products. Then show me items where quantity < 10."
            )
            print(result["summary"])
        """
        messages: List[Dict] = [
            {"role": "system", "content": _AGENT_SYSTEM},
            {"role": "user",   "content": task},
        ]
        call_log: List[Dict] = []
        iterations = 0

        if verbose:
            print(f"\nTask: {task}")
            print("─" * 60)

        while iterations < max_iterations:
            iterations += 1

            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=TOOL_DEFINITIONS,
                tool_choice="auto",
            )

            choice = response.choices[0]
            msg = choice.message
            messages.append(msg.model_dump(exclude_unset=True))

            if not msg.tool_calls or choice.finish_reason == "stop":
                final = msg.content or "Task complete."
                if verbose:
                    print(f"\n{final}")
                return {
                    "success": True,
                    "summary": final,
                    "tool_calls_made": call_log,
                    "iterations": iterations,
                }

            for tc in msg.tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}

                if verbose:
                    args_preview = json.dumps(args, default=str)
                    if len(args_preview) > 100:
                        args_preview = args_preview[:97] + "..."
                    print(f"  → {name}({args_preview})")

                outcome = self.execute_tool(name, args)
                call_log.append({
                    "tool":    name,
                    "args":    args,
                    "success": outcome["success"],
                    "result":  str(outcome.get("result", ""))[:500],
                    "error":   outcome.get("error"),
                })

                result_str = (
                    json.dumps(outcome["result"], default=str)
                    if outcome["success"]
                    else f"ERROR: {outcome['error']}"
                )

                if verbose:
                    status = "OK" if outcome["success"] else "ERROR"
                    preview = result_str[:300]
                    print(f"     [{status}] {preview}")

                messages.append({
                    "role":         "tool",
                    "tool_call_id": tc.id,
                    "content":      result_str,
                })

        return {
            "success": False,
            "summary": f"Reached max_iterations ({max_iterations}) without completing task.",
            "tool_calls_made": call_log,
            "iterations": iterations,
        }


# ── CLI demo ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("Error: OPENROUTER_API_KEY environment variable not set.")
        sys.exit(1)

    task = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else (
        "List all tables in the database and give me a summary of what's there."
    )

    with DBAgentToolkit(api_key=api_key) as toolkit:
        result = toolkit.run_task(task, verbose=True)

    if not result["success"]:
        print(f"\nTask did not complete: {result['summary']}")
        sys.exit(1)
