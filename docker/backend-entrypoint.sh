#!/bin/sh
set -eu

if [ "${AUTO_RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Running main database migrations..."
  node ./node_modules/typeorm/cli.js -d dist/database/data-source.main.js migration:run

  echo "Running tool database migrations..."
  node ./node_modules/typeorm/cli.js -d dist/database/data-source.tool.js migration:run

  echo "Running audit database migrations..."
  node ./node_modules/typeorm/cli.js -d dist/database/data-source.audit.js migration:run

  echo "Running film database migrations..."
  node ./node_modules/typeorm/cli.js -d dist/database/data-source.film.js migration:run
fi

exec node dist/main.js
