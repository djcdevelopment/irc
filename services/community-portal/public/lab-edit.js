"use strict";

(() => {
	const MIRC_COLORS = [
		["0", "white", "#ffffff"],
		["1", "black", "#000000"],
		["2", "navy", "#00007f"],
		["3", "green", "#009300"],
		["4", "red", "#ff0000"],
		["5", "maroon", "#7f0000"],
		["6", "purple", "#9c009c"],
		["7", "orange", "#fc7f00"],
		["8", "yellow", "#ffff00"],
		["9", "light green", "#00fc00"],
		["10", "teal", "#009393"],
		["11", "cyan", "#00ffff"],
		["12", "blue", "#0000fc"],
		["13", "magenta", "#ff00ff"],
		["14", "grey", "#7f7f7f"],
		["15", "light grey", "#d2d2d2"],
	];
	const token = location.hash.slice(1);
	const gate = document.getElementById("gate");
	const form = document.getElementById("editor-form");
	const status = document.getElementById("status");
	const field = (id) => document.getElementById(id);

	const accentSelect = field("irc_accent");
	for (const [value, name] of MIRC_COLORS) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = `${value} — ${name}`;
		accentSelect.append(option);
	}

	function say(text, isError) {
		status.textContent = text;
		status.classList.toggle("error", Boolean(isError));
	}

	async function api(method, body, pathname = "/lab/api/profile") {
		const response = await fetch(pathname, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body ? {"content-type": "application/json"} : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		const value = await response.json();
		if (!response.ok) {
			throw new Error(value.message || value.error || "request failed");
		}
		return value;
	}

	function refreshPreview() {
		const preview = field("preview");
		preview.style.background = field("theme_bg").value;
		preview.style.color = field("theme_fg").value;
		field("preview-name").style.color = field("theme_accent").value;
		field("preview-tagline").style.color = field("theme_accent2").value;
		field("preview-name").textContent = field("lab_name").value || "Lab name";
		field("preview-tagline").textContent = field("tagline").value || "tagline";
	}

	function populate(profile) {
		field("lab_name").value = profile.lab_name || "";
		field("tagline").value = profile.tagline || "";
		field("marquee").value = profile.marquee || "";
		field("bio").value = profile.bio || "";
		const parse = (value, fallback) => {
			try {
				const parsed = JSON.parse(value);
				return Array.isArray(parsed) || typeof parsed === "object"
					? parsed
					: fallback;
			} catch {
				return fallback;
			}
		};
		field("experiments").value = parse(profile.experiments, []).join("\n");
		field("links").value = parse(profile.links, [])
			.map((link) => `${link.label} | ${link.url}`)
			.join("\n");
		field("ascii_banner").value = profile.ascii_banner || "";
		const theme = parse(profile.theme, {});
		field("theme_bg").value = theme.bg || "#090b10";
		field("theme_fg").value = theme.fg || "#cfd8e3";
		field("theme_accent").value = theme.accent || "#ffb340";
		field("theme_accent2").value = theme.accent2 || "#62d996";
		accentSelect.value = String(
			Number.isInteger(theme.irc_accent) ? theme.irc_accent : 11
		);
		const view = field("view-link");
		view.href = profile.web_url;
		view.textContent = `View ${profile.web_url}`;
		field("rename-slug").value = profile.lab_slug || "";
		refreshPreview();
	}

	function collect() {
		const experiments = field("experiments")
			.value.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const links = field("links")
			.value.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [label, ...rest] = line.split("|");
				return {label: (label || "").trim(), url: rest.join("|").trim()};
			});
		return {
			lab_name: field("lab_name").value,
			tagline: field("tagline").value,
			marquee: field("marquee").value,
			bio: field("bio").value,
			experiments,
			links,
			ascii_banner: field("ascii_banner").value,
			theme: {
				bg: field("theme_bg").value,
				fg: field("theme_fg").value,
				accent: field("theme_accent").value,
				accent2: field("theme_accent2").value,
				irc_accent: Number.parseInt(accentSelect.value, 10),
			},
		};
	}

	async function start() {
		if (!token) {
			return;
		}
		try {
			const profile = await api("GET");
			gate.hidden = true;
			form.hidden = false;
			populate(profile);
		} catch (error) {
			say(`Could not open your profile: ${error.message}`, true);
			return;
		}
		field("rename-channel").addEventListener("click", async () => {
			const slug = field("rename-slug").value.trim().toLowerCase();
			if (!slug) {
				say("Choose a lab slug first.", true);
				return;
			}
			say("Moving your channel…");
			try {
				const profile = await api(
					"POST",
					{lab_slug: slug},
					"/lab/api/rename-channel"
				);
				populate(profile);
				const notes = (profile.notes || []).join("; ");
				say(
					`Moved. Your lab now lives in ${profile.channel}.` +
						(notes ? ` Note: ${notes}` : "")
				);
			} catch (error) {
				say(`Not moved: ${error.message}`, true);
			}
		});
		field("rename-companion").addEventListener("click", async () => {
			const companion = field("rename-companion-name").value.trim();
			if (!companion) {
				say("Choose a companion name first.", true);
				return;
			}
			if (
				!window.confirm(
					"Renaming your companion breaks deployed remote agents until " +
						"you update HERDER_ACCOUNT in each agent.env and restart " +
						"them. Continue?"
				)
			) {
				return;
			}
			say("Renaming your companion…");
			try {
				const result = await api(
					"POST",
					{companion},
					"/lab/api/rename-companion"
				);
				const notes = (result.notes || []).join("; ");
				say(
					`Done. ${result.previous || "Your companion"} is now ${result.companion}.` +
						(notes ? ` Note: ${notes}` : "")
				);
			} catch (error) {
				say(`Not renamed: ${error.message}`, true);
			}
		});
		form.addEventListener("input", refreshPreview);
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			say("Saving…");
			try {
				const profile = await api("PUT", collect());
				populate(profile);
				say("Saved. Your lab page is live.");
			} catch (error) {
				say(`Not saved: ${error.message}`, true);
			}
		});
	}

	start();
})();
