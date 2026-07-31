"use strict";

// Personal AI Storefront rendering and validation.
//
// Everything here is presentation over two inputs: the owner-authored profile
// row (untrusted text, always escaped) and the HEARTH snapshot the member's
// BotHerder pushed (trusted transport, still schema-checked and escaped).
// Operational truth is never invented here — a missing or old snapshot is
// rendered as exactly that.

const HEX_PATTERN = /^#[0-9a-f]{6}$/;
const HTTPS_PATTERN = /^https:\/\/[^\s<>"']{1,200}$/;
const SNAPSHOT_MAX_BYTES = 15_000;
const SNAPSHOT_STALE_MINUTES = 30;

const THEME_DEFAULTS = {
	bg: "#090b10",
	fg: "#cfd8e3",
	accent: "#ffb340",
	accent2: "#62d996",
};

const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function parseJsonOr(value, fallback) {
	try {
		const parsed = JSON.parse(value);
		return parsed === null || typeof parsed !== typeof fallback ? fallback : parsed;
	} catch {
		return fallback;
	}
}

function labTheme(profile) {
	const stored = parseJsonOr(profile.theme, {});
	const theme = {...THEME_DEFAULTS};
	for (const key of Object.keys(THEME_DEFAULTS)) {
		const value = typeof stored[key] === "string" ? stored[key].toLowerCase() : "";
		if (HEX_PATTERN.test(value)) {
			theme[key] = value;
		}
	}
	return theme;
}

function paragraphs(text) {
	return String(text)
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
		.join("\n");
}

function listItems(values, limit) {
	return values
		.filter((value) => typeof value === "string" && value.trim())
		.slice(0, limit)
		.map((value) => `<li>${escapeHtml(value.trim())}</li>`)
		.join("\n");
}

function linkTiles(links) {
	const items = [];
	for (const link of Array.isArray(links) ? links.slice(0, 8) : []) {
		if (
			!link ||
			typeof link.label !== "string" ||
			typeof link.url !== "string" ||
			!HTTPS_PATTERN.test(link.url)
		) {
			continue;
		}
		items.push(
			`<a class="link-tile" href="${escapeHtml(link.url)}" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`
		);
	}
	return items.join("\n");
}

function odometer(visitors) {
	const digits = String(Math.max(0, visitors) % 1_000_000).padStart(6, "0");
	return [...digits]
		.map((digit) => `<span class="digit">${digit}</span>`)
		.join("");
}

function snapshotAge(fetchedAt, now) {
	const fetched = Date.parse(fetchedAt);
	return Number.isFinite(fetched) ? (now - fetched) / 60_000 : Infinity;
}

function keyValueRows(entries) {
	return entries
		.map(
			([key, value]) =>
				`<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span></div>`
		)
		.join("\n");
}

function truthPanel(snapshotRow, now) {
	if (!snapshotRow) {
		return [
			'<section class="truth">',
			'<h2>From the HEARTH</h2>',
			'<p class="stale">This lab is not currently projecting HEARTH state.</p>',
			"</section>",
		].join("\n");
	}
	const snapshot = parseJsonOr(snapshotRow.snapshot, {});
	const age = snapshotAge(snapshotRow.fetched_at, now);
	const stamp = escapeHtml(String(snapshotRow.fetched_at).slice(11, 16));
	const parts = ['<section class="truth">', "<h2>From the HEARTH</h2>"];
	if (age > SNAPSHOT_STALE_MINUTES) {
		parts.push(
			`<p class="stale">HEARTH projection stale — last seen ${escapeHtml(
				String(snapshotRow.fetched_at).slice(0, 16).replace("T", " ")
			)} UTC.</p>`
		);
	}
	const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
	if (providers.length > 0) {
		parts.push('<h3>Iron on the floor</h3><ul class="providers">');
		for (const provider of providers) {
			const models = (provider.models || []).map(escapeHtml).join(", ");
			const tags = (provider.tags || []).map(escapeHtml).join(" · ");
			parts.push(
				`<li><span class="name">${escapeHtml(provider.name)}</span>` +
					(models ? ` <span class="models">${models}</span>` : "") +
					(tags ? ` <span class="tags">${tags}</span>` : "") +
					"</li>"
			);
		}
		parts.push("</ul>");
	}
	const operations = Array.isArray(snapshot.operations) ? snapshot.operations : [];
	if (operations.length > 0) {
		parts.push('<h3>On offer</h3><ul class="operations">');
		for (const operation of operations) {
			parts.push(
				`<li><span class="name">${escapeHtml(operation.name)}</span>` +
					(operation.description
						? ` — ${escapeHtml(operation.description)}`
						: "") +
					"</li>"
			);
		}
		parts.push("</ul>");
	}
	const kernel =
		snapshot.kernel && typeof snapshot.kernel === "object" ? snapshot.kernel : {};
	const kernelEntries = Object.entries(kernel).filter(
		([, value]) => Number.isInteger(value)
	);
	if (kernelEntries.length > 0) {
		parts.push('<h3>Vitals</h3><div class="kernel">');
		parts.push(keyValueRows(kernelEntries));
		parts.push("</div>");
	}
	const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
	if (recent.length > 0) {
		parts.push('<h3>Fresh out of the lab</h3><ul class="recent">');
		for (const entry of recent) {
			parts.push(
				`<li><span class="name">${escapeHtml(entry.operation)}</span>` +
					` <span class="status status-${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span>` +
					(entry.finished_at
						? ` <span class="when">${escapeHtml(String(entry.finished_at).slice(0, 16).replace("T", " "))}</span>`
						: "") +
					"</li>"
			);
		}
		parts.push("</ul>");
	}
	const artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
	if (artifacts.length > 0) {
		parts.push('<h3>Artifacts</h3><ul class="artifacts">');
		for (const artifact of artifacts) {
			parts.push(
				`<li><span class="name">${escapeHtml(artifact.name)}</span>` +
					(artifact.kind ? ` <span class="kind">${escapeHtml(artifact.kind)}</span>` : "") +
					"</li>"
			);
		}
		parts.push("</ul>");
	}
	if (parts.length === 2) {
		parts.push('<p class="stale">The projection is currently empty.</p>');
	}
	parts.push(
		`<p class="stamp">projected from HEARTH · as of ${stamp} UTC · never faked</p>`
	);
	parts.push("</section>");
	return parts.join("\n");
}

// Every public lab surface ends with a way in: the pages double as the
// community's recruitment flyers.
function doorbell() {
	return (
		'<p class="doorbell">want a lab like this? membership is by invitation — ' +
		'<a href="/guide/">read the field guide</a> · ' +
		'<a href="/lab/">tour the labs</a></p>'
	);
}

function renderGalleryPage(profiles, {nonce}) {
	// Each card wears its lab's own theme — the gallery is a street of
	// storefronts, not a directory listing. Only validated #rrggbb tokens
	// from labTheme ever reach the nonce'd style block.
	const styles = [];
	const cards = profiles
		.map((profile, index) => {
			const theme = labTheme(profile);
			styles.push(
				`.gallery-card.card-${index}{background:${theme.bg};` +
					`border-color:color-mix(in srgb, ${theme.accent} 45%, transparent);}` +
					`.gallery-card.card-${index}:hover{border-color:${theme.accent};}` +
					`.gallery-card.card-${index} .name{color:${theme.accent};}` +
					`.gallery-card.card-${index} .tagline{color:${theme.accent2};}` +
					`.gallery-card.card-${index} .meta{color:${theme.fg};}`
			);
			return (
				`<a class="gallery-card card-${index}" href="/lab/${escapeHtml(profile.lab_slug)}">` +
				`<span class="name">${escapeHtml(profile.lab_name)}</span>` +
				(profile.tagline
					? `<span class="tagline">${escapeHtml(profile.tagline)}</span>`
					: "") +
				`<span class="meta">${escapeHtml(profile.channel)} · ` +
				`${Math.max(0, profile.visitors)} visitors · ` +
				`est. ${escapeHtml(String(profile.created_at).slice(0, 10))}</span>` +
				"</a>"
			);
		})
		.join("\n");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Labs — Omen IRC</title>
<link rel="stylesheet" href="/lab/lab.css">
${styles.length ? `<style nonce="${nonce}">${styles.join("\n")}</style>` : ""}
</head>
<body class="lab gallery">
<div class="crt">
<header>
<h1>The Labs</h1>
<p class="tagline">every member runs one</p>
</header>
${
	cards
		? `<nav class="gallery-grid">\n${cards}\n</nav>`
		: '<p class="stale">No labs are published yet.</p>'
}
<footer>an Omen IRC community${doorbell()}</footer>
</div>
</body>
</html>
`;
}

function renderLabPage(profile, snapshotRow, {nonce, now = Date.now()}) {
	const theme = labTheme(profile);
	const experiments = parseJsonOr(profile.experiments, []);
	const links = parseJsonOr(profile.links, []);
	const experimentItems = listItems(experiments, 8);
	const linkItems = linkTiles(links);
	const established = escapeHtml(String(profile.created_at).slice(0, 10));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(profile.lab_name)} — Omen IRC</title>
<link rel="stylesheet" href="/lab/lab.css">
<style nonce="${nonce}">:root{--lab-bg:${theme.bg};--lab-fg:${theme.fg};--lab-accent:${theme.accent};--lab-accent2:${theme.accent2};}</style>
</head>
<body class="lab">
<div class="crt">
${
	profile.marquee
		? `<div class="marquee"><span>${escapeHtml(profile.marquee)}</span></div>`
		: ""
}
<header>
<h1>${escapeHtml(profile.lab_name)}</h1>
${profile.tagline ? `<p class="tagline">${escapeHtml(profile.tagline)}</p>` : ""}
</header>
${
	profile.ascii_banner
		? `<pre class="banner">${escapeHtml(profile.ascii_banner)}</pre>`
		: ""
}
<div class="counter">you are visitor <span class="odometer">${odometer(
		profile.visitors
	)}</span> · est. ${established}</div>
${profile.bio ? `<section class="bio">\n${paragraphs(profile.bio)}\n</section>` : ""}
${
	experimentItems
		? `<section class="experiments">\n<h2>Current experiments</h2>\n<ul>\n${experimentItems}\n</ul>\n</section>`
		: ""
}
${
	linkItems
		? `<section class="links">\n<h2>Elsewhere</h2>\n<nav>\n${linkItems}\n</nav>\n</section>`
		: ""
}
${truthPanel(snapshotRow, now)}
<footer>irc: ${escapeHtml(profile.channel)} · an Omen IRC laboratory${doorbell()}</footer>
</div>
</body>
</html>
`;
}

function limitedString(value, limit) {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

function sanitizeSnapshot(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw Object.assign(new Error("snapshot must be an object"), {status: 400});
	}
	const snapshot = {};
	const providers = [];
	for (const provider of Array.isArray(value.providers)
		? value.providers.slice(0, 12)
		: []) {
		if (!provider || typeof provider.name !== "string") {
			continue;
		}
		providers.push({
			name: limitedString(provider.name, 64),
			models: (Array.isArray(provider.models) ? provider.models.slice(0, 8) : [])
				.filter((model) => typeof model === "string")
				.map((model) => model.slice(0, 64)),
			tags: (Array.isArray(provider.tags) ? provider.tags.slice(0, 8) : [])
				.filter((tag) => typeof tag === "string")
				.map((tag) => tag.slice(0, 32)),
		});
	}
	snapshot.providers = providers;
	const operations = [];
	for (const operation of Array.isArray(value.operations)
		? value.operations.slice(0, 16)
		: []) {
		if (!operation || typeof operation.name !== "string") {
			continue;
		}
		operations.push({
			name: limitedString(operation.name, 64),
			description: limitedString(operation.description, 160),
		});
	}
	snapshot.operations = operations;
	const kernel = {};
	if (value.kernel && typeof value.kernel === "object") {
		for (const [key, entry] of Object.entries(value.kernel).slice(0, 8)) {
			if (/^[a-z0-9_]{1,32}$/.test(key) && Number.isInteger(entry)) {
				kernel[key] = entry;
			}
		}
	}
	snapshot.kernel = kernel;
	const recent = [];
	for (const entry of Array.isArray(value.recent) ? value.recent.slice(0, 10) : []) {
		if (!entry || typeof entry.operation !== "string") {
			continue;
		}
		recent.push({
			operation: limitedString(entry.operation, 64),
			status: limitedString(entry.status, 24),
			finished_at: limitedString(entry.finished_at, 32),
		});
	}
	snapshot.recent = recent;
	const artifacts = [];
	for (const artifact of Array.isArray(value.artifacts)
		? value.artifacts.slice(0, 12)
		: []) {
		if (!artifact || typeof artifact.name !== "string") {
			continue;
		}
		artifacts.push({
			name: limitedString(artifact.name, 80),
			kind: limitedString(artifact.kind, 32),
			created_at: limitedString(artifact.created_at, 32),
		});
	}
	snapshot.artifacts = artifacts;
	const serialized = JSON.stringify(snapshot);
	if (Buffer.byteLength(serialized, "utf8") > SNAPSHOT_MAX_BYTES) {
		throw Object.assign(new Error("snapshot is too large"), {status: 400});
	}
	return serialized;
}

function invalid(message) {
	return Object.assign(new Error(message), {status: 400, code: "invalid_profile"});
}

function singleLine(value, label, limit, {required = false} = {}) {
	if (typeof value !== "string") {
		throw invalid(`${label} must be a string`);
	}
	const text = value.trim();
	if (required && !text) {
		throw invalid(`${label} is required`);
	}
	if (text.length > limit) {
		throw invalid(`${label} is longer than ${limit} characters`);
	}
	if (/[\x00-\x1f\x7f]/.test(text)) {
		throw invalid(`${label} contains a control character`);
	}
	return text;
}

// Owner-editable presentation fields. Everything is validated here once and
// escaped again at render time; nothing an owner types ever reaches the page
// as markup. The reserved html_fragment column is deliberately not editable.
function validateProfilePatch(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw invalid("profile update must be an object");
	}
	if ("html_fragment" in body) {
		throw invalid("html fragments are not supported yet");
	}
	const patch = {};
	if ("lab_name" in body) {
		const name = singleLine(body.lab_name, "lab name", 48, {required: true});
		if (name.length < 2 || /[<>]/.test(name)) {
			throw invalid("lab name must be 2–48 characters without angle brackets");
		}
		patch.lab_name = name;
	}
	if ("tagline" in body) {
		patch.tagline = singleLine(body.tagline, "tagline", 120);
	}
	if ("marquee" in body) {
		patch.marquee = singleLine(body.marquee, "marquee", 160);
	}
	if ("bio" in body) {
		if (typeof body.bio !== "string") {
			throw invalid("bio must be a string");
		}
		const bio = body.bio.replace(/\r\n?/g, "\n").trim();
		if (bio.length > 2000) {
			throw invalid("bio is longer than 2000 characters");
		}
		if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bio)) {
			throw invalid("bio contains a control character");
		}
		patch.bio = bio;
	}
	if ("experiments" in body) {
		if (!Array.isArray(body.experiments) || body.experiments.length > 8) {
			throw invalid("experiments must be a list of at most 8 entries");
		}
		patch.experiments = JSON.stringify(
			body.experiments
				.map((entry, index) =>
					singleLine(entry, `experiment ${index + 1}`, 120)
				)
				.filter(Boolean)
		);
	}
	if ("links" in body) {
		if (!Array.isArray(body.links) || body.links.length > 8) {
			throw invalid("links must be a list of at most 8 entries");
		}
		const links = [];
		for (const [index, link] of body.links.entries()) {
			if (!link || typeof link !== "object") {
				throw invalid(`link ${index + 1} must be an object`);
			}
			const label = singleLine(link.label, `link ${index + 1} label`, 40, {
				required: true,
			});
			if (typeof link.url !== "string" || !HTTPS_PATTERN.test(link.url)) {
				throw invalid(`link ${index + 1} must use an https:// URL`);
			}
			links.push({label, url: link.url});
		}
		patch.links = JSON.stringify(links);
	}
	if ("ascii_banner" in body) {
		if (typeof body.ascii_banner !== "string") {
			throw invalid("ascii banner must be a string");
		}
		const banner = body.ascii_banner.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
		const lines = banner ? banner.split("\n") : [];
		if (lines.length > 24) {
			throw invalid("ascii banner is taller than 24 lines");
		}
		for (const line of lines) {
			if (line.length > 80) {
				throw invalid("ascii banner is wider than 80 columns");
			}
			if (/[\x00-\x1f\x7f]/.test(line)) {
				throw invalid("ascii banner contains a control character");
			}
		}
		patch.ascii_banner = lines.join("\n");
	}
	if ("theme" in body) {
		if (!body.theme || typeof body.theme !== "object" || Array.isArray(body.theme)) {
			throw invalid("theme must be an object");
		}
		const theme = {};
		for (const key of Object.keys(THEME_DEFAULTS)) {
			if (!(key in body.theme)) {
				continue;
			}
			const value =
				typeof body.theme[key] === "string" ? body.theme[key].toLowerCase() : "";
			if (!HEX_PATTERN.test(value)) {
				throw invalid(`theme ${key} must be a #rrggbb color`);
			}
			theme[key] = value;
		}
		if ("irc_accent" in body.theme) {
			const accent = body.theme.irc_accent;
			if (!Number.isInteger(accent) || accent < 0 || accent > 15) {
				throw invalid("theme irc_accent must be an mIRC color index 0–15");
			}
			theme.irc_accent = accent;
		}
		patch.theme = JSON.stringify(theme);
	}
	return patch;
}

module.exports = {
	escapeHtml,
	labTheme,
	renderGalleryPage,
	renderLabPage,
	sanitizeSnapshot,
	validateProfilePatch,
	SNAPSHOT_STALE_MINUTES,
};
