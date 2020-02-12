/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019-2020 */

import yargs from "yargs";
import readline from "readline";

import { AMORedashClient, getConfig, detectIdType, partitionIds } from "amolib";

const FORMAT_CHOICES = ["id", "guid", "slug", "user_id"];

/**
 * Make the text bold for output on the terminal.
 *
 * @param {string} text     The string to make bold.
 * @return {string}         The bold text.
 */
export function bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

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


class AMOID {
  constructor({ redash }) {
    this.redash = redash;
  }

  async getInputData(data, message) {
    if (!data.length) {
      if (process.stdin.isTTY && message) {
        console.warn(message);
      }
      data = await waitForStdin();
    }
    return data;
  }


  async convert(argv) {
    let data = await this.getInputData(argv.identifier, `Waiting for ${argv.input}s... (one per line, Ctrl+D to finish)`);

    if (argv.input == "auto") {
      argv.input = detectIdType(data);
    }

    let columns = Array.isArray(argv.output) ? argv.output : [argv.output];
    let escape = columns.length > 1 ? csvEscape : (value) => value;

    let columnmap = {
      id: "a.id",
      guid: "a.guid",
      slug: "a.slug",
      user_id: "au.user_id"
    };

    console.warn(`Converting ${argv.input}s to ${columns.join("s,")}s`);

    // Remove falsy values from Array
    data = data.filter(Boolean);

    let escapedIds = data.map(line => '"' + mysqlEscape(line) + '"');
    let res;
    if (argv.user) {
      res = await this.redash.sql(`
        SELECT ${columns.map(col => columnmap[col] || "a." + col).join(",")},au.user_id
        FROM addons_users au
        LEFT JOIN addons a ON (a.id = au.addon_id)
        ${argv.wx ? `
          LEFT JOIN versions v ON (v.addon_id = a.id)
          LEFT JOIN files f ON (f.version_id = v.id)
          ` : ""}
        WHERE
          au.user_id IN (
            SELECT au.user_id
            FROM addons a
            RIGHT JOIN addons_users au ON (a.id = au.addon_id)
            WHERE a.${argv.input} IN (${escapedIds.join(",")})
            GROUP BY au.user_id
          )
          AND a.guid NOT LIKE 'guid-reused-by-pk-%'
          ${argv.wx ? "AND f.is_webextension = 1" : ""}
          GROUP BY a.id
      `);

      // Add the user_id column for display, if there is more than one column already
      if (columns.length > 1) {
        columns.push("user_id");
      }
    } else if (columns.length == 1 && columns[0] == "user_id") {
      res = await this.redash.sql(`
        SELECT au.user_id
        FROM addons_users au
        LEFT JOIN addons a ON (a.id = au.addon_id)
        WHERE a.${argv.input} IN (${escapedIds.join(",")})
      `);
    } else {
      res = await this.redash.sql(`
        SELECT ${columns.map(col => columnmap[col] || "a." + col).join(",")}
        FROM addons a
        ${argv.wx ? `
          LEFT JOIN versions v ON (v.addon_id = a.id)
          LEFT JOIN files f ON (f.version_id = v.id)
          ` : ""}
        LEFT JOIN addons_users au ON (au.addon_id = a.id AND au.position = 0)
        WHERE
          a.${argv.input} IN (${escapedIds.join(",")})
          AND a.guid NOT LIKE 'guid-reused-by-pk-%'
          ${argv.wx ? "AND f.is_webextension = 1" : ""}
        GROUP BY a.id
      `);
    }

    let resdata = res.query_result.data.rows.map(row => columns.map(column => escape(row[column])).join(","));

    if (columns.length > 1 && resdata.length > 0) {
      console.log(columns.join(","));
    }
    console.log(resdata.join("\n"));
    if (resdata.length < data.length) {
      console.warn(`Warning: ${data.length - resdata.length} entries were not found`);
    }
  }

  async partition(argv) {
    function header(text) {
      return argv.output ? "" : bold(text) + "\n";
    }

    let data = await this.getInputData(argv.identifier);
    let { ids, guids, other } = partitionIds(data);
    let sections = [];

    if (argv.debug) {
      console.warn(`Found ${ids.length} ids, ${guids.length} guids, and ${other.length} potential slugs`);
    }

    if (ids.length && (!argv.output || argv.output.includes("id"))) {
      sections.push(header("IDs:") + ids.join("\n"));
    }
    if (guids.length && (!argv.output || argv.output.includes("guid"))) {
      sections.push(header("GUIDs:") + guids.join("\n"));
    }
    if (other.length && (!argv.output || argv.output.includes("slug"))) {
      sections.push(header("Slugs:") + other.join("\n"));
    }

    console.log(sections.join(argv.output ? "\n" : "\n\n"));
  }
}

(async function() {
  let config = getConfig();

  let argv = yargs // eslint-disable-line no-unused-expressions
    .option("d", {
      "alias": "debug",
      "describe": "Show debugging information",
      "boolean": true,
      "global": true
    })
    .command("partition [identifier...]", "Split ids between different formats: ids, guids, or slugs.\nNote that slugs may also contain invalid guids as there is no format restriction on slugs.", (subyargs) => {
      subyargs.positional("identifier", {
        describe: "The guids, ids or slugs as input.",
        type: "string",
      })
        .default("identifier", [], "<from stdin>")
        .option("o", {
          alias: "output",
          describe: "The ids types to output. If this option is passed, no headers will be shown",
          type: "array",
          choices: ["id", "guid", "slug"]
        })
        .example("amoid partition 123 @guid slug", "Splits the ids into three sections, one for each id type")
        .example("amoid partition 123 @guid slug -o guid", "Show a flat list of only the guids, no headers")
        .example("amoid partition 123 @guid slug -o id -o guid", "Show a flat list of ids and guids, no headers");
    })
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
          "choices": FORMAT_CHOICES.concat(["auto"]),
          "default": "auto"
        })
        .option("o", {
          "alias": "output",
          "nargs": 1,
          "describe": "The input format",
          "choices": FORMAT_CHOICES,
          "default": FORMAT_CHOICES
        })
        .option("U", {
          "alias": "user",
          "describe": "Expand list to include all guids of all involved users",
          "boolean": true
        })
        .option("w", {
          "alias": "wx",
          "describe": "Filter ids to only include add-ons that have a WebExtension version",
          "boolean": true
        });
    })
    .example("cat guids | $0", "hello")
    .demandCommand(1, 1, "Error: Missing required command")
    .strict()
    .wrap(120)
    .argv; // This line is needed to make the promises spin

  let amoid = new AMOID({ redash: new AMORedashClient({ apiToken: config.auth && config.auth.redash_key, debug: argv.debug }), });

  amoid[argv._[0] || "convert"](argv);
})().catch((e) => {
  console.error("Error:", e.message, e);
  process.exit(1);
});
