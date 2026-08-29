"""
db_nl_interface.py
==================
Natural language interface to PostgreSQL. Type commands in plain English;
an LLM (via OpenRouter) interprets your intent and calls the right database tool.

Maintains conversation history so follow-up commands have full context
("now delete those rows", "add another column to that table", etc.).

Setup:
    export OPENROUTER_API_KEY="sk-or-..."
    pip install psycopg2-binary tabulate openai

Run:
    python db_nl_interface.py

Example session:
    > create a table called products with id, name, price, and in_stock columns
    > insert 3 sample products — a laptop, a phone, and some headphones
    > show me all products where price is over 500
    > update the phone's price to 999
    > describe the products table
    > show me a summary of the whole database
    > drop the products table
"""

import os
import sys
import json
from typing import Any, Dict, List
from openai import OpenAI

from db_core import PostgresDB
from db_agent_toolkit import TOOL_DEFINITIONS, dispatch_tool


# ── Configuration ────────────────────────────────────────────────────────────

def _load_db_url() -> str:
    path = os.path.join(os.path.dirname(__file__), "db_info.txt")
    return open(path).read().strip()

DB_URL = _load_db_url()
DEFAULT_MODEL = os.environ.get("DB_NL_MODEL", "anthropic/claude-3.5-haiku")

_SYSTEM_PROMPT = """\
You are a helpful database assistant. The user interacts with a live PostgreSQL database
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
- If the user's request is ambiguous, make a reasonable inference and proceed.
- Remember previous commands in the conversation — "that table" or "those rows" refers
  to what was last discussed.
"""


# ── Tool Result Formatter ─────────────────────────────────────────────────────

def _format_result(name: str, result: Any) -> str:
    """Convert a tool result to a string to feed back to the model."""
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and "display" in result:
        return result["display"]
    return json.dumps(result, default=str, indent=2)


# ── NaturalLanguageDB ─────────────────────────────────────────────────────────

class NaturalLanguageDB:
    """
    Chat-based natural language interface to PostgreSQL.

    Users type commands in plain English. An LLM (via OpenRouter) routes each
    command to the appropriate database tool and returns a human-readable response.

    Conversation history is maintained across turns so follow-up commands work
    naturally ("now add a column to that table", "delete those rows", etc.).
    """

    def __init__(
        self,
        db_url: str = DB_URL,
        api_key: str = "",
        model: str = DEFAULT_MODEL,
    ):
        if not api_key:
            api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            raise ValueError("api_key required or set OPENROUTER_API_KEY environment variable.")

        self.db = PostgresDB(db_url)
        self.db.connect()
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
            default_headers={"X-Title": "Natural Language DB Interface"},
        )
        self.model = model
        self._history: List[Dict] = []

    def close(self) -> None:
        self.db.disconnect()

    def __enter__(self) -> "NaturalLanguageDB":
        return self

    def __exit__(self, *_) -> None:
        self.close()

    def reset_history(self) -> None:
        """Clear conversation history."""
        self._history = []

    # ── Core chat ─────────────────────────────────────────────────────────

    def chat(self, user_message: str, show_tools: bool = True) -> str:
        """
        Send a natural language message and return the assistant's response.

        The LLM will call database tools as needed, receive their outputs,
        then return a friendly human-readable summary.

        Args:
            user_message: Plain English command or question.
            show_tools:   Print "[tool: name]" to stdout as calls are made.

        Returns:
            The assistant's text response.
        """
        self._history.append({"role": "user", "content": user_message})
        messages = [{"role": "system", "content": _SYSTEM_PROMPT}] + self._history

        while True:
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
                reply = msg.content or ""
                self._history.append({"role": "assistant", "content": reply})
                return reply

            # Execute all tool calls in this round
            for tc in msg.tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}

                if show_tools:
                    print(f"  [tool: {name}]", flush=True)

                try:
                    raw = dispatch_tool(self.db, name, args)
                    result_str = _format_result(name, raw)
                except Exception as e:
                    result_str = f"ERROR: {e}"

                messages.append({
                    "role":         "tool",
                    "tool_call_id": tc.id,
                    "content":      result_str,
                })

    # ── REPL ─────────────────────────────────────────────────────────────

    def run_repl(self) -> None:
        """
        Start an interactive REPL. Type database commands in plain English.

        Special commands:
            /reset   — clear conversation history
            /tables  — quick table list (no LLM round-trip)
            /schema <table> — quick schema view
            /history — show conversation history length
            quit / exit / q  — exit
        """
        db_host = self.db.connection_url.split("@")[-1].split("/")[0]
        print("\nNatural Language Database Interface")
        print("=" * 45)
        print(f"  Database : {db_host}")
        print(f"  Model    : {self.model}")
        print("  Type commands in plain English. 'help' for tips, 'quit' to exit.")
        print("=" * 45 + "\n")

        while True:
            try:
                user_input = input("> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nGoodbye!")
                break

            if not user_input:
                continue

            # Quick exit
            if user_input.lower() in ("quit", "exit", "q"):
                print("Goodbye!")
                break

            # Built-in shortcuts (bypass the LLM for speed)
            if user_input.lower() == "/reset":
                self.reset_history()
                print("Conversation history cleared.\n")
                continue

            if user_input.lower() == "/tables":
                tables = self.db.list_tables()
                print("Tables:", ", ".join(tables) if tables else "(none)")
                print()
                continue

            if user_input.lower().startswith("/schema "):
                table = user_input[8:].strip()
                print(self.db.get_schema_display(table))
                print()
                continue

            if user_input.lower() == "/history":
                turns = len([m for m in self._history if m["role"] == "user"])
                print(f"Conversation: {turns} user turn(s) in history.\n")
                continue

            if user_input.lower() in ("help", "/help"):
                print(
                    "\nExample commands:\n"
                    "  create a table called orders with id, customer name, total, and status\n"
                    "  insert 3 sample orders into the orders table\n"
                    "  show me all orders where total is over 100\n"
                    "  update order 2's status to 'shipped'\n"
                    "  delete all cancelled orders\n"
                    "  describe the orders table\n"
                    "  show me a summary of the whole database\n"
                    "  drop the orders table\n"
                    "\nShortcuts: /reset  /tables  /schema <table>  /history\n"
                )
                continue

            # Normal NL command → LLM
            try:
                reply = self.chat(user_input, show_tools=True)
                print(f"\n{reply}\n")
            except Exception as e:
                print(f"\nError: {e}\n")


# ── Standalone usage ──────────────────────────────────────────────────────────

def quick_query(message: str, api_key: str = "", model: str = DEFAULT_MODEL) -> str:
    """
    One-shot natural language DB query — no REPL, no history.
    Useful for embedding NL DB access in scripts or other agents.

    Example:
        result = quick_query("How many users signed up in the last 7 days?")
        print(result)
    """
    with NaturalLanguageDB(api_key=api_key, model=model) as nldb:
        return nldb.chat(message, show_tools=False)


# ── CLI entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("Error: OPENROUTER_API_KEY environment variable not set.")
        print("  export OPENROUTER_API_KEY='sk-or-...'")
        sys.exit(1)

    model = os.environ.get("DB_NL_MODEL", DEFAULT_MODEL)
    nldb = NaturalLanguageDB(api_key=api_key, model=model)
    try:
        nldb.run_repl()
    finally:
        nldb.close()
