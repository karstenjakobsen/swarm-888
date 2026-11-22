"""Isolated skill interpreter. Input is a JSON request on stdin."""

import json
import resource
import sqlite3
import sys


def main() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_AS, (128 << 20, 128 << 20))
    request = json.load(sys.stdin)
    db = sqlite3.connect(":memory:")
    db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 128000)
    db.execute("PRAGMA temp_store=MEMORY")
    db.execute("CREATE TABLE lines(n INTEGER, line TEXT)")
    text = request["input"].get("text", "")
    db.executemany("INSERT INTO lines VALUES (?,?)", enumerate(str(text).splitlines(), 1))
    functions = set(
        "abs char coalesce count format group_concat hex ifnull iif instr json json_array json_array_length json_extract json_group_array json_group_object json_object json_quote json_type length like lower ltrim max min nullif printf replace round rtrim substr sum trim typeof upper row_number".split()
    )

    def authorize(op, arg, function, _database, _source):
        allowed = op in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_RECURSIVE)
        allowed |= op == sqlite3.SQLITE_READ and arg == "lines"
        allowed |= op == sqlite3.SQLITE_FUNCTION and function in functions
        return sqlite3.SQLITE_OK if allowed else sqlite3.SQLITE_DENY

    db.set_authorizer(authorize)
    cursor = db.execute(request["sql"], {"input": json.dumps(request["input"])})
    rows = cursor.fetchmany(2)
    if len(rows) != 1 or len(rows[0]) != 1:
        raise ValueError("Return one row with one JSON value")
    result = json.loads(rows[0][0])
    if not isinstance(result, dict):
        raise ValueError("Return a JSON object")
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.exit(str(exc)[:400])
