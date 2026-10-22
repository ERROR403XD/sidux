#!/usr/bin/python3
import json
import sqlite3
import sys

database, *arguments = sys.argv[1:]
sql = arguments[-1]
with sqlite3.connect(database) as connection:
    if sql.lstrip().startswith('BEGIN;'):
        connection.executescript(sql)
    else:
        cursor = connection.execute(sql)
        if cursor.description:
            rows = cursor.fetchall()
            if '-json' in arguments:
                columns = [column[0] for column in cursor.description]
                print(json.dumps([dict(zip(columns, row)) for row in rows]))
            else:
                for row in rows:
                    print('|'.join('' if value is None else str(value) for value in row))
