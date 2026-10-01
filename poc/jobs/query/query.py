"""Runs the client's SQL over the client's own tables, where they are stored.

Job contract (the same for every PieceWork job): read from /in (read-only), write to /out, no network.

The client puts the query in a file whose name starts with "query" (.sql or .txt); every .csv, .parquet,
.json and .jsonl file beside it becomes a table named after the file, so a data set holding trades.csv is
queried as `select * from trades`.

Outputs:
  /out/results.csv   the rows the query returned
  /out/query-report.txt  what ran, over which tables, how long it took, how much was read and returned

Input is gigabytes and output is a few rows: this is the case where moving the query to the data rather than
the data to the query is not an optimisation but the only sensible arrangement. It needs no GPU.
"""
import os
import re
import sys
import time

IN, OUT = "/in", "/out"
TABLES = (".csv", ".parquet", ".json", ".jsonl")
MAX_ROWS = int(os.environ.get("MAX_ROWS", "100000"))


def table_name(filename):
    """trades-2026.csv -> trades_2026. DuckDB needs an identifier, the client gave us a filename."""
    stem = os.path.splitext(filename)[0]
    name = re.sub(r"[^0-9a-zA-Z_]+", "_", stem).strip("_").lower()
    return name if re.match(r"^[a-z_]", name or "") else f"t_{name}"


def main():
    import duckdb

    queries = sorted(f for f in os.listdir(IN) if re.match(r"^query.*\.(sql|txt)$", f, re.I))
    sources = sorted(f for f in os.listdir(IN) if f.lower().endswith(TABLES))
    if not queries:
        raise SystemExit("no query file in /in: name it query.sql and put the SQL in it")
    if not sources:
        raise SystemExit("no data files in /in: the job needs .csv, .parquet, .json or .jsonl to query")

    con = duckdb.connect()
    registered = {}
    for f in sources:
        name, path = table_name(f), os.path.join(IN, f)
        reader = {".csv": "read_csv_auto", ".parquet": "read_parquet",
                  ".json": "read_json_auto", ".jsonl": "read_json_auto"}[os.path.splitext(f)[1].lower()]
        con.execute(f"create or replace view {name} as select * from {reader}('{path}')")
        registered[name] = f

    sql = open(os.path.join(IN, queries[0]), encoding="utf-8", errors="replace").read().strip().rstrip(";")
    t0 = time.time()
    rows = con.execute(sql).fetchdf()
    took = time.time() - t0
    truncated = len(rows) > MAX_ROWS
    if truncated:
        rows = rows.head(MAX_ROWS)
    rows.to_csv(os.path.join(OUT, "results.csv"), index=False)

    read = sum(os.path.getsize(os.path.join(IN, f)) for f in sources)
    produced = os.path.getsize(os.path.join(OUT, "results.csv"))
    with open(os.path.join(OUT, "query-report.txt"), "w") as rep:
        rep.write("Query: your SQL, run where your tables are stored\n\n")
        rep.write(f"Query file: {queries[0]}\n\n{sql}\n\n")
        rep.write("Tables available to it:\n")
        for name, f in registered.items():
            rep.write(f"  {name}  (from {f}, {os.path.getsize(os.path.join(IN, f)):,} bytes)\n")
        rep.write(f"\nRows returned: {len(rows):,}{' (truncated)' if truncated else ''}\n")
        rep.write(f"Read: {read:,} bytes\nProduced: {produced:,} bytes (results.csv)\n")
        rep.write(f"\nHow the job ran: DuckDB on CPU, {took:.2f} s. No GPU, no network. "
                  f"{read / max(produced, 1):.0f}x less came out than went in.\n")
    print(f"{len(rows)} rows from {len(registered)} table(s) in {took:.2f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
