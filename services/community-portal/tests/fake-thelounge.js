"use strict";

const fs = require("node:fs");
const path = require("node:path");

const account = process.argv[process.argv.length - 1];
const users = path.join(process.env.THELOUNGE_HOME, "users");

fs.mkdirSync(users, {recursive: true});
fs.writeFileSync(
	path.join(users, `${account}.json`),
	JSON.stringify({password: "hashed-by-thelounge", log: true, networks: []})
);
