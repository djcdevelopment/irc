"use strict";

module.exports = {
	public: false,
	host: "0.0.0.0",
	port: 9000,
	reverseProxy: false,
	prefetch: false,
	disableMediaPreview: true,
	fileUpload: {
		enable: false,
		maxFileSize: 10240,
		baseUrl: null,
	},
	defaults: {
		name: "Omen Private IRC",
		host: "ergo",
		port: 6667,
		password: "",
		tls: false,
		rejectUnauthorized: true,
		nick: "Guest%%",
		username: "thelounge",
		realname: "The Lounge user",
		join: "#general,#ops",
		leaveMessage: "",
	},
	lockNetwork: true,
	messageStorage: ["sqlite"],
	storagePolicy: {
		enabled: true,
		maxAgeDays: 30,
		deletionPolicy: "everything",
	},
	webirc: null,
	identd: {
		enable: false,
		port: 113,
	},
	oidentd: null,
};
