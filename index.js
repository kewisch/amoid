#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

var ini = require("ini");
var fs = require("fs");
var RedashClient = require("redash-client");
var yargs = require("yargs");
var readline = require("readline");
var os = require("os");
var path = require("path");

const REDASH_URL = "https://sql.telemetry.mozilla.org/";
const REDASH_AMO_DB = 25;
const FORMAT_CHOICES = ["id", "guid", "slug"];

/**
 * Wait for input from stdin until Ctrl+D
 *
 * @return {Promise<String[]>}      An array with the lines from stdin
 */
function waitForStdin() {
  return new Promise((resolve) => {
    let lines = [];
    let rli = readline.createInterface({ input: process.stdin, });

    rli.on("line", line => lines.push(line));
    rli.once("close", () => {
      resolve(lines);
    });
  });
}

async function redashSQL(sql, debug) {
  if (debug) {
    console.warn(sql);
  }
  let config = ini.parse(fs.readFileSync(path.join(os.homedir(), ".amorc"), "utf-8"));
  if (config && config.auth && config.auth.redash_key) {
    let redash = new RedashClient({
      endPoint: REDASH_URL,
      apiToken: config.auth.redash_key
    });
    let result = await redash.queryAndWaitResult({
      query: sql,
      data_source_id: REDASH_AMO_DB
    });

    return result;
  } else {
    throw new Error("Missing redash API key in ~/.amorc");
  }
}

function mysqlEscape(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\\n")
    .replace(/\r/g, "\\\r")
    .replace(/\x00/g, "\\\x00") // eslint-disable-line no-control-regex
    .replace(/\x1a/g, "\\\x1a"); // eslint-disable-line no-control-regex
}
function csvEscape(str) {
  return (str || "").toString().replace(/,/g, "\\,");
}

async function cmd_convert(argv) {
  let data = argv.identifier;
  if (!data.length) {
    if (process.stdin.isTTY) {
      console.warn(`Waiting for ${argv.input}s... (one per line, Ctrl+D to finish)`);
    }
    data = await waitForStdin();
  }


  let columns = Array.isArray(argv.output) ? argv.output : [argv.output];
  let escape = columns.length > 1 ? csvEscape : (value) => value;

  let escapedIds = data.map(line => '"' + mysqlEscape(line) + '"');
  let res = await redashSQL(`SELECT ${columns.join(",")} FROM addons WHERE ${argv.input} IN (${escapedIds.join(",")})`);
  let resdata = res.query_result.data.rows.map(row => columns.map(column => escape(row[column])).join(","));

  if (columns.length > 1 && resdata.length > 0) {
    console.log(columns.join(","));
  }
  console.log(resdata.join("\n"));
  if (resdata.length != data.length) {
    console.warn(`Warning: ${data.length - resdata.length} entries were not found`);
  }
}

(async function() {
  yargs // eslint-disable-line no-unused-expressions
    .command("$0 [identifier..]", "Convert between different id formats. Takes guids by default.", (subyargs) => {
      subyargs.positional("identifier", {
        describe: "The guids, ids or slugs as input.",
        type: "string",
      })
        .default("identifier", [], "<from stdin>")
        .option("i", {
          "alias": "input",
          "coerce": (data) => {
            if (Array.isArray(data)) {
              throw new Error("Error: --input may only be specified once");
            } else if (typeof data != "string") {
              throw new Error("Error: Invalid value passed for input: " + data);
            }
            return data;
          },
          "describe": "The input format",
          "nargs": 1,
          "choices": FORMAT_CHOICES,
          "default": "guid"
        })
        .option("o", {
          "alias": "output",
          "nargs": 1,
          "describe": "The input format",
          "choices": FORMAT_CHOICES,
          "default": FORMAT_CHOICES
        })
        .option("d", {
          "alias": "debug",
          "describe": "Show debugging information",
          "boolean": true
        });
    }, cmd_convert)
    .example("cat guids | $0", "hello")
    .demandCommand(1, 1, "Error: Missing required command")
    .strict()
    .wrap(120)
    .argv; // This line is needed to make the promises spin
})().catch((e) => {
  console.error("Error:", e.message, e);
  process.exit(1);
});
