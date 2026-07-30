"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

class ClassList {
	constructor(initial = []) {
		this.values = new Set(initial);
	}

	add(value) {
		this.values.add(value);
	}

	remove(value) {
		this.values.delete(value);
	}

	contains(value) {
		return this.values.has(value);
	}
}

function element(id) {
	return {
		id,
		classList: new ClassList(["hidden"]),
		dataset: {},
		textContent: "",
		value: "",
		href: "",
		addEventListener() {},
	};
}

const ids = [
	"title",
	"subtitle",
	"expectations",
	"error",
	"member-form",
	"agent-form",
	"working",
	"member-success",
	"agent-success",
	"account",
	"herder-account",
	"display-name",
	"agent-name",
	"agent-owner",
	"agent-herder",
	"redeem-agent",
	"member-account",
	"member-password",
	"member-herder",
	"open-lobby",
	"first-command",
	"quassel-host",
	"quassel-port",
	"agent-account",
	"agent-success-herder",
	"download-agent-env",
	"download-compose",
	"download-dockerfile",
	"download-adapter",
	"download-requirements",
	"download-runbook",
];
const elements = new Map(ids.map((id) => [id, element(id)]));

global.document = {
	getElementById(id) {
		return elements.get(id) || null;
	},
	querySelectorAll() {
		return [];
	},
};
global.location = {hash: "#test-token", pathname: "/join/"};
global.history = {replaceState() {}};
global.fetch = async (pathValue, options) => {
	assert.equal(pathValue, "api/invites/preview");
	assert.equal(options.method, "POST");
	return {
		ok: true,
		async json() {
			return {
				kind: "member",
				display_name: "Friend",
			};
		},
	};
};

require(path.resolve(__dirname, "../public/app.js"));

setImmediate(() => {
	assert.equal(elements.get("title").textContent, "Friend, you’re invited");
	assert.equal(
		elements.get("member-form").classList.contains("hidden"),
		false
	);
	assert.equal(
		elements.get("expectations").classList.contains("hidden"),
		false
	);
	process.stdout.write("portal browser-script smoke: PASS\n");
});
